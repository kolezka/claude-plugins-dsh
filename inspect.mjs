#!/usr/bin/env node
// Load each plugin's dsh/index.js against a recording context and print what it
// registers: skills, commands, prompt sections, hook listeners. A dry run, no DSH needed.
//   node inspect.mjs <plugin-dir>...
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

let failed = false
for (const arg of process.argv.slice(2)) {
  const entry = pathToFileURL(resolve(arg, 'dsh', 'index.js')).href
  const mod = await import(entry)
  const seen = { skills: [], commands: [], sections: [], events: [] }
  const ctx = {
    logger: { warn: (m) => console.warn('  warn:', m) },
    skills: { registerProvider: (create) => seen.skills.push(create({ signal: new AbortController().signal, invalidate() {} })) },
    commands: { register: (d) => seen.commands.push(d.name) },
    systemPrompt: { section: (s) => seen.sections.push(s) },
    workingDirectory: { get: () => process.cwd() },
    inject: (names, fn) => fn(ctx),
    effect() {},
    on: (event) => seen.events.push(event),
  }
  mod.apply(ctx, {})
  const skills = []
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
  const prompt = seen.sections.map((s) => s.text({})).join('')
  console.log(`${mod.name}`)
  console.log(`  skills:   ${skills.join(', ') || '-'}`)
  console.log(`  commands: ${seen.commands.map((c) => '/' + c).join(' ') || '-'}`)
  console.log(`  prompt:   ${prompt ? `${prompt.length} chars, claude-only left: ${/harness:claude-only/.test(prompt)}` : '-'}`)
  console.log(`  events:   ${[...new Set(seen.events)].join(', ') || '-'}`)
}
process.exit(failed ? 1 : 0)
