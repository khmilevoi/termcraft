# termcraft MVP — Session Handoff (2026-07-17)

Purpose: hand the running MVP implementation to a fresh session with zero loss
of context. Read this top to bottom, then read the two operative plan docs it
points at. Everything here is already committed to `main` unless explicitly
marked otherwise.

## 0. TL;DR for the next session

- The MVP is being built in 9 phases. **Phase 0 is done and committed.
  Phase 1 has its first slice committed and is still open.**
- Operative sequencing: `docs/superpowers/plans/2026-07-17-termcraft-mvp-roadmap.md`.
  Its **"Global constraints"** block is binding for every phase and every task —
  read it before writing any code.
- Green gates, run after every task: `bun test` and `bun x tsc --noEmit`
  (both must be clean). Current state: **50 tests, 0 fail, tsc clean.**
- Load the `/reatom` and `/errore` skills before touching code (CLAUDE.md
  makes this mandatory for this repo).
- Next concrete work: **write the phase-2 plan (design host) and build the
  headless render harness**, then finish the phase-1 component catalog on top
  of it. See §5.

## 1. What exists now (committed to `main`)

Commit chain (newest first), all on `main`, all with the Claude co-author trailer:

```
b109386 feat: add runtime facade page contract — definePage + kit API identity
f9c31e4 feat: add buffering frame decoder — fragmentation-tolerant, poisoning on violation
4e7d9ca feat: add host-protocol frame encoder with §5 header layout and limits
b8861b6 feat: add injectable clock infrastructure
2f3fa10 feat: add uuidv7 infrastructure over Bun.randomUUIDv7
e270727 feat: add turn entity — AgentEvent taxonomy and TurnFence
987dc6e feat: add page entity — branded slug with mask + device-name validation
5d84b7e plan: MVP roadmap + phase-0 plan, review-hardened
3f280cb docs: land the MVP backend swap to Claude Code across spec and architecture
```

Source tree (`src/`) — every file has a colocated `*.test.ts` except pure
`types.ts`/`index.ts`:

```
src/
  entities/
    page/     types.ts (PageSlug branded, Size, PageMeta) + model/slug.ts (parsePageSlug, InvalidPageSlugError)
    turn/     types.ts (AgentEvent, AgentToolOp, TokenUsage, TurnFence)
  infrastructure/
    uuid/     model/uuidv7.ts (Bun.randomUUIDv7)
    clock/    types.ts (Clock) + model/system-clock.ts (systemClock)
    framing/  types.ts (MessageClass, WireFrame) + model/{constants,errors,encode,decoder}.ts
  runtime/    types.ts (PageMeta, Size, ThemeId) + model/define-page.ts (definePage, CURRENT_KIT_API_VERSION)
```

### Phase 0 — DONE (entities + infrastructure)

- `entities/page`: `parsePageSlug(raw) => InvalidPageSlugError | PageSlug`.
  Branded `PageSlug`. Enforces the mask `^[a-z0-9][a-z0-9-]{0,31}$` and rejects
  Windows device names (`con`,`nul`,`aux`,`prn`,`com1`–`com9`,`lpt1`–`lpt9`).
  Note: `com0`/`lpt0` are NOT reserved; `console` passes (only `con` is).
- `entities/turn`: the `AgentEvent` discriminated union (master spec §6.1
  verbatim: `reasoning | tool | final | usage | error`), `AgentToolOp`,
  `TokenUsage` (`contextPercent: number | null`), `TurnFence`
  (`{turnId, attempt, leaseNonce}`).
- `infrastructure/uuid`: `uuidv7()` over `Bun.randomUUIDv7` (monotonic → ids
  sort in generation order; storage relies on this).
- `infrastructure/clock`: injectable `Clock { now(): Date }` + `systemClock`.
- `infrastructure/framing`: the host-protocol §5 outer-frame codec.
  `encodeFrame(WireFrame) => FramingError | Uint8Array` and a `FrameDecoder`
  push-parser: `feed(chunk) => FramingError | WireFrame[]`, buffers arbitrary
  fragmentation, poisons permanently on any fatal condition.

### Phase 1 — STARTED (first slice committed, phase NOT complete)

- `runtime/`: `definePage(meta) => PageMeta` (identity — the Gate reads the AST,
  it never executes this) + `CURRENT_KIT_API_VERSION = 1`. The runtime `PageMeta`
  is deliberately a separate type from `entities/page`'s `PageMeta` so the
  facade leaks no internal module identity into authored pages (runtime-api
  §3.3). `ThemeId = "dark-default"` (MVP: one theme).

## 2. Where I stopped, and why (READ THIS)

I stopped at a clean, committed boundary **inside phase 1**, after the
`definePage` slice.

**Why here and not further:** the rest of phase 1 — the component catalog
(`Row`, `Column`, `Panel`, `Tabs`, `Text`, `Button`, `Input`, `List`, `Table`,
`Gauge`, `Sparkline`, `Separator`, `Spacer`), the Reatom re-exports, the JSX
helper surface, and the `dark-default` theme tokens — cannot be *verified*
without a working OpenTUI render loop. The runtime-api spec's own testing
strategy (§11.1) requires facade contract tests to compile representative pages
through `@termcraft/runtime` and **render** them. That render harness is built
in phase 2 (the design host). Writing the catalog blind, with no way to render
and snapshot it, would be unverifiable code — exactly what to avoid.

So the correct order is: **build the phase-2 headless render harness first,
then finish the phase-1 catalog against it.** This is a dependency reality, not
a scope cut. The roadmap already lists Spike D as normative for phase 1 *and*
phase 2 for this reason.

**Task tracker state at handoff** (in-session TaskList; re-create if the new
session has no task list): phase 0 completed, phase 1 in_progress, phases 2–8
pending.

## 3. Findings from the adversarial plan review (all resolved)

A 4-lens review workflow (spec-coverage, code-rules, framing-contract,
spike-fidelity) with skeptic verifiers ran against the roadmap + phase-0 plan.
The session hit a usage limit during the verify stage, so a few verifiers
errored — I verified those claims myself. Confirmed findings and their fixes,
all already landed in the committed plans/code:

1. **[BLOCKING] Zero-length frames were silently accepted.** Host-supervision
   §5 (verbatim): *"Lengths of zero, unsupported framing versions, unknown
   classes, and non-zero flags are fatal framing errors."* Every payload is
   UTF-8 JSON; empty bytes can't be valid JSON. **Fixed:** `encodeFrame` returns
   `FramingError` on an empty payload; `FrameDecoder` poisons on `N = 0`
   (detected from the 4-byte length prefix alone, next to the ceiling check).
   Tests inverted accordingly. This is done in the shipped code.
2. **[important] Roadmap framing constraint omitted the four fatal §5
   conditions + the no-resync rule.** **Fixed** in the roadmap's Global
   constraints.
3. **[important] Spike D's second finding was lost.** A Reatom+OpenTUI process
   does **not** exit on its own after `renderer.destroy()` — a one-shot render
   child (export session, smoke render, scripted-terminal test child) must call
   `process.exit()` explicitly or it hangs; harmless for the long-lived
   interactive kernel. **Fixed:** added to the roadmap's spike-earned rules and
   the normative-sources table (phases 1/2/8). **The next session MUST honor
   this when building any one-shot host in phase 2/8.**
4. **[verified-by-me] Branded `PageSlug` test wouldn't typecheck.** bun's
   `toBe(expected: T)` is strict (`expect("hello").toBe(3.14)` is a TS error).
   `expect(parsePageSlug(raw)).toBe(raw)` fails because plain `string` isn't
   assignable to the branded `PageSlug`. **Fixed:** the expected side is cast,
   `toBe(raw as PageSlug)`. Confirmed compiling in the committed code.
5. **[minor] §9 host-crash preview error panel** was unassigned. **Fixed:**
   added to phase 7's UI inventory in the roadmap.
6. **[cheap correctness]** The 120 s stream-silence watchdog + non-resettable
   absolute deadline, and the `termcraft export` CLI entry point, were made
   explicit in phases 5/6/8.

Refuted (correctly, no change): "export package content not assigned to a
phase" — the roadmap is explicitly *not* an executable task plan; the master
spec is normative per phase via the normative-sources table.

## 4. Traps and constraints the next session must not rediscover the hard way

From the spikes (`docs/spikes/2026-07-17-findings.md`,
`docs/spikes/2026-07-17-round-2-findings.md`) and from real tsc failures hit
during phase 0. These are all in the roadmap's Global constraints, repeated
here because they bite:

- **TS is `typescript@7.0.2` — the native Go port.** No `ts.createProgram`, no
  `CompilerHost`. The Gate (phase 3) is built on `typescript/unstable/sync`.
  `Uint8Array` is now generic over its buffer (`Uint8Array<ArrayBufferLike>`),
  so a reassigned byte buffer must be annotated as bare `Uint8Array` or tsc
  errors `Uint8Array<ArrayBuffer>` vs `<ArrayBufferLike>` (hit in the decoder;
  fixed by annotating the field). Watch for this everywhere bytes are handled.
- **Gate diagnostics (phase 3):** union `getGlobalDiagnostics()` (missing-lib
  errors land ONLY there), dedupe on `(code, fileName, pos)`, and distinguish
  compiler-crash from clean (empty diag array from a crash must be a typed
  failure, never an apply).
- **tsc is extracted to a per-user dir and spawned** (`uv_spawn` can't run an
  embedded `B:/~BUN/root/…` path); pin `lib: ["esnext"]`; per-platform builds.
- **Host resolver registers THREE specifiers** (`@termcraft/runtime`,
  `react/jsx-runtime`, `react/jsx-dev-runtime`) and **fails open** — so the
  Gate's source-text import scan is the only enforcement of the allowlist.
- **Respawn-per-source is a correctness requirement** — Bun's module cache is
  stale and `?v=` busting doesn't work.
- **Frame text from the span API (`captureSpans`/`getSpanLines`), never
  `buffers.char`** (wide chars throw); width is display width; build the host
  on the **public** OpenTUI API, not `@opentui/core/testing`; a fake stdout's
  `columns` silently overrides the requested size; the stream shim must
  implement `setRawMode`.
- **`reatomComponent` is from `@reatom/react@1001.0.0`** (NOT `@reatom/core`).
  Tests of `reatomComponent` trees under the test renderer MUST wrap Reatom
  writes in `act()` from `'react'` or frames silently never change (Spike D).
- **`process.execPath`** is the self-spawn path only inside the compiled binary;
  under `bun run` it's the Bun CLI — dev mode must branch (Spike E).
- **`SafeProjectFs` (phase 4):** escape check via `realpathSync` comparison;
  junction/reparse detection needs the `GetFileAttributesW` +
  `FILE_ATTRIBUTE_REPARSE_POINT` FFI backstop, not `isSymbolicLink()` alone
  (Spike F). Real NTFS symlinks were untested (no elevated shell).
- **Durability flush (phase 4):** `CreateFileW(FILE_FLAG_BACKUP_SEMANTICS,
  GENERIC_WRITE)` + `FlushFileBuffers` — `GENERIC_WRITE` **alone**
  (`GENERIC_READ` makes the flush fail `ERROR_ACCESS_DENIED`); ~19 ms per flush,
  ~380 ms per 10-op transaction — budget for it (Spike G).
- **Claude confinement (phase 5):** `canUseTool` deny-by-default callback,
  verified under attack. **Codex is NOT in the MVP** (quota-blocked until
  2026-07-23; re-verify then) — Claude Code only.
- **Process-tree cancel (phase 5):** Job Object + `QueryInformationJobObject`
  confirmation works for graceful `cancel()`; the **crash-recovery
  confirmation path is an open gap** — MVP treats it as
  `backend_unhealthy_unconfirmed_exit`. Do not pretend it's solved.

## 5. Concrete next steps (in order)

1. **Write the phase-2 plan** (`docs/superpowers/plans/2026-07-17-mvp-phase-2-host.md`)
   per the writing-plans skill, normative sources: the whole
   `2026-07-16-host-supervision-protocol-design.md` + Spikes A/B/D/E. It covers:
   the `termcraft _host` entry, the `Bun.plugin` resolver for the three
   specifiers, a headless renderer on the **public** OpenTUI API (fake streams,
   `bufferedOutput: "memory"`), span-based styled frame capture, protocol v1
   (handshake binding `sessionId`/nonce/`sourceHash`/`kitApiVersion`/limits;
   heartbeat; frames with monotonic `frameSeq`; queries `checkHit`/`rectOf`/
   `describe`/`layoutTree`), `HostSupervisor` (timeouts, restart budget,
   backoff, circuit breaker, respawn-per-source), `PreviewSession`
   (latest-frame-wins), and the one-shot export session (`renderOnce` at t=0,
   **explicit `process.exit()`** per Spike D). The framing codec from phase 0
   (`src/infrastructure/framing`) is the wire layer — reuse it, don't reinvent.
2. **Build a minimal headless render harness** as part of phase 2 (or its first
   task) so a page can be mounted and its frame captured. This is what unblocks
   phase 1.
3. **Finish phase 1 on that harness:** the component catalog (each visible
   component takes a mandatory stable `id` prop, wraps an OpenTUI renderable —
   the intrinsics are lowercase: `box`, `text`, `input`, `select`, `scrollbox`,
   `span`, `tab-select`, …), the low-level primitive escape hatch, the Reatom
   re-exports (`atom`, `computed`, `action`, `wrap`, `withAsync`,
   `withAsyncData`, `withComputed`, `withAbort`, `withConnectHook`,
   `reatomComponent`), the JSX helper surface (positional `key`; `jsx`/`jsxs`
   share `(type, props, key)`; `jsxs` is production-only, dev emits `jsxDEV`;
   `Fragment` is an exported value), the dormant `usePages().goTo` /
   `useTweak` / `defineTweaks` APIs, and the `dark-default` theme tokens
   (`background surface text text-muted text-faint border primary accent
   selection ok error` — palette in `design/*.dc.html`; warm dark, bg `#0a0908`,
   surface `#14110d`, primary-gold `#f6c163`; pin exact token→hex against the
   design frames with the render harness).
4. Then phases 3→8 per the roadmap.

## 6. Operative documents (read in this order)

1. `docs/superpowers/plans/2026-07-17-termcraft-mvp-roadmap.md` — phases,
   Global constraints, normative-sources table, cross-phase interface registry,
   out-of-scope list.
2. `docs/superpowers/plans/2026-07-17-mvp-phase-0-scaffold.md` — the completed
   phase-0 plan (reference for the TDD cadence and file-shape conventions).
3. `docs/superpowers/specs/2026-07-13-termcraft-design.md` — master spec.
4. The six `2026-07-16-*-design.md` detailed specs (host, kernel, storage,
   durability, runtime-api, projections) — normative per phase.
5. `docs/spikes/2026-07-17-findings.md` and `-round-2-findings.md` — the
   spike evidence behind every "trap" in §4.
6. `CLAUDE.md` (repo) — module folder shape, mandatory `/reatom` + `/errore`.
7. Memory: `termcraft-pending-design-fixes` carries the standing design
   decisions and a mirror of this implementation-status note.

## 7. Working conventions in force

- TDD: write the failing test, run it red, implement, run green, then
  `bun x tsc --noEmit`, then commit. One entity/capability per commit.
- Module folder shape (CLAUDE.md): code in `model/` (or `ui/`) subfolders,
  `types.ts` + `index.ts` at the module root; nothing loose at the root.
- Module DAG (code-structure.md): `core` imports only `entities/` + its own
  `ports/`; adapters implement ports; `ui` sees only core boundary types +
  `PreviewSession`; `runtime/` is a leaf (imports NO termcraft module, which is
  why runtime redefines `PageMeta` rather than importing `entities/page`);
  `infrastructure/` is domain-free.
- errore everywhere: namespace import, errors as values, tagged errors,
  one-line `instanceof Error` early returns, no silent swallows.
- Commit-message language and all docs/comments in English; chat replies to the
  user in Russian.
