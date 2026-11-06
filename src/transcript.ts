// DSH session log -> Claude Code transcript JSONL, the format hook scripts read
// through `transcript_path`.
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Agent, ContentBlock, Session, SessionEvent, UserMessage } from './dsh-types.js'

// DSH tool name -> Claude Code tool name, for matchers and tool_name in hook input.
export const TOOL_NAME_MAP: Readonly<Record<string, string>> = {
  bash: 'Bash',
  read: 'Read',
  read_image: 'Read',
  write: 'Write',
  edit: 'Edit',
  str_replace_based_edit_tool: 'Edit',
  glob: 'Glob',
  grep: 'Grep',
  web_fetch: 'WebFetch',
  web_search: 'WebSearch',
  skill: 'Skill',
  subagent: 'Agent',
  subagent_fork: 'Agent',
  spawn_teammate: 'Agent',
  todo_write: 'TodoWrite',
  ask_user_question: 'AskUserQuestion',
}

export const claudeToolName = (dshName: string): string => TOOL_NAME_MAP[dshName] ?? dshName

export type ToolInput = Record<string, unknown>

export function textOf(message: { content?: readonly ContentBlock[] } | undefined): string {
  return (message?.content ?? [])
    .filter((b): b is { type: 'text'; text: string } => b?.type === 'text' && typeof (b as { text?: unknown }).text === 'string' && (b as { text: string }).text !== '')
    .map((b) => b.text)
    .join('\n')
}

export function parseArguments(raw: unknown): ToolInput {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'string') return raw as ToolInput
  try {
    return JSON.parse(raw) as ToolInput
  } catch {
    return { raw }
  }
}

/** DSH tool arguments -> Claude Code `tool_input` shape. */
export function toClaudeToolInput(dshName: string, args: ToolInput | undefined): ToolInput {
  const input: ToolInput = { ...(args ?? {}) }
  if (dshName === 'glob' || dshName === 'grep') {
    if (input.include && !input.glob) input.glob = input.include
  }
  if (dshName === 'subagent' || dshName === 'subagent_fork' || dshName === 'spawn_teammate') {
    if (input.description === undefined && input.name) input.description = input.name
    if (input.subagent_type === undefined) input.subagent_type = input.name ?? 'general-purpose'
  }
  if (dshName === 'skill' && input.name && input.skill === undefined) input.skill = input.name
  return input
}

type TranscriptBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: ToolInput }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error: boolean }

interface TranscriptLine {
  type: 'user' | 'assistant'
  uuid: string
  sessionId: string
  cwd: string
  timestamp: string
  message: { role: 'user' | 'assistant'; content: string | TranscriptBlock[] }
}

const isUserMessageEvent = (e: SessionEvent): e is Extract<SessionEvent, { type: 'user/message' }> & { data: UserMessage } => e.type === 'user/message'

/**
 * Export DSH session events as Claude Code transcript JSONL records:
 * `{type:"user"|"assistant", message:{role, content:[...]}, sessionId, timestamp, cwd}`.
 * Tool calls become `tool_use` blocks with Claude tool names; results become `tool_result`.
 */
export function toClaudeTranscript(events: readonly SessionEvent[], sessionId: string, cwd: string): string {
  const lines: TranscriptLine[] = []
  const stamp = (event: SessionEvent): string => new Date(event.time ?? Date.now()).toISOString()
  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    if (isUserMessageEvent(event)) {
      const message = event.data
      if (message?.source?.kind !== 'user') continue
      const text = textOf(message)
      if (!text) continue
      lines.push({ type: 'user', uuid: randomUUID(), sessionId, cwd, timestamp: stamp(event), message: { role: 'user', content: text } })
    } else if (event.type === 'assistant/message') {
      const message = (event.data as { message?: { content?: readonly ContentBlock[] } } | undefined)?.message
      if (!message) continue
      const content: TranscriptBlock[] = []
      for (const block of message.content ?? []) {
        if (block?.type === 'text' && 'text' in block && typeof block.text === 'string' && block.text) content.push({ type: 'text', text: block.text })
        else if (block?.type === 'tool-call') {
          const call = block as { id: string; name: string; arguments: string }
          content.push({ type: 'tool_use', id: call.id, name: claudeToolName(call.name), input: toClaudeToolInput(call.name, parseArguments(call.arguments)) })
        }
      }
      if (content.length) lines.push({ type: 'assistant', uuid: randomUUID(), sessionId, cwd, timestamp: stamp(event), message: { role: 'assistant', content } })
    } else if (event.type === 'tool/result') {
      const message = (event.data as { message?: { toolCallId?: string; content?: readonly ContentBlock[]; isError?: boolean } } | undefined)?.message
      if (!message?.toolCallId) continue
      lines.push({
        type: 'user',
        uuid: randomUUID(),
        sessionId,
        cwd,
        timestamp: stamp(event),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: message.toolCallId, content: textOf(message), is_error: message.isError === true }] },
      })
    }
  }
  return lines.map((line) => JSON.stringify(line)).join('\n') + (lines.length ? '\n' : '')
}

// The full log, fork-inherited prefix included, as Claude Code transcripts also carry it.
export function sessionEvents(session: Session): readonly SessionEvent[] {
  try {
    return session.snapshotEvents?.() ?? session.events ?? session.ownEvents?.() ?? []
  } catch {
    return []
  }
}

export function lastAssistantText(session: Session): string {
  const events = sessionEvents(session)
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type === 'assistant/message') return textOf((event.data as { message?: { content?: readonly ContentBlock[] } } | undefined)?.message)
  }
  return ''
}

function stateHome(): string {
  const base = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(base, 'state', 'claude-compat')
}

export function transcriptPath(agent: Agent): string {
  return join(stateHome(), 'transcripts', `${String(agent.session.header.id).replace(/[^A-Za-z0-9_-]/g, '')}.jsonl`)
}

// Exported event count per transcript path; the file only ever grows by the new tail.
const exported = new Map<string, number>()

/** Bring the Claude-shaped transcript up to date by appending events not yet written. */
export function syncTranscript(agent: Agent, cwd: string): string {
  const path = transcriptPath(agent)
  const events = sessionEvents(agent.session)
  let done = exported.get(path)
  if (done === undefined || done > events.length || !existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, '', { mode: 0o600 })
    done = 0
  }
  if (events.length > done) appendFileSync(path, toClaudeTranscript(events.slice(done), agent.session.header.id, cwd), { mode: 0o600 })
  exported.set(path, events.length)
  return path
}

export function dropTranscript(agent: Agent): void {
  const path = transcriptPath(agent)
  exported.delete(path)
  rmSync(path, { force: true })
}
