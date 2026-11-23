// Reading a Claude Code plugin tree: manifest, skills, commands, agents, hooks.json,
// and the text transforms applied to what is read.
import { readdirSync, readFileSync, statSync, type Dirent } from 'node:fs'
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
  /** Exec form: `command` is spawned directly with these arguments, no shell. */
  args?: string[]
  /** `block` makes a crash, timeout or exit code other than 0 and 2 count as a block. */
  onFailure?: 'block' | 'continue'
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
  const match = /^---\r?\n(?:([\s\S]*?)\r?\n)??---[ \t]*(?:\r?\n|$)/.exec(text)
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

export type UserConfigValue = string | number | boolean | readonly string[]

export interface UserConfig {
  values: Record<string, UserConfigValue>
  /** Keys declared `sensitive: true`: never substituted into skill, agent or command text. */
  sensitive: ReadonlySet<string>
  /** Required keys with no value and no default. */
  missing: string[]
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const isUserConfigValue = (value: unknown): value is UserConfigValue =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || (Array.isArray(value) && value.every((v) => typeof v === 'string'))

/** Merge the manifest `userConfig` declarations with the row's `options`; only declared keys count. */
export function resolveUserConfig(manifest: PluginManifest, options: Record<string, unknown> = {}): UserConfig {
  const declared = isRecord(manifest.userConfig) ? manifest.userConfig : {}
  const values: Record<string, UserConfigValue> = {}
  const sensitive = new Set<string>()
  const missing: string[] = []
  for (const [key, raw] of Object.entries(declared)) {
    const option = isRecord(raw) ? raw : {}
    if (option.sensitive === true) sensitive.add(key)
    const value = options[key] !== undefined ? options[key] : option.default
    if (isUserConfigValue(value)) values[key] = value
    else if (option.required === true) missing.push(key)
  }
  return { values, sensitive, missing }
}

export const userConfigString = (value: UserConfigValue): string => (Array.isArray(value) ? value.join(',') : String(value))

/** `CLAUDE_PLUGIN_OPTION_<KEY>` for every option with a value, as Claude Code exports to hooks. */
export function userConfigEnv(config: UserConfig): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(config.values)) env[`CLAUDE_PLUGIN_OPTION_${key.toUpperCase()}`] = userConfigString(value)
  return env
}

/**
 * Substitute `${user_config.KEY}`. In model-visible text (`content: true`) a sensitive
 * value becomes a placeholder; unknown keys are left as written.
 */
export function expandUserConfig(text: string, config: UserConfig, { content }: { content: boolean }): string {
  return text.replace(/\$\{user_config\.([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, key: string) => {
    const value = config.values[key]
    if (value === undefined) return whole
    if (content && config.sensitive.has(key)) return `[sensitive option ${key} not shown]`
    return userConfigString(value)
  })
}

/** A manifest component field: one path or an array of paths. */
const manifestPaths = (value: unknown): string[] =>
  typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

const isDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
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

/**
 * Skill directories: `skills/<name>/SKILL.md` plus the manifest `skills` paths, which add to
 * the default. A listed directory holding SKILL.md is one skill. With no `skills/` and no
 * `skills` key, a SKILL.md at the plugin root loads as a single skill.
 */
export function discoverSkills(root: string, options: SkillOptions = {}): SkillFile[] {
  const manifest = readManifest(root)
  const skillDirs: string[] = []
  const collect = (dir: string): void => {
    if (isFile(join(dir, 'SKILL.md'))) return void skillDirs.push(dir)
    for (const entry of listDir(dir)) if (entry.isDirectory() || entry.isSymbolicLink()) skillDirs.push(join(dir, entry.name))
  }
  const defaultDir = join(root, 'skills')
  for (const entry of listDir(defaultDir)) if (entry.isDirectory() || entry.isSymbolicLink()) skillDirs.push(join(defaultDir, entry.name))
  for (const path of manifestPaths(manifest.skills)) collect(resolve(root, path))
  if (!isDir(defaultDir) && manifest.skills === undefined && isFile(join(root, 'SKILL.md'))) skillDirs.push(root)

  const skip = new Set(options.exclude ?? [])
  const out: SkillFile[] = []
  const seen = new Set<string>()
  for (const dir of skillDirs) {
    const dirName = dir === root ? manifest.name : basename(dir)
    if (skip.has(dirName)) continue
    const path = join(dir, 'SKILL.md')
    const text = readText(path)
    if (text === undefined) continue
    const { meta } = parseFrontMatter(text)
    const bare = kebab(meta.name || dirName)
    if (!bare || !meta.description) continue
    const name = options.prefix ? `${options.prefix}-${bare}` : bare
    if (seen.has(name)) continue
    seen.add(name)
    out.push({ name, description: meta.description, path, base: dirname(path), meta })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

interface CommandSource {
  stem: string
  path: string
  text: string
  description?: string
  hint?: string
}

/** The manifest `commands` field, or `commands/` when it is unset. A set field replaces the default. */
function commandSources(root: string): CommandSource[] {
  const field = readManifest(root).commands
  const fromFile = (path: string): CommandSource[] => {
    const text = readText(path)
    return text === undefined ? [] : [{ stem: basename(path).replace(/\.md$/, ''), path, text }]
  }
  const fromDir = (dir: string): CommandSource[] => listDir(dir).flatMap((entry) => (entry.name.endsWith('.md') ? fromFile(join(dir, entry.name)) : []))
  if (field === undefined) return fromDir(join(root, 'commands'))
  if (isRecord(field)) {
    const out: CommandSource[] = []
    for (const [stem, raw] of Object.entries(field)) {
      if (!isRecord(raw)) continue
      const extra = { description: typeof raw.description === 'string' ? raw.description : undefined, hint: typeof raw.argumentHint === 'string' ? raw.argumentHint : undefined }
      if (typeof raw.content === 'string') out.push({ stem, path: join(root, '.claude-plugin', 'plugin.json'), text: raw.content, ...extra })
      else if (typeof raw.source === 'string') {
        const path = resolve(root, raw.source)
        const text = readText(path)
        if (text !== undefined) out.push({ stem, path, text, ...extra })
      }
    }
    return out
  }
  return manifestPaths(field).flatMap((rel) => {
    const path = resolve(root, rel)
    return isDir(path) ? fromDir(path) : fromFile(path)
  })
}

/** Command files: `commands/<name>.md`, or what the manifest `commands` field names. */
export function discoverCommands(root: string, options: CommandOptions = {}): CommandFile[] {
  const skip = new Set(options.exclude ?? [])
  const out: CommandFile[] = []
  const seen = new Set<string>()
  for (const source of commandSources(root)) {
    if (skip.has(source.stem)) continue
    const { meta, body } = parseFrontMatter(source.text)
    const name = kebab(meta.name || source.stem)
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push({ stem: source.stem, name, description: source.description || meta.description || source.stem, hint: source.hint ?? meta['argument-hint'] ?? '', body, path: source.path })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** Markdown files under `dir`, recursively, with the subfolder names leading to each. */
function agentFiles(dir: string, scope: string[] = []): Array<{ path: string; scope: string[] }> {
  return listDir(dir).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return agentFiles(path, [...scope, entry.name])
    return entry.name.endsWith('.md') ? [{ path, scope }] : []
  })
}

/**
 * Agent definitions: `agents/**.md`, where subfolders join the name (`review/security.md` is
 * `review-security`), or the files the manifest `agents` field lists, which replace the
 * default and load without subfolder names. Extra bundle directories are added either way.
 */
export function discoverAgents(root: string, options: AgentOptions = {}): AgentFile[] {
  const listed = readManifest(root).agents
  const files =
    listed === undefined
      ? agentFiles(join(root, 'agents'))
      : manifestPaths(listed).flatMap((rel) => {
          const path = resolve(root, rel)
          return isDir(path) ? agentFiles(path) : [{ path, scope: [] }]
        })
  for (const dir of options.extraDirs ?? []) files.push(...agentFiles(resolve(root, dir)))
  const skip = new Set(options.exclude ?? [])
  const out: AgentFile[] = []
  const seen = new Set<string>()
  for (const file of files) {
    const text = readText(file.path)
    if (text === undefined) continue
    const { meta, body } = parseFrontMatter(text)
    const name = kebab([...file.scope, meta.name || basename(file.path).replace(/\.md$/, '')].join('-'))
    if (!name || skip.has(name) || seen.has(name) || !meta.description) continue
    seen.add(name)
    out.push({ name, description: meta.description, tools: meta.tools || '', model: meta.model || '', body, path: file.path })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

interface HooksJson {
  hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ type?: string; command?: string; args?: unknown; onFailure?: string; timeout?: number }> }> | undefined>
}

/**
 * Command hooks from `hooks/hooks.json` merged with the manifest `hooks` field (a path, an
 * inline object, or an array of either), flattened. A file named twice loads once.
 * Function-hook `modules` are Claude-only and skipped.
 */
export function readHooks(root: string): HookSpec[] {
  const configs: Array<{ label: string; json: HooksJson }> = []
  const loaded = new Set<string>()
  const loadFile = (path: string, required: boolean): void => {
    if (loaded.has(path)) return
    loaded.add(path)
    const raw = readText(path)
    if (raw === undefined) {
      if (required) throw new Error(`plugin.json: hooks file ${path} is missing`)
      return
    }
    configs.push({ label: basename(path), json: JSON.parse(raw) as HooksJson })
  }
  loadFile(join(root, 'hooks', 'hooks.json'), false)
  const field = readManifest(root).hooks
  for (const entry of Array.isArray(field) ? field : field === undefined ? [] : [field]) {
    if (typeof entry === 'string') loadFile(resolve(root, entry), true)
    else if (isRecord(entry)) configs.push({ label: 'plugin.json', json: entry as HooksJson })
  }

  const out: HookSpec[] = []
  for (const { label, json } of configs) {
    for (const [event, groups] of Object.entries(json.hooks ?? {})) {
      for (const group of groups ?? []) {
        for (const hook of group.hooks ?? []) {
          if (hook.type !== 'command' || !hook.command) continue
          const spec: HookSpec = { event, matcher: group.matcher ?? '', command: hook.command, timeout: hook.timeout ?? DEFAULT_HOOK_TIMEOUT_S }
          if (hook.args !== undefined) {
            // Running a malformed exec hook through a shell would quietly run something else.
            if (!Array.isArray(hook.args) || !hook.args.every((arg) => typeof arg === 'string')) throw new Error(`${label}: ${event} hook "${hook.command}" has args that are not a list of strings`)
            spec.args = hook.args
          }
          if (hook.onFailure === 'block' || hook.onFailure === 'continue') spec.onFailure = hook.onFailure
          out.push(spec)
        }
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
