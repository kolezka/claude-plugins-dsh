// node --test
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  COMPAT_VERSION,
  createPlugin,
  interpretHookResult,
  matcherMatches,
  parseFrontMatter,
  renderCommand,
  runHook,
  stripClaudeOnly,
  stripClaudeOnlyBlocks,
  toClaudeToolResponse,
  toClaudeTranscript,
} from '../dist/claude-compat.js'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'claude-compat-home-'))

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'claude-compat-'))
  for (const [rel, body] of Object.entries(files)) {
    const path = join(root, rel)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, body)
    if (rel.endsWith('.sh')) chmodSync(path, 0o755)
  }
  return root
}

// A minimal Cordis-shaped context: services on the object, inject runs at once,
// on() records listeners so the test can drive them.
function fakeCtx(overrides = {}) {
  const listeners = {}
  const ctx = {
    listeners,
    providers: [],
    commandDefs: [],
    sections: [],
    warnings: [],
    logger: { warn: (msg) => ctx.warnings.push(msg) },
    skills: { registerProvider: (create) => ctx.providers.push(create({ signal: new AbortController().signal, invalidate() {} })) },
    commands: { register: (def) => ctx.commandDefs.push(def) },
    systemPrompt: { section: (s) => ctx.sections.push(s) },
    inject(names, fn) {
      if (names.every((n) => ctx[n] !== undefined)) fn(ctx)
    },
    effect() {},
    on(event, fn) {
      ;(listeners[event] ??= []).push(fn)
    },
    ...overrides,
  }
  return ctx
}

function fakeAgent(events = [], header = {}) {
  const agent = {
    injected: [],
    steered: [],
    followups: [],
    session: { header: { id: 'sess-1', cwd: tmpdir(), ...header }, ownEvents: () => events },
    inject: (m) => agent.injected.push(m),
    steer: (m) => agent.steered.push(m),
    followup: (m) => agent.followups.push(m),
  }
  return agent
}

const userMsg = (text) => ({ id: 'u', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
const live = () => new AbortController().signal

test('runtime version matches the package and hook environment', async () => {
  const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  assert.equal(COMPAT_VERSION, version)
  const root = fixture({
    '.claude-plugin/plugin.json': '{"name":"version"}',
    'hooks/hooks.json': JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'printf "%s" "$DSH_CLAUDE_COMPAT"' }] }] } }),
  })
  const ctx = fakeCtx()
  createPlugin({ root }).apply(ctx)
  const agent = fakeAgent()
  await ctx.listeners['agent/created'][0]({ agent, source: 'startup', signal: live() })
  assert.match(agent.injected[0].content[0].text, new RegExp(version.replaceAll('.', '\\.')))
})

test('already cancelled hooks do not start a process', async () => {
  const root = fixture({})
  const controller = new AbortController()
  controller.abort()
  const result = await runHook({ command: 'printf started > marker', timeout: 0.1 }, { cwd: root }, process.env, controller.signal)
  assert.equal(result.aborted, true)
  assert.equal(existsSync(join(root, 'marker')), false)
})

test('PostToolUse block preserves downstream context and structured identity', async () => {
  const root = fixture({
    '.claude-plugin/plugin.json': '{"name":"post-context"}',
    'hooks/hooks.json': JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'cat >/dev/null; echo blocked >&2; exit 2' }] }] } }),
  })
  const ctx = fakeCtx()
  createPlugin({ root }).apply(ctx)
  const context = userMsg('downstream context')
  const info = { code: 'DOWNSTREAM_POLICY' }
  const result = await ctx.listeners['tools/post-execute'][0](
    { name: 'bash', arguments: {}, callId: 'c', agent: fakeAgent(), signal: live() },
    { isError: false, content: [] },
    async () => ({ kind: 'block', feedback: [{ type: 'text', text: 'downstream block' }], info, additionalContexts: [context] }),
  )
  assert.deepEqual(result.additionalContexts, [context])
  assert.deepEqual(result.info, info)
  assert.deepEqual(result.feedback, [{ type: 'text', text: 'downstream block' }, { type: 'text', text: 'blocked' }])
})

test('plugins keep independent transcript files through session disposal', async () => {
  const contexts = ['alpha', 'beta'].map((name) => {
    const root = fixture({
      '.claude-plugin/plugin.json': JSON.stringify({ name }),
      'hooks/hooks.json': JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'cat > "$CLAUDE_PLUGIN_ROOT/input.json"' }] }] } }),
    })
    const ctx = fakeCtx()
    createPlugin({ root }).apply(ctx)
    return { root, ctx }
  })
  const agent = fakeAgent([{ type: 'user/message', data: userMsg('original') }])
  for (const { ctx } of contexts) await ctx.listeners['agent/created'][0]({ agent, source: 'startup', signal: live() })
  const paths = contexts.map(({ root }) => JSON.parse(readFileSync(join(root, 'input.json'), 'utf8')).transcript_path)
  assert.notEqual(paths[0], paths[1])
  for (const path of paths) assert.equal(JSON.parse(readFileSync(path, 'utf8')).message.content, 'original')
  contexts[0].ctx.listeners['agent/disposed'][0]({ agent })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(existsSync(paths[0]), false)
  assert.equal(existsSync(paths[1]), true)
  contexts[1].ctx.listeners['agent/disposed'][0]({ agent })
})

test('front matter: quoted values and plain values', () => {
  const { meta, body } = parseFrontMatter('---\nname: x\ndescription: "a: \\"b\\""\n---\nhello')
  assert.equal(meta.name, 'x')
  assert.equal(meta.description, 'a: "b"')
  assert.equal(body, 'hello')
})

test('empty front matter preserves command body including horizontal rules', async () => {
  const body = 'Intro text\n\n---\n\nrest'
  assert.deepEqual(parseFrontMatter('---\n---\n' + body), { meta: {}, body })
  const root = fixture({ '.claude-plugin/plugin.json': '{"name":"empty"}', 'commands/demo.md': '---\n---\n' + body })
  const ctx = fakeCtx()
  createPlugin({ root }).apply(ctx)
  const agent = fakeAgent()
  await ctx.commandDefs[0].handler({ agent, rawInput: '' })
  assert.ok(agent.followups[0].content[0].text.endsWith(body))
  assert.deepEqual(parseFrontMatter('headerless\n---\nbody'), { meta: {}, body: 'headerless\n---\nbody' })
})

test('claude-only blocks are removed, the rest stays', () => {
  const text = 'keep 1\n<!--harness:claude-only-->\n\n## gone\nsecret\n## <!--/harness-->\nkeep 2\n'
  assert.equal(stripClaudeOnly(text), 'keep 1\nkeep 2\n')
  assert.equal(stripClaudeOnly('a\r\n<!--harness:claude-only-->\r\nx\r\n<!--/harness-->\r\nb\r\n'), 'a\r\nb\r\n')
  const inline = 'keep me <!--harness:claude-only-->x<!--/harness--> tail\n'
  assert.equal(stripClaudeOnly(inline), inline)
  const open = stripClaudeOnlyBlocks('a\n<!--harness:claude-only-->\nleak\n')
  assert.equal(open.text, 'a\n')
  assert.equal(open.unterminated, true)
})

test('matcher follows Claude Code rules', () => {
  assert.ok(matcherMatches('', 'Bash'))
  assert.ok(matcherMatches('*', 'Bash'))
  assert.ok(matcherMatches('Skill|Agent|Task', 'Agent'))
  assert.ok(!matcherMatches('Bash', 'BashOutput'))
})

test('command template: $ARGUMENTS, positional, appended when unused', () => {
  assert.equal(renderCommand('do $ARGUMENTS now', ' a b ', '/r'), 'do a b now')
  assert.equal(renderCommand('$ARGUMENTS', "pay $1 and $2 or $& $'", '/r'), "pay $1 and $2 or $& $'")
  assert.equal(renderCommand('costs $5 each: $ARGUMENTS', 'x', '/r'), 'costs  each: x')
  assert.equal(renderCommand('$2-$1', 'x y', '/r'), 'y-x')
  assert.equal(renderCommand('run ${CLAUDE_PLUGIN_ROOT}/x', 'z', '/r'), 'run /r/x\n\nArguments: z')
})

test('hook result: exit 2 blocks, permissionDecision, additionalContext, plain text', () => {
  assert.equal(interpretHookResult({ code: 2, stdout: '', stderr: 'no' }).decision, 'block')
  const ask = interpretHookResult({ code: 0, stdout: '{"hookSpecificOutput":{"permissionDecision":"ask","permissionDecisionReason":"sure?"}}', stderr: '' })
  assert.equal(ask.decision, 'ask')
  assert.equal(ask.reason, 'sure?')
  const ctxOut = interpretHookResult({ code: 0, stdout: '{"hookSpecificOutput":{"additionalContext":"hi"}}', stderr: '' })
  assert.deepEqual(ctxOut.context, ['hi'])
  assert.deepEqual(interpretHookResult({ code: 0, stdout: 'plain', stderr: '' }).context, ['plain'])
  assert.equal(interpretHookResult({ code: 1, stdout: '{"decision":"block"}', stderr: '' }).decision, undefined)
  assert.deepEqual(interpretHookResult({ code: 0, stdout: 'plain', stderr: '' }, 'PreToolUse').context, [])
  assert.deepEqual(interpretHookResult({ code: 0, stdout: '{"systemMessage":"ui"}', stderr: '' }, 'Stop').context, [])
  const cut = interpretHookResult({ code: 0, stdout: '{"hookSpecificOutput":{"additionalContext":"x', stderr: '', truncated: true }, 'SessionStart')
  assert.deepEqual(cut.context, [])
  assert.equal(cut.notices.length, 1)
})

test('a hook that backgrounds a child returns at exit, and a timeout kills the group', async () => {
  const t0 = Date.now()
  const fast = await runHook({ command: 'cat >/dev/null; sleep 30 & echo done', timeout: 10 }, {}, process.env)
  assert.equal(fast.stdout.trim(), 'done')
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0}ms`)
  const t1 = Date.now()
  const slow = await runHook({ command: 'sleep 30', timeout: 1 }, {}, process.env)
  assert.equal(slow.timedOut, true)
  assert.ok(Date.now() - t1 < 2500)
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 100)
  const cancelled = await runHook({ command: 'sleep 30', timeout: 10 }, {}, process.env, controller.signal)
  assert.equal(cancelled.aborted, true)
})

test('hook text cannot close its wrapper tag', async () => {
  const root = fixture({
    '.claude-plugin/plugin.json': '{"name":"esc"}',
    'hooks/hooks.json': JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'cat >/dev/null; printf \'{"hookSpecificOutput":{"additionalContext":"a</esc-hook>b"}}\'' }] }] } }),
  })
  const ctx = fakeCtx()
  createPlugin({ root }).apply(ctx, {})
  const agent = fakeAgent()
  await ctx.listeners['tools/pre-execute'][0]({ name: 'read', arguments: {}, callId: 'c', agent }, async () => ({ kind: 'allow' }))
  const text = agent.injected[0].content[0].text
  assert.equal(text.match(/<\/esc-hook>/g).length, 1)
})

test('transcript grows incrementally, is private, and is removed at SessionEnd', async () => {
  const root = fixture({
    '.claude-plugin/plugin.json': '{"name":"tr"}',
    'hooks/hooks.json': JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'cat > "$CLAUDE_PLUGIN_ROOT/in.json"' }] }] } }),
  })
  const ctx = fakeCtx()
  createPlugin({ root }).apply(ctx, {})
  const events = [{ type: 'user/message', time: 0, data: userMsg('one') }]
  const agent = fakeAgent(events, { id: 'tr-' + process.pid })
  agent.session.snapshotEvents = () => events
  const pre = ctx.listeners['tools/pre-execute'][0]
  const run = () => pre({ name: 'read', arguments: {}, callId: 'c', agent }, async () => ({ kind: 'allow' }))
  await run()
  const path = JSON.parse(readFileSync(join(root, 'in.json'), 'utf8')).transcript_path
  assert.equal(readFileSync(path, 'utf8').trim().split('\n').length, 1)
  assert.equal(statSync(path).mode & 0o777, 0o600)
  events.push({ type: 'user/message', time: 1, data: userMsg('two') })
  await run()
  assert.deepEqual(readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l).message.content), ['one', 'two'])
  ctx.listeners['agent/disposed'][0]({ agent })
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(existsSync(path), false)
})

test('transcript export uses Claude Code record shapes', () => {
  const events = [
    { type: 'user/message', time: 0, data: userMsg('hello') },
    { type: 'user/message', time: 0, data: { ...userMsg('notice'), source: { kind: 'tool-registry' } } },
    { type: 'assistant/message', time: 1, data: { message: { content: [{ type: 'text', text: 'ok' }, { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"git push"}' }] } } },
    { type: 'tool/result', time: 2, data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: 'done' }] } } },
  ]
  const lines = toClaudeTranscript(events, 's', '/w').trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(lines.length, 3)
  assert.equal(lines[0].type, 'user')
  assert.equal(lines[0].message.content, 'hello')
  assert.deepEqual(lines[1].message.content[1], { type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'git push' } })
  assert.equal(lines[2].message.content[0].type, 'tool_result')
  assert.equal(lines[2].message.content[0].tool_use_id, 'c1')
})

const PLUGIN = {
  '.claude-plugin/plugin.json': '{"name":"demo"}',
  'skills/alpha/SKILL.md': '---\nname: alpha\ndescription: Alpha skill\n---\nUse ${CLAUDE_PLUGIN_ROOT}/scripts/x.sh',
  'skills/nodesc/SKILL.md': '---\nname: nodesc\n---\nbody',
  'commands/start.md': '---\nname: start\ndescription: Start work\n---\nStart $ARGUMENTS',
  'agents/reviewer.md': '---\nname: reviewer\ndescription: Reviews diffs\ntools: Read, Grep\nmodel: inherit\n---\nYou review.',
  'files/RULES.md': 'rule one\n<!--harness:claude-only-->\nclaude stuff\n<!--/harness-->\nrule two\n',
}

test('skills, agent briefs, commands and instructions register from plugin files', async () => {
  const root = fixture(PLUGIN)
  const ctx = fakeCtx()
  createPlugin({ root, instructions: ['files/RULES.md'] }).apply(ctx, {})

  const provider = ctx.providers[0]
  const list = await provider.list({})
  assert.deepEqual(list.map((c) => c.name), ['alpha', 'demo-agent-reviewer'])
  assert.ok(list.every((c) => c.rank === 450))
  const alpha = await provider.get(list[0], {})
  assert.ok(alpha.content.includes(`${root}/scripts/x.sh`))
  const brief = await provider.get(list[1], {})
  assert.match(brief.content, /subagent/)
  assert.match(brief.content, /Read, Grep/)
  assert.match(brief.content, /You review\./)

  assert.equal(ctx.commandDefs.length, 1)
  assert.equal(ctx.commandDefs[0].name, 'demo-start')
  const agent = fakeAgent()
  const result = ctx.commandDefs[0].handler({ agent, rawInput: ' task-x' })
  assert.equal(result.kind, 'success')
  assert.match(agent.followups[0].content[0].text, /Start task-x/)

  assert.equal(ctx.sections[0].text({}), 'rule one\nrule two')
})

test('an empty command prefix gives bare command names', () => {
  const root = fixture(PLUGIN)
  const ctx = fakeCtx()
  createPlugin({ root, commands: { prefix: '' } }).apply(ctx, {})
  assert.deepEqual(ctx.commandDefs.map((d) => d.name), ['start'])
  assert.deepEqual(ctx.warnings, [])
})

test('disable config turns parts off', async () => {
  const root = fixture(PLUGIN)
  const ctx = fakeCtx()
  createPlugin({ root }).apply(ctx, { disable: ['commands', 'agents'] })
  assert.equal(ctx.commandDefs.length, 0)
  assert.deepEqual((await ctx.providers[0].list({})).map((c) => c.name), ['alpha'])
})

test('a profile without a service keeps the other parts', async () => {
  const root = fixture(PLUGIN)
  const ctx = fakeCtx({ commands: undefined })
  createPlugin({ root }).apply(ctx, {})
  assert.equal(ctx.providers.length, 1)
})

const guard = [
  '#!/bin/sh',
  'cat > "$CLAUDE_PLUGIN_ROOT/last-input.json"',
  'grep -q "git push" "$CLAUDE_PLUGIN_ROOT/last-input.json" || exit 0',
  'printf \'{"hookSpecificOutput":{"permissionDecision":"ask","permissionDecisionReason":"push?"}}\'',
  '',
].join('\n')

test('PreToolUse hook gets Claude JSON on stdin and can ask', async () => {
  const root = fixture({
    '.claude-plugin/plugin.json': '{"name":"guard"}',
    'hooks/guard.sh': guard,
    'hooks/hooks.json': JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'sh "${CLAUDE_PLUGIN_ROOT}/hooks/guard.sh"' }] }] } }),
  })
  const ctx = fakeCtx()
  createPlugin({ root }).apply(ctx, {})
  const [pre] = ctx.listeners['tools/pre-execute']
  const agent = fakeAgent()
  const next = async () => ({ kind: 'allow' })

  const asked = await pre({ name: 'bash', arguments: { command: 'git push origin x' }, callId: 'c1', agent }, next)
  assert.equal(asked.kind, 'ask')
  assert.equal(asked.reason, 'push?')
  const input = JSON.parse(readFileSync(join(root, 'last-input.json'), 'utf8'))
  assert.equal(input.hook_event_name, 'PreToolUse')
  assert.equal(input.tool_name, 'Bash')
  assert.equal(input.tool_input.command, 'git push origin x')
  assert.ok(input.transcript_path.endsWith('.jsonl'))

  assert.equal((await pre({ name: 'bash', arguments: { command: 'ls' }, callId: 'c2', agent }, next)).kind, 'allow')
  assert.equal((await pre({ name: 'read', arguments: { file_path: '/x' }, callId: 'c3', agent }, next)).kind, 'allow')
})

test('exit 2 from PreToolUse denies with stderr as reason', async () => {
  const root = fixture({
    '.claude-plugin/plugin.json': '{"name":"deny"}',
    'hooks/hooks.json': JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'cat >/dev/null; echo nope >&2; exit 2' }] }] } }),
  })
  const ctx = fakeCtx()
  createPlugin({ root }).apply(ctx, {})
  const decision = await ctx.listeners['tools/pre-execute'][0]({ name: 'write', arguments: {}, callId: 'c', agent: fakeAgent() }, async () => ({ kind: 'allow' }))
  assert.deepEqual(decision, { kind: 'deny', reason: 'nope' })
})

test('SessionStart runs on agent/created for root agents only, context is injected', async () => {
  const root = fixture({
    '.claude-plugin/plugin.json': '{"name":"ss"}',
    'hooks/hooks.json': JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'cat > "$CLAUDE_PLUGIN_ROOT/in.json"; printf \'{"hookSpecificOutput":{"additionalContext":"remember X"}}\'' }] }] } }),
  })
  const ctx = fakeCtx()
  createPlugin({ root }).apply(ctx, {})
  const [created] = ctx.listeners['agent/created']
  const agent = fakeAgent()
  await created({ agent, source: 'resume', signal: live() })
  assert.equal(agent.injected.length, 1)
  assert.match(agent.injected[0].content[0].text, /remember X/)
  assert.notEqual(agent.injected[0].source.kind, 'user')
  assert.equal(JSON.parse(readFileSync(join(root, 'in.json'), 'utf8')).source, 'resume')
  const sub = fakeAgent([], { origin: 'subagent' })
  await created({ agent: sub, source: 'startup', signal: live() })
  assert.equal(sub.injected.length, 0)
})

test('UserPromptSubmit block keeps the prompt out of the step', async () => {
  const root = fixture({
    '.claude-plugin/plugin.json': '{"name":"ups"}',
    'hooks/hooks.json': JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'cat >/dev/null; echo secret found >&2; exit 2' }] }] } }),
  })
  const ctx = fakeCtx()
  createPlugin({ root }).apply(ctx, {})
  const decision = await ctx.listeners['agent/pre-step'][0]({ agent: fakeAgent(), messages: [], signal: live() }, async () => ({ kind: 'enter', messages: [userMsg('my password is hunter2')] }))
  assert.equal(decision.messages.length, 1)
  assert.doesNotMatch(decision.messages[0].content[0].text, /hunter2/)
  assert.match(decision.messages[0].content[0].text, /secret found/)
})

test('Stop hook block steers once, then stop_hook_active ends the loop', async () => {
  const root = fixture({
    '.claude-plugin/plugin.json': '{"name":"st"}',
    'hooks/stop.sh': '#!/bin/sh\nif grep -q \'"stop_hook_active":true\'; then exit 0; fi\nprintf \'{"decision":"block","reason":"write the handoff"}\'\n',
    'hooks/hooks.json': JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'sh "${CLAUDE_PLUGIN_ROOT}/hooks/stop.sh"' }] }] } }),
  })
  const ctx = fakeCtx()
  createPlugin({ root }).apply(ctx, {})
  const [stop] = ctx.listeners['agent/turn-stopping']
  const agent = fakeAgent()
  await stop({ agent, turn: 1, signal: live() })
  assert.equal(agent.steered.length, 1)
  assert.match(agent.steered[0].content[0].text, /write the handoff/)
  await stop({ agent, turn: 1, signal: live() })
  assert.equal(agent.steered.length, 1)
})

test('hook-injected context is not a user prompt and stays out of the transcript', async () => {
  const root = fixture({
    '.claude-plugin/plugin.json': '{"name":"loop"}',
    'hooks/hooks.json': JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'cat >/dev/null; echo ctx' }] }] } }),
  })
  const ctx = fakeCtx()
  createPlugin({ root }).apply(ctx, {})
  const decision = await ctx.listeners['agent/pre-step'][0](
    { agent: fakeAgent(), messages: [], signal: live() },
    async () => ({ kind: 'enter', messages: [userMsg('real prompt')] }),
  )
  const injected = decision.messages[1]
  assert.notEqual(injected.source.kind, 'user')
  const transcript = toClaudeTranscript([{ type: 'user/message', time: 0, data: injected }], 's', '/w')
  assert.equal(transcript, '')
})

test('subagent sessions fire SubagentStop, not Stop', async () => {
  const root = fixture({
    '.claude-plugin/plugin.json': '{"name":"sub"}',
    'hooks/hooks.json': JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'cat >/dev/null; printf \'{"decision":"block","reason":"x"}\'' }] }] } }),
  })
  const ctx = fakeCtx()
  createPlugin({ root }).apply(ctx, {})
  const agent = fakeAgent([], { origin: 'subagent' })
  await ctx.listeners['agent/turn-stopping'][0]({ agent, turn: 1, signal: live() })
  assert.equal(agent.steered.length, 0)
})

test('hook result exposes updatedInput without inventing a decision', () => {
  const out = interpretHookResult({ code: 0, stdout: '{"hookSpecificOutput":{"updatedInput":{"command":"safe"}}}', stderr: '' }, 'PreToolUse')
  assert.deepEqual(out.updatedInput, { command: 'safe' })
  assert.equal(out.decision, undefined)
})

test('PreToolUse denies rather than run arguments a hook rewrote', async () => {
  const root = fixture({
    '.claude-plugin/plugin.json': '{"name":"rewrite"}',
    'hooks/hooks.json': JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `cat >/dev/null; printf '{"hookSpecificOutput":{"permissionDecision":"allow","updatedInput":{"command":"safe"}}}'` }] }] } }),
  })
  const ctx = fakeCtx()
  createPlugin({ root }).apply(ctx, {})
  let called = false
  const decision = await ctx.listeners['tools/pre-execute'][0](
    { name: 'bash', arguments: { command: 'rm -rf /' }, callId: 'c1', agent: fakeAgent() },
    async () => {
      called = true
      return { kind: 'allow' }
    },
  )
  assert.equal(decision.kind, 'deny')
  assert.match(decision.reason, /updatedInput/)
  assert.equal(called, false)
})

test('PreToolUse allow hides an approval prompt but not a deny', async () => {
  const root = fixture({
    '.claude-plugin/plugin.json': '{"name":"ok"}',
    'hooks/hooks.json': JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `cat >/dev/null; printf '{"hookSpecificOutput":{"permissionDecision":"allow"}}'` }] }] } }),
  })
  const ctx = fakeCtx()
  createPlugin({ root }).apply(ctx, {})
  const pre = ctx.listeners['tools/pre-execute'][0]
  const exec = { name: 'bash', arguments: { command: 'ls' }, callId: 'c1', agent: fakeAgent() }
  assert.deepEqual(await pre(exec, async () => ({ kind: 'ask', reason: 'sure?' })), { kind: 'allow' })
  assert.deepEqual(await pre(exec, async () => ({ kind: 'deny', reason: 'no' })), { kind: 'deny', reason: 'no' })
})

test('PostToolUse blocks through tools/post-execute and sees Claude tool_response', async () => {
  const root = fixture({
    '.claude-plugin/plugin.json': '{"name":"post"}',
    'hooks/post.sh': '#!/bin/sh\ncat > "$CLAUDE_PLUGIN_ROOT/post-input.json"\necho "lint failed" >&2\nexit 2\n',
    'hooks/hooks.json': JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'sh "${CLAUDE_PLUGIN_ROOT}/hooks/post.sh"' }] }] } }),
  })
  const ctx = fakeCtx()
  createPlugin({ root }).apply(ctx, {})
  const agent = fakeAgent()
  const decision = await ctx.listeners['tools/post-execute'][0](
    { name: 'bash', arguments: { command: 'git push' }, callId: 'c1', agent },
    { isError: false, content: [{ type: 'text', text: 'pushed' }] },
    async () => ({ kind: 'accept' }),
  )
  assert.deepEqual(decision, { kind: 'block', feedback: [{ type: 'text', text: 'lint failed' }] })
  const input = JSON.parse(readFileSync(join(root, 'post-input.json'), 'utf8'))
  assert.equal(input.tool_name, 'Bash')
  assert.equal(input.tool_input.command, 'git push')
  assert.equal(input.tool_response.stdout, 'pushed')
  assert.equal(input.tool_response.stderr, '')
  assert.equal(input.tool_response.interrupted, false)
})

test('PostToolUse context rides on the decision, not agent.inject', async () => {
  const root = fixture({
    '.claude-plugin/plugin.json': '{"name":"ctx"}',
    'hooks/hooks.json': JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command: `cat > "$CLAUDE_PLUGIN_ROOT/read-input.json"; printf '{"hookSpecificOutput":{"additionalContext":"remember this"}}'` }] }] } }),
  })
  const ctx = fakeCtx()
  createPlugin({ root }).apply(ctx, {})
  const agent = fakeAgent()
  const decision = await ctx.listeners['tools/post-execute'][0](
    { name: 'read', arguments: { file_path: '/tmp/a.txt' }, callId: 'c1', agent },
    { isError: false, content: [{ type: 'text', text: 'file body' }] },
    async () => ({ kind: 'accept' }),
  )
  assert.equal(decision.kind, 'accept')
  assert.equal(decision.additionalContexts.length, 1)
  assert.match(decision.additionalContexts[0].content[0].text, /remember this/)
  assert.equal(agent.injected.length, 0)
  const input = JSON.parse(readFileSync(join(root, 'read-input.json'), 'utf8'))
  assert.deepEqual(input.tool_response, { type: 'text', file: { filePath: '/tmp/a.txt', content: 'file body' } })
})


test('tool_response follows Claude Code shapes per tool', () => {
  const content = [{ type: 'text', text: 'body' }]
  assert.deepEqual(toClaudeToolResponse('bash', { command: 'ls' }, { isError: false, content }), {
    stdout: 'body',
    stderr: '',
    interrupted: false,
    isImage: false,
  })
  assert.deepEqual(toClaudeToolResponse('write', { file_path: '/a', content: 'x' }, { isError: false, content }), {
    type: 'update',
    filePath: '/a',
    content: 'x',
    originalFile: null,
  })
  assert.deepEqual(toClaudeToolResponse('edit', { file_path: '/a', old_string: 'x', new_string: 'y' }, { isError: false, content }), {
    filePath: '/a',
    oldString: 'x',
    newString: 'y',
  })
  assert.deepEqual(toClaudeToolResponse('glob', {}, { isError: false, content: [{ type: 'text', text: 'a\nb\n' }] }), {
    filenames: ['a', 'b'],
    durationMs: 0,
    numFiles: 2,
    truncated: false,
  })
})

test('exec-form hooks pass args without a shell and expand the plugin root per element', async () => {
  // A root with a space, `$`, a quote and a backtick would break any shell-joined command line.
  const root = mkdtempSync(join(tmpdir(), "claude compat $HOME 'q' `x`-"))
  mkdirSync(join(root, '.claude-plugin'))
  mkdirSync(join(root, 'hooks'))
  writeFileSync(join(root, '.claude-plugin/plugin.json'), '{"name":"exec"}')
  writeFileSync(join(root, 'hooks/argv.sh'), 'cat >/dev/null; printf "%s\\n" "$@" > "$CLAUDE_PLUGIN_ROOT/argv.txt"; echo "denied by argv" >&2; exit 2\n')
  const hooks = [{ type: 'command', command: '/bin/sh', args: ['${CLAUDE_PLUGIN_ROOT}/hooks/argv.sh', 'pre-tool', '$(touch pwned) ; *'] }]
  writeFileSync(join(root, 'hooks/hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'WebFetch', hooks }] } }))
  const ctx = fakeCtx()
  createPlugin({ root }).apply(ctx, {})
  const cwd = mkdtempSync(join(tmpdir(), 'claude-compat-cwd-'))
  const decision = await ctx.listeners['tools/pre-execute'][0]({ name: 'web_fetch', arguments: { url: 'https://x' }, callId: 'c', agent: fakeAgent([], { cwd }) }, async () => ({ kind: 'allow' }))
  assert.deepEqual(decision, { kind: 'deny', reason: 'denied by argv' })
  assert.deepEqual(readFileSync(join(root, 'argv.txt'), 'utf8').split('\n').slice(0, -1), ['pre-tool', '$(touch pwned) ; *'])
  assert.equal(existsSync(join(cwd, 'pwned')), false)
})

test('onFailure "block" turns a failed PreToolUse hook into a deny; the default does not', async () => {
  const decide = async (hook) => {
    const root = fixture({
      '.claude-plugin/plugin.json': '{"name":"fail"}',
      'hooks/hooks.json': JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', ...hook }] }] } }),
    })
    const ctx = fakeCtx()
    createPlugin({ root }).apply(ctx, {})
    return ctx.listeners['tools/pre-execute'][0]({ name: 'web_search', arguments: {}, callId: 'c', agent: fakeAgent() }, async () => ({ kind: 'allow' }))
  }
  const exit1 = { command: '/bin/sh', args: ['-c', 'cat >/dev/null; echo broken >&2; exit 1'] }
  assert.deepEqual(await decide(exit1), { kind: 'allow' })
  const blocked = await decide({ ...exit1, onFailure: 'block' })
  assert.equal(blocked.kind, 'deny')
  assert.match(blocked.reason, /broken/)
  assert.equal((await decide({ command: 'definitely-not-a-program-xyz', args: [], onFailure: 'block' })).kind, 'deny')
  assert.equal((await decide({ command: 'sleep 30', timeout: 1, onFailure: 'block' })).kind, 'deny')
  assert.deepEqual(await decide({ ...exit1, onFailure: 'continue' }), { kind: 'allow' })
})

test('a failed tool runs PostToolUseFailure, not PostToolUse', async () => {
  const root = fixture({
    '.claude-plugin/plugin.json': '{"name":"fail"}',
    'hooks/hooks.json': JSON.stringify({
      hooks: {
        PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'cat > "$CLAUDE_PLUGIN_ROOT/post-ran.json"; echo "should not block" >&2; exit 2' }] }],
        PostToolUseFailure: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: `cat > "$CLAUDE_PLUGIN_ROOT/failure-input.json"; printf '{"hookSpecificOutput":{"hookEventName":"PostToolUseFailure","additionalContext":"retry with --force"}}'` }],
          },
        ],
      },
    }),
  })
  const ctx = fakeCtx()
  createPlugin({ root }).apply(ctx, {})
  const agent = fakeAgent()
  const decision = await ctx.listeners['tools/post-execute'][0](
    { name: 'bash', arguments: { command: 'git push' }, callId: 'c9', agent },
    { isError: true, content: [{ type: 'text', text: 'rejected: non-fast-forward' }] },
    async () => ({ kind: 'accept' }),
  )
  assert.equal(existsSync(join(root, 'post-ran.json')), false, 'PostToolUse must not run for a failed tool')
  assert.equal(decision.kind, 'accept')
  assert.equal(decision.additionalContexts.length, 1)
  assert.match(decision.additionalContexts[0].content[0].text, /event="PostToolUseFailure"[\s\S]*retry with --force/)
  const input = JSON.parse(readFileSync(join(root, 'failure-input.json'), 'utf8'))
  assert.equal(input.hook_event_name, 'PostToolUseFailure')
  assert.equal(input.tool_name, 'Bash')
  assert.equal(input.tool_input.command, 'git push')
  assert.equal(input.tool_use_id, 'c9')
  assert.equal(input.error, 'rejected: non-fast-forward')
  assert.equal(input.tool_response, undefined)
})

test('a successful tool does not run PostToolUseFailure', async () => {
  const root = fixture({
    '.claude-plugin/plugin.json': '{"name":"ok"}',
    'hooks/hooks.json': JSON.stringify({ hooks: { PostToolUseFailure: [{ hooks: [{ type: 'command', command: 'cat > "$CLAUDE_PLUGIN_ROOT/ran.json"' }] }] } }),
  })
  const ctx = fakeCtx()
  createPlugin({ root }).apply(ctx, {})
  const decision = await ctx.listeners['tools/post-execute'][0](
    { name: 'bash', arguments: { command: 'ls' }, callId: 'c1', agent: fakeAgent() },
    { isError: false, content: [{ type: 'text', text: 'a' }] },
    async () => ({ kind: 'accept' }),
  )
  assert.deepEqual(decision, { kind: 'accept' })
  assert.equal(existsSync(join(root, 'ran.json')), false)
})

test('hooks get a persistent CLAUDE_PLUGIN_DATA directory', async () => {
  const root = fixture({
    '.claude-plugin/plugin.json': '{"name":"Data Plugin"}',
    'hooks/hooks.json': JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: 'printf %s "$CLAUDE_PLUGIN_DATA" > "$CLAUDE_PLUGIN_ROOT/shell.txt"' }] },
          { hooks: [{ type: 'command', command: 'node', args: ['-e', 'require("fs").writeFileSync(process.argv[1] + "/exec.txt", process.argv[2])', '${CLAUDE_PLUGIN_ROOT}', '${CLAUDE_PLUGIN_DATA}'] }] },
        ],
      },
    }),
  })
  const ctx = fakeCtx()
  createPlugin({ root, env: { CACHE_DIR: '${CLAUDE_PLUGIN_DATA}/cache' } }).apply(ctx, {})
  const agent = fakeAgent()
  await ctx.listeners['agent/created'][0]({ agent, source: 'startup' })
  const expected = join(process.env.DSH_HOME, 'state', 'claude-compat', 'plugin-data', 'data-plugin')
  assert.equal(readFileSync(join(root, 'shell.txt'), 'utf8'), expected)
  assert.equal(readFileSync(join(root, 'exec.txt'), 'utf8'), expected)
  assert.ok(statSync(expected).isDirectory())
})

// ---- Claude Code plugin parity: userConfig, manifest component paths, SubagentStart, PreCompact, bin/

const skillsOf = async (ctx) => (await ctx.providers[0].list()).map((c) => c.name).sort()
const skillText = async (ctx, name) => {
  const candidate = (await ctx.providers[0].list()).find((c) => c.name === name)
  return (await ctx.providers[0].get(candidate)).content
}

test('userConfig values reach hooks as CLAUDE_PLUGIN_OPTION_* and ${user_config.*}, sensitive ones stay out of content', async () => {
  const root = fixture({
    '.claude-plugin/plugin.json': JSON.stringify({
      name: 'cfg',
      userConfig: {
        api_url: { type: 'string', title: 'API', description: 'API URL', default: 'https://default.example' },
        api_token: { type: 'string', title: 'Token', description: 'Token', sensitive: true, required: true },
        regions: { type: 'string', title: 'Regions', description: 'Regions', multiple: true },
      },
    }),
    'skills/use/SKILL.md': '---\nname: use\ndescription: use it\n---\nCall ${user_config.api_url} with ${user_config.api_token}.',
    'hooks/hooks.json': JSON.stringify({
      hooks: {
        SessionStart: [
          {
            hooks: [
              { type: 'command', command: 'printf "%s|%s|%s" "$CLAUDE_PLUGIN_OPTION_API_URL" "$CLAUDE_PLUGIN_OPTION_API_TOKEN" "$CLAUDE_PLUGIN_OPTION_REGIONS" > "$CLAUDE_PLUGIN_ROOT/shell.txt"' },
              { type: 'command', command: '/bin/sh', args: ['-c', 'printf "%s" "$1" > "$0"', '${CLAUDE_PLUGIN_ROOT}/exec.txt', '${user_config.api_token}'] },
            ],
          },
        ],
      },
    }),
  })
  const ctx = fakeCtx()
  createPlugin({ root }).apply(ctx, { options: { api_token: 's3cret', regions: ['eu', 'us'] } })
  await ctx.listeners['agent/created'][0]({ agent: fakeAgent(), source: 'startup', signal: live() })
  assert.equal(readFileSync(join(root, 'shell.txt'), 'utf8'), 'https://default.example|s3cret|eu,us')
  assert.equal(readFileSync(join(root, 'exec.txt'), 'utf8'), 's3cret')
  const content = await skillText(ctx, 'use')
  assert.match(content, /Call https:\/\/default\.example with /)
  assert.doesNotMatch(content, /s3cret/)

  const missing = fakeCtx()
  createPlugin({ root }).apply(missing, {})
  assert.ok(missing.warnings.some((w) => /api_token/.test(w) && /required/.test(w)))
})

test('manifest component paths: commands and agents replace defaults, skills add, hooks merge', async () => {
  const root = fixture({
    '.claude-plugin/plugin.json': JSON.stringify({
      name: 'paths',
      commands: { status: { source: './extra/status.md', argumentHint: '[env]' }, about: { content: 'Explain $ARGUMENTS.', description: 'About it' } },
      agents: ['./custom/review/security.md'],
      skills: ['./more-skills/'],
      hooks: './config/hooks.json',
    }),
    'commands/ignored.md': '---\ndescription: default dir\n---\nignored',
    'extra/status.md': '---\ndescription: Status\n---\nStatus for $ARGUMENTS',
    'agents/ignored.md': '---\ndescription: default agent\n---\nignored',
    'custom/review/security.md': '---\ndescription: Security review\n---\nReview it.',
    'skills/base/SKILL.md': '---\ndescription: base skill\n---\nbase',
    'more-skills/extra/SKILL.md': '---\ndescription: extra skill\n---\nextra',
    'hooks/hooks.json': JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo from-default' }] }] } }),
    'config/hooks.json': JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo from-manifest' }] }] } }),
  })
  const ctx = fakeCtx()
  createPlugin({ root }).apply(ctx, {})
  assert.deepEqual(ctx.commandDefs.map((d) => d.name).sort(), ['paths-about', 'paths-status'])
  assert.deepEqual(await skillsOf(ctx), ['base', 'extra', 'paths-agent-security'])
  const agent = fakeAgent()
  await ctx.listeners['agent/created'][0]({ agent, source: 'startup', signal: live() })
  const text = agent.injected.map((m) => m.content[0].text).join('\n')
  assert.match(text, /from-default/)
  assert.match(text, /from-manifest/)
})

test('a manifest hooks path naming the default file loads it once', async () => {
  const root = fixture({
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'dup', hooks: './hooks/hooks.json' }),
    'hooks/hooks.json': JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo once' }] }] } }),
  })
  const ctx = fakeCtx()
  createPlugin({ root }).apply(ctx, {})
  const agent = fakeAgent()
  await ctx.listeners['agent/created'][0]({ agent, source: 'startup', signal: live() })
  assert.equal(agent.injected[0].content[0].text.match(/once/g).length, 1)
})

test('root SKILL.md loads as one skill and agent subfolders join the agent name', async () => {
  const root = fixture({
    '.claude-plugin/plugin.json': '{"name":"solo"}',
    'SKILL.md': '---\ndescription: the whole plugin\n---\nroot skill',
    'agents/review/security.md': '---\ndescription: Security review\n---\nReview it.',
    'agents/plain.md': '---\ndescription: Plain\n---\nplain',
  })
  const ctx = fakeCtx()
  createPlugin({ root }).apply(ctx, {})
  assert.deepEqual(await skillsOf(ctx), ['solo', 'solo-agent-plain', 'solo-agent-review-security'])
  assert.match(await skillText(ctx, 'solo'), /root skill/)
})

test('SubagentStart fires for subagents with agent_id and agent_type, context goes to the child', async () => {
  const root = fixture({
    '.claude-plugin/plugin.json': '{"name":"subs"}',
    'hooks/hooks.json': JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'echo root-only' }] }],
        SubagentStart: [{ matcher: 'explore', hooks: [{ type: 'command', command: 'cat > "$CLAUDE_PLUGIN_ROOT/sub.json"; printf \'{"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":"child rules"}}\'' }] }],
      },
    }),
  })
  const ctx = fakeCtx()
  createPlugin({ root }).apply(ctx, {})
  const created = ctx.listeners['agent/created']
  const child = fakeAgent([], { id: 'child-1', origin: 'subagent', agentPreset: 'explore' })
  for (const listener of created) await listener({ agent: child, source: 'startup', signal: live() })
  assert.equal(child.injected.length, 1)
  assert.match(child.injected[0].content[0].text, /child rules/)
  const input = JSON.parse(readFileSync(join(root, 'sub.json'), 'utf8'))
  assert.equal(input.hook_event_name, 'SubagentStart')
  assert.equal(input.agent_id, 'child-1')
  assert.equal(input.agent_type, 'explore')
  const other = fakeAgent([], { id: 'child-2', origin: 'subagent', agentPreset: 'plan' })
  for (const listener of created) await listener({ agent: other, source: 'startup', signal: live() })
  assert.equal(other.injected.length, 0)
})

test('PreCompact fires when the session log records compaction/start', async () => {
  const root = fixture({
    '.claude-plugin/plugin.json': '{"name":"pc"}',
    'hooks/hooks.json': JSON.stringify({ hooks: { PreCompact: [{ matcher: 'manual', hooks: [{ type: 'command', command: 'cat > "$CLAUDE_PLUGIN_ROOT/pc.json"' }] }] } }),
  })
  const ctx = fakeCtx()
  createPlugin({ root }).apply(ctx, {})
  assert.equal(ctx.listeners['session/event']?.length, 1, 'PreCompact needs a session/event listener')
  const [onEvent] = ctx.listeners['session/event']
  const session = fakeAgent().session
  onEvent(session, { type: 'assistant/message', data: { message: { content: [] } } })
  onEvent(session, { type: 'compaction/start', data: { compactionId: 'c1', turn: 3 } })
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(existsSync(join(root, 'pc.json')), false, 'auto compaction does not match the manual matcher')
  onEvent(session, { type: 'compaction/start', data: { compactionId: 'c2', sourceCommandId: 'cmd-1', turn: 3 } })
  for (let i = 0; i < 50 && !existsSync(join(root, 'pc.json')); i++) await new Promise((r) => setTimeout(r, 50))
  const input = JSON.parse(readFileSync(join(root, 'pc.json'), 'utf8'))
  assert.equal(input.hook_event_name, 'PreCompact')
  assert.equal(input.trigger, 'manual')
  assert.equal(input.custom_instructions, null)
  assert.equal(input.session_id, 'sess-1')
})

test('bin/ is appended to PATH while the plugin is applied and removed on dispose', () => {
  const root = fixture({ '.claude-plugin/plugin.json': '{"name":"tools"}', 'bin/hello-tool.sh': '#!/bin/sh\necho hi' })
  const before = process.env.PATH
  const disposers = []
  const ctx = fakeCtx({ effect: (fn) => disposers.push(fn()) })
  createPlugin({ root }).apply(ctx, {})
  const entries = process.env.PATH.split(':')
  assert.equal(entries.at(-1), join(root, 'bin'))
  assert.equal(entries.slice(0, -1).join(':'), before)
  for (const dispose of disposers) dispose?.()
  assert.equal(process.env.PATH, before)
})
