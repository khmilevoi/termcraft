# Application Entrypoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add runnable interactive and demo entrypoints, deterministic lifecycle tests, package commands, and user-facing setup documentation.

**Architecture:** A small `entrypoint/` module owns OpenTUI renderer lifecycle behind injected boundaries. `main.tsx` and `demo.tsx` are thin executable roots that build `UiDeps` with the currently available UI-owned kernel implementation and render the existing `App`. Because no composed production `KernelPort` exists yet, the real adapter graph is explicitly deferred rather than represented by misleading fake-to-real wiring.

**Tech Stack:** Bun >=1.3.14, TypeScript 7.0.2, React 19, OpenTUI 0.4.5, Reatom v1001, errore.

## Global Constraints

- Preserve the module DAG and use top-level aliases across module boundaries.
- Return expected startup failures as `Error | T`; only the executable boundary sets `process.exitCode`.
- Always destroy the OpenTUI renderer before reporting a fatal failure.
- Do not change visual tokens or layout.
- Use a failing Bun test before each production-code change.

---

### Task 1: Testable OpenTUI lifecycle

**Files:**
- Create: `src/entrypoint/types.ts`
- Create: `src/entrypoint/model/run-app.tsx`
- Create: `src/entrypoint/model/run-app.test.tsx`
- Create: `src/entrypoint/index.ts`
- Modify: `tsconfig.json`

**Interfaces:**
- Produces: `runApp(deps, options): Promise<Error | RunningApp>` where `RunningApp.close()` unmounts and destroys once.
- Consumes: injected `createRenderer`, `createRoot`, and `renderNode` boundaries so tests never acquire the real terminal.

- [x] Write lifecycle tests for successful render, idempotent close, and render failure cleanup.
- [x] Run `bun test src/entrypoint/model/run-app.test.tsx` and confirm failure because the module is absent.
- [x] Implement the smallest lifecycle satisfying the tests, wrapping third-party promise failures in a tagged `AppStartupError`.
- [x] Re-run the focused test and `bunx tsc --noEmit`.

### Task 2: Runnable roots and package commands

**Files:**
- Create: `src/entrypoint/model/create-shell.ts`
- Create: `src/entrypoint/model/create-shell.test.ts`
- Create: `src/main.tsx`
- Create: `src/demo.tsx`
- Create: `src/entrypoints.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `createShell(mode, env)` returning stable `UiDeps` for `App`.
- Produces executable commands `start`, `dev`, `demo`, and `build`.

- [x] Write tests proving demo/interactive roots create distinct seeded shells and package scripts point at existing entrypoints.
- [x] Run focused tests and confirm they fail for missing roots/scripts.
- [x] Implement thin roots guarded by `import.meta.main`, process signal cleanup, and non-zero fatal exit reporting.
- [x] Add `start`, `dev`, `demo`, and `build` scripts; compile to `dist/termcraft.exe` on Windows.
- [x] Re-run focused tests, typecheck, and `bun run build`.

### Task 3: Documentation and repository verification

**Files:**
- Create: `README.md`
- Modify: `docs/architecture/code-structure.md`
- Modify: `docs/superpowers/specs/2026-07-22-application-entrypoints-design.md`

**Interfaces:**
- Documents exact prerequisites and commands.
- Records that executable/UI lifecycle landed while real `KernelPort` composition remains a named follow-up.

- [x] Document install, start, demo, development, build, authentication expectations, and the current kernel-composition limitation.
- [x] Update architecture source anchors without claiming the missing adapter graph exists.
- [x] Run `bun test`, `bunx tsc --noEmit`, `bun run lint`, and `bun run fmt:check`.
- [x] Run `git diff --check` and inspect the final diff.

---

## Execution notes (deviations from the plan as written)

Three deliberate departures, all in the direction the plan's own architecture note
points ("the real adapter graph is explicitly deferred rather than represented by
misleading fake-to-real wiring"):

1. **No `runApp` renderer lifecycle of its own.** Phase 7 task 1 had already landed
   `ui`'s `createUiRoot` — injected adapters, idempotent `dispose()`, unmount before
   destroy, renderer destroyed on a failed mount. `entrypoint/model/run-app.ts`
   composes that instead of re-implementing it, and owns only what sits above the UI:
   releasing the shell on every exit path, binding `SIGINT`/`SIGTERM` to one shared
   teardown promise, and exposing `closed`.

2. **`main.tsx` refuses rather than silently running the demo kernel.** The design
   doc forbids "silently falling back from production to demo," so
   `bootstrap("interactive", …)` returns `KernelCompositionPendingError` — naming
   `bun run demo` and `bun start --preview-shell` — instead of quietly seeding the
   in-memory kernel behind the production command.

3. **Mode logic lives in `bootstrap`, not in the roots.** `main.tsx` and `demo.tsx`
   are `import.meta.main` guards over `bootstrap`, so argv handling, mode selection
   and the refusal are all covered by `bun test` without a terminal.

Landed surface: `src/entrypoint/{types.ts,index.ts}`,
`src/entrypoint/model/{run-app,create-shell,bootstrap,process-boundary}.ts`,
`src/main.tsx`, `src/demo.tsx`, `src/entrypoints.test.ts`, and the four package
commands. Verified end to end: `bun run demo` paints the workspace through real
OpenTUI, `bun start` exits 1 with the composition-pending message, `bun run build`
compiles `dist/termcraft.exe` (109 MB) and the binary reproduces that same message.
