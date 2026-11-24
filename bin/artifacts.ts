import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

export const stateDir = '.claude-plugin-dsh'
export type Artifacts = { artifacts: 'build'; build: string; outputs: string[] } | { artifacts: 'release'; branch: string }
function json(file: string): unknown {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch (err) { throw new Error(`${file}: ${err}`) }
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim() && !v.includes('\0')
export function declaration(root: string): Artifacts | undefined {
  const file = join(root, 'package.json')
  if (!existsSync(file)) return
  const pkg = json(file)
  if (!object(pkg)) throw new Error(`${file}: expected an object`)
  if (!('claudePluginDsh' in pkg)) return
  const v = pkg.claudePluginDsh
  const bad = (reason: string): never => { throw new Error(`${file}: invalid claudePluginDsh: ${reason}`) }
  if (!object(v)) return bad('expected an object')
  const keys = v.artifacts === 'build' ? ['artifacts', 'build', 'outputs'] : ['artifacts', 'branch']
  if (v.artifacts !== 'build' && v.artifacts !== 'release') return bad('artifacts must be build or release')
  for (const k of Object.keys(v)) if (!keys.includes(k)) return bad(`unknown key ${k}`)
  if (v.artifacts === 'release') {
    if (!text(v.branch) || v.branch.startsWith('-') || spawnSync('git', ['check-ref-format', `refs/heads/${v.branch}`]).status !== 0) return bad('invalid release branch')
    return { artifacts: 'release', branch: v.branch }
  }
  if (!text(v.build)) return bad('build must be a nonempty command')
  const outputs = v.outputs === undefined ? [] : v.outputs
  if (!Array.isArray(outputs) || !outputs.every(p => text(p) && !isAbsolute(p) && !p.split('/').includes('..'))) return bad('outputs must be checkout-relative paths')
  return { artifacts: 'build', build: v.build, outputs }
}
export function buildArtifacts(root: string, head: string, spec: Extract<Artifacts, { artifacts: 'build' }>, check: boolean, ignoreState: () => void, changed: () => void): boolean {
  const dir = join(root, stateDir), file = join(dir, 'build.json')
  const stamp = existsSync(file) ? json(file) : undefined
  if (stamp !== undefined && (!object(stamp) || !text(stamp.head) || !text(stamp.command) || !text(stamp.builtAt))) throw new Error(`${file}: malformed build stamp`)
  const missing = () => spec.outputs.filter(p => !existsSync(join(root, p)))
  if (object(stamp) && stamp.head === head && stamp.command === spec.build && !missing().length) return true
  if (check) {
    console.log(`${root}: ${object(stamp) ? `build stale (built ${String(stamp.head).slice(0, 7)}, HEAD ${head.slice(0, 7)})` : 'never built'}`)
    return false
  }
  ignoreState()
  const run = (cmd: string, args: string[]) => {
    const r = spawnSync(cmd, args, { cwd: root, encoding: 'utf8' })
    if (r.error || r.status !== 0) throw new Error(`${root}: built output stale: ${cmd} failed (${r.status ?? r.signal}): ${r.error?.message ?? r.stderr.trim().slice(-2048)}`)
  }
  if (existsSync(join(root, 'bun.lock'))) run('bun', ['install', '--frozen-lockfile'])
  run('sh', ['-c', spec.build])
  const absent = missing()
  if (absent.length) throw new Error(`${root}: built output stale: missing ${absent.join(', ')}`)
  mkdirSync(dir, { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ head, builtAt: new Date().toISOString(), command: spec.build }) + '\n')
  renameSync(tmp, file)
  changed()
  return true
}
