#!/usr/bin/env node
import { inspect } from './inspect.js'
import { scaffold } from './scaffold.js'
import { sync } from './sync.js'

const usage = `Usage: claude-plugins-dsh <command> [options] <plugin-dir>...

Commands:
  scaffold [--scope @you] <plugin-dir>...  Generate manifest, locale and runtime
  inspect <plugin-dir>...                List plugin registrations (loads plugin code)
  sync [--check] <plugin-dir>...          Copy runtime, or check for drift

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
  if (command !== 'scaffold' && command !== 'inspect' && command !== 'sync') {
    throw new UsageError(command ? `Unknown command: ${command}` : 'A command is required')
  }
  if (rest.length === 1 && (rest[0] === '-h' || rest[0] === '--help')) {
    console.log(usage)
    return 0
  }
  let scope: string | undefined
  let check = false
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
    } else if (!positional && arg === '--check' && command === 'sync') {
      if (check) throw new UsageError('--check may only be supplied once')
      check = true
    } else if (!positional && arg.startsWith('-')) {
      throw new UsageError(`Unknown option for ${command}: ${arg}`)
    } else {
      directories.push(arg)
    }
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
