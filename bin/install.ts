import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function install(directories: readonly string[], check: boolean): number {
  const profilesDir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles')
  const profiles = readdirSync(profilesDir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
  if (!profiles.length) throw new Error(`No existing profiles in ${profilesDir}`)
  const adapters = directories.map(directory => {
    const dir = realpathSync(join(directory, 'dsh'))
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    if (typeof pkg.name !== 'string' || !/^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/.test(pkg.name) || !pkg.dsh?.bundle?.patch) throw new Error(`Not a named DSH bundle: ${dir}`)
    return { name: pkg.name as string, dir }
  })
  if (new Set(adapters.map(a => a.name)).size !== adapters.length) throw new Error('Duplicate adapter package name')
  const plans = profiles.map(profile => {
    const dir = join(profilesDir, profile)
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    if (!Array.isArray(manifest.dsh?.profile?.bundles)) throw new Error(`Invalid DSH profile: ${dir}`)
    const specs: string[] = []
    for (const adapter of adapters) {
      const existing = manifest.dependencies?.[adapter.name]
      if (existing !== undefined) {
        if (typeof existing !== 'string' || !existing.startsWith('link:') || realpathSync(join(dir, 'node_modules', adapter.name)) !== adapter.dir) throw new Error(`${profile}: conflicting installation of ${adapter.name}`)
        continue // Do not re-enable a bundle the user turned off.
      }
      specs.push(`${adapter.name}@link:${adapter.dir}`)
    }
    return { profile, specs }
  })
  for (const { profile, specs } of plans) {
    console.log(`${profile}: ${specs.length ? specs.join(', ') : 'already installed'}`)
    if (check || !specs.length) continue
    const result = spawnSync('dsh', ['plugin', '--profile', profile, 'add', ...specs], { stdio: 'inherit' })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`${profile}: dsh plugin add failed (${result.signal ?? result.status})`)
    const profileDir = join(profilesDir, profile)
    const saved = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    for (const { name, dir } of adapters) {
      if (!Object.hasOwn(saved.dependencies ?? {}, name) || realpathSync(join(profileDir, 'node_modules', name)) !== dir || (specs.includes(`${name}@link:${dir}`) && !saved.dsh?.profile?.bundles?.includes(name))) throw new Error(`${profile}: registration not confirmed for ${name}`)
    }
  }
  return 0
}
