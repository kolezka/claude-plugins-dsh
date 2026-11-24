import { spawnSync } from 'node:child_process'
import { buildArtifacts, declaration, stateDir } from './artifacts.js'
import { appendFileSync, mkdirSync, existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
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
  for (const match of readFileSync(patchFile, 'utf8').matchAll(/(?:"file:\/\/(\/[^"\n]+)"|'file:\/\/(\/[^'\n]+)'|file:\/\/(\/[^"'\s]+))/g)) {
    const entry = match[1] ?? match[2] ?? match[3]
    // Only adapter bundles; other file:// rows (a plugin's own dist build) are not ours to pull.
    if (entry === undefined || basename(dirname(entry)) !== 'dsh' || !existsSync(entry)) continue
    const root = checkoutRootOf(dirname(entry))
    if (root) roots.push(basename(root) === 'release' && basename(dirname(root)) === stateDir ? dirname(dirname(root)) : root)
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
  const fromProfiles: string[] = []
  const profiles = join(dshHome(env), 'profiles')
  for (const entry of existsSync(profiles) ? readdirSync(profiles, { withFileTypes: true }) : []) {
    if (!entry.isDirectory()) continue
    const dir = join(profiles, entry.name)
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    for (const spec of Object.values(manifest.dependencies ?? {})) {
      if (typeof spec !== 'string' || !spec.startsWith('link:')) continue
      const adapter = resolve(dir, spec.slice(5))
      if (basename(adapter) !== 'dsh' || !existsSync(join(dirname(adapter), '.claude-plugin', 'plugin.json'))) continue
      const root = checkoutRootOf(adapter)
      if (root) fromProfiles.push(root)
    }
  }
  const seen = new Set<string>()
  const roots: string[] = []
  for (const root of [...checkoutsFromPatch(patchFile), ...fromSource, ...fromProfiles]) {
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

function checkedGit(root: string, ...args: string[]): string {
  const result = git(root, ...args)
  if (!result.ok) throw new Error(`${root}: git ${args.join(' ')} failed\n${result.err}`)
  return result.out
}

function ignoreState(root: string): void {
  if (git(root, 'check-ignore', '-q', `${stateDir}/build.json`).ok && git(root, 'check-ignore', '-q', `${stateDir}/release`).ok) return
  const exclude = resolve(root, checkedGit(root, 'rev-parse', '--git-path', 'info/exclude'))
  mkdirSync(dirname(exclude), { recursive: true })
  appendFileSync(exclude, `\n/${stateDir}/\n`)
}

function releasePatch(checkout: Checkout, patch: string, wt: string, branch: string, head: string, restore = false): string {
  const lines = readFileSync(patch, 'utf8').split('\n')
  const start = lines.indexOf('# KOLEZKA_DSH_ADAPTERS_START'), end = lines.indexOf('# KOLEZKA_DSH_ADAPTERS_END')
  let matched = false
  for (let i = start + 1; start >= 0 && i < end; i++) {
    const match = /^(\s*name:\s*["']?)file:\/\/(.*?)(["']?\s*)$/.exec(lines[i]!)
    if (!match) continue
    const path = match[2]!
    const prefix = path.startsWith(`${wt}/`) ? wt : checkout.root
    if (!path.startsWith(`${prefix}/`)) continue
    const suffix = path.slice(prefix.length)
    if (!/\/dsh\/[^/]+$/.test(suffix)) continue
    if (restore && prefix !== wt) continue
    const route = join(restore ? checkout.root : wt, suffix)
    if (!existsSync(route)) throw new Error(`missing release adapter: ${route}`)
    lines[i] = `${match[1]}file://${route}${match[3]}`
    const pin = new RegExp(`^# ${escapeRegExp(checkout.name)} \\S+ [0-9a-f]{7,40}\\s*$`)
    const j = i - 3
    const comment = `# ${checkout.name} ${branch} ${head}`
    if (j > start && pin.test(lines[j]!)) lines[j] = comment
    else if (!restore) throw new Error(`${patch}: missing pin comment above release adapter ${path}`)
    matched = true
  }
  if (!matched && !restore) throw new Error(`${patch}: no managed release adapter row for ${checkout.root}`)
  return lines.join('\n')
}

function deliver(checkout: Checkout, head: string, options: UpdateOptions, patch: string, remote: string, changed: () => void): { pinned: boolean } | undefined {
  const { root } = checkout
  const spec = declaration(root)
  if (spec?.artifacts !== 'release') {
    if (spec && !buildArtifacts(root, head, spec, options.check, () => ignoreState(root), changed)) return
    if (!options.check) installAdapterDependencies(root)
    const wt = join(root, stateDir, 'release')
    if (existsSync(wt) && existsSync(patch)) {
      const restored = releasePatch(checkout, patch, wt, checkout.branch, head, true)
      if (restored !== readFileSync(patch, 'utf8')) {
        if (options.check) { console.log(`${root}: adapter still routed to release worktree`); return }
        writeFileSync(patch, restored)
        changed()
      }
    }
    return { pinned: rewritePin(patch, checkout, head, !options.check) }
  }
  const ref = `refs/remotes/${remote}/${spec.branch}`, target = checkedGit(root, 'rev-parse', '--verify', `${ref}^{commit}`)
  const wt = join(root, stateDir, 'release')
  let current: string | undefined
  if (existsSync(wt)) {
    if (realpathSync(checkedGit(wt, 'rev-parse', '--show-toplevel')) !== realpathSync(wt) || realpathSync(checkedGit(wt, 'rev-parse', '--path-format=absolute', '--git-common-dir')) !== realpathSync(checkedGit(root, 'rev-parse', '--path-format=absolute', '--git-common-dir'))) throw new Error(`${wt}: not a release worktree of ${root}`)
    if (checkedGit(wt, 'status', '--porcelain', '--untracked-files=no')) throw new Error(`${wt}: release worktree has uncommitted changes`)
    current = checkedGit(wt, 'rev-parse', 'HEAD')
  }
  if (current !== target) {
    if (options.check) { console.log(`${root}: release stale (${spec.branch} ${short(target)})`); return }
    if (current && !git(wt, 'merge-base', '--is-ancestor', current, target).ok && !options.reset) throw new Error(`${wt}: cannot fast-forward release; re-run with --reset`)
    ignoreState(root)
    if (current) checkedGit(wt, 'checkout', '--detach', target)
    else checkedGit(root, 'worktree', 'add', '--detach', wt, target)
    changed()
  }
  const replacement = releasePatch(checkout, patch, wt, spec.branch, target)
  if (!options.check) installAdapterDependencies(wt)
  if (replacement !== readFileSync(patch, 'utf8')) {
    if (options.check) { console.log(`${root}: release adapter route or pin stale`); return }
    writeFileSync(patch, replacement)
    changed()
  }
  return { pinned: true }
}

export function update(directories: readonly string[], options: UpdateOptions): number {
  const patchFile = options.patch ?? defaultPatchFile()
  let changed = false
  const markChanged = () => { changed = true }
  let status = 0
  for (const directory of directories) {
    try {
      if (!updateOne(openCheckout(directory), options, patchFile, markChanged)) status = 1
    } catch (error) {
      status = 1
      console.error(error instanceof Error ? error.message : String(error))
    }
  }
  if (changed) console.log('DSH loads adapters only at startup; restart DSH to load the changed checkout(s).')
  return status
}

/** Returns false when the checkout is behind in --check mode. Throws when it cannot be updated. */
function updateOne(checkout: Checkout, options: UpdateOptions, patchFile: string, changed: () => void): boolean {
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

  const base = git(root, 'merge-base', before, target.out)
  const ahead = base.ok && base.out === target.out && before !== target.out
  if (before === target.out || ahead) {
    // A fresh clone or a manual pull is up to date but may lack the adapter's dependencies.
    const delivery = deliver(checkout, before, options, patchFile, remote, changed)
    if (!delivery) return false
    const { pinned } = delivery
    const aheadNote = ahead ? `, ahead of ${upstream} by ${git(root, 'rev-list', '--count', `${target.out}..${before}`).out} commit(s)` : ''
    console.log(`${label} up to date at ${short(before)}${versionBefore ? ` (${versionBefore})` : ''}${aheadNote}${pinned ? '' : noPin}`)
    return true
  }

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

  changed()
  const after = checkedGit(root, 'rev-parse', 'HEAD')
  const delivery = deliver(checkout, after, options, patchFile, remote, changed)
  if (!delivery) return false
  const { pinned } = delivery
  const versionAfter = pluginVersion(root)
  const versions = versionBefore || versionAfter ? ` (${versionBefore ?? '?'} -> ${versionAfter ?? '?'})` : ''
  console.log(`${label} ${short(before)} -> ${short(after)}${versions}${pinned ? '' : noPin}`)
  return true
}
