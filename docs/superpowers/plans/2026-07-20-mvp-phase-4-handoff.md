# MVP session handoff — phase 4 complete, phase 5 next

**Date:** 2026-07-20 · **Branch:** `phase-2-host` · **Baseline:** `bun test` 1038 pass / 0 fail
(114 files), `bun x tsc --noEmit` clean.

## Where the MVP stands

| Phase | Module | Status |
|---|---|---|
| 0 | scaffold, `entities/`, `infrastructure/` | done |
| 1 | `runtime/` | done |
| 2 | `host/` | done |
| 3 | `gate/` | done |
| 4 | `store/` | **done this session** (T6–T19) |
| 5 | `agent/` | next — plan written: `2026-07-19-mvp-phase-5-agent.md` |
| 6 | `core/` | **no plan yet** |
| 7 | `ui/` | **no plan yet** |
| 8 | composition, build, smoke | **no plan yet** |

Phase 4 landed as five wave commits (`f165d05`, `9f01c87`, `46140e6`, `96970de`, `89bf88d`)
plus `2e9b6b6` (mutex chain). 84 files, ~21k lines under `src/store/`.

## How phase 4 was executed (reuse this shape)

A single `Workflow` run, dependency-ordered waves, with a verification gate agent between
waves (full `bun test` + `bun x tsc --noEmit` + a DAG/errore/folder-shape audit), then an
adversarial review phase: 4 lenses (spec-conformance, durability, errore/DAG, test
adequacy) → per-finding refutation panel → fix agent for survivors.

**Model split (user rule, `memory/workflow-fanout-use-sonnet.md`): Sonnet for
implementation agents, Opus for gates and review lenses.** Wide mechanical fan-outs (the
refutation panel) also go to Sonnet. Set `model: 'sonnet'` explicitly on those `agent()`
calls — inheriting the session model burns the user's limits.

Cost of phase 4 for calibration: 43 agents, ~6.0M subagent tokens, ~4h15m wall clock.

## What the review caught (do not let phase 5 repeat these)

The review phase found 18 issues, 10 confirmed after refutation. The instructive ones:

- **Vacuous crash-injection tests.** 25 sweep tests spawned a child, never asserted it
  reached the injected boundary (no `exitCode === CRASH_EXIT_CODE` check), and passed
  against a child that never ran. Any test that spawns a process must assert the child's
  exit code and that the injected point was hit.
- **A missing durability gate.** `transactions.local/format.json` was never written or
  read, so `journal_too_new` did not exist and a newer-format journal was silently deleted.
  Now `transaction/model/journal-format.ts`.
- **Unflushed directory creation.** New directories were never flushed, so the journal
  directory entry anchoring recovery was not durable.
- **`errore.try` rethrows non-`Error` throwables.** `Bun.TOML.parse` throws a
  `BuildMessage`, so a corrupt `project.toml` threw out of `openProject` and leaked the
  acquired lease. Check what a boundary actually throws before wrapping it.
- A Wave B gate independently found a real double-counting bug in the §5.3 aggregate limit
  budget that rejected legal trees at the 64 MiB boundary.

## Open items carried forward

- **Architecture docs.** `docs/architecture/` Source anchors for storage still point at
  spec sections, not `src/store/**`. CLAUDE.md requires moving them; the roadmap defers the
  final sweep to phase 8, but `storage.md` and `code-structure.md` are stale now.
- **Phase 4 plan §"Unresolved contract questions" 5** — `WorkspaceLocalState` TOML key
  spellings were chosen at implementation time (snake_case, documented in
  `store/toml/model/workspace-toml.ts` comments). No external consumer known; revisit if
  phase 6/7 needs a specific spelling.
- **`store/lease` kernel32 bindings** (`LockFileEx`/`UnlockFileEx`) live in `store/`, not
  `infrastructure/`, though they are domain-free like `durability` and `fs-guard`. Injected
  via `LeaseLockApi`, so relocating changes no caller. Flagged by the Wave B gate, left as
  an architecture decision.
- **Restore / export publication / migration** infrastructure is built and unit-tested but
  has **no MVP caller** by design (roadmap out-of-scope). Do not wire a command to them.

## Phase 5 entry conditions

`agent/` implements the `AgentBackend` port over `@anthropic-ai/claude-agent-sdk`. It
depends on `entities/turn` (`AgentEvent`, `TokenUsage`) and the fenced turn workspace that
`store/sandbox` now provides. Per the roadmap the port shape lives in `agent/types.ts` and
moves to `core/ports/` in phase 6 — `agent` must not import `core`.

Spike H (confinement via `canUseTool` deny-by-default) and Spike I (process-tree ownership
via Job Object; crash-path confirmation is an open gap → `unhealthy_unconfirmed_exit`) are
binding. Codex backend is out of MVP scope.

Before writing code: load `/errore` and `/reatom` (CLAUDE.md mandate). `agent/` is another
non-Reatom adapter layer — the Reatom state machines start in phase 6.
