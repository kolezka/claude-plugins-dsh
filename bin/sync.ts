import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { runtimePath } from './runtime.js'

export function sync(directories: readonly string[], check: boolean): number {
  const canonical = readFileSync(runtimePath)
  let status = 0
  for (const directory of directories) {
    const dsh = resolve(directory, 'dsh')
    const destination = join(dsh, 'claude-compat.js')
    if (check) {
      if (!existsSync(destination) || !canonical.equals(readFileSync(destination))) {
        console.log(`drift: ${destination}`)
        status = 1
      }
    } else {
      mkdirSync(dsh, { recursive: true })
      copyFileSync(runtimePath, destination)
      console.log(`synced: ${destination}`)
    }
  }
  return status
}
