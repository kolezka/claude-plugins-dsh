import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

test('public declarations work without ambient Node typings', () => {
  const root = mkdtempSync(join(tmpdir(), 'compat-types-'))
  const entry = resolve('dist/src/claude-compat.js')
  writeFileSync(join(root, 'consumer.ts'), `
import { createPlugin, type PluginSpec, type ContentBlock, type SkillResourceBase } from ${JSON.stringify(entry)}
const spec: PluginSpec = { root: '.' }
createPlugin(spec)
interface FileBlock { type: 'file'; url: string }
declare const file: FileBlock
const content: ContentBlock = file
const base: SkillResourceBase = { kind: 'url', url: 'https://example.com' }
void content; void base
`)
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'NodeNext', strict: true, noEmit: true, types: [], skipLibCheck: false },
    files: ['./consumer.ts'],
  }))
  const result = spawnSync(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', join(root, 'tsconfig.json')], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stdout + result.stderr)
})
