import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { HostContext, PromptSection, SkillProvider } from '../src/dsh-types.js'

export async function inspect(directories: readonly string[]): Promise<number> {
  let failed = false
  for (const directory of directories) {
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
