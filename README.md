# @kolezka/claude-plugins-dsh

Run an unmodified [Claude Code](https://docs.claude.com/en/docs/claude-code) plugin inside
[DeepSeek Harness](https://github.com/deepseek-ai) (DSH).

You add a `dsh/` directory next to the plugin's `.claude-plugin/`. It holds a small DSH
bundle and a copy of `claude-compat.js`. The bundle reads the plugin's own skills, commands,
agents, hooks and instruction files and wires them into DSH. Claude Code never reads `dsh/`,
so the same tree keeps working in both harnesses. The vendored runtime is refreshed with
`sync`, not by hand.

TypeScript sources, compiled JavaScript and declarations. The vendored runtime is one file
with no runtime dependencies. Node 20 or newer; hooks require a POSIX shell.

The npm package is not published yet. Until the first release, build it from a checkout:

```sh
git clone https://github.com/kolezka/claude-plugins-dsh
cd claude-plugins-dsh
pnpm install --frozen-lockfile
pnpm run build
```

From that checkout, `pnpm add file:/path/to/claude-plugins-dsh` gives typed imports, and
`node dist/bin/cli.js` runs the CLI. Replace every `pnpm dlx @kolezka/claude-plugins-dsh`
below with that `node` command until the package is on npm.

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
script can tell the two harnesses apart. Matching hooks run in parallel, each in its own process
group. A timeout or a cancelled turn kills the whole group.

`transcript_path` points at a Claude-shaped JSONL export of the DSH session under
`$DSH_HOME/state/claude-compat/transcripts/`. It is mode 0600, grows by appending, and is
deleted when the agent is disposed.

Not mapped: function hooks (`hooks.json` `modules`), `PreCompact`, `Notification`, LSP
servers, and per-agent model pins.

## Add it to a plugin

```sh
pnpm dlx @kolezka/claude-plugins-dsh scaffold --scope @you /path/to/plugin
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
pnpm dlx @kolezka/claude-plugins-dsh inspect /path/to/plugin
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

## Keeping vendored copies current

```sh
pnpm dlx @kolezka/claude-plugins-dsh sync plugin-a plugin-b
pnpm dlx @kolezka/claude-plugins-dsh sync --check plugin-a plugin-b
```

## Development

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
pnpm pack
```

`pnpm run build` compiles the typed modules and CLI, emits declarations, and bundles
`dist/claude-compat.js` for existing adapters. Generated files are not committed.
Tests run against the compiled runtime and CLI. `prepack` builds before packaging.

Publishing requires npm access to the `kolezka` scope:

```sh
npm login
npm publish --access public
```

`prepublishOnly` runs type checking and tests before publication. Do not put registry tokens
in the repository. Run `inspect` only on trusted plugins: it imports their JavaScript.

## Used by

The [kolezka](https://github.com/kolezka/marketplace) Claude Code plugins.

## License

MIT
