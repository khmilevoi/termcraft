# Application Entrypoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

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

- [ ] Write lifecycle tests for successful render, idempotent close, and render failure cleanup.
- [ ] Run `bun test src/entrypoint/model/run-app.test.tsx` and confirm failure because the module is absent.
- [ ] Implement the smallest lifecycle satisfying the tests, wrapping third-party promise failures in a tagged `AppStartupError`.
- [ ] Re-run the focused test and `bunx tsc --noEmit`.

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

- [ ] Write tests proving demo/interactive roots create distinct seeded shells and package scripts point at existing entrypoints.
- [ ] Run focused tests and confirm they fail for missing roots/scripts.
- [ ] Implement thin roots guarded by `import.meta.main`, process signal cleanup, and non-zero fatal exit reporting.
- [ ] Add `start`, `dev`, `demo`, and `build` scripts; compile to `dist/termcraft.exe` on Windows.
- [ ] Re-run focused tests, typecheck, and `bun run build`.

### Task 3: Documentation and repository verification

**Files:**
- Create: `README.md`
- Modify: `docs/architecture/code-structure.md`
- Modify: `docs/superpowers/specs/2026-07-22-application-entrypoints-design.md`

**Interfaces:**
- Documents exact prerequisites and commands.
- Records that executable/UI lifecycle landed while real `KernelPort` composition remains a named follow-up.

- [ ] Document install, start, demo, development, build, authentication expectations, and the current kernel-composition limitation.
- [ ] Update architecture source anchors without claiming the missing adapter graph exists.
- [ ] Run `bun test`, `bunx tsc --noEmit`, `bun run lint`, and `bun run fmt:check`.
- [ ] Run `git diff --check` and inspect the final diff.
