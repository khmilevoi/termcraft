# termcraft MVP — Session Handoff (2026-07-17, rev 2 — phase 2A+2B)

Purpose: hand the running MVP implementation to a fresh session with zero loss of
context. Read this top to bottom, then read the operative plan docs it points at.

## ⚠️ 0. READ FIRST — branch state

**All phase-2 work lives on branch `phase-2-host`, NOT on `main`.** `main` is still
at `f867f3e` (phase 0 done + phase 1 started). The branch adds 15 commits
(`68f5b33..c496159`): phase 2A (`host/protocol`), phase 2B (`host/render`), and
their plan docs.

- To resume: `git checkout phase-2-host`.
- The branch is a clean linear descendant of `main`, so integrating is a trivial
  fast-forward `git merge phase-2-host` from `main` whenever you decide to — nothing
  else has moved on `main`.
- The SDD progress ledger is `.superpowers/sdd/progress.md` (git-ignored scratch;
  trust it + `git log` after any compaction).

## 1. TL;DR for the next session

- The MVP is built in 9 phases (roadmap below). **Phase 0 done. Phase 1 started
  (only `definePage`). Phase 2 is now decomposed into four sub-plans 2A–2D; 2A and
  2B are DONE on the branch; 2C and 2D are the next work.**
- Green gates, run after every task: `bun test` and `bun x tsc --noEmit` (both must
  be clean). **Current state on `phase-2-host`: 133 tests, 0 fail, tsc clean,
  `bun test` exits without hanging.**
- Load the `/reatom` and `/errore` skills before touching code (CLAUDE.md mandate).
- **Next concrete work: write + implement Plan 2C (the `_host` process entry +
  Bun.plugin resolver + host-side protocol loop), then Plan 2D (HostSupervisor +
  PreviewSession + frame broker).** After 2C/2D, the phase-1 component catalog is
  finally unblocked (the render harness exists now). See §5.

## 2. What exists now

### On `main` (unchanged this session)
Phase 0 (entities + infrastructure) and the phase-1 `runtime/` `definePage` slice —
see the git log. `entities/page`, `entities/turn`, `infrastructure/{uuid,clock,framing}`,
`runtime/` (`definePage`, `CURRENT_KIT_API_VERSION`, `ThemeId`).

### On `phase-2-host` (this session) — phase 2A + 2B

**Phase 2A — `src/host/protocol/` — DONE** (host-supervision §5/§5.1–5.3/§7.1). A
pure, closed-schema JSON codec over the phase-0 byte framing:
- `model/errors.ts` — `ProtocolError` (tagged, `code`+`reason`+`cause`),
  `ProtocolViolationCode`.
- `model/strict-json.ts` — `decodeUtf8` (fatal UTF-8), `parseStrictJson`
  (`JSON.parse` + a strict scanner that rejects **duplicate keys**, **non-finite
  numbers** incl. `1e999`→Infinity, and **unsafe-integer tokens** incl. exponent
  form), `decodeJsonPayload`, `JsonValue`.
- `model/shape.ts` — shape guards over `JsonValue | undefined` (`asObject`,
  `asArray`, `asString`, `expectExactKeys`, `isPositiveSafeInteger`,
  `isSortedUnique*`, `isBoundedAscii`, `isDecimalUint64String`, `isLowercaseHex`).
- `model/bundle.ts` — `validateRuntimeDeclarationBundle`, `validatePublicLimits`,
  `PROTOCOL_HARD_LIMITS`.
- `model/hello.ts` — `encode/decodeClientHello`, `encode/decodeHostHello`.
- `model/control-envelope.ts` — `encode/decodeControlEnvelope`.
- `model/frame.ts` — `encode/decodeFrameEnvelope`, `FRAME_MAX_AXIS/CELLS/ATTR_MASK`.
- `types.ts` — all DTO types; `host/types.ts` — `HostMode`, `InteractionMode`, `Size`;
  `host/index.ts`.

**Phase 2B — `src/host/render/` — DONE** (host-supervision §5.3, Spikes B/D). The
headless OpenTUI render harness on the **public** API:
- `model/color.ts` — `rgbaToColor(RGBA): Color` (default/transparent→"default",
  indexed→`{indexed}`, else→`{rgb:"#rrggbb"}`).
- `model/attributes.ts` — `attributesToMask(number)`: explicit remap (OpenTUI
  `INVERSE=32`→protocol bit 16, `STRIKETHROUGH=128`→bit 32, `getBaseAttributes`
  strips link id) — **NOT** a naïve `& 0x3f`.
- `model/span-rows.ts` — `styledRowsFromSpanLines(CapturedLine[]): StyledRun[][]`
  (reuses 2A `StyledRun`/`Color`).
- `model/streams.ts` — `makeHeadlessStreams(Size)` fake TTY (columns/rows outrank
  config; `isTTY`/`setRawMode` load-bearing).
- `model/renderer.ts` — `createHeadlessRenderer(Size): Promise<RenderHandle>` and
  `renderNodeOnce(node, Size)` using `createCliRenderer` + `@opentui/react`
  `createRoot` + `intermediateRender()`/`await idle()` + `getSpanLines()`.
- `types.ts` — `CapturedFrame`, `RenderHandle`, `RenderSize`; `index.ts`.

## 3. Phase-2 plan structure (operative)

- `docs/superpowers/plans/2026-07-17-mvp-phase-2-host.md` — **master index**: scope,
  module layout, the four sub-plans, sequencing, cross-slice interface registry,
  out-of-scope. **Read this to understand how 2A–2D fit.**
- `2026-07-17-mvp-phase-2a-protocol.md` — Plan 2A (DONE). Its code IS what shipped.
- `2026-07-17-mvp-phase-2b-render.md` — Plan 2B (DONE). **Embeds the full, verified
  OpenTUI headless-render recipe** (createCliRenderer config, fake-stream shim, RGBA
  class API, attribute constants, mount path, traps). The single best OpenTUI
  reference for 2C/2D and phase 1/7 — read its "OpenTUI recipe" section.
- Plans 2C and 2D are **not yet written** — write them just-in-time per the master
  index, following superpowers:writing-plans, then execute via
  superpowers:subagent-driven-development.

## 4. Traps and facts learned THIS session (do not rediscover)

New this session (in addition to §8's carried-forward traps):

- **`errore.try` takes an OPTIONS OBJECT `{ try, catch }`, not positional
  `(fn, onError)`** in the installed `errore@0.14.1` (`tryFn<T,E>(opts)`; the `catch`
  cb is typed `(e: Error)`). The skill's examples show the positional form — the
  installed `.d.ts` wins. (Caught before implementation; the adversarial plan review
  independently flagged it too.)
- **`createTaggedError` template vars are typed `string | number`** and are passed +
  read as instance properties; `cause` is an optional ctor arg
  (`PropsWithCause`). Reserved var names cannot be template vars.
- **`noUncheckedIndexedAccess` makes `obj.field` on a `{ [k]: JsonValue }` type
  `JsonValue | undefined`** (dot access too, not just `obj[k]`). All 2A shape guards
  accept `JsonValue | undefined` for this reason.
- **Attribute masks: bitwise `(attrs & ~MASK)` is defeated by JS Int32 coercion** —
  a safe integer ≥ 2³² whose low bits form a valid mask passes it. Use a numeric
  bound (`attrs > MASK`). (Found by the 2A plan review.)
- **Strict JSON must reject `1e999` (parses to `Infinity`) and exponent-form unsafe
  integers (`1e20`)** — `JSON.parse` only rejects the bare `NaN`/`Infinity` literals.
  (Found by the 2A final whole-branch review.)
- **OpenTUI headless render works under `bun test` and does NOT hang** if every test
  destroys its renderer (`afterEach`/`finally`). The Spike-D "process doesn't
  self-exit" trap did not materialise in the test runner (no `process.exit` needed
  in tests; the one-shot host entry in 2C still needs it).
- **`.tsx` files need `/** @jsxImportSource @opentui/react */` as the first line** —
  the repo has no `@types/react`, so `tsc` can't resolve `JSX.IntrinsicElements`
  without the per-file pragma. Do NOT add `@types/react` or change tsconfig `jsx`;
  the pragma keeps OpenTUI's own JSX types. **This will matter for phase 7 (ui)
  too.**
- **Production mount path (`createRoot(renderer).render`) needs NO `act()`** — Reatom
  writes flush after a microtask tick. `act()` from `"react"` is required only under
  the test renderer (`@opentui/react/test-utils`), which the harness avoids. Phase
  6/7 model tests that DO use the test renderer still need `act()` (Spike D).
- **Bun's `node:stream` `Writable` defers the write callback to `process.nextTick`**
  — a synchronous "callback was called" assertion fails; await it.

## 5. Concrete next steps (in order)

1. **Write + implement Plan 2C** (`2026-07-17-mvp-phase-2c-session.md`) — the
   `host/session/` slice: `termcraft _host --stdio` entry; the `Bun.plugin` resolver
   registering **three** specifiers (`@termcraft/runtime`, `react/jsx-runtime`,
   `react/jsx-dev-runtime`, fails open — Spike A); source-hash recompute + import
   rescan at mount; the host-side protocol state machine (hello→mount→ready→frames→
   queries→heartbeat→shutdown) built on 2A's codec + 2B's harness; the one-shot
   export/smoke path with **explicit `process.exit()`** (Spike D). `process.execPath`
   self-spawn is correct only in the compiled binary — dev mode must branch (Spike E).
   Normative: host-supervision §6, §7, §11 + runtime-api §3.1 + Spikes A/E.
2. **Write + implement Plan 2D** (`2026-07-17-mvp-phase-2d-supervisor.md`) — the
   `host/supervisor/` slice: `HostSupervisor` (spawn, negotiate, timeouts §9, restart
   budget/backoff/circuit-breaker §10, bounded queues/backpressure §8, respawn-per-
   source), the typed `HostSession` handle, `PreviewSession` facade + capacity-1 frame
   broker (§3.2, §4), one-shot smoke/export sessions. Declare `PreviewSession`/
   `FrameToken`/`SmokeRenderer`-slice contracts in `host/`'s own `types.ts` (phase 6
   lifts them into `core/ports/`). Normative: host-supervision §3, §4, §8–§10, §12, §13.
3. **Finish phase 1** (`runtime/`) on the now-existing render harness — the component
   catalog (`Row`,`Column`,`Panel`,`Tabs`,`Text`,`Button`,`Input`,`List`,`Table`,
   `Gauge`,`Sparkline`,`Separator`,`Spacer`) with mandatory `id`, the low-level
   primitive escape hatch, the Reatom re-exports, the JSX helper surface
   (`jsx`/`jsxs`/`jsxDEV`, positional `key`, `Fragment` value), dormant
   navigation/tweaks APIs, and the `dark-default` theme tokens — snapshot-tested via
   `host/render`. Normative: runtime-api spec (whole), master §5, Spike D. (Handoff
   rev 1 §5.3 has the token palette detail.)
4. Then phases 3→8 per the roadmap.

## 6. Open items / gaps to close

- **Plan 2B has NOT had an independent final whole-branch review** (2A did — it
  caught the non-finite-JSON bug). Consider a `/code-review`-style pass on
  `host/render` before or after merging.
- **The branch is not merged to `main`.** Decide merge timing (trivial ff).
- **No `process.exit()` path is exercised yet** — it lands with 2C's one-shot host.
- The `@opentui/core` version is pinned exact (0.4.5); the render harness reaches
  into `currentRenderBuffer`/`getSpanLines`/`intermediateRender`/`idle` — gate any
  OpenTUI upgrade on the `host/render` integration tests.

## 7. Operative documents (read in this order)

1. `2026-07-17-mvp-phase-2-host.md` — phase-2 master index (the map for 2C/2D).
2. `2026-07-17-mvp-phase-2b-render.md` — its embedded OpenTUI recipe is the reference.
3. `2026-07-17-termcraft-mvp-roadmap.md` — phases, **Global constraints** (binding),
   normative-sources table, cross-phase interface registry, out-of-scope.
4. `docs/superpowers/specs/2026-07-16-host-supervision-protocol-design.md` — the whole
   host contract; §6/§7/§8/§9/§10/§11/§12/§13 are what 2C/2D implement.
5. `docs/superpowers/specs/2026-07-16-runtime-api-compatibility-design.md` — §3.1
   resolver, §7 handshake/identity.
6. `docs/superpowers/specs/2026-07-13-termcraft-design.md` — master spec.
7. `docs/spikes/2026-07-17-findings.md` + `-round-2-findings.md` — spike evidence.
8. `CLAUDE.md` (repo) — module folder shape, mandatory `/reatom` + `/errore`.
9. Memory: `termcraft-pending-design-fixes` (standing design decisions + status mirror).

## 8. Traps carried forward (from rev 1, still valid for phases 3–8)

- **TS is `typescript@7.0.2` (native Go port).** No `ts.createProgram`; the Gate
  (phase 3) uses `typescript/unstable/sync`. `Uint8Array` is generic over its buffer
  — annotate a reassigned byte buffer as bare `Uint8Array`.
- **Gate diagnostics (phase 3):** union `getGlobalDiagnostics()`, dedupe on
  `(code, fileName, pos)`, distinguish compiler-crash from clean (Spike C).
- **tsc is extracted per-user + spawned** (`uv_spawn` can't run an embedded
  `B:/~BUN/root/…` path); pin `lib: ["esnext"]`; per-platform builds (Spike C).
- **Host resolver registers THREE specifiers and fails open** — the Gate's
  source-text import scan is the only allowlist enforcement (Spike A).
- **Respawn-per-source is a correctness requirement** — Bun's module cache is stale;
  `?v=` busting fails (Spike A).
- **`reatomComponent` is from `@reatom/react@1001.0.0`**; test-renderer trees need
  `act()` from `'react'` (Spike D).
- **`SafeProjectFs` (phase 4):** `realpathSync` escape check + `GetFileAttributesW` +
  `FILE_ATTRIBUTE_REPARSE_POINT` FFI backstop (Spike F).
- **Durability flush (phase 4):** `CreateFileW(FILE_FLAG_BACKUP_SEMANTICS,
  GENERIC_WRITE)` + `FlushFileBuffers` — `GENERIC_WRITE` alone; ~19 ms/flush,
  ~380 ms/10-op tx (Spike G).
- **Claude confinement (phase 5):** `canUseTool` deny-by-default. **Codex is NOT in
  the MVP** (quota-blocked until 2026-07-23; re-verify then).
- **Process-tree cancel (phase 5):** Job Object + `QueryInformationJobObject` for
  graceful cancel; crash-recovery confirmation is an **open gap** →
  `backend_unhealthy_unconfirmed_exit`.

## 9. Working conventions in force

- **Work is on branch `phase-2-host`** — `git checkout phase-2-host` to resume.
- TDD: failing test → red → implement → green → `bun x tsc --noEmit` → commit. One
  capability per commit. Commit trailer: `Co-Authored-By: Claude Opus 4.8
  <noreply@anthropic.com>` (this session's model; earlier commits used Fable 5).
- Module folder shape (CLAUDE.md): code in `model/` (or `ui/`), `types.ts` + `index.ts`
  at module root; nothing loose at the root. `host/` submodules: `protocol/`, `render/`,
  and (next) `session/`, `supervisor/`.
- Module DAG (code-structure.md): `host` imports `infrastructure/`, resolves `runtime/`,
  implements `core`/`gate` ports (declared in `host/`'s own `types.ts` until those
  modules exist); `host` imports no other module.
- errore everywhere: namespace import, errors as values, tagged errors, one-line
  `instanceof Error` early returns, `.catch`/`errore.try({try,catch})` only at
  boundaries, no silent swallows.
- Execution pattern that worked this session: write plan → adversarial multi-lens
  review workflow → implement via a fresh subagent (its context is independent of the
  controller's) → controller runs the green gates itself → final whole-branch review
  subagent → apply fixes. The plan docs carry complete code; subagents transcribe +
  test + commit.
- Commit-message language + all docs/comments in English; chat replies to the user in
  Russian.
