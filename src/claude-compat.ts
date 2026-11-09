// Public API. The build bundles this entry into one dependency-free file
// so existing adapters can keep vendoring dsh/claude-compat.js.
export { createPlugin, rootFrom, COMPAT_VERSION, SKILL_RANK } from './plugin.js'
export type { PluginSpec, RowConfig, Part, DshPlugin } from './plugin.js'
export * from './plugin-files.js'
export { runHook, interpretHookResult } from './hooks.js'
export type { HookRunResult, HookOutcome } from './hooks.js'
export { TOOL_NAME_MAP, toClaudeTranscript, toClaudeToolInput, toClaudeToolResponse, claudeToolName } from './transcript.js'
export type * from './dsh-types.js'
