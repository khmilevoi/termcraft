# termcraft

A terminal workspace where an agent writes the pages and the terminal renders them
live: you describe a change, Claude Code edits the project's design pages, a
validation gate checks them, and a design host renders the result into the preview
pane next to the chat.

## Status

The nine source modules — `entities/`, `infrastructure/`, `runtime/`, `host/`,
`gate/`, `store/`, `agent/`, `core/`, `ui/` — have landed and are tested. The UI
shell is complete and runnable.

**What is not built yet: the production Kernel composition.** `core/` owns the state
machines, capability guards, mailbox and orchestration, but nothing yet maps
`store`/`agent`/`gate`/`host` onto `core/ports/`, and no command handler registry
exists — so there is no real `KernelPort` to hand the UI. Until that lands:

- `bun run demo` runs the whole shell against an in-memory kernel;
- `bun start` **refuses to start** and says so, rather than silently passing the
  in-memory kernel off as the real application;
- `bun start --preview-shell` opens the same UI against that in-memory kernel when
  you want the interactive root's own code path.

## Prerequisites

- [Bun](https://bun.sh) **1.3.14 or newer** (`bun --version`).
- Windows is the first-class target. The build script produces a Windows binary.
- For the eventual production path: the [Claude Code](https://claude.com/claude-code)
  CLI, installed and logged in. termcraft uses the Claude Agent SDK's own
  authentication — it never asks for an API key and stores no credentials. The demo
  needs none of this.

## Install

```bash
bun install
```

## Commands

| Command                              | What it does                                                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `bun run demo`                       | The full UI against the in-memory kernel: a trusted workspace, one preview frame, no credentials, nothing written to disk.           |
| `bun start`                          | The interactive application. Currently exits with the composition-pending message above.                                             |
| `bun start --preview-shell [dir]`    | The interactive root against the in-memory kernel; `dir` (default: the working directory) becomes the workspace root the UI reports. |
| `bun run dev`                        | `bun start` under watch mode — restarts on source changes.                                                                           |
| `bun run build`                      | Compiles a standalone executable to `dist/termcraft.exe`.                                                                            |
| `bun test`                           | The whole suite.                                                                                                                     |
| `bun x tsc --noEmit`                 | Typecheck.                                                                                                                           |
| `bun run lint` / `bun run fmt:check` | oxlint / oxfmt.                                                                                                                      |

Quit the running app with `Ctrl+C`; `Esc` is the app's own layered back key, not an
exit.

## How startup is wired

`src/main.tsx` and `src/demo.tsx` are `import.meta.main` guards and nothing else.
Every decision lives in `src/entrypoint/`, behind injected renderer and process
seams, so `bun test` exercises startup, shutdown, signal handling and failure
reporting without ever acquiring a terminal:

- `createShell(mode, env)` — which Kernel boundary a run drives, and its seed.
- `runApp({ shell, process, adapters })` — acquires the terminal through `ui`'s
  `createUiRoot`, binds `SIGINT`/`SIGTERM` to one idempotent shutdown, releases the
  shell in reverse acquisition order, and never leaves a renderer alive behind a
  failure.
- `bootstrap(mode, deps)` — argv, mode selection, and the composition-pending
  refusal.

Architecture documents live in [`docs/architecture/`](docs/architecture/); the design
system that every visual decision comes from lives in [`design/`](design/).
