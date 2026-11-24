import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { HostContext, PromptSection, SkillProvider } from '../src/dsh-types.js'

function inspectPaths(root: string): boolean {
  const paths = new Set<string>()
  const visited = new Set<string>()
  function scan(file: string, base: string): void {
    if (visited.has(file) || !existsSync(file)) return
    visited.add(file)
    let value: unknown
    try { value = JSON.parse(readFileSync(file, 'utf8')) } catch (error) { throw new Error(`${file}: ${error}`) }
    walk(value, base)
  }
  function walk(value: unknown, base: string, kind = ''): void {
    if (Array.isArray(value)) { for (const item of value) walk(item, base, kind); return }
    if (typeof value === 'object' && value) {
      for (const [key, item] of Object.entries(value)) walk(item, base, key)
    } else if (typeof value === 'string') {
      const marker = '${CLAUDE_PLUGIN_ROOT}/'
      if (kind === 'description') return
      if (kind === 'modules' || ((kind === 'hooks' || kind === 'commands' || kind === 'mcpServers') && (value.startsWith('./') || value.startsWith(marker)))) {
        const path = value.startsWith(marker) ? resolve(root, value.slice(marker.length)) : resolve(base, value)
        paths.add(path)
        if (kind === 'hooks' || kind === 'mcpServers') scan(path, dirname(path))
      } else {
        if (kind === 'args' && value.startsWith(marker)) paths.add(resolve(root, value.slice(marker.length)))
        else for (const match of value.matchAll(/(["'])\$\{CLAUDE_PLUGIN_ROOT\}\/([^"']+)\1|\$\{CLAUDE_PLUGIN_ROOT\}\/([^"'\s;|&)]+)/g)) paths.add(resolve(root, (match[2] ?? match[3])!))
      }
    }
  }
  const hooks = join(root, 'hooks/hooks.json'), manifest = join(root, '.claude-plugin/plugin.json')
  scan(hooks, dirname(hooks))
  scan(manifest, root)
  scan(join(root, '.mcp.json'), root)
  let valid = true
  for (const path of paths) {
    if (existsSync(path)) console.log(`  path: ${relative(root, path)}`)
    else { console.error(`  missing: ${path}`); valid = false }
  }
  return valid
}

export async function inspect(directories: readonly string[]): Promise<number> {
  let failed = false
  for (const directory of directories) {
    if (!inspectPaths(resolve(directory))) failed = true
    const entry = pathToFileURL(resolve(directory, 'dsh', 'index.js')).href
    const plugin: unknown = await import(entry)
    if (typeof plugin !== 'object' || plugin === null || !('apply' in plugin) || typeof plugin.apply !== 'function') {
      throw new Error(`${entry}: expected a plugin exporting apply`)
    }
    const seen: { skills: SkillProvider[]; commands: string[]; sections: PromptSection[]; events: string[] } = {
      skills: [], commands: [], sections: [], events: [],
    }
    const ctx: HostContext = {
      logger: { warn: (message) => console.warn('  warn:', message) },
      skills: { registerProvider: (create) => seen.skills.push(create({ signal: new AbortController().signal, invalidate() {} })) },
      commands: { register: (definition) => seen.commands.push(definition.name) },
      systemPrompt: { section: (section) => seen.sections.push(section) },
      workingDirectory: { get: () => process.cwd() },
      inject: (_services, callback) => callback(ctx),
      effect() {},
      on: (event) => seen.events.push(event),
    }
    await plugin.apply(ctx, {})
    const skills: string[] = []
    for (const provider of seen.skills) {
      for (const candidate of await provider.list({})) {
        const body = await provider.get(candidate, {})
        if (!body?.content) {
          failed = true
          console.error(`  ${candidate.name}: empty body`)
        }
        skills.push(candidate.name)
      }
    }
    const prompt = seen.sections.map((section) => typeof section.text === 'string' ? section.text : section.text({})).join('')
    console.log('name' in plugin ? String(plugin.name) : directory)
    console.log(`  skills:   ${skills.join(', ') || '-'}`)
    console.log(`  commands: ${seen.commands.map((command) => '/' + command).join(' ') || '-'}`)
    console.log(`  prompt:   ${prompt ? `${prompt.length} chars, claude-only left: ${/harness:claude-only/.test(prompt)}` : '-'}`)
    console.log(`  events:   ${[...new Set(seen.events)].join(', ') || '-'}`)
  }
  return failed ? 1 : 0
}
