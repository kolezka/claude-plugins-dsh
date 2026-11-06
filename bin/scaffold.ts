import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { runtimePath } from './runtime.js'

interface Manifest {
  name: string
  version: string
  description: string
}

function readManifest(root: string): Manifest {
  const value: unknown = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'))
  if (typeof value !== 'object' || value === null || !('name' in value) || typeof value.name !== 'string' || !value.name) {
    throw new Error(`${root}: plugin manifest must contain a name`)
  }
  const version = 'version' in value ? value.version : undefined
  const description = 'description' in value ? value.description : undefined
  if (version !== undefined && typeof version !== 'string') throw new Error(`${root}: plugin version must be a string`)
  if (description !== undefined && typeof description !== 'string') throw new Error(`${root}: plugin description must be a string`)
  return { name: value.name, version: version ?? '0.0.0', description: description ?? '' }
}

export function scaffold(directories: readonly string[], scope: string): void {
  for (const directory of directories) {
    const root = resolve(directory)
    const manifest = readManifest(root)
    const dsh = join(root, 'dsh')
    mkdirSync(join(dsh, 'locale'), { recursive: true })
    copyFileSync(runtimePath, join(dsh, 'claude-compat.js'))
    const pkg = {
      name: `${scope ? scope + '/' : ''}${manifest.name}-dsh`,
      version: manifest.version,
      private: true,
      description: `DeepSeek Harness adapter for the ${manifest.name} Claude Code plugin`,
      type: 'module',
      exports: { '.': './index.js', './locale/*.json': './locale/*.json' },
      files: ['index.js', 'claude-compat.js', 'cordis.patch.yml', 'locale/*.json'],
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }
    writeFileSync(join(dsh, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
    const locale = { meta: { title: manifest.name, description: manifest.description } }
    writeFileSync(join(dsh, 'locale', 'en.json'), JSON.stringify(locale, null, 2) + '\n')
    for (const required of ['index.js', 'cordis.patch.yml']) {
      if (!existsSync(join(dsh, required))) console.warn(`${manifest.name}: dsh/${required} is missing, write it by hand`)
    }
    console.log(`scaffolded ${dsh}`)
  }
}
