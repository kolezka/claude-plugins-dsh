// Running Claude Code hook commands and reading their output.
import { spawn } from 'node:child_process'
import { DEFAULT_HOOK_TIMEOUT_S, type HookSpec } from './plugin-files.js'

const PLACEHOLDERS = ['CLAUDE_PLUGIN_ROOT', 'CLAUDE_PROJECT_DIR'] as const

/** Exec-form substitution: each placeholder becomes its value as plain text, never shell syntax. */
function expandPlaceholders(text: string, env: Record<string, string | undefined>): string {
  let out = text
  for (const name of PLACEHOLDERS) {
    const value = env[name]
    if (value !== undefined) out = out.replaceAll('${' + name + '}', value).replaceAll('$' + name, value)
  }
  return out
}

export const HOOK_STDOUT_LIMIT = 256 * 1024
// Grace period for stdout after the hook process exits, in case a backgrounded child
// keeps the pipe open (Claude Code does not wait for those either).
const HOOK_DRAIN_MS = 50
// Plain stdout and systemMessage reach the model only for these events, as in Claude Code.
const PLAIN_CONTEXT_EVENTS = new Set(['SessionStart', 'UserPromptSubmit'])

export interface HookRunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  truncated?: boolean
  aborted?: boolean
}

export type HookDecision = 'allow' | 'deny' | 'ask' | 'block' | (string & {})

export interface HookOutcome {
  context: string[]
  decision: HookDecision | undefined
  reason: string | undefined
  /** PreToolUse rewrite requested by the hook; DSH cannot apply it, so callers must fail closed. */
  updatedInput: Record<string, unknown> | undefined
  /** Text for the operator log, never for the model. */
  notices: string[]
}

/**
 * Run one hook command with Claude Code's hook contract: JSON on stdin, exit 2 blocks.
 * The hook runs in its own process group; a timeout or abort kills the whole group, and
 * the result is taken at process exit, not when every inherited stdout handle closes.
 */
export function runHook(hook: Pick<HookSpec, 'command'> & { args?: string[] | undefined; timeout?: number }, input: { cwd?: string } & Record<string, unknown>, env: Record<string, string | undefined>, signal?: AbortSignal): Promise<HookRunResult> {
  return new Promise((resolvePromise) => {
    let stdout = ''
    let stderr = ''
    let truncated = false
    let settled = false
    let drain: NodeJS.Timeout | undefined
    const options = { cwd: input.cwd || process.cwd(), env, stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'], detached: true }
    const child = hook.args
      ? spawn(expandPlaceholders(hook.command, env), hook.args.map((arg) => expandPlaceholders(arg, env)), options)
      : spawn('/bin/sh', ['-c', hook.command], options)
    const killGroup = (): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
    const timer = setTimeout(
      () => {
        killGroup()
        finish({ code: null, stdout, stderr: stderr + `\nhook timed out after ${hook.timeout}s`, timedOut: true, truncated })
      },
      (hook.timeout || DEFAULT_HOOK_TIMEOUT_S) * 1000,
    )
    const onAbort = (): void => {
      killGroup()
      finish({ code: null, stdout: '', stderr: 'hook cancelled', timedOut: false, truncated: false, aborted: true })
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    function finish(result: HookRunResult): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(drain)
      signal?.removeEventListener('abort', onAbort)
      child.stdout.destroy()
      child.stderr.destroy()
      resolvePromise(result)
    }
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length + chunk.length > HOOK_STDOUT_LIMIT) truncated = true
      else stdout += chunk
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < HOOK_STDOUT_LIMIT) stderr += chunk
    })
    child.on('error', (error) => finish({ code: null, stdout, stderr: String(error), timedOut: false, truncated }))
    child.on('exit', (code) => {
      drain = setTimeout(() => finish({ code, stdout, stderr, timedOut: false, truncated }), HOOK_DRAIN_MS)
    })
    child.on('close', (code) => finish({ code, stdout, stderr, timedOut: false, truncated }))
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(input))
  })
}

interface HookJsonOutput {
  hookSpecificOutput?: { additionalContext?: unknown; permissionDecision?: string; permissionDecisionReason?: string; updatedInput?: unknown }
  systemMessage?: unknown
  decision?: string
  reason?: string
  continue?: boolean
  stopReason?: string
}

/**
 * Normalize a hook result to one decision shape across events.
 * @param event - Claude hook event; plain stdout counts as context only for
 *   SessionStart and UserPromptSubmit, as in Claude Code.
 */
export function interpretHookResult(result: HookRunResult, event?: string): HookOutcome {
  const out: HookOutcome = { context: [], decision: undefined, reason: undefined, updatedInput: undefined, notices: [] }
  if (result.code === 2) {
    out.decision = 'block'
    out.reason = result.stderr.trim() || 'blocked by hook'
    return out
  }
  if (result.code !== 0) return out
  if (result.truncated) {
    out.notices.push(`hook output over ${HOOK_STDOUT_LIMIT} bytes was dropped`)
    return out
  }
  const text = result.stdout.trim()
  if (!text) return out
  let json: HookJsonOutput
  try {
    json = JSON.parse(text) as HookJsonOutput
  } catch {
    if (event === undefined || PLAIN_CONTEXT_EVENTS.has(event)) out.context.push(text)
    return out
  }
  const specific = json.hookSpecificOutput ?? {}
  if (specific.additionalContext) out.context.push(String(specific.additionalContext))
  if (specific.updatedInput && typeof specific.updatedInput === 'object' && !Array.isArray(specific.updatedInput)) out.updatedInput = specific.updatedInput as Record<string, unknown>
  if (json.systemMessage) out.notices.push(String(json.systemMessage))
  if (specific.permissionDecision) {
    out.decision = specific.permissionDecision
    out.reason = specific.permissionDecisionReason
  } else if (json.decision) {
    out.decision = json.decision === 'approve' ? 'allow' : json.decision
    out.reason = json.reason
  }
  if (json.continue === false) {
    out.decision = 'block'
    out.reason = json.stopReason || out.reason
  }
  return out
}
