// The slice of the DeepSeek Harness (DSH) host API this package touches, declared
// structurally so the package does not pin a DSH version. Names and shapes follow the
// d.ts files shipped in @deepseek-ai/dsh-agent, dsh-tools, dsh-skill, dsh-commands,
// dsh-system-prompt, dsh-session and dsh-working-directory.

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ToolCallBlock {
  type: 'tool-call'
  id: string
  name: string
  /** Raw JSON string as produced by the model. */
  arguments: string
}

export type ContentBlock = TextBlock | ToolCallBlock | { type: string }

export interface MessageSource {
  kind: string
}

export interface UserMessage {
  id: string
  role: 'user'
  content: readonly ContentBlock[]
  source: MessageSource
}

export interface SessionHeader {
  id: string
  cwd?: string
  origin?: 'subagent'
}

export type SessionEvent =
  | { type: 'user/message'; seq?: number; time?: number; data: UserMessage }
  | { type: 'assistant/message'; seq?: number; time?: number; data: { message: { content: readonly ContentBlock[] } } }
  | { type: 'tool/result'; seq?: number; time?: number; data: { message: { toolCallId: string; content: readonly ContentBlock[]; isError?: boolean } } }
  | { type: string; seq?: number; time?: number; data?: unknown }

export interface Session {
  header: SessionHeader
  snapshotEvents?(): readonly SessionEvent[]
  ownEvents?(): readonly SessionEvent[]
  events?: readonly SessionEvent[]
}

export interface Agent {
  session: Session
  /** Queue context for the next step without waking the agent. */
  inject(message: UserMessage): void
  /** Steering for the nearest step; wakes an idle agent. */
  steer(message: UserMessage): void
  /** A new turn whose only message is this one. */
  followup(message: UserMessage): void
}

export type PreStepDecision = { kind: 'reject' } | { kind: 'enter'; messages: UserMessage[]; startsRequestSeries?: true }

export type PreToolDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'cancel' }
  | { kind: 'ask'; reason?: string; displayReason?: { en: string; [locale: string]: string } }

export interface ToolExecution {
  callId: string
  name: string
  arguments: unknown
  agent?: Agent
  signal?: AbortSignal
}

export interface ToolExecutionResult {
  isError: boolean
  content?: readonly ContentBlock[]
}

export type PostToolDecision =
  | { kind: 'accept'; content?: ContentBlock[]; value?: never; additionalContexts?: UserMessage[] }
  | { kind: 'accept'; value: unknown; content?: never; additionalContexts?: UserMessage[] }
  | { kind: 'block'; feedback: ContentBlock[]; additionalContexts?: UserMessage[] }

export type SkillSource = 'custom' | (string & {})

export interface SkillInvocationPolicy {
  modelInvocable: boolean
  userInvocable: boolean
}

export type SkillResourceBase =
  | { kind: 'directory'; path: string }
  | { kind: 'url'; url: string }
  | { kind: 'opaque'; description: string }

export interface SkillCandidate {
  name: string
  description: string
  whenToUse?: string
  invocation: SkillInvocationPolicy
  provider: string
  source: SkillSource
  path?: string
  resourceBase?: SkillResourceBase
  rank: number
  locator: unknown
}

export interface SkillDefinition {
  name: string
  description: string
  invocation: SkillInvocationPolicy
  provider: string
  source: SkillSource
  path?: string
  resourceBase?: SkillResourceBase
  content: string
}

export interface SkillLookupOptions {
  cwd?: string
  signal?: AbortSignal
}

export interface SkillProvider {
  name: string
  list(options: SkillLookupOptions): Promise<readonly SkillCandidate[]>
  get(candidate: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinition | undefined>
}

export interface SkillProviderControl {
  signal: AbortSignal
  invalidate(): void
}

export interface CommandInvocation {
  agent: Agent
  rawInput: string
}

export type CommandResult = { kind: 'success'; text?: string } | { kind: 'error'; text: string }

export interface CommandDefinition {
  name: string
  description: string
  input?: { hint?: string }
  handler(invocation: CommandInvocation): CommandResult | Promise<CommandResult>
}

export interface PromptSection {
  name: string
  order: number
  text: string | ((context: unknown) => string)
  interpolate?: boolean
}

export type SessionStartSource = 'startup' | 'resume' | 'clear' | 'compact'

/** Listener signatures for the events this package subscribes to. */
export interface HostEvents {
  'agent/created': (payload: { agent: Agent; source?: SessionStartSource; signal?: AbortSignal }) => undefined | Promise<undefined>
  'agent/pre-step': (
    payload: { agent: Agent; messages: UserMessage[]; turn?: number; step?: number; signal?: AbortSignal },
    next: () => Promise<PreStepDecision>,
  ) => Promise<PreStepDecision>
  'agent/turn-stopping': (payload: { agent: Agent; turn?: number; signal?: AbortSignal }) => undefined | Promise<undefined>
  'agent/disposed': (payload: { agent: Agent }) => void
  'tools/pre-execute': (exec: ToolExecution, next: () => Promise<PreToolDecision>) => Promise<PreToolDecision>
  'tools/post-execute': (exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>) => Promise<PostToolDecision>
  'tools/result': (exec: ToolExecution, result: ToolExecutionResult) => void
}

export type HostEventSubscriber = UnionToIntersection<{
  [K in keyof HostEvents]: (event: K, listener: HostEvents[K]) => unknown
}[keyof HostEvents]>

type UnionToIntersection<T> = (T extends unknown ? (value: T) => void : never) extends (value: infer I) => void ? I : never

export interface Logger {
  warn(message: string): void
}

/** A Cordis context, narrowed to what this package uses. Services are present only after `inject`. */
export interface HostContext {
  logger?: Logger
  skills?: { registerProvider(create: (control: SkillProviderControl) => SkillProvider): unknown }
  commands?: { register(definition: CommandDefinition): unknown }
  systemPrompt?: { section(section: PromptSection): unknown }
  workingDirectory?: { get(session: Session): string }
  inject(services: string[], callback: (ctx: HostContext) => void): unknown
  effect(execute: () => () => void): unknown
  on: HostEventSubscriber
}
