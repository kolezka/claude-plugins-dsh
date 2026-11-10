import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const dist = fileURLToPath(new URL('../dist/', import.meta.url))
const cli = join(dist, 'bin', 'cli.js')
const runtime = join(dist, 'claude-compat.js')

function run(args, entry = cli) {
  const result = spawnSync(process.execPath, [entry, ...args], { encoding: 'utf8' })
  assert.ifError(result.error)
  return result
}

function fixture(t, manifest = { name: 'fixture', version: '1.2.3', description: 'Fixture plugin' }) {
  const temporary = mkdtempSync(join(tmpdir(), 'dsh-cli-'))
  t.after(() => rmSync(temporary, { recursive: true, force: true }))
  const root = join(temporary, 'plugin with spaces')
  mkdirSync(join(root, '.claude-plugin'), { recursive: true })
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify(manifest))
  const write = (path, content) => {
    const destination = join(root, path)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, content)
  }
  return { temporary, root, write }
}

test('help exits successfully and malformed commands fail', () => {
  for (const args of [['-h'], ['--help'], ['scaffold', '--help'], ['inspect', '-h'], ['sync', '--help']]) {
    const result = run(args)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Usage: claude-plugin-dsh /)
  }
  for (const args of [[], ['wat'], ['scaffold'], ['inspect'], ['sync'], ['inspect', '--check', '.'], ['sync', '--wat', '.']]) {
    const result = run(args)
    assert.equal(result.status, 64, `${args}: ${result.stderr}`)
  }
})

test('scaffold preserves generated output and handwritten files across retries', (t) => {
  const { root, write } = fixture(t)
  write('dsh/index.js', '// handwritten entry\n')
  write('dsh/cordis.patch.yml', '# handwritten patch\n')
  for (let retry = 0; retry < 2; retry++) {
    const result = run(['scaffold', '--scope', '@you', root])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /scaffolded /)
    assert.equal(result.stderr, '')
    const pkg = JSON.parse(readFileSync(join(root, 'dsh/package.json'), 'utf8'))
    assert.deepEqual(pkg, {
      name: '@you/fixture-dsh', version: '1.2.3', private: true,
      description: 'DeepSeek Harness adapter for the fixture Claude Code plugin', type: 'module',
      exports: { '.': './index.js', './locale/*.json': './locale/*.json' },
      files: ['index.js', 'claude-compat.js', 'cordis.patch.yml', 'locale/*.json'],
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    })
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'dsh/locale/en.json'), 'utf8')), {
      meta: { title: 'fixture', description: 'Fixture plugin' },
    })
    assert.deepEqual(readFileSync(join(root, 'dsh/claude-compat.js')), readFileSync(runtime))
    assert.equal(readFileSync(join(root, 'dsh/index.js'), 'utf8'), '// handwritten entry\n')
    assert.equal(readFileSync(join(root, 'dsh/cordis.patch.yml'), 'utf8'), '# handwritten patch\n')
  }
})

test('scaffold defaults missing metadata and warns without creating handwritten files', (t) => {
  const { root } = fixture(t, { name: 'minimal' })
  const result = run(['scaffold', root])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stderr, /dsh\/index.js is missing/)
  assert.match(result.stderr, /dsh\/cordis.patch.yml is missing/)
  assert.equal(existsSync(join(root, 'dsh/index.js')), false)
  assert.equal(existsSync(join(root, 'dsh/cordis.patch.yml')), false)
  const pkg = JSON.parse(readFileSync(join(root, 'dsh/package.json'), 'utf8'))
  assert.equal(pkg.name, 'minimal-dsh')
  assert.equal(pkg.version, '0.0.0')
})

test('scope validation rejects malformed or repeated scopes before writing', (t) => {
  const { root } = fixture(t)
  for (const args of [
    ['--scope'], ['--scope', 'you'], ['--scope', '@Upper'], ['--scope', '@'],
    ['--scope', '@you/path'], ['--scope', '@you', '--scope', '@other'],
  ]) {
    const result = run(['scaffold', root, ...args])
    assert.equal(result.status, 64, result.stderr)
    assert.match(result.stderr, /--scope/)
    assert.equal(existsSync(join(root, 'dsh')), false)
  }
})

test('sync check detects missing and changed runtimes without writing; sync repairs drift', (t) => {
  const { root, write } = fixture(t)
  const destination = join(root, 'dsh/claude-compat.js')
  let result = run(['sync', '--check', root])
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stdout, /drift:/)
  assert.equal(existsSync(destination), false)
  result = run(['sync', root])
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(readFileSync(destination), readFileSync(runtime))
  assert.equal(run(['sync', '--check', root]).status, 0)
  write('dsh/claude-compat.js', '// drift\n')
  result = run(['sync', '--check', root])
  assert.equal(result.status, 1, result.stderr)
  assert.equal(readFileSync(destination, 'utf8'), '// drift\n')
  assert.equal(run(['sync', root]).status, 0)
  assert.equal(run(['sync', '--check', root]).status, 0)
})

test('inspect loads the vendored runtime and reports skills, commands, prompts and hooks', (t) => {
  const { root, write } = fixture(t)
  assert.equal(run(['scaffold', root]).status, 0)
  write('dsh/index.js', `import { createPlugin, rootFrom } from './claude-compat.js'
const plugin = createPlugin({ root: rootFrom(import.meta.url), instructions: ['NOTES.md'] })
export const { name, apply } = plugin
`)
  write('skills/hello/SKILL.md', '---\nname: hello\ndescription: A fixture skill\n---\nFixture skill body\n')
  write('commands/greet.md', '---\ndescription: A fixture command\n---\nHello $ARGUMENTS\n')
  write('NOTES.md', 'Fixture notes\n<!--harness:claude-only-->\nOmitted notes\n<!--/harness-->\n')
  write('hooks/hooks.json', JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo should-not-execute' }] }] } }))
  const result = run(['inspect', root])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /claude-compat-fixture/)
  assert.match(result.stdout, /skills: +hello/)
  assert.match(result.stdout, /commands: +\/fixture-greet/)
  assert.match(result.stdout, /claude-only left: false/)
  assert.match(result.stdout, /agent\/created/)
  assert.doesNotMatch(result.stdout, /should-not-execute/)
})

test('inspect handles string prompt sections and rejects empty skill bodies', (t) => {
  const { root, write } = fixture(t)
  write('dsh/package.json', '{"type":"module"}')
  write('dsh/index.js', `export const name = 'empty-fixture'
export function apply(ctx) {
  ctx.systemPrompt.section({ name: 'static', order: 1, text: 'Static notes' })
  ctx.skills.registerProvider(() => ({
    name: 'empty', async list() { return [{ name: 'empty' }] },
    async get() { return { content: '' } },
  }))
}
`)
  const result = run(['inspect', root])
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /empty: empty body/)
  assert.match(result.stdout, /prompt: +12 chars/)
})

test('CLI runtime resolution survives relocation outside the checkout', (t) => {
  const { temporary, root } = fixture(t)
  const installed = join(temporary, 'installed package')
  mkdirSync(installed)
  writeFileSync(join(installed, 'package.json'), '{"type":"module"}')
  cpSync(join(dist, 'bin'), join(installed, 'dist/bin'), { recursive: true })
  cpSync(runtime, join(installed, 'dist/claude-compat.js'))
  const result = run(['scaffold', root], resolve(installed, 'dist/bin/cli.js'))
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(readFileSync(join(root, 'dsh/claude-compat.js')), readFileSync(runtime))
})

test('package exposes the CLI under the new and legacy bin names', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.name, 'claude-plugin-dsh')
  assert.deepEqual(pkg.bin, { 'claude-plugin-dsh': 'dist/bin/cli.js', 'claude-plugins-dsh': 'dist/bin/cli.js' })
  assert.match(readFileSync(join(dist, '..', pkg.bin['claude-plugin-dsh']), 'utf8'), /^#!\/usr\/bin\/env node\n/)
})
