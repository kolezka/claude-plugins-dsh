import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { discoverCheckouts } from '../dist/bin/update.js'

test('update discovers a nested managed adapter in multiple profiles once without global rows', t => {
  const home = mkdtempSync(join(tmpdir(), 'linked-update-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const repo = join(home, 'repo')
  const plugin = join(repo, 'plugins', 'example')
  mkdirSync(join(repo, '.git'), { recursive: true })
  mkdirSync(join(plugin, 'dsh'), { recursive: true })
  mkdirSync(join(plugin, '.claude-plugin'))
  writeFileSync(join(plugin, '.claude-plugin/plugin.json'), '{}')
  for (const name of ['custom', 'another']) {
    const profile = join(home, 'profiles', name)
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ dependencies: { example: 'link:../../repo/plugins/example/dsh' } }))
  }
  assert.deepEqual(discoverCheckouts({ DSH_HOME: home }), [repo])
})

const cli = fileURLToPath(new URL('../dist/bin/cli.js', import.meta.url))
test('install preflights every profile and preserves a disabled linked adapter', t => {
  const root = mkdtempSync(join(tmpdir(), 'adapter-install-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'my plugin', 'dsh')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'test-adapter', dsh: { bundle: { patch: './patch.yml' } } }))
  const manifest = { dsh: { profile: { bundles: [] } } }
  for (const name of ['one', 'two']) {
    const profile = join(root, 'profiles', name)
    mkdirSync(join(profile, 'node_modules'), { recursive: true })
    writeFileSync(join(profile, 'package.json'), JSON.stringify(manifest))
  }
  const one = join(root, 'profiles', 'one')
  const before = JSON.stringify({ ...manifest, dependencies: { 'test-adapter': `link:${dir}` } })
  writeFileSync(join(one, 'package.json'), before)
  symlinkSync(dir, join(one, 'node_modules/test-adapter'))
  const run = () => spawnSync(process.execPath, [cli, 'install', '--check', join(root, 'my plugin')], { env: { ...process.env, DSH_HOME: root }, encoding: 'utf8' })
  let result = run()
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /one: already installed/)
  assert.match(result.stdout, /two: test-adapter@link:/)
  assert.equal(readFileSync(join(one, 'package.json'), 'utf8'), before)
  const two = join(root, 'profiles/two/package.json')
  assert.equal(readFileSync(two, 'utf8'), JSON.stringify(manifest))
  writeFileSync(two, '{}')
  result = run()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Invalid DSH profile/)
})
