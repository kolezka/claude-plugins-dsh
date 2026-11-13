import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

export interface UpdateOptions {
  /** Report what would change and exit 1 when behind, without writing. */
  check: boolean
  /** When the branch cannot be fast-forwarded, `git reset --hard` it onto the upstream. */
  reset: boolean
  /** Patch file whose pin comments are rewritten; undefined uses $DSH_HOME/cordis.patch.yml. */
  patch: string | undefined
}

interface Checkout {
  root: string
  /** Directory name: the pin comments in cordis.patch.yml are keyed by it. */
  name: string
  upstream: string
  branch: string
}

function git(root: string, ...args: string[]): { ok: boolean; out: string; err: string } {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' })
  if (result.error) throw result.error
  return { ok: result.status === 0, out: result.stdout.trim(), err: result.stderr.trim() }
}

let ghCredentialArgs: string[] | undefined

/**
 * Lets fetch use the `gh auth login` session. Added after the user's own helpers, so it is only a fallback,
 * and gh answers nothing for hosts it is not logged in to.
 */
function credentialArgs(): string[] {
  if (ghCredentialArgs === undefined) {
    const probe = spawnSync('gh', ['--version'], { stdio: 'ignore' })
    ghCredentialArgs = probe.error || probe.status !== 0 ? [] : ['-c', 'credential.helper=!gh auth git-credential']
  }
  return ghCredentialArgs
}

function short(hash: string): string {
  return hash.slice(0, 7)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function dshHome(env: NodeJS.ProcessEnv): string {
  return env.DSH_HOME || join(homedir(), '.dsh')
}

export function defaultPatchFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(dshHome(env), 'cordis.patch.yml')
}

/** The nearest ancestor of `start` holding a .git entry, keeping the path as written. */
function checkoutRootOf(start: string): string | undefined {
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return dir
    if (dirname(dir) === dir) return undefined
  }
}

/** Checkouts behind the patch file's `file://.../dsh/<entry>` adapter rows, wherever they live. */
function checkoutsFromPatch(patchFile: string): string[] {
  if (!existsSync(patchFile)) return []
  const roots: string[] = []
  for (const match of readFileSync(patchFile, 'utf8').matchAll(/file:\/\/(\/[^"'\s]+)/g)) {
    const entry = match[1]
    // Only adapter bundles; other file:// rows (a plugin's own dist build) are not ours to pull.
    if (entry === undefined || basename(dirname(entry)) !== 'dsh' || !existsSync(entry)) continue
    const root = checkoutRootOf(dirname(entry))
    if (root) roots.push(root)
  }
  return roots
}

/**
 * Every checkout DSH loads an adapter from: the patch file's `file://` adapter rows plus every git
 * checkout directly under $DSH_HOME/plugins-src. A checkout reached both ways is listed once.
 */
export function discoverCheckouts(env: NodeJS.ProcessEnv = process.env, patchFile = defaultPatchFile(env)): string[] {
  const source = join(dshHome(env), 'plugins-src')
  const fromSource = existsSync(source)
    ? readdirSync(source, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(join(source, entry.name, '.git')))
        .map((entry) => join(source, entry.name))
    : []
  const seen = new Set<string>()
  const roots: string[] = []
  for (const root of [...checkoutsFromPatch(patchFile), ...fromSource]) {
    const key = realpathSync(root)
    if (seen.has(key)) continue
    seen.add(key)
    roots.push(root)
  }
  return roots.sort()
}

/** The plugin version from .claude-plugin/plugin.json at the checkout root, if any. */
function pluginVersion(root: string): string | undefined {
  const manifest = join(root, '.claude-plugin', 'plugin.json')
  if (!existsSync(manifest)) return undefined
  try {
    const value: unknown = JSON.parse(readFileSync(manifest, 'utf8'))
    if (typeof value === 'object' && value !== null && 'version' in value && typeof value.version === 'string') return value.version
  } catch {
    // a broken manifest is the plugin's problem, not the updater's
  }
  return undefined
}

/** Resolve the tracking ref: the configured upstream, else origin/<branch>, else origin/HEAD. */
function resolveUpstream(root: string): { upstream: string; branch: string } {
  const tracked = git(root, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')
  if (tracked.ok && tracked.out) return { upstream: tracked.out, branch: tracked.out.replace(/^[^/]+\//, '') }
  const head = git(root, 'rev-parse', '--abbrev-ref', 'HEAD')
  if (head.ok && head.out !== 'HEAD' && git(root, 'rev-parse', '--verify', '--quiet', `origin/${head.out}`).ok) {
    return { upstream: `origin/${head.out}`, branch: head.out }
  }
  const remoteHead = git(root, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD')
  if (remoteHead.ok && remoteHead.out) return { upstream: remoteHead.out, branch: remoteHead.out.replace(/^[^/]+\//, '') }
  throw new Error(`${basename(root)}: cannot determine the upstream branch (detached HEAD?); run git checkout <branch> or git branch --set-upstream-to first`)
}

function openCheckout(directory: string): Checkout {
  const root = resolve(directory)
  const inside = git(root, 'rev-parse', '--is-inside-work-tree')
  if (!inside.ok || inside.out !== 'true') throw new Error(`${root}: not a git checkout`)
  const top = git(root, 'rev-parse', '--show-toplevel').out
  if (realpathSync(top) !== realpathSync(root)) throw new Error(`${root}: pass the checkout root (${top})`)
  const { upstream, branch } = resolveUpstream(root)
  return { root, name: basename(root), upstream, branch }
}

/** Adapter directories: every tracked dsh/bun.lock, so nested adapters are found too. */
function adapterDirectories(root: string): string[] {
  const listed = git(root, 'ls-files', '--', 'dsh/bun.lock', '**/dsh/bun.lock')
  return listed.out ? listed.out.split('\n').map((file) => join(root, dirname(file))) : []
}

function installAdapterDependencies(root: string): void {
  for (const dsh of adapterDirectories(root)) {
    const result = spawnSync('bun', ['install', '--frozen-lockfile'], { cwd: dsh, encoding: 'utf8' })
    if (result.error) throw new Error(`${dsh}: bun install failed to start: ${result.error.message}`)
    if (result.status !== 0) throw new Error(`${dsh}: bun install --frozen-lockfile failed\n${result.stderr.trim()}`)
  }
}

/**
 * Rewrite the `# <dir> <branch> <hash>` pin comment above the checkout's insert row.
 * The comment is documentation only; DSH loads whatever the checkout contains.
 * Returns false when the patch file has no pin for this checkout.
 */
export function rewritePin(patchFile: string, checkout: Checkout, hash: string, write: boolean): boolean {
  if (!existsSync(patchFile)) return false
  const lines = readFileSync(patchFile, 'utf8').split('\n')
  const pin = new RegExp(`^# ${escapeRegExp(checkout.name)} \\S+ [0-9a-f]{7,40}\\s*$`)
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (line === undefined || !pin.test(line)) continue
    const below = lines.slice(index + 1, index + 5).join('\n')
    if (!below.includes(`file://${checkout.root}/`)) continue
    const replacement = `# ${checkout.name} ${checkout.branch} ${hash}`
    if (line !== replacement && write) {
      lines[index] = replacement
      writeFileSync(patchFile, lines.join('\n'))
    }
    return true
  }
  return false
}

export function update(directories: readonly string[], options: UpdateOptions): number {
  const patchFile = options.patch ?? defaultPatchFile()
  let status = 0
  for (const directory of directories) {
    try {
      if (!updateOne(openCheckout(directory), options, patchFile)) status = 1
    } catch (error) {
      status = 1
      console.error(error instanceof Error ? error.message : String(error))
    }
  }
  return status
}

/** Returns false when the checkout is behind in --check mode. Throws when it cannot be updated. */
function updateOne(checkout: Checkout, options: UpdateOptions, patchFile: string): boolean {
  const { root, name, upstream } = checkout
  const label = `${name}:`
  const remote = upstream.split('/')[0] ?? 'origin'
  const fetch = git(root, ...credentialArgs(), 'fetch', '--quiet', remote)
  if (!fetch.ok) {
    const hint = credentialArgs().length ? '' : '\n(gh not found: install it and run gh auth login, or configure a git credential helper)'
    throw new Error(`${label} git fetch ${remote} failed\n${fetch.err}${hint}`)
  }

  const dirty = git(root, 'status', '--porcelain', '--untracked-files=no')
  if (dirty.out) throw new Error(`${label} working tree has uncommitted changes, commit or stash them first`)

  const before = git(root, 'rev-parse', 'HEAD').out
  const target = git(root, 'rev-parse', '--verify', '--quiet', upstream)
  if (!target.ok) throw new Error(`${label} unknown upstream ${upstream}`)
  const versionBefore = pluginVersion(root)
  const noPin = `, no pin comment in ${patchFile}`

  if (before === target.out) {
    // A fresh clone or a manual pull is up to date but may lack the adapter's dependencies.
    if (!options.check) installAdapterDependencies(root)
    const pinned = rewritePin(patchFile, checkout, before, !options.check)
    console.log(`${label} up to date at ${short(before)}${versionBefore ? ` (${versionBefore})` : ''}${pinned ? '' : noPin}`)
    return true
  }

  const base = git(root, 'merge-base', before, target.out)
  const fastForward = base.ok && base.out === before
  const localOnly = base.ok ? git(root, 'rev-list', '--count', `${target.out}..${before}`).out : ''

  if (options.check) {
    const behind = git(root, 'rev-list', '--count', `${before}..${target.out}`).out
    const how = fastForward ? 'fast-forward' : base.ok ? `diverged, ${localOnly} local commit(s)` : 'unrelated history, needs --reset'
    console.log(`${label} behind ${upstream} by ${behind} commit(s), ${short(before)} -> ${short(target.out)} (${how})`)
    return false
  }

  if (fastForward) {
    const merge = git(root, 'merge', '--ff-only', '--quiet', target.out)
    if (!merge.ok) throw new Error(`${label} git merge --ff-only failed\n${merge.err}`)
  } else if (options.reset) {
    const reset = git(root, 'reset', '--hard', '--quiet', target.out)
    if (!reset.ok) throw new Error(`${label} git reset --hard failed\n${reset.err}`)
  } else {
    const why = base.ok
      ? `the local branch has ${localOnly} commit(s) not on ${upstream}`
      : `local and ${upstream} share no history (the remote was rewritten)`
    throw new Error(`${label} cannot fast-forward: ${why}. Re-run with --reset to move the branch onto ${upstream} (undo: git -C ${root} reset --hard ${short(before)}).`)
  }

  installAdapterDependencies(root)
  const after = git(root, 'rev-parse', 'HEAD').out
  const pinned = rewritePin(patchFile, checkout, after, true)
  const versionAfter = pluginVersion(root)
  const versions = versionBefore || versionAfter ? ` (${versionBefore ?? '?'} -> ${versionAfter ?? '?'})` : ''
  console.log(`${label} ${short(before)} -> ${short(after)}${versions}${pinned ? '' : noPin}`)
  return true
}
