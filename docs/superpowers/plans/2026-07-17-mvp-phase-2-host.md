# termcraft MVP Phase 2 — `host/` Design Host + HostSupervisor (master index)

> **For agentic workers:** This is the phase-2 index, not an executable task
> plan. Phase 2 is decomposed into four sub-plans, each a standalone document in
> `docs/superpowers/plans/` that produces working, independently-tested software.
> Write each sub-plan just-in-time with superpowers:writing-plans; execute it with
> superpowers:subagent-driven-development. Read this index, the roadmap's Global
> constraints, and the normative sources below before writing any sub-plan.

**Goal:** Build the `host/` module of the termcraft MVP: the supervised
design-host subprocess, its versioned stdio protocol, the headless OpenTUI
render harness, and the Kernel-owned `HostSupervisor` / `PreviewSession` facade —
per `docs/superpowers/specs/2026-07-16-host-supervision-protocol-design.md`.

**Normative sources (binding for every sub-plan):**

- `docs/superpowers/specs/2026-07-16-host-supervision-protocol-design.md` — the
  whole document (ownership, framing §5, hello DTOs §5.1, control envelope §5.2,
  frame envelope §5.3, handshake §6, requests/ordering §7, backpressure §8,
  timeouts §9, lifecycle/circuit-breaker §10, flows §11, failure table §12,
  isolation §13, testing §14, acceptance §15).
- `docs/superpowers/specs/2026-07-16-runtime-api-compatibility-design.md` — §3.1
  (three-specifier resolver, facade-owned JSX helper contract), §7 (compatibility
  identity, `RuntimeDeclarationBundleV1`, host handshake), §11.1 (facade contract
  tests must compile *and render* representative pages).
- `docs/superpowers/specs/2026-07-13-termcraft-design.md` — §4.2 (design host).
- Spikes A/B/D/E: `docs/spikes/{01-tsx-import,02-frame-capture,04-reatom-opentui,05-host-respawn}/FINDINGS.md`,
  synthesized in `docs/spikes/2026-07-17-findings.md` and `-round-2-findings.md`.
- `docs/architecture/code-structure.md` — `host/` is an adapter: it imports
  `infrastructure/`, resolves `runtime/`, implements the ports `core`/`gate`
  declare, and imports no other module. Module shape recurses (`model/`,
  `types.ts`, `index.ts`).

## Module layout

`host/` is one adapter module (code-structure.md §1). Its submodules each take the
`CLAUDE.md` shape (`model/`, `types.ts`, `index.ts`); a submodule appears only when
an area has both its own model and its own boundary.

```text
src/host/
  types.ts            host-shared vocabulary: HostMode, InteractionMode,
                      HostSessionSpec, HostSessionIdentity, FrameIdentity,
                      PreviewFrame, TerminalCapabilities, GeometryQuery/Reply
  index.ts            host module public entry (grows per slice)
  protocol/           2A — closed wire schemas + validating codec over framing
    model/            errors, strict-json, bundle, hello, control-envelope, frame
    types.ts          protocol DTOs (RuntimeDeclarationBundleV1, PublicLimits,
                      ClientHelloV1, HostHelloV1, ControlEnvelope, FrameEnvelope,
                      StyledRun, Color, ProtocolMessageClass mapping)
    index.ts
  render/             2B — headless OpenTUI renderer + span-based frame capture
    model/            renderer, fake-stream, capture, styled-frame, one-shot exit
    types.ts          CapturedFrame, RenderHandle, FakeStreamOptions
    index.ts
  session/            2C — `_host --stdio` entry, resolver, host-side protocol
    model/            resolver, source-mount, host-state-machine, entry
    ports/            (if any host-process-consumed port is declared here)
    types.ts
    index.ts
  supervisor/         2D — HostSupervisor, PreviewSession facade, frame broker,
    model/            one-shot smoke/export sessions, restart budget, queues
    types.ts          HostSession, PreviewSession, FrameToken, GeometryToken
    index.ts
```

`SmokeRenderer` and `PreviewSession`/`FrameToken` are consumed by `gate`/`core`,
which do not exist yet. Per the roadmap port-placement note, phase 2 declares these
contracts in `host/`'s own `types.ts` (or a submodule `types.ts`); phase 3/6 lift
the exact shapes `gate`/`core` consume into their `ports/` and inject via `main.ts`.
No cross-module import is introduced in phase 2.

## Sub-plans (dependency-ordered)

| Slice | Plan doc | Produces | Depends on | Primary spec |
|---|---|---|---|---|
| 2A | `2026-07-17-mvp-phase-2a-protocol.md` | `host/protocol/` — closed wire schemas + validating codec | phase-0 `infrastructure/framing` | §5, §5.1–5.3, §7.1 |
| 2B | `2026-07-17-mvp-phase-2b-render.md` | `host/render/` — headless renderer + styled-frame capture | phase-1 `runtime/` (partial), OpenTUI public API | §5.3, Spikes B/D |
| 2C | `2026-07-17-mvp-phase-2c-session.md` | `host/session/` — `_host` entry, resolver, host protocol loop | 2A, 2B, `runtime/` | §6, §7, §11, Spikes A/E |
| 2D | `2026-07-18-mvp-phase-2d-supervisor.md` (master index → 2D-1…2D-4 sub-plans, written JIT) | `host/supervisor/` — HostSupervisor, PreviewSession, broker | 2A, 2C | §3, §4, §8, §9, §10, §12, §13 |

2A and 2B are independent and can be built in either order; 2B is the phase-1
unblocker. 2C consumes both. 2D consumes 2A + 2C. Written and executed in this
session: **2A first** (pure, deterministic spine, lowest integration risk), then
**2B** (unblocks phase 1). 2C/2D follow in later sessions.

## Cross-slice interface registry

Names fixed here; exact signatures pinned in the slice that defines them, consumed
verbatim by later slices.

| Interface | Defined in | Consumed by | Authority |
|---|---|---|---|
| `ProtocolError` (tagged, `code`) | 2A `host/protocol` | 2C, 2D | §12 failure codes |
| `RuntimeDeclarationBundleV1`, `PublicLimits` | 2A `host/protocol` | 2C, 2D | runtime-api §7.1, host §5.1 |
| `ClientHelloV1`, `HostHelloV1` + codecs | 2A `host/protocol` | 2C (host emits `host.hello`), 2D (supervisor emits `client.hello`) | §5.1, §6 |
| `ControlEnvelope` + codec | 2A `host/protocol` | 2C, 2D | §5.2 |
| `FrameEnvelope`, `StyledRun`, `Color`, `FrameIdentity` | 2A `host/protocol` | 2B (encodes), 2D (decodes/brokers) | §5.3 |
| `CapturedFrame`, `RenderHandle` | 2B `host/render` | 2C (mounts + captures) | §5.3, Spike B |
| host-side protocol state machine | 2C `host/session` | 2D (spawns it) | §6, §7 |
| `HostSession`, `PreviewSession`, `FrameToken`, `GeometryToken` | 2D `host/supervisor` | phase 6 `core` | §3.1, §3.2 |

## Global constraints (inherited by every 2x sub-plan)

Every sub-plan repeats the roadmap's **Global constraints** by reference
(`2026-07-17-termcraft-mvp-roadmap.md`) and its tasks must obey them. Phase-2-critical
items, repeated because they bite:

- **errore mandatory:** namespace import; errors as values (`Error | T` unions);
  `createTaggedError` for `ProtocolError` (carry a stable `code` field); one-line
  `instanceof Error` early returns; `.catch()`/`errore.try` only at the OpenTUI /
  process / `JSON.parse` boundaries; no `let`+try; flat control flow.
- **Reatom v1001:** the render harness mounts a `reatomComponent` tree; automated
  tests of it MUST wrap Reatom writes in `act()` from `'react'` or the frame never
  changes (Spike D). `reatomComponent` is from `@reatom/react@1001.0.0`.
- **Framing is phase-0's job — reuse it, do not reinvent.** `host/protocol` builds
  on `infrastructure/framing` (`encodeFrame`, `FrameDecoder`, the constants,
  `WireFrame`, `MessageClass`). The four fatal framing conditions (§5: zero length,
  unsupported version, unknown class, non-zero flags) are already enforced there.
- **Closed schemas (§5).** Every JSON payload is a closed schema. Unknown/missing
  required fields, invalid UTF-8, **duplicate object keys**, non-finite numbers,
  **unsafe-integer JSON numbers**, and a `kind` invalid for its class are protocol
  violations. Identifiers/counters that may exceed `Number.MAX_SAFE_INTEGER`
  (`messageId`, `requestId`, `responseTo`, `frameSeq`) are decimal **strings** on
  the wire, never JSON numbers. `JSON.parse` alone cannot detect duplicate keys or
  unsafe integers — a strict parse is required (2A Task 1).
- **No resync.** The protocol never scans for a new prefix after malformed input;
  the supervisor terminates the incarnation (§5). At the codec layer this means a
  decode function returns a `ProtocolError`; recovery is not its concern.
- **Payload limits (§5):** control 262,144 B (256 KiB); frame/bulk 16,777,216 B
  (16 MiB); global ceiling 16 MiB. Hello payloads are control-class. Frame v1: ≤2,048
  cells per axis, ≤262,144 cells total; check `width × height` for integer overflow
  before allocation.
- **Resolver (Spike A / runtime-api §3.1):** the host registers **three** specifiers
  (`@termcraft/runtime`, `react/jsx-runtime`, `react/jsx-dev-runtime`) via a
  `Bun.plugin` resolver before the dynamic import; it **fails open**, so the Gate's
  source-text scan is the only allowlist enforcement. Read the environment through
  `Bun.env`, and register both JSX helper subpaths unconditionally. Respawn-per-source
  is a correctness requirement — Bun's module cache is stale and query-busting fails.
- **Render capture (Spike B):** frame text from the span API
  (`captureSpans`/`getSpanLines`), never `buffers.char` (wide chars throw); `span.width`
  is display width, not codepoint count; build on the **public** OpenTUI API, not
  `@opentui/core/testing`; a fake stdout's `columns` silently overrides the requested
  size (guard it); the stream shim must implement `setRawMode`; use
  `bufferedOutput: "memory"`.
- **One-shot exit (Spike D):** a Reatom+OpenTUI process does not exit on its own after
  `renderer.destroy()` — every one-shot host (smoke, export, a test render child) must
  call `process.exit()` explicitly. Harmless for the long-lived interactive kernel.
- **Self-spawn (Spike E):** `process.execPath` is the self-spawn path only inside the
  compiled binary; under `bun run` it is the Bun CLI — dev mode must branch.
- **Green gates:** `bun test` and `bun x tsc --noEmit` both clean after every task.
- **Commits:** one capability per commit; `feat:`/`test:` prefixes; Claude co-author
  trailer per repo history.
- **Architecture docs:** when a `host/` submodule lands, move the affected
  `docs/architecture/` Source anchors from spec sections to the real source paths.

## Out of scope for phase 2 (deferred to their phase)

- The Gate itself (phase 3) — `host` only *implements* `SmokeRenderer`; the Gate's
  tsc/import-scan/contract checks are phase 3.
- `SafeProjectFs`, leases, transactions, projections, render cache (phase 4).
- The agent backend (phase 5).
- The Kernel's Command/Event DTOs, the frame broker's wiring onto the Kernel event
  channel, and `PreviewSession` as typed Kernel-command adapters (phase 6). Phase 2
  builds the supervisor as a standalone owner of the child process and exposes the
  typed session handle; phase 6 wires it into `core`.
- The UI shell (phase 7). Composition root + `bun build --compile` (phase 8).
