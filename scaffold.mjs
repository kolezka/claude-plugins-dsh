#!/usr/bin/env node
// Write the generated files of a plugin's dsh/ directory: package.json, locale/en.json
// and the vendored claude-compat.js. index.js and cordis.patch.yml are hand-written
// per plugin and never touched here. Usage:
//   node scaffold.mjs [--scope @you] <plugin-dir>...
// The bundle package is named <scope>/<plugin>-dsh; without --scope it is <plugin>-dsh.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
let scope = ''
const at = args.indexOf('--scope')
if (at !== -1) {
  scope = args[at + 1] ?? ''
  args.splice(at, 2)
  if (!/^@[a-z0-9][a-z0-9._-]*$/.test(scope)) {
    console.error(`--scope must look like @name, got ${JSON.stringify(scope)}`)
    process.exit(64)
  }
}
if (!args.length) {
  console.error('usage: scaffold.mjs [--scope @you] <plugin-dir>...')
  process.exit(64)
}

for (const arg of args) {
  const root = resolve(arg)
  const manifest = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'))
  const dsh = join(root, 'dsh')
  mkdirSync(join(dsh, 'locale'), { recursive: true })
  copyFileSync(join(here, 'claude-compat.js'), join(dsh, 'claude-compat.js'))

  const pkg = {
    name: `${scope ? scope + '/' : ''}${manifest.name}-dsh`,
    version: manifest.version ?? '0.0.0',
    private: true,
    description: `DeepSeek Harness adapter for the ${manifest.name} Claude Code plugin`,
    type: 'module',
    exports: { '.': './index.js', './locale/*.json': './locale/*.json' },
    files: ['index.js', 'claude-compat.js', 'cordis.patch.yml', 'locale/*.json'],
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }
  writeFileSync(join(dsh, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')

  const locale = { meta: { title: manifest.name, description: manifest.description ?? '' } }
  writeFileSync(join(dsh, 'locale', 'en.json'), JSON.stringify(locale, null, 2) + '\n')

  for (const required of ['index.js', 'cordis.patch.yml']) {
    if (!existsSync(join(dsh, required))) console.warn(`${manifest.name}: dsh/${required} is missing, write it by hand`)
  }
  console.log(`scaffolded ${dsh}`)
}
