import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
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

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

// A bare "origin" plus a clone under <home>/plugins-src/<name>, with a pin comment in <home>/cordis.patch.yml.
function checkoutFixture(t, name = 'fixture-plugin') {
  const temporary = mkdtempSync(join(tmpdir(), 'dsh-update-'))
  t.after(() => rmSync(temporary, { recursive: true, force: true }))
  const origin = join(temporary, 'origin.git')
  const seed = join(temporary, 'seed')
  git(temporary, 'init', '--bare', '--initial-branch=main', origin)
  git(temporary, 'init', '--initial-branch=main', seed)
  const commit = (cwd, version, extra = {}) => {
    mkdirSync(join(cwd, '.claude-plugin'), { recursive: true })
    mkdirSync(join(cwd, 'dsh'), { recursive: true })
    writeFileSync(join(cwd, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version }))
    writeFileSync(join(cwd, 'dsh', 'index.js'), '// adapter\n')
    for (const [path, content] of Object.entries(extra)) writeFileSync(join(cwd, path), content)
    git(cwd, 'add', '-A')
    git(cwd, 'commit', '-q', '-m', `v${version}`)
    return git(cwd, 'rev-parse', 'HEAD')
  }
  const first = commit(seed, '0.1.0')
  git(seed, 'remote', 'add', 'origin', origin)
  git(seed, 'push', '-q', '-u', 'origin', 'main')
  const home = join(temporary, 'dsh home')
  const root = join(home, 'plugins-src', name)
  mkdirSync(join(home, 'plugins-src'), { recursive: true })
  git(temporary, 'clone', '-q', origin, root)
  const patch = join(home, 'cordis.patch.yml')
  writeFileSync(patch, `# other main 0000000000000000000000000000000000000000\n- insert:\n    - id: other\n      name: "file:///elsewhere/${name}/dsh/index.js"\n# ${name} main ${first}\n- insert:\n    - id: claude-compat-${name}\n      name: "file://${root}/dsh/index.js"\n`)
  const runUpdate = (...args) => {
    const result = spawnSync(process.execPath, [cli, 'update', ...args], { encoding: 'utf8', env: { ...process.env, DSH_HOME: home } })
    assert.ifError(result.error)
    return result
  }
  return { temporary, origin, seed, root, home, patch, first, commit, runUpdate }
}

test('update fast-forwards, installs adapter deps only when a lockfile exists, and rewrites the pin', (t) => {
  const { seed, root, patch, first, commit, runUpdate } = checkoutFixture(t)
  let result = runUpdate()
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /fixture-plugin: up to date at [0-9a-f]{7} \(0\.1\.0\)/)
  const second = commit(seed, '0.2.0')
  git(seed, 'push', '-q')
  result = runUpdate('--check')
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stdout, /behind origin\/main by 1 commit\(s\).*\(fast-forward\)/)
  assert.equal(git(root, 'rev-parse', 'HEAD'), first, '--check must not move the checkout')
  assert.match(readFileSync(patch, 'utf8'), new RegExp(`# fixture-plugin main ${first}`), '--check must not rewrite the pin')
  result = runUpdate()
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /fixture-plugin: [0-9a-f]{7} -> [0-9a-f]{7} \(0\.1\.0 -> 0\.2\.0\)/)
  assert.equal(git(root, 'rev-parse', 'HEAD'), second)
  const text = readFileSync(patch, 'utf8')
  assert.match(text, new RegExp(`# fixture-plugin main ${second}\n- insert:\n    - id: claude-compat-fixture-plugin`))
  assert.match(text, /# other main 0{40}/, 'other pins stay as they were')
  assert.equal(existsSync(join(root, 'dsh', 'node_modules')), false, 'no bun.lock, so no install')
})

test('update refuses rewritten history unless --reset is given, and refuses a dirty tree', (t) => {
  const { temporary, origin, root, patch, first, commit, runUpdate } = checkoutFixture(t)
  const rewritten = join(temporary, 'rewritten')
  git(temporary, 'init', '--initial-branch=main', rewritten)
  const fresh = commit(rewritten, '0.3.0')
  git(rewritten, 'remote', 'add', 'origin', origin)
  git(rewritten, 'push', '-q', '--force', 'origin', 'main')
  let result = runUpdate('--check')
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stdout, /unrelated history, needs --reset/)
  result = runUpdate()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /cannot fast-forward: local and origin\/main share no history/)
  assert.match(result.stderr, new RegExp(`undo: git -C .* reset --hard ${first.slice(0, 7)}`))
  assert.equal(git(root, 'rev-parse', 'HEAD'), first)
  writeFileSync(join(root, 'dsh', 'index.js'), '// local edit\n')
  result = runUpdate('--reset')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /uncommitted changes/)
  assert.equal(git(root, 'rev-parse', 'HEAD'), first)
  git(root, 'checkout', '--', 'dsh/index.js')
  result = runUpdate('--reset')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /\(0\.1\.0 -> 0\.3\.0\)/)
  assert.equal(git(root, 'rev-parse', 'HEAD'), fresh)
  assert.match(readFileSync(patch, 'utf8'), new RegExp(`# fixture-plugin main ${fresh}`))
})

test('update discovers checkouts under $DSH_HOME/plugins-src, honours --patch, and validates options', (t) => {
  const { root, home, runUpdate } = checkoutFixture(t)
  const elsewhere = join(home, 'elsewhere.yml')
  writeFileSync(elsewhere, '# unrelated\n')
  let result = runUpdate('--patch', elsewhere)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /up to date .*no pin comment in .*elsewhere\.yml/)
  result = runUpdate(root)
  assert.equal(result.status, 0, result.stderr)
  result = runUpdate(join(root, 'dsh'))
  assert.equal(result.status, 1)
  assert.match(result.stderr, /pass the checkout root/)
  for (const args of [['--check', '--reset'], ['--patch'], ['--wat'], ['--check', '--check']]) {
    result = runUpdate(...args)
    assert.equal(result.status, 64, `${args}: ${result.stderr}`)
  }
  const empty = spawnSync(process.execPath, [cli, 'update'], { encoding: 'utf8', env: { ...process.env, DSH_HOME: join(home, 'missing') } })
  assert.equal(empty.status, 64)
  assert.match(empty.stderr, /found no checkouts/)
})

test('update fetches over HTTPS-style auth with the gh login when no other credential helper has one', async (t) => {
  const { temporary, origin, seed, root, home, commit } = checkoutFixture(t)
  const server = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'auth-git-server.mjs'), temporary, 'x-access-token', 'gh-secret'])
  t.after(() => server.kill())
  const port = await new Promise((resolvePort, reject) => {
    server.stdout.once('data', (chunk) => resolvePort(chunk.toString().trim()))
    server.once('exit', (code) => reject(new Error(`server exited ${code}`)))
  })
  git(root, 'remote', 'set-url', 'origin', `http://127.0.0.1:${port}/${basename(origin)}`)
  const second = commit(seed, '0.2.0')
  git(seed, 'push', '-q')

  // A fake gh that knows the password, so success proves update asked gh and not some other helper.
  const bin = join(temporary, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\nif [ "$1 $2 $3" = "auth git-credential get" ]; then cat >/dev/null; printf "username=x-access-token\\npassword=gh-secret\\n"; fi\nexit 0\n')
  chmodSync(join(bin, 'gh'), 0o755)
  const isolated = { ...process.env, DSH_HOME: home, GIT_CONFIG_GLOBAL: join(temporary, 'empty-gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '' }
  writeFileSync(isolated.GIT_CONFIG_GLOBAL, '')
  const runWith = (path) => spawnSync(process.execPath, [cli, 'update'], { encoding: 'utf8', env: { ...isolated, PATH: path } })

  // Control: without gh on PATH the same fetch must fail on auth, so the fixture really requires credentials.
  const systemPath = (process.env.PATH ?? '').split(':').filter((entry) => !existsSync(join(entry, 'gh'))).join(':')
  let result = runWith(systemPath)
  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stderr, /git fetch origin failed/)
  assert.match(result.stderr, /gh not found/)
  assert.notEqual(git(root, 'rev-parse', 'HEAD'), second)

  result = runWith(`${bin}:${systemPath}`)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /\(0\.1\.0 -> 0\.2\.0\)/)
  assert.equal(git(root, 'rev-parse', 'HEAD'), second)
})
