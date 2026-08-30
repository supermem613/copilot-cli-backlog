# backlog

A GitHub Copilot CLI extension that gives each workspace a **persistent queue backlog** with deterministic slash commands, passive in-conversation tools the agent can call, an agentic-first `backlog` CLI, and a chromeless sidecar viewer for queue control.

Backlog is passive queue state. You can `/backlog add` something while the agent is working, inspect the queue with `/backlog list`, and use the sidecar window to view or edit items without injecting prompts into the active session.

Backlog persists queues and items in a SQLite database at `~/.backlog/backlog.db` (zero deps — uses Node 24's built-in `node:sqlite`), so items survive restarts without storing Copilot session rows.

Backlog queues are resolved from the current workspace directory. A queue can have one or more directory bindings, usually the local repo path. Item commands and tools use the bound queue automatically, including from sidequest or worktree paths when Git or `sd status` reports the sidequest `mainRepo` root. Remote URLs, owners, repo names, and branch names are not stored as queue identity.

## Install

### 1. Enable experimental Copilot CLI extensions

In a Copilot CLI session:

```
/experimental
```

Enable the **Extensions** feature. If your Copilot CLI version does not show that option, add `"EXTENSIONS"` to `experimental_flags` in `~/.copilot/config.json` and restart.

### 2. Install the plugin from GitHub

```
copilot plugin install supermem613/backlog
```

Verify:

```
copilot plugin list
```

### 3. Enable the `/backlog` extension

The plugin install puts the package on disk. The `/backlog` command and sidecar are loaded as a Copilot CLI SDK extension discovered from the user extensions folder.

Easiest path — in a Copilot CLI session, run:

```
Use the backlog-install skill to enable the /backlog command.
```

The skill installs a small user-scoped delegate at `~/.copilot/extensions/backlog/extension.mjs` that imports the SDK extension from the plugin install location.

If you prefer to do it by hand, paste this into your shell after `copilot plugin install` completes:

PowerShell:

```powershell
$installer = Get-ChildItem "$env:USERPROFILE\.copilot\installed-plugins" -Directory -Recurse |
  Where-Object { Test-Path (Join-Path $_.FullName "scripts\install-extension-shim.mjs") } |
  Select-Object -First 1 -ExpandProperty FullName

if (-not $installer) { throw "Could not find installed backlog plugin." }

node (Join-Path $installer "scripts\install-extension-shim.mjs")
```

Bash/zsh:

```bash
installer="$(find "$HOME/.copilot/installed-plugins" -type f -path '*/scripts/install-extension-shim.mjs' | head -n 1)"
if [ -z "$installer" ]; then echo "Could not find installed backlog plugin." >&2; exit 1; fi
node "$installer"
```

In Copilot CLI:

```
/extensions
```

Enable `backlog` under **User**. Then run `/backlog list` to confirm.

## Use

### Slash commands

```
/backlog add <description>          # append a new item
/backlog add --top <description>    # add as position 1
/backlog list [queue-id] [--status <value>] # show items in the resolved or named queue (default pending-only)
/backlog move <id-or-position> <position|top|bottom> # reorder an item
/backlog done <id-or-position>      # mark complete
/backlog remove <id-or-position>    # delete without completing
/backlog edit <id-or-position> <new-description>
/backlog pending                    # count of pending items
/backlog status                     # inspect queue binding for this workspace
/backlog init [queue-id] [name]     # create or bind a queue for this workspace
/backlog clear                      # delete every item in the resolved queue
/backlog queue list                 # list queues and their bindings
/backlog queue add <queue-id> [name] # create a queue
/backlog queue edit <queue-id> <description>
/backlog queue rename <queue-id> <new-name>
/backlog show                       # open the sidecar window
/backlog approve <id>               # approve an autonomous item to start
/backlog review                     # list autonomous outputs waiting for review
/backlog review <id> approve|reject # accept or reject an autonomous item output
/backlog backup [path]              # export a checksum-protected JSON backup
/backlog restore <path>             # verify checksum and restore a JSON backup
/backlog doctor                     # show runtime provenance and run delete smoke check
```

Items can be referenced by short ID (e.g. `t1a2b3`) or by position number (e.g. `2`).
Use `/backlog list` to see the current workspace queue, or `/backlog list <queue-id>` to inspect a specific queue from `/backlog queue list`. The first listed item is the next pending item.
Add `--status <value>` to inspect a different status; omitting it keeps the default pending-only view. Use `--status done` for done items. Unknown status values and `--status` without a value are rejected loudly instead of returning an empty list.
Use `/backlog move <item> <position|top|bottom>` to reorder a queue.

Unsupported `backlog add` CLI flags are rejected with usage guidance before any item is stored, so the queue stays unchanged.

The current workspace queue is the workspace-resolved queue for the command's `cwd`. Backlog is passive: it stores queue items and does not track live sessions or push work into Copilot.

`/backlog status` is read-only. It reports the selected `queueId`, queue bindings, item counts, match type (`exact`, `worktree-origin`, `ancestor`, or `default`), and any ambiguous candidates. Use it to confirm what workspace-resolved queue Copilot CLI will operate on before adding, draining, or starting work.

Run `/backlog init` or `backlog init` from a repo directory to create or reuse a queue named after that directory and bind it. For `C:\Users\marcusm\repos\soda`, the single command is `backlog init`, which creates queue `soda` and binds that local repo path. You can override the id and name with `backlog init <queue-id> <name>`.

`/backlog doctor` reports the loaded extension path, package version, git commit, storage status, and runs an item delete smoke check. Use it after upgrades or extension reloads to confirm the running extension is the one you expect.

### CLI

The package also installs a `backlog` CLI that mirrors the slash command surface for automation and local tests:

```
backlog
backlog commands
backlog queues
backlog queue <queue-id>
backlog queue <queue-id> list
backlog status
backlog init
backlog list <queue-id> --status done
backlog add "write the next test" --cwd C:\path\to\repo
backlog schema
```

`backlog` and `backlog commands` return the CLI command catalog as structured entries with CLI usage. `backlog queues` returns every queue with total and per-status item counts. `backlog queue <queue-id>` returns the queue plus all of its items, including status, priority, timestamps, POR context, and active lease details when present. The equivalent `backlog queue list <queue-id>` and `backlog queue <queue-id> list` forms are also accepted. Use `backlog queue list <queue-id>` when a queue id matches a mutation verb such as `add` or `rename`.

Use `backlog list <queue-id> [--status <value>]` to inspect a specific status; omit `--status` to keep the default pending-only view. Every CLI command now rejects unrecognized dash-prefixed arguments with a non-zero exit, including `--status` without a value or unsupported status values.

Use `--cwd <path>` to resolve the queue for a workspace directory. Named queue reads do not require a workspace binding. Use `--db-dir <path>` in tests or automation when you need an isolated backlog database. Every CLI command writes a stable JSON envelope with `ok`, `command`, `schemaVersion`, `data`, and `timingMs`.

Typed CLI data in `data` follows the command shape: `backlog add` returns `data.item` with `id`, `description`, and `position`; `backlog list` returns `data.queueId` and `data.items`; and `backlog edit` returns `data.item`. Supported domain failures return `ok: false`, `data.error`, and process exit code `1`, while successful commands may retain `data.output` display text.

### Agent-callable tools

The agent automatically gets these passive tools:

- `backlog_list` — list all pending items.
- `backlog_done` — mark an item complete by item id or position. Pass it as `ref`; `id` is accepted as an alias for the same value.
- `backlog_status` — inspect which queue is bound to the current workspace.

Tools accept `cwd` when the agent needs to inspect or operate on a specific workspace. If no `cwd` is available, or if no queue binding resolves for that workspace, item operations fail closed instead of silently using a fallback queue. `backlog_done` validates its item reference in the handler and returns a message naming the cause, so a missing argument, a conflicting `ref`/`id` pair, and an unknown item stay distinguishable from one another. Add, edit, remove, move, and next-work selection stay explicit user actions through `/backlog ...` or `backlog ...`, not automatic agent-callable tools.

### Permission prompts

Backlog avoids elevated extension capabilities: it does not skip tool permissions, register lifecycle hooks, or handle permission requests. The agent-callable tools may still ask for normal per-tool approval under Copilot CLI's standard tool-permission flow.

### Sidecar viewer

`/backlog show` opens a chromeless sidecar window — `msedge --app=` on Windows; falls back to the default browser elsewhere. The viewer groups work by explicit queue and exposes passive add, edit, reorder, delete, and refresh controls.

The top bar shows the loaded package version, git commit, and storage status. Hover it to see the exact extension and package paths.

A single sidecar window is shared across **all** Copilot CLI sessions on the machine — owner election happens via a lock file at `~/.backlog/viewer.lock`. If the owning session goes away, another active session takes over automatically. When you close the viewer window it stays closed across that handoff: a session taking over ownership will not reopen it. It reopens only when a new pending item is added or you run `/backlog show`.

## Develop

```bash
git clone https://github.com/supermem613/backlog.git
cd backlog
npm run check    # node --check on every .mjs
npm test         # run the extension test suite
```

To run your local working tree as the live extension (instead of the installed plugin), drop a one-line shim at `~/.copilot/extensions/backlog/extension.mjs` that dynamic-imports your working tree. **Do not** point the directory itself at the working tree with a junction or symlink — Copilot CLI's extension loader does not pick those up.

```powershell
# Windows
$ext = "$env:USERPROFILE\.copilot\extensions\backlog"
Remove-Item $ext -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $ext | Out-Null
$target = "$PWD\.github\extensions\backlog\extension.mjs"
@"
import { pathToFileURL } from "node:url";
await import(pathToFileURL($($target | ConvertTo-Json)).href);
"@ | Set-Content -Path "$ext\extension.mjs" -NoNewline
```

```bash
# macOS / Linux
ext="$HOME/.copilot/extensions/backlog"
rm -rf "$ext"
mkdir -p "$ext"
target="$PWD/.github/extensions/backlog/extension.mjs"
cat > "$ext/extension.mjs" <<EOF
import { pathToFileURL } from "node:url";
await import(pathToFileURL("$target").href);
EOF
```

Then `/extensions` → reload `backlog`. Edits to the working tree take effect on the next `extensions reload` (the shim is just a delegate; your working tree is the real source).

## Repo layout

```
backlog/
├── bin/
│   └── backlog.mjs                CLI entry point
├── .github/
│   ├── extensions/backlog/    SDK extension: db, queues, resolver, CLI, sidecar, commands, prompt, extension + viewer.html + favicon.svg + tests
│   └── workflows/ci.yml       Cross-platform CI: node --check + tests on Node 24
├── scripts/
│   └── install-extension-shim.mjs   Writes the user-scoped delegate after plugin install
├── skills/
│   └── backlog-install/SKILL.md     Setup skill the user invokes from a Copilot CLI session
├── plugin.json                Plugin metadata (name, version, skills dir)
├── package.json               npm scripts (check, test) and bin mapping
├── LICENSE                    MIT
└── README.md                  (this file)
```

## License

MIT © Marcus Markiewicz
