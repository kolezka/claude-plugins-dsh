#!/usr/bin/env node
import { inspect } from './inspect.js'
import { scaffold } from './scaffold.js'
import { sync } from './sync.js'
import { discoverCheckouts, update } from './update.js'

const usage = `Usage: claude-plugin-dsh <command> [options] <plugin-dir>...

Commands:
  scaffold [--scope @you] <plugin-dir>...  Generate manifest, locale and runtime
  inspect <plugin-dir>...                List plugin registrations (loads plugin code)
  sync [--check] <plugin-dir>...          Copy runtime, or check for drift
  update [--check] [--reset] [--patch <file>] [<checkout-dir>...]
                                        Pull adapter checkouts, install their dsh/ dependencies and
                                        refresh the pin comments in cordis.patch.yml. Without directories,
                                        every checkout behind a file:// adapter row in the patch file and
                                        every checkout under $DSH_HOME/plugins-src is updated.

Options:
  -h, --help                            Show help
`

class UsageError extends Error {}

async function main(args: readonly string[]): Promise<number> {
  const [command, ...rest] = args
  if ((command === '-h' || command === '--help') && rest.length === 0) {
    console.log(usage)
    return 0
  }
  if (command !== 'scaffold' && command !== 'inspect' && command !== 'sync' && command !== 'update') {
    throw new UsageError(command ? `Unknown command: ${command}` : 'A command is required')
  }
  if (rest.length === 1 && (rest[0] === '-h' || rest[0] === '--help')) {
    console.log(usage)
    return 0
  }
  let scope: string | undefined
  let check = false
  let reset = false
  let patch: string | undefined
  let positional = false
  const directories: string[] = []
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]
    if (arg === undefined) continue
    if (!positional && arg === '--') {
      positional = true
    } else if (!positional && arg === '--scope' && command === 'scaffold') {
      if (scope !== undefined) throw new UsageError('--scope may only be supplied once')
      scope = rest[++index]
      if (scope === undefined || !/^@[a-z0-9][a-z0-9._-]*$/.test(scope)) {
        throw new UsageError(`--scope must look like @name, got ${JSON.stringify(scope)}`)
      }
    } else if (!positional && arg === '--check' && (command === 'sync' || command === 'update')) {
      if (check) throw new UsageError('--check may only be supplied once')
      check = true
    } else if (!positional && arg === '--reset' && command === 'update') {
      if (reset) throw new UsageError('--reset may only be supplied once')
      reset = true
    } else if (!positional && arg === '--patch' && command === 'update') {
      if (patch !== undefined) throw new UsageError('--patch may only be supplied once')
      patch = rest[++index]
      if (patch === undefined || patch.startsWith('-')) throw new UsageError('--patch requires a file path')
    } else if (!positional && arg.startsWith('-')) {
      throw new UsageError(`Unknown option for ${command}: ${arg}`)
    } else {
      directories.push(arg)
    }
  }
  if (command === 'update') {
    if (check && reset) throw new UsageError('--check and --reset cannot be combined')
    const targets = directories.length ? directories : discoverCheckouts(process.env, patch)
    if (!targets.length) {
      throw new UsageError('update found no checkouts in the patch file or under $DSH_HOME/plugins-src; pass directories explicitly')
    }
    return update(targets, { check, reset, patch })
  }
  if (!directories.length) throw new UsageError(`${command} requires at least one plugin directory`)
  if (command === 'scaffold') {
    scaffold(directories, scope ?? '')
    return 0
  }
  if (command === 'sync') return sync(directories, check)
  return inspect(directories)
}

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  if (error instanceof UsageError) console.error(usage)
  process.exitCode = error instanceof UsageError ? 64 : 1
}
