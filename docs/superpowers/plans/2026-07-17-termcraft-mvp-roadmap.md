# termcraft MVP — Implementation Roadmap

> **For agentic workers:** This is the master roadmap, not an executable task
> plan. Each phase below gets its own detailed plan document in
> `docs/superpowers/plans/` written just-in-time before that phase starts,
> following the superpowers:writing-plans skill. Execute phase plans with
> superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** Ship the termcraft MVP defined by
`docs/superpowers/specs/2026-07-13-termcraft-design.md` §8.2: Home prompt →
project creation → Claude Code generation turns → live host-rendered preview →
pins/selection → chats + slash menu → export package — on Windows first.

**Architecture:** Seven strictly-bounded modules (`runtime`, `gate`, `host`,
`agent`, `store`, `core`, `ui`) plus `entities/`, `infrastructure/`, and a
composition root, per `docs/architecture/code-structure.md`. Two process seams:
the transport-neutral UI↔Kernel DTO boundary and the design-host subprocess.
All state/logic is Reatom v1001; all error handling is errore (errors as
values); design pages import only `@termcraft/runtime`.

**Tech Stack:** TypeScript on Bun ≥1.3.14, `@opentui/core`+`@opentui/react`
0.4.5 (exact), `@reatom/core` ^1001.1.0 + `@reatom/react` ^1001.0.0,
`typescript` 7.0.2 (exact, native Go port), `errore` ^0.14.1,
`@anthropic-ai/claude-agent-sdk` ^0.3.212, `react` ^19.2.7.

## Global constraints (inherited by every phase plan)

Copied from the specs and the two spike findings docs; every phase plan repeats
this section by reference and its tasks must obey it.

- **Bun** `>=1.3.14` (engines). Tests run with `bun test`; typecheck with
  `bun x tsc --noEmit` (TS 7.0.2 from the repo lockfile).
- **errore is mandatory** (`CLAUDE.md` → `/errore` skill): namespace import,
  errors as values (`Error | T` unions), `createTaggedError` for domain errors,
  `.catch()`/`errore.try` only at boundaries, flat control flow, no `let`+try,
  `| null` for optional values, one-line `instanceof Error` early returns.
- **Reatom v1001 rules** (`/reatom` skill, binding): named atoms/computeds/
  actions everywhere; `wrap(...)` at every async boundary; `withAsync`/
  `withAsyncData` instead of manual flags; no identity setter actions;
  `withConnectHook` cleanup for long-lived subscriptions — but critical
  process/transaction lifetimes are owned by supervisors, not connection hooks
  (hardening register §3.8).
- **Module DAG** (`docs/architecture/code-structure.md`): `core` imports only
  `entities/` and its own `ports/`; adapters implement core ports; `ui` sees
  only core boundary types + `PreviewSession`; `runtime/` is a leaf;
  `infrastructure/` is domain-free (fails the "knows what a Page is" test →
  move it out); no shared `contracts/` folder; consumer declares the port.
  Forbidden shapes table in code-structure.md §11 is review-blocking.
- **Module folder shape** (`CLAUDE.md`): `ui/`, `model/`, `types.ts`,
  `index.ts`; code always inside subfolders (e.g. `model/`), never loose at
  module root; atomic single-purpose functions.
- **Page slug mask**: `^[a-z0-9][a-z0-9-]{0,31}$` minus Windows device names
  (`con`, `nul`, `aux`, `prn`, `com1`–`com9`, `lpt1`–`lpt9`).
- **Non-page identities are UUIDv7** (lowercase canonical); page identity is
  the slug.
- **Host protocol framing** (host-supervision spec §5): 8-byte outer header —
  4-byte unsigned big-endian payload length `N` (excludes header), 1-byte
  framing version = `1`, 1-byte message class (`1` control, `2` frame/bulk),
  2-byte flags = `0` — then `N` bytes UTF-8 JSON. Limits: control 262,144 B;
  frame/bulk 16,777,216 B; reject `N` above the global ceiling before
  allocating. **The four fatal framing conditions, §5 verbatim: "Lengths of
  zero, unsupported framing versions, unknown classes, and non-zero flags are
  fatal framing errors."** A framing violation is fatal and the parser does
  **not** resynchronize by scanning for a new prefix. The decoder must
  tolerate arbitrary fragmentation (Spike E: frames really do split across
  `data` events).
- **Spike-earned rules that phase plans must not lose:**
  - Gate TypeScript check: union `getGlobalDiagnostics()`, dedupe on
    `(code, fileName, pos)`, distinguish compiler-crash from clean (Spike C).
  - tsc is extracted to a per-user dir and spawned; `lib: ["esnext"]` pinned;
    per-platform builds (Spike C).
  - Host registers three specifiers: `@termcraft/runtime`,
    `react/jsx-runtime`, `react/jsx-dev-runtime`; resolution fails open, so
    the Gate's source-text scan is load-bearing (Spike A).
  - Respawn-per-source is a correctness requirement — Bun's module cache is
    stale and query-busting does not work (Spike A).
  - Frame text from the span API, never `buffers.char`; width is display
    width; capture via public API, not `@opentui/core/testing` (Spike B);
    fake stdout stream must not let `columns` override the requested size;
    stream shim implements `setRawMode`.
  - `reatomComponent` comes from `@reatom/react@1001.0.0`; tests of
    `reatomComponent` trees under the test renderer must wrap Reatom writes in
    `act()` from `'react'` or frames silently never change (Spike D).
  - A Reatom+OpenTUI process does not exit on its own after
    `renderer.destroy()` — a one-shot render child (the export session, a
    smoke render, a scripted-terminal test child) must call `process.exit()`
    explicitly or it hangs; harmless for the long-lived interactive kernel
    (Spike D, second finding).
  - `process.execPath` is the self-spawn path only inside the compiled
    binary; dev mode must branch (Spike E).
  - `SafeProjectFs` escape check via `realpathSync` comparison; junction/
    reparse detection needs the `GetFileAttributesW` +
    `FILE_ATTRIBUTE_REPARSE_POINT` FFI backstop, not `isSymbolicLink()` alone
    (Spike F).
  - Durability flush: `CreateFileW(FILE_FLAG_BACKUP_SEMANTICS,
    GENERIC_WRITE)` + `FlushFileBuffers` — `GENERIC_WRITE` **alone**; ~19 ms
    median per flush, budget transactions accordingly (Spike G).
  - Claude confinement via `canUseTool` deny-by-default callback (Spike H).
  - Process-tree ownership via Job Object + `QueryInformationJobObject`
    confirmation for graceful cancel; crash-path confirmation is an open gap —
    MVP treats it as `backend_unhealthy_unconfirmed_exit` (Spike I).
- **Language rules:** all code, comments, commit messages, docs in English.
- **Commits:** frequent, per plan task, message style follows repo history
  (`feat:`/`docs:`/`test:` prefixes), each ends with the Claude co-author
  trailer.
- **Architecture docs:** when a phase lands a module, move the affected
  `docs/architecture/` Source anchors from spec sections to real source paths
  (CLAUDE.md architecture-docs-maintenance rule; final sweep in phase 8).

## Normative sources per phase

| Phase | Module(s) | Normative spec(s) beyond the master spec |
|---|---|---|
| 0 | scaffold, `entities/`, `infrastructure/` | host-supervision §5 (framing), storage-identity (identities) |
| 1 | `runtime/` | runtime-api-compatibility (whole), master §5, Spike D |
| 2 | `host/` | host-supervision-protocol (whole), Spikes A/B/D/E |
| 3 | `gate/` | master §6.3, runtime-api-compatibility §3.1, Spike C |
| 4 | `store/` | production-storage-identity + turn-durability (whole), projections-observability-scale, Spikes F/G |
| 5 | `agent/` | master §6.1–6.2, turn-durability §6.5, Spikes H/I |
| 6 | `core/` | kernel-command-contract (whole), turn-durability, projections |
| 7 | `ui/` | master §3.x, design/*.dc.html frames, kernel contract capabilities |
| 8 | `main.ts`, build | master §4.1, npm packaging, Spike D (one-shot exit), §10 smoke, §11 criteria |

## Phases

Dependency-ordered; each produces working, independently-tested software
(`bun test` + `bun x tsc --noEmit` green at every phase boundary).

### Phase 0 — scaffold, entities, infrastructure

`src/` skeleton per code-structure.md; `entities/` vocabulary types that the
master spec pins verbatim (page slug + meta + size, turn fence +
`AgentEvent`); `infrastructure/framing` (encoder + buffering push-decoder
with limits), `infrastructure/uuid` (UUIDv7 via `Bun.randomUUIDv7`),
`infrastructure/clock`. Chat and pin record schemas are **not** defined here —
their JSON shapes are normed by the storage-identity spec and land with
phase 4. Detailed plan: `2026-07-17-mvp-phase-0-scaffold.md`.

### Phase 1 — `runtime/` (@termcraft/runtime facade)

`definePage`/`defineTweaks`, palette tokens + `dark-default` theme registry,
MVP catalog (`Row`, `Column`, `Panel`, `Tabs`, `Text`, `Button`, `Input`,
`List`, `Table`, `Gauge`, `Sparkline`, `Separator`, `Spacer`) with mandatory
`id` props, low-level primitive escape hatch, `reatomComponent` +
selected-Reatom re-exports, dormant navigation/tweaks APIs, runtime
capabilities + export flag, the JSX helper surface (`jsx`/`jsxs`/`jsxDEV`
with positional `key`, `Fragment` as value). Component snapshot tests via the
private headless renderer.

### Phase 2 — `host/` (design host + HostSupervisor)

`_host` entry; `Bun.plugin` resolver for the three specifiers; headless
renderer on the public OpenTUI API (fake streams, memory-buffered output);
span-based styled frame capture; protocol v1 (hello/handshake binding
`sessionId`, nonce, `sourceHash`, `kitApiVersion`, limits; heartbeat; frames
with monotonic `frameSeq`; queries `checkHit`/`rectOf`/`describe`/
`layoutTree`); `HostSupervisor` (spawn, timeouts, restart budget + backoff +
circuit breaker, respawn-per-source) and `PreviewSession` (bounded
latest-frame-wins stream); one-shot export session (`renderOnce` at t=0,
frame + layout tree from the same pass). Protocol contract tests +
determinism test.

### Phase 3 — `gate/`

tsc extraction (`%LOCALAPPDATA%/termcraft/tsc-<version>/`) + spawn;
`typescript/unstable/sync` check with the three spike-earned rules; import
allowlist source scan (§5.8 exact list, incl. dynamic-import/re-export/eval
bans); page contract (static `meta` literal, default `reatomComponent`
export, supported integer `kitApiVersion`); manifest-slice checks
(`pages.json`); smoke render through the `SmokeRenderer` port (implemented by
`host`); warning lints (dropped ids, unpointed raw elements, unguarded
timers/randomness, navigation to unlisted pages). Hostile-fixture test suite.

### Phase 4 — `store/`

`SafeProjectFs` (path/link/limit validation, immutable candidate copy);
OS-held `ProjectLease`; `project.toml` / `workspace.local.toml` /
`.gitignore` generation with `format_version`; chats JSONL (typed header,
1 MiB line cap, valid-prefix reader, `ChatIndex`); `comments.jsonl` pin
events; the recoverable transaction engine (durable flush primitive via
`bun:ffi`, plan → intent → idempotent roll-forward → committed; startup
recovery classification); machine-local trust ledger + `TrustSubject`;
`{userStateRoot}` sandboxes/turn workspaces; migration registry (empty chain,
live infrastructure); rebuildable projections (page-meta cache keyed by
source hash + extractor version, diagnostics store, render cache).
Fault-injection tests after every durability boundary.

### Phase 5 — `agent/`

`AgentBackend` port implementation `ClaudeBackend` over
`@anthropic-ai/claude-agent-sdk`: `startTurn` bound to the fenced turn
workspace (cwd + `canUseTool` allow-file-tools-in-workspace / deny Bash+web),
vendor-event → `AgentEvent` normalization (thinking → `reasoning`,
`tool_use` → `tool` op+target, result → `final`+`usage`), `healthCheck`
(installed? logged in?), `cancel` (the SDK abort the kernel fires on `Esc`,
on the 120 s stream-silence watchdog, or on the non-resettable absolute
deadline) resolving only after confirmed process-tree exit (Job Object via
`bun:ffi`; crash-path confirmation is the open Spike I gap →
`unhealthy_unconfirmed_exit`), session resume/checkpoint fallback seeding
(32 records / 64 KiB), fencing `{turnId, attempt, leaseNonce}`. Tests
against scripted SDK fakes.

### Phase 6 — `core/`

Kernel per kernel-command-contract: versioned Command/Result/Event DTOs with
`commandId`/`stateRevision`/`eventSeq`; named Reatom state machines (turn,
export, preview, chats, startup/trust); capability publication with typed
unavailable reasons; turn orchestration (admission transaction → staging
population → agent run under the kernel-owned 120 s stream-silence watchdog
and the non-resettable absolute deadline covering the initial attempt plus
all retries → `SafeProjectFs` freeze → Gate → ≤3 retries → project-write
mutex CAS → `TurnTransaction` apply → pin resolution); export
orchestration (size ladder, bounded pool, render cache,
`ExportPublishTransaction`); chat create/switch; pins lifecycle;
`PreviewSession` frame broker; startup recovery + trust + lease + broken-
source launch path. Contract/transition-table tests with faked adapters.

### Phase 7 — `ui/`

OpenTUI shell via `reatomComponent`: Home (centered prompt, display-only
combo, agent health states, `r` re-check); Workspace (chat panel ~35%,
preview compositing frames + pins + selection, tab strip, status bar with
fixed segment order, empty-state, and the preview error panel that shows a
host crash / broken-source failure — compile-error text or crash stack — in
the preview region only while the rest of the app keeps working, §3.2/§9);
action table (single registry driving
hotkeys, hints, slash menu); slash menu (`/new`, `/chats`, `/export`);
ephemeral agent status block (spinner, tool steps, 1–3-line reasoning ticker,
gate-retry line) collapsing into markdown-lite records; composer +
context-usage indicator; mouse hover/select/pin flows with dimmed pin input;
chat list popup; the workspace-trust prompt + declined read-only state
(§3.1); the "enlarge the window" placeholder when the terminal is below the
app frame's minimum (§9); focus rules + layered `Esc`; `F2` fullscreen
(chip/ctx hidden with composer). Action-table units, markdown-lite units,
ephemeral block snapshots (`act()` wrapped).

### Phase 8 — composition, npm distribution, smoke

`main.ts` composition root + argv dispatch for the three entry points — the
interactive TUI, `termcraft _host` (the installed entry run through Bun), and
the headless `termcraft export` CLI (§3.7/§9: refuses on an untrusted project
with the trust error); the top-level panic-equivalent handler that
restores the terminal (raw mode off, mouse capture off, alternate screen
exited) before printing the failure (§9); npm packaging — a `bin` entry, a
`files` allowlist, and a real version in `package.json`, with `typescript@7`,
OpenTUI's native core, and React resolved as ordinary `node_modules`
dependencies rather than build-time embedded files (master §4.1); scripted-terminal
smoke test (§10: open → prompt → fake agent edits staging → gate → render →
export); §11 success-criteria manual walkthrough with the real Claude CLI;
architecture-docs Source-anchor sweep.

## Cross-phase interface registry

Names fixed by the specs; exact signatures are pinned in the earliest phase
plan that defines them, and later phase plans must consume them verbatim.

| Interface | Declared in | Implemented in | Consumed by | Signature authority |
|---|---|---|---|---|
| `AgentEvent`, `TokenUsage` | phase 0 `entities/turn` | — (pure types) | agent, core, ui | master §6.1 |
| `PageSlug`, `PageMeta`, `Size` | phase 0 `entities/page` | — | runtime, gate, store, core, ui | master §5.1, §6.2 |
| Chat/pin record types | phase 4 `entities/chat`, `entities/pin` | — | store, core, ui | storage-identity §5–7 |
| Framing codec | phase 0 `infrastructure/framing` | same | host | host-supervision §5 |
| `definePage`, component props, tokens | phase 1 `runtime/` | same | gate (types), host (resolver), design pages | runtime-api spec |
| Host protocol messages | phase 2 `host/types.ts` | host | gate (smoke), core | host-supervision §5 |
| `PreviewSession`, `FrameToken` | phase 2 `core/ports/` (moved when core lands) | host | core, ui | host-supervision §4 |
| `SmokeRenderer` | phase 3 `gate/ports/` | host | gate | code-structure §5 |
| `GateResult` (errors/warnings) | phase 3 `gate/types.ts` | gate | core, agent feedback | master §6.3 |
| Store ports (lease, chats, pages, pins, tx, trust) | phase 6 `core/ports/` (shapes drafted in phase 4 `store/types.ts`) | store | core | storage-identity, turn-durability |
| `AgentBackend`, `AgentTask`, `AgentRun` | phase 5 `agent/types.ts` (moved to `core/ports/` in phase 6) | agent | core | master §6.1 |
| Command/Result/Event DTOs, capabilities | phase 6 `core/types.ts` | core | ui | kernel-command-contract |

Port-placement note: until `core/` exists (phase 6), adapter phases declare
their contracts in their own `types.ts`; phase 6 lifts the shapes `core`
consumes into `core/ports/` verbatim and the adapters import nothing — the
composition root injects. This keeps the DAG legal at every phase boundary.

## Out of scope for MVP (do not build)

Codex backend (v1.0, quota-blocked until 2026-07-23), `/model` picker UI,
Git history/Restore/`/commit-*`, interactive mode + input forwarding (`F4`
inert), Tweaks panel (`F3` inert; `defineTweaks` export exists but dormant),
`Modal`/`Menu`/`Tree`/`Progress`/`Chart`/`Scroll`, light theme, preview
controls popup (`Ctrl+P`), first-run wizard, chat rename/deletion/AI titles,
keyboard element selection, daemon/IPC.
