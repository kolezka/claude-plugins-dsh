// Reading a Claude Code plugin tree: manifest, skills, commands, agents, hooks.json,
// and the text transforms applied to what is read.
import { readdirSync, readFileSync, type Dirent } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

export const DEFAULT_HOOK_TIMEOUT_S = 60

export type FrontMatter = Record<string, string>

export interface PluginManifest {
  name: string
  version?: string
  description?: string
  [key: string]: unknown
}

export interface SkillFile {
  name: string
  description: string
  path: string
  base: string
  meta: FrontMatter
}

export interface CommandFile {
  stem: string
  name: string
  description: string
  hint: string
  body: string
  path: string
}

export interface AgentFile {
  name: string
  description: string
  tools: string
  model: string
  body: string
  path: string
}

export interface HookSpec {
  event: string
  matcher: string
  command: string
  /** Seconds. */
  timeout: number
}

export interface SkillOptions {
  exclude?: string[]
  /** Renames `x` to `<prefix>-x`. Empty keeps bare names. */
  prefix?: string
}

export interface CommandOptions {
  exclude?: string[]
  /** DSH command prefix; defaults to the plugin name. Empty gives bare `/<name>`. */
  prefix?: string
}

export interface AgentOptions {
  exclude?: string[]
  /** Extra root-relative directories holding agent markdown files. */
  extraDirs?: string[]
}

/** Split YAML-ish front matter from a markdown file. Only flat `key: value` lines are read. */
export function parseFrontMatter(text: string): { meta: FrontMatter; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!match) return { meta: {}, body: text }
  const meta: FrontMatter = {}
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!kv || kv[1] === undefined || kv[2] === undefined) continue
    const raw = kv[2].trim()
    let value = raw
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
      if (raw.startsWith('"')) value = value.replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    }
    meta[kv[1]] = value
  }
  return { meta, body: text.slice(match[0].length) }
}

// A marker counts only on a line of its own, optionally after heading hashes (`## <!--/harness-->`).
const CLAUDE_ONLY_OPEN = /^\s*(?:#+\s*)?<!--\s*harness:claude-only\s*-->\s*$/
const CLAUDE_ONLY_CLOSE = /^\s*(?:#+\s*)?<!--\s*\/harness\s*-->\s*$/

/**
 * Remove `<!--harness:claude-only--> ... <!--/harness-->` blocks.
 * An opener without a closer drops the rest of the file, so Claude-only text never leaks.
 */
export function stripClaudeOnlyBlocks(text: string): { text: string; unterminated: boolean } {
  const out: string[] = []
  let inside = false
  for (const line of text.split(/(?<=\n)/)) {
    const bare = line.replace(/\r?\n$/, '')
    if (!inside && CLAUDE_ONLY_OPEN.test(bare)) inside = true
    else if (inside && CLAUDE_ONLY_CLOSE.test(bare)) inside = false
    else if (!inside) out.push(line)
  }
  return { text: out.join(''), unterminated: inside }
}

export const stripClaudeOnly = (text: string): string => stripClaudeOnlyBlocks(text).text

/** Keep hook text from closing the tag it is wrapped in. */
export const escapeClosingTag = (text: string, tag: string): string => String(text).replaceAll(`</${tag}`, `<\\/${tag}`)

/** Replace the Claude plugin root variables with the real plugin directory. */
export function expandPluginRoot(text: string, root: string): string {
  return text.replaceAll('${CLAUDE_PLUGIN_ROOT}', root).replaceAll('$CLAUDE_PLUGIN_ROOT', root)
}

export const kebab = (value: unknown): string =>
  String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

export function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

function listDir(path: string): Dirent[] {
  try {
    return readdirSync(path, { withFileTypes: true })
  } catch {
    return []
  }
}

/** Read the plugin manifest; the plugin name falls back to the directory name. */
export function readManifest(root: string): PluginManifest {
  const raw = readText(join(root, '.claude-plugin', 'plugin.json'))
  const manifest = (raw ? JSON.parse(raw) : {}) as Partial<PluginManifest>
  return { ...manifest, name: manifest.name || basename(root) }
}

/** Skill directories: `skills/<name>/SKILL.md`. */
export function discoverSkills(root: string, options: SkillOptions = {}): SkillFile[] {
  const dir = join(root, 'skills')
  const skip = new Set(options.exclude ?? [])
  const out: SkillFile[] = []
  for (const entry of listDir(dir)) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    if (skip.has(entry.name)) continue
    const path = join(dir, entry.name, 'SKILL.md')
    const text = readText(path)
    if (text === undefined) continue
    const { meta } = parseFrontMatter(text)
    const bare = kebab(meta.name || entry.name)
    if (!bare || !meta.description) continue
    const name = options.prefix ? `${options.prefix}-${bare}` : bare
    out.push({ name, description: meta.description, path, base: dirname(path), meta })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** Command files: `commands/<name>.md`. */
export function discoverCommands(root: string, options: CommandOptions = {}): CommandFile[] {
  const dir = join(root, 'commands')
  const skip = new Set(options.exclude ?? [])
  const out: CommandFile[] = []
  for (const entry of listDir(dir)) {
    if (!entry.name.endsWith('.md')) continue
    const stem = entry.name.slice(0, -3)
    if (skip.has(stem)) continue
    const path = join(dir, entry.name)
    const text = readText(path)
    if (text === undefined) continue
    const { meta, body } = parseFrontMatter(text)
    out.push({ stem, name: kebab(meta.name || stem), description: meta.description || stem, hint: meta['argument-hint'] || '', body, path })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** Agent definitions: `agents/<name>.md` plus any extra directories the bundle lists. */
export function discoverAgents(root: string, options: AgentOptions = {}): AgentFile[] {
  const dirs = [join(root, 'agents'), ...(options.extraDirs ?? []).map((d) => resolve(root, d))]
  const skip = new Set(options.exclude ?? [])
  const out: AgentFile[] = []
  const seen = new Set<string>()
  for (const dir of dirs) {
    for (const entry of listDir(dir)) {
      if (!entry.name.endsWith('.md')) continue
      const path = join(dir, entry.name)
      const text = readText(path)
      if (text === undefined) continue
      const { meta, body } = parseFrontMatter(text)
      const name = kebab(meta.name || entry.name.slice(0, -3))
      if (skip.has(name) || seen.has(name) || !meta.description) continue
      seen.add(name)
      out.push({ name, description: meta.description, tools: meta.tools || '', model: meta.model || '', body, path })
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

interface HooksJson {
  hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ type?: string; command?: string; timeout?: number }> }> | undefined>
}

/** hooks/hooks.json command hooks, flattened. Function-hook `modules` are Claude-only and skipped. */
export function readHooks(root: string): HookSpec[] {
  const raw = readText(join(root, 'hooks', 'hooks.json'))
  if (!raw) return []
  const hooks = (JSON.parse(raw) as HooksJson).hooks ?? {}
  const out: HookSpec[] = []
  for (const [event, groups] of Object.entries(hooks)) {
    for (const group of groups ?? []) {
      for (const hook of group.hooks ?? []) {
        if (hook.type !== 'command' || !hook.command) continue
        out.push({ event, matcher: group.matcher ?? '', command: hook.command, timeout: hook.timeout ?? DEFAULT_HOOK_TIMEOUT_S })
      }
    }
  }
  return out
}

/** A Claude Code matcher: empty or `*` matches all, otherwise an anchored regex (`Bash`, `Skill|Agent|Task`). */
export function matcherMatches(matcher: string, toolName: string): boolean {
  if (!matcher || matcher === '*') return true
  try {
    return new RegExp(`^(?:${matcher})$`).test(toolName)
  } catch {
    return matcher === toolName
  }
}

/** Expand `$ARGUMENTS`, `$1..$9` and `${CLAUDE_PLUGIN_ROOT}` in a command body. */
export function renderCommand(body: string, rawInput: string, root: string): string {
  const args = rawInput.trim()
  const positional = args ? args.split(/\s+/) : []
  let text = expandPluginRoot(body, root)
  const usesArgs = /\$ARGUMENTS|\$[1-9]/.test(text)
  // One pass with a function: user text is never re-scanned or read as a replacement pattern.
  text = text.replace(/\$(ARGUMENTS|[1-9])/g, (_, key: string) => (key === 'ARGUMENTS' ? args : (positional[Number(key) - 1] ?? '')))
  if (!usesArgs && args) text += `\n\nArguments: ${args}`
  return text
}
