# claude-plugin-dsh

Run an unmodified [Claude Code](https://docs.claude.com/en/docs/claude-code) plugin inside
[DeepSeek Harness](https://github.com/deepseek-ai) (DSH).

You add a `dsh/` directory next to the plugin's `.claude-plugin/`. It holds a small DSH
bundle and a copy of `claude-compat.js`. The bundle reads the plugin's own skills, commands,
agents, hooks and instruction files and wires them into DSH. Claude Code never reads `dsh/`,
so the same tree keeps working in both harnesses. The vendored runtime is refreshed with
`sync`, not by hand.

TypeScript sources, compiled JavaScript and declarations. The vendored runtime is one file
with no runtime dependencies. Node 20 or newer; hooks require a POSIX shell.

Install the package:

```sh
bun add claude-plugin-dsh
```

`bun x claude-plugin-dsh` runs the CLI without installing it.
The old `claude-plugins-dsh` command name still works as an alias.

Adapters may import `createPlugin` and `rootFrom` directly, or vendor the built runtime as
shown below. Direct imports receive types; vendored copies stay self-contained and must be
updated with `sync`.

## What maps to what

| Claude Code | DSH |
|---|---|
| `skills/<n>/SKILL.md` | skill at rank 450, so a same-named skill in `~/.dsh/skills` still wins |
| `commands/<n>.md` | `/<plugin>-<n>` slash command (prefix configurable); the body, with `$ARGUMENTS` and `$1` to `$9`, becomes the next turn |
| `agents/<n>.md` | skill `<plugin>-agent-<n>`: a role brief to pass to `subagent` or `spawn_teammate` |
| `CLAUDE.md`-style files you list | system prompt section, with `<!--harness:claude-only-->` blocks removed |
| `PreToolUse` hook | `tools/pre-execute`; `ask` becomes a DSH approval, `deny` or exit 2 denies, `updatedInput` is denied because DSH cannot rewrite arguments |
| `PostToolUse` hook | `tools/post-execute`; exit 2 blocks the result and its stderr becomes the feedback, `additionalContext` rides on the decision |
| `SessionStart` hook | `agent/created` of a root agent (subagents skipped, as in Claude Code) |
| `UserPromptSubmit` hook | a step carrying a user message; a block keeps the prompt from the model |
| `Stop`, `SubagentStop` hooks | `agent/turn-stopping`; `{"decision":"block"}` steers one more step |
| `SessionEnd` hook | `agent/disposed` |
| `.mcp.json` | not handled here: add `@deepseek-ai/dsh-mcp-client` rows to the bundle patch |

Hooks get Claude Code's stdin JSON: `session_id`, `cwd`, `hook_event_name`, `tool_name` using
Claude names such as `Bash`, `tool_input`, `stop_hook_active` and `transcript_path`.
`tool_response` uses Claude's per-tool shape: `stdout` and `stderr` for Bash, `file.content`
for Read, `filePath` plus edit strings for Write and Edit, and `filenames` for Glob. Their
environment has `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PROJECT_DIR`, plus `CLAUDE_HARNESS=dsh` so a
script can tell the two harnesses apart. A hook with `args` runs in exec form, as in Claude Code: `command` is spawned directly with those arguments and no shell, and `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PROJECT_DIR}` are replaced inside each argument as plain text. `onFailure: "block"` makes a crash, a timeout or an exit code other than 0 and 2 count as a block. Matching hooks run in parallel, each in its own process
group. A timeout or a cancelled turn kills the whole group.

`transcript_path` points at a Claude-shaped JSONL export of the DSH session under
`$DSH_HOME/state/claude-compat/transcripts/`. It is mode 0600, grows by appending, and is
deleted when the agent is disposed.

Not mapped: function hooks (`hooks.json` `modules`), `PreCompact`, `Notification`, LSP
servers, and per-agent model pins.

## Add it to a plugin

```sh
bun x claude-plugin-dsh scaffold --scope @you /path/to/plugin
```

`scaffold` writes `dsh/package.json` (package `@you/<plugin>-dsh`, or `<plugin>-dsh` without
`--scope`), `dsh/locale/en.json` and the runtime copy. You write two small files yourself.

`dsh/index.js`:

```js
import { createPlugin, rootFrom } from './claude-compat.js'

const plugin = createPlugin({
  root: rootFrom(import.meta.url),
  // all optional:
  instructions: ['CLAUDE.md'],          // files to put in the system prompt
  skills: { exclude: [], prefix: '' },  // prefix renames x to <prefix>-x; '' keeps x
  commands: { exclude: [], prefix: '' },// default is the plugin name; '' gives /<n>
  agents: { exclude: [], extraDirs: [] },
  hooks: { events: ['PreToolUse'] },    // limit which hook events run
  disableByDefault: [],                 // skills | commands | agents | instructions | hooks
})
export const { name, apply } = plugin
export default plugin
```

`dsh/cordis.patch.yml`:

```yaml
- insert:
    - id: claude-compat-my-plugin
      name: '@you/my-plugin-dsh'   # the name in dsh/package.json
```

Check what it registers without starting DSH:

```sh
bun x claude-plugin-dsh inspect /path/to/plugin
```

## Install into DSH

Through DSH's plugin manager:

```sh
dsh plugin --profile web add file:/abs/path/to/plugin/dsh
```

Or for every profile, add a row to `~/.dsh/cordis.patch.yml`. DSH picks it up without a restart:

```yaml
- insert:
    - id: claude-compat-my-plugin
      name: "file:///abs/path/to/plugin/dsh/index.js"
```

A row config can turn parts off: `config: { disable: [hooks] }`.

## Updating installed plugins

When adapters are loaded from git checkouts under `$DSH_HOME/plugins-src` (one row per
checkout in `~/.dsh/cordis.patch.yml`), `update` brings them to their upstream branch:

```sh
bun x claude-plugin-dsh update                  # every checkout under $DSH_HOME/plugins-src
bun x claude-plugin-dsh update --check          # report what is behind, write nothing, exit 1 if any
bun x claude-plugin-dsh update ~/.dsh/plugins-src/design-studio
```

For each checkout it fetches, fast-forwards the current branch onto its tracking ref
(`origin/<branch>` when none is configured), runs `bun install --frozen-lockfile` in every
tracked `dsh/` directory, and rewrites the `# <dir> <branch> <hash>` comment above the
checkout's row in the patch file. That comment is a note for people; DSH loads the checkout
as it is on disk. A dirty working tree stops the update for that checkout.

Private HTTPS remotes fetch with your `gh auth login` session when `gh` is on `PATH`. It is
tried after any credential helper you configured. SSH remotes use your SSH keys as usual.

When the remote history was rewritten and the branch cannot be fast-forwarded, `update`
refuses and prints the undo command. `--reset` moves the branch onto the upstream with
`git reset --hard` instead; local commits that are not upstream are dropped from the branch
but stay in the reflog. `--patch <file>` rewrites pins in a different file.

Restart DSH afterwards so it loads the new version.

## Keeping vendored copies current

```sh
bun x claude-plugin-dsh sync plugin-a plugin-b
bun x claude-plugin-dsh sync --check plugin-a plugin-b
```

## Development

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
bun pm pack
```

`bun run build` compiles the typed modules and CLI, emits declarations, and bundles
`dist/claude-compat.js` for existing adapters. Generated files are not committed.
`bun run test` runs the Node compatibility suite against the compiled runtime and CLI.
`prepack` builds before packaging.

Publishing requires npm access to the `claude-plugin-dsh` package:

```sh
bun publish
```

`prepublishOnly` runs type checking and tests before publication. Do not put registry tokens
in the repository. Run `inspect` only on trusted plugins: it imports their JavaScript.

## Used by

The [kolezka](https://github.com/kolezka/marketplace) Claude Code plugins.

## License

MIT
