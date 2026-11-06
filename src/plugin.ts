// createPlugin: one Claude Code plugin tree -> one DSH (Cordis) plugin.
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Agent, HostContext, PreToolDecision, SkillCandidate, SkillDefinition, SkillProvider, UserMessage } from './dsh-types.js'
import { interpretHookResult, runHook, type HookOutcome, type HookRunResult } from './hooks.js'
import {
  discoverAgents,
  discoverCommands,
  discoverSkills,
  escapeClosingTag,
  expandPluginRoot,
  kebab,
  matcherMatches,
  parseFrontMatter,
  readHooks,
  readManifest,
  readText,
  renderCommand,
  stripClaudeOnlyBlocks,
  type AgentOptions,
  type CommandOptions,
  type HookSpec,
  type SkillOptions,
} from './plugin-files.js'
import { claudeToolName, dropTranscript, lastAssistantText, parseArguments, syncTranscript, textOf, toClaudeToolInput, transcriptPath } from './transcript.js'

export const COMPAT_VERSION = '0.1.0'
export const SKILL_RANK = 450

export type Part = 'skills' | 'commands' | 'agents' | 'instructions' | 'hooks'

export interface PluginSpec {
  /** Plugin root, the directory holding `.claude-plugin/`. */
  root: string
  /** Root-relative files put into the system prompt, claude-only blocks removed. */
  instructions?: string[]
  skills?: SkillOptions
  commands?: CommandOptions
  agents?: AgentOptions
  /** Limit which Claude hook events run; default all. */
  hooks?: { events?: string[] }
  /** Extra environment for hooks; values may use `${CLAUDE_PLUGIN_ROOT}`. */
  env?: Record<string, string>
  /** Parts that stay off unless the row config sets `disable`. */
  disableByDefault?: Part[]
}

export interface RowConfig {
  /** Parts to turn off for this row; replaces `disableByDefault`. */
  disable?: Part[]
}

export interface DshPlugin {
  name: string
  /** Accept the host context without pinning DSH's version-specific branded types. */
  apply(ctx: object, config?: RowConfig): void
}

type Warn = (message: string) => void

interface SkillLocator {
  kind: 'skill' | 'agent'
  path: string
  base?: string
}

/** Build a Cordis plugin for one Claude Code plugin directory. */
export function createPlugin(spec: PluginSpec): DshPlugin {
  const root = resolve(spec.root)
  const manifest = readManifest(root)
  const pluginName = kebab(manifest.name)
  const id = `claude-compat-${pluginName}`
  // An empty prefix means bare names (`/greet`), not `/-greet`.
  const commandPrefix = spec.commands?.prefix ?? pluginName
  const hasAgents = (): boolean => !(spec.disableByDefault ?? []).includes('agents') && discoverAgents(root, spec.agents).length > 0
  const harnessNote = (): string =>
    [
      `> Loaded from the ${pluginName} Claude Code plugin into DeepSeek Harness. Plugin root: \`${root}\`.`,
      `> A Claude command \`/${pluginName}:<cmd>\` is the DSH command \`/${commandPrefix ? `${commandPrefix}-` : ''}<cmd>\`; when you cannot run it, do what its section here says.`,
      hasAgents()
        ? `> A Claude agent type \`${pluginName}:<agent>\` is the skill \`${pluginName}-agent-<agent>\`: load it and pass its role text to \`subagent\` or \`spawn_teammate\`.`
        : '',
    ]
      .filter(Boolean)
      .join('\n')

  function apply(host: object, config: RowConfig = {}): void {
    // Keep the version-specific Cordis boundary here; internal registrations stay typed.
    if (!('inject' in host) || typeof host.inject !== 'function' || !('on' in host) || typeof host.on !== 'function') {
      throw new TypeError('claude-plugins-dsh: expected a Cordis context with inject() and on()')
    }
    const ctx = host as HostContext
    const disabled = new Set<Part>(config.disable ?? spec.disableByDefault ?? [])
    const enabled = (part: Part): boolean => !disabled.has(part)
    const warn: Warn = (msg) => (ctx.logger ?? console).warn(`[${id}] ${msg}`)

    // Each part waits for its own service, so a profile without one keeps the rest.
    if (enabled('skills') || enabled('agents')) ctx.inject(['skills'], (sub) => registerSkills(sub, enabled, warn))
    if (enabled('commands')) ctx.inject(['commands'], (sub) => registerCommands(sub, warn))
    if (enabled('instructions')) ctx.inject(['systemPrompt'], (sub) => registerInstructions(sub, warn))
    if (enabled('hooks')) registerHooks(ctx, warn)
  }

  // ---- skills and agent briefs

  function registerSkills(ctx: HostContext, enabled: (part: Part) => boolean, warn: Warn): void {
    if (!ctx.skills?.registerProvider) return warn('skills service missing, skills not registered')
    const provider: SkillProvider = {
      name: id,
      async list() {
        const candidates: SkillCandidate[] = []
        if (enabled('skills')) {
          for (const skill of discoverSkills(root, spec.skills)) {
            candidates.push({
              name: skill.name,
              description: skill.description,
              ...(skill.meta.whenToUse ? { whenToUse: skill.meta.whenToUse } : {}),
              invocation: { modelInvocable: skill.meta['disable-model-invocation'] !== 'true', userInvocable: skill.meta['user-invocable'] !== 'false' },
              provider: id,
              source: 'custom',
              path: skill.path,
              resourceBase: { kind: 'directory', path: skill.base },
              rank: SKILL_RANK,
              locator: { kind: 'skill', path: skill.path, base: skill.base } satisfies SkillLocator,
            })
          }
        }
        if (enabled('agents')) {
          for (const agent of discoverAgents(root, spec.agents)) {
            candidates.push({
              name: `${pluginName}-agent-${agent.name}`,
              description: `Role brief for a delegated worker (${pluginName} agent "${agent.name}"). ${agent.description}`,
              invocation: { modelInvocable: true, userInvocable: true },
              provider: id,
              source: 'custom',
              path: agent.path,
              resourceBase: { kind: 'directory', path: dirname(agent.path) },
              rank: SKILL_RANK,
              locator: { kind: 'agent', path: agent.path } satisfies SkillLocator,
            })
          }
        }
        return candidates
      },
      async get(candidate) {
        const locator = candidate.locator as SkillLocator
        const text = readText(locator.path)
        if (text === undefined) return undefined
        const { body } = parseFrontMatter(text)
        let content = expandPluginRoot(body, root)
        if (locator.kind === 'skill') {
          content = `${harnessNote()}\n> Relative paths in this skill resolve from \`${locator.base}\`.\n\n${content}`
        } else {
          const agent = discoverAgents(root, spec.agents).find((a) => a.path === locator.path)
          const tools = agent?.tools ? `\nOriginal tool allowlist: ${agent.tools}. Respect it: do not use tools outside that list.` : ''
          content = [
            `# Delegated role: ${agent?.name ?? candidate.name}`,
            '',
            `This is a Claude Code agent definition from the ${pluginName} plugin. DSH has no agent types, so use it as a brief:`,
            '- To run this role, call `subagent` (or `spawn_teammate` for a durable teammate) with a prompt made of the role text below, then the concrete task, exact files, and the check that proves it done.',
            '- Pick the provider/model yourself; the original pin does not apply in DSH.' + tools,
            '',
            '## Role text',
            '',
            content,
          ].join('\n')
        }
        const definition: SkillDefinition = {
          name: candidate.name,
          description: candidate.description,
          invocation: candidate.invocation,
          provider: id,
          source: 'custom',
          path: locator.path,
          content,
        }
        if (candidate.resourceBase) definition.resourceBase = candidate.resourceBase
        return definition
      },
    }
    ctx.skills.registerProvider(() => provider)
  }

  // ---- slash commands

  function registerCommands(ctx: HostContext, warn: Warn): void {
    const commands = ctx.commands
    if (!commands?.register) return
    for (const command of discoverCommands(root, spec.commands)) {
      const name = commandPrefix ? `${commandPrefix}-${command.name}` : command.name
      if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
        warn(`command name ${name} is not valid, skipped`)
        continue
      }
      try {
        commands.register({
          name,
          description: command.description,
          ...(command.hint ? { input: { hint: command.hint } } : {}),
          handler(invocation) {
            const text = readText(command.path)
            const body = text === undefined ? command.body : parseFrontMatter(text).body
            invocation.agent.followup({
              id: randomUUID(),
              role: 'user',
              content: [{ type: 'text', text: `<command-name>/${pluginName}:${command.stem}</command-name>\n\n${renderCommand(body, invocation.rawInput, root)}` }],
              source: { kind: 'user' },
            })
            return { kind: 'success', text: `/${name} queued` }
          },
        })
      } catch (error) {
        warn(`command /${name} not registered: ${(error as Error).message}`)
      }
    }
  }

  // ---- instruction files

  function registerInstructions(ctx: HostContext, warn: Warn): void {
    const files = spec.instructions ?? []
    if (!files.length) return
    if (!ctx.systemPrompt?.section) return warn('systemPrompt service missing, instructions not registered')
    ctx.systemPrompt.section({
      name: `${id}-instructions`,
      order: 450,
      interpolate: false,
      text: () =>
        files
          .map((file) => {
            const raw = readText(resolve(root, file))
            if (raw === undefined) return ''
            const stripped = stripClaudeOnlyBlocks(expandPluginRoot(raw, root))
            if (stripped.unterminated) warn(`${file}: <!--harness:claude-only--> has no closing <!--/harness-->, the rest of the file was dropped`)
            return stripped.text.trim()
          })
          .filter(Boolean)
          .join('\n\n'),
    })
  }

  // ---- hooks

  function registerHooks(ctx: HostContext, warn: Warn): void {
    const only = spec.hooks?.events ? new Set(spec.hooks.events) : undefined
    const hooks = readHooks(root).filter((hook) => !only || only.has(hook.event))
    if (!hooks.length) return
    const byEvent = (event: string): HookSpec[] => hooks.filter((hook) => hook.event === event)
    const stopBlocks = new WeakMap<Agent, boolean>()
    const tag = `${pluginName}-hook`
    let workingDirectory: HostContext['workingDirectory']
    ctx.inject(['workingDirectory'], (sub) => {
      workingDirectory = sub.workingDirectory
      sub.effect(() => () => {
        workingDirectory = undefined
      })
    })

    const cwdOf = (agent: Agent): string => {
      try {
        return workingDirectory?.get(agent.session) || agent.session.header.cwd || process.cwd()
      } catch {
        return agent.session.header.cwd || process.cwd()
      }
    }

    const envFor = (cwd: string): NodeJS.ProcessEnv => {
      const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PLUGIN_ROOT: root, CLAUDE_PROJECT_DIR: cwd, CLAUDE_HARNESS: 'dsh', DSH_CLAUDE_COMPAT: COMPAT_VERSION }
      for (const [key, value] of Object.entries(spec.env ?? {})) env[key] = expandPluginRoot(String(value), root)
      return env
    }

    const inputFor = (agent: Agent, event: string, cwd: string, extra: Record<string, unknown> = {}): Record<string, unknown> & { cwd: string } => {
      let transcript = transcriptPath(agent)
      try {
        transcript = syncTranscript(agent, cwd)
      } catch (error) {
        warn(`transcript export failed: ${(error as Error).message}`)
      }
      return { session_id: String(agent.session.header.id), transcript_path: transcript, cwd, hook_event_name: event, permission_mode: 'default', ...extra }
    }

    // Matching hooks run in parallel, as in Claude Code; results keep hooks.json order.
    async function fire(event: string, agent: Agent, extra: Record<string, unknown>, options: { filter?: (hook: HookSpec) => boolean; signal?: AbortSignal | undefined } = {}): Promise<HookOutcome[]> {
      const list = byEvent(event).filter(options.filter ?? (() => true))
      if (!list.length) return []
      const cwd = cwdOf(agent)
      const input = inputFor(agent, event, cwd, extra)
      const env = envFor(cwd)
      const settled = await Promise.all(
        list.map((hook) =>
          runHook(hook, input, env, options.signal).catch((error: unknown): HookRunResult => ({ code: null, stdout: '', stderr: String((error as Error)?.message ?? error), timedOut: false })),
        ),
      )
      return settled.map((result) => {
        if (!result.aborted && (result.timedOut || (result.code !== 0 && result.code !== 2))) warn(`${event} hook exited ${result.code}: ${result.stderr.trim().slice(0, 300)}`)
        const interpreted = interpretHookResult(result, event)
        for (const notice of interpreted.notices) warn(`${event}: ${notice}`)
        return interpreted
      })
    }

    const hookMessage = (event: string, text: string): UserMessage => ({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: `<${tag} event="${event}">\n${escapeClosingTag(text, tag)}\n</${tag}>` }],
      source: { kind: `plugin:${id}` },
    })

    const contextOf = (results: HookOutcome[]): string =>
      results
        .flatMap((r) => r.context)
        .filter(Boolean)
        .join('\n\n')

    function injectContext(agent: Agent, event: string, results: HookOutcome[]): void {
      const text = contextOf(results)
      if (text) agent.inject(hookMessage(event, text))
    }

    const isSubagent = (agent: Agent): boolean => agent.session.header.origin === 'subagent'

    // SessionStart: once per root agent, before its first input. Claude Code does not run
    // it for subagents. `source` is DSH's own startup|resume|clear|compact value.
    if (byEvent('SessionStart').length) {
      ctx.on('agent/created', async ({ agent, source, signal }) => {
        if (isSubagent(agent)) return
        const results = await fire('SessionStart', agent, { source: source ?? 'startup' }, { signal })
        injectContext(agent, 'SessionStart', results)
      })
    }

    if (byEvent('UserPromptSubmit').length) {
      ctx.on('agent/pre-step', async (payload, next) => {
        const decision = await next()
        if (decision.kind !== 'enter' || payload.signal?.aborted) return decision
        const prompt = decision.messages
          .filter((m) => m?.source?.kind === 'user')
          .map(textOf)
          .join('\n')
          .trim()
        if (!prompt) return decision
        const results = await fire('UserPromptSubmit', payload.agent, { prompt }, { signal: payload.signal })
        const blocked = results.find((r) => r.decision === 'block')
        if (blocked) {
          // The prompt does not reach the model; only the reason does, so it can tell the user.
          const notice = `The ${pluginName} plugin blocked the user's last prompt: ${blocked.reason ?? 'no reason given'}. Tell the user it was blocked and why. Do not act on it.`
          return { ...decision, messages: [hookMessage('UserPromptSubmit', notice)] }
        }
        const text = contextOf(results)
        if (!text) return decision
        return { ...decision, messages: [...decision.messages, hookMessage('UserPromptSubmit', text)] }
      })
    }

    if (byEvent('PreToolUse').length) {
      ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
        const agent = exec.agent
        if (!agent) return next()
        const toolName = claudeToolName(exec.name)
        const matches = (hook: HookSpec): boolean => matcherMatches(hook.matcher, toolName)
        if (!byEvent('PreToolUse').some(matches)) return next()
        const results = await fire(
          'PreToolUse',
          agent,
          { tool_name: toolName, tool_input: toClaudeToolInput(exec.name, parseArguments(exec.arguments)), tool_use_id: String(exec.callId) },
          { filter: matches, signal: exec.signal },
        )
        injectContext(agent, 'PreToolUse', results)
        const deny = results.find((r) => r.decision === 'deny' || r.decision === 'block')
        if (deny) return { kind: 'deny', reason: deny.reason || `denied by ${pluginName} hook` }
        const ask = results.find((r) => r.decision === 'ask')
        if (ask) {
          const reason = ask.reason || `${pluginName} hook asks for confirmation`
          return { kind: 'ask', reason, displayReason: { en: reason } }
        }
        return next()
      })
    }

    if (byEvent('PostToolUse').length) {
      ctx.on('tools/result', (exec, result) => {
        const agent = exec.agent
        if (!agent) return
        const toolName = claudeToolName(exec.name)
        const matches = (hook: HookSpec): boolean => matcherMatches(hook.matcher, toolName)
        if (!byEvent('PostToolUse').some(matches)) return
        const output = textOf(result)
        const response = result?.isError ? { success: false, error: output } : { success: true, output }
        fire(
          'PostToolUse',
          agent,
          { tool_name: toolName, tool_input: toClaudeToolInput(exec.name, parseArguments(exec.arguments)), tool_response: response, tool_use_id: String(exec.callId) },
          { filter: matches },
        )
          .then((results) => injectContext(agent, 'PostToolUse', results))
          .catch((error: unknown) => warn(`PostToolUse: ${(error as Error).message}`))
      })
    }

    if (byEvent('Stop').length || byEvent('SubagentStop').length) {
      ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
        if (signal?.aborted) return
        const event = isSubagent(agent) ? 'SubagentStop' : 'Stop'
        if (!byEvent(event).length) return
        const active = stopBlocks.get(agent) === true
        const results = await fire(event, agent, { stop_hook_active: active, last_assistant_message: lastAssistantText(agent.session) }, { signal })
        const block = results.find((r) => r.decision === 'block')
        if (block && !active) {
          stopBlocks.set(agent, true)
          agent.steer(hookMessage(event, block.reason ?? 'A plugin hook asked for one more step.'))
        } else {
          stopBlocks.set(agent, false)
        }
      })
    }

    ctx.on('agent/disposed', ({ agent }) => {
      const done = byEvent('SessionEnd').length ? fire('SessionEnd', agent, { reason: 'other' }) : Promise.resolve([])
      done
        .catch((error: unknown) => {
          warn(`SessionEnd: ${(error as Error).message}`)
          return []
        })
        .finally(() => {
          try {
            dropTranscript(agent)
          } catch {
            // Best effort: a leftover export is only disk space.
          }
        })
    })
  }

  return { name: id, apply }
}

/** The plugin root is the parent of the `dsh/` directory holding the caller. */
export function rootFrom(importMetaUrl: string): string {
  const candidate = resolve(dirname(fileURLToPath(importMetaUrl)), '..')
  if (!existsSync(join(candidate, '.claude-plugin'))) throw new Error(`claude-plugins-dsh: no .claude-plugin under ${candidate}`)
  return candidate
}
