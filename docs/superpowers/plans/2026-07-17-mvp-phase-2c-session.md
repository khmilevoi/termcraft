# termcraft MVP Phase 2C — Host Session (`_host --stdio`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Load `/reatom` and `/errore` before touching code (CLAUDE.md mandate).

**Goal:** Build `src/host/session/` — the design-host **child** process: the
`Bun.plugin` three-specifier resolver, the source mount path (hash recompute +
import rescan + dynamic import + page validation), the host-side protocol state
machine (`client.hello`→`host.hello`→`mount`→`ready`→`frame`→`heartbeat`→
`resize`/`set-mode`/`ping`→`shutdown`), and the `termcraft _host --stdio` entry
with the one-shot smoke/export `process.exit()` path.

**Architecture:** `host/session/` is the fourth submodule of the `host/` adapter.
It is the code that runs **inside** the spawned child. It imports `host/protocol`
(2A codecs/DTOs), `host/render` (2B headless harness), `infrastructure/framing`
(the byte `FrameDecoder`), `infrastructure/uuid` is **not** used here (the child
never generates identity — it echoes the supervisor's), and it resolves
`@termcraft/runtime` at runtime through a `Bun.plugin` resolver. The state machine
is a pure-ish driver: it consumes decoded control payloads and emits **logical**
outbound messages through an injected `send` callback, so it is testable without
real stdio. The thin `entry` wires the byte transport (stdin `FrameDecoder` →
state machine → stdout sink), the heartbeat timer, and `process.exit`.

**Tech Stack:** TypeScript 7.0.2, Bun ≥1.3.14 (`Bun.plugin`, `Bun.Transpiler`,
`Bun.CryptoHasher`, `Bun.env`, `Bun.file`), `@opentui/core`/`@opentui/react` 0.4.5
(exact) via `host/render` (`createElement` is re-exported by `@opentui/react` —
the repo has no `@types/react`, so importing it from `react` directly does **not**
typecheck), `react` 19 (runtime only), `errore` 0.14.1, `bun:test`. tsconfig
`jsx: "react-jsx"`, `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`.

## Global Constraints

See `2026-07-17-termcraft-mvp-roadmap.md` and `2026-07-17-mvp-phase-2-host.md` →
"Global constraints". Phase-2C-critical items (verbatim values that bite):

- **errore mandatory:** namespace import; errors as values (`Error | T`); reuse
  2A's `ProtocolError` (tagged, stable `code`) for every fatal protocol violation;
  one-line `instanceof Error` early returns; `.catch()`/`errore.try({try,catch})`
  **only** at the Bun boundaries (`import()`, `Bun.file`, `JSON`, the renderer);
  no `let`+try; flat control flow; never silently swallow (log or return).
- **Resolver registers THREE specifiers and fails open (Spike A / runtime-api
  §3.1):** `@termcraft/runtime`, `react/jsx-runtime`, `react/jsx-dev-runtime`, via
  `Bun.plugin` `build.module` **before** any dynamic import. Register all three
  **unconditionally** — never branch on `process.env.NODE_ENV` (dot access is
  inlined to the literal `"development"` in the compiled binary and lies forever;
  the transform follows the real value). The JSX helpers back to
  `@opentui/react/jsx-runtime` / `@opentui/react/jsx-dev-runtime` (which re-export
  React's `jsx`/`jsxs`/`jsxDEV`/`Fragment`). The resolver is the **only** thing
  making a page's `@termcraft/runtime` import resolve; it does **not** enforce the
  allowlist — the import **rescan** (Task 2) does.
- **Respawn-per-source is correctness (Spike A):** Bun serves a stale module for a
  re-imported path and ignores `?v=` cache-busting; the child imports each source
  exactly once and exits. Nothing in this slice re-imports a changed page in-process.
- **One-shot exit (Spike D):** a Reatom+OpenTUI child does **not** exit on its own
  after `renderer.destroy()`. Every one-shot host (`smoke`, `export`) MUST call
  `process.exit()` explicitly, after flushing stdout. `bun test` MUST NOT call
  `process.exit` (it kills the runner) — the entry's `exit` is injected; tests
  capture it.
- **Self-spawn is 2D's concern, not this slice's:** `process.execPath` names the
  child only inside the compiled binary; under `bun run` it is the Bun CLI
  (Spike E). This slice is the child; it never spawns anything.
- **Framing reuse:** the child reads stdin through `infrastructure/framing`'s
  `FrameDecoder` (fragmentation is normal — Spike E saw 5 stdio events for 3
  frames) and writes through the 2A codecs' already-framed bytes. Do not reinvent
  framing.
- **Identity echo, never generate:** the child echoes the supervisor's `sessionId`
  and `nonce` from `client.hello`. Every post-handshake inbound envelope whose
  `sessionId`/`nonce` differ is a fatal violation (§10.1).
- **Closed schemas, no resync (§5):** a decode/validation failure returns a
  `ProtocolError`; the child emits a best-effort `error` (only if past handshake,
  when it has identity to echo) and exits. It never scans for a new prefix.
- **`.tsx` pragma (carried trap):** every `.tsx` file (test fixtures, state-machine
  `.test.tsx`) needs `/** @jsxImportSource @opentui/react */` as its FIRST line —
  the repo has no `@types/react`, so `tsc` can't resolve `JSX.IntrinsicElements`
  without it. Do NOT add `@types/react` or change tsconfig `jsx`. **A saved page
  fixture (`fixtures/*.tsx`) must NOT carry the pragma** — a real page uses plain
  JSX, and the transform's `react/jsx-runtime` output is what the resolver serves.
- **Production mount path needs no `act()` (Spike D):** `createRoot(renderer)
  .render()` flushes Reatom writes after a microtask tick. A reactive assertion
  waits one `setTimeout(0)` tick after `atom.set` before re-rendering.
- **Green gates after every task:** `bun test` and `bun x tsc --noEmit` both clean,
  and `bun test` returns to the shell (no hang — every live renderer destroyed).

## Scope (what 2C builds — and what it explicitly does NOT)

**In scope — the host-side protocol spine:**

- resolver (three specifiers, fail-open);
- source mount: `computeSourceHash`, `scanPageImports`, `loadPage`;
- `host/render` `RenderHandle.resize` (small extension needed for `resize`);
- the state machine handling inbound `client.hello`, `mount`, `resize`,
  `set-mode`, `ping`, `shutdown`, and emitting `host.hello`, `ready`, `frame`,
  `heartbeat`, correlated responses, `shutdown-ack`, and typed `error`;
- one-shot exit for `smoke`/`export` (mount → `ready` + first `frame` → exit 0);
- the `_host --stdio` entry (arg parse, byte transport, heartbeat timer, exit).

> **`export` is a documented MVP stand-in, not conformant.** Per host-supervision
> §4 / §11.4 / lines 564-565, an `export` host's real deliverable is a
> request-correlated `capture` reply carrying **one frame AND one resolved layout
> tree at the same `frameSeq`**. 2A defines only the `frame` envelope; the bulk
> `capture`/`layout` family does not exist yet. So a 2C `export` mount emits the
> plain preview-shaped `frame` and exits 0 — a correct one-shot **process lifetime**
> but a **non-conformant wire deliverable**: it is uncorrelated and shaped like a
> preview frame, so §14.5 forbids a supervisor from ever routing it to the preview
> stream. **2D must add the correlated `capture` reply (frame + layout at a matching
> `frameSeq`/request id) before any real export flow works**, and 2D's export
> supervisor must not treat the 2C stand-in frame as a conformant capture. `smoke`
> (§11.3: one mount, one render, metadata + one frame, then exit) IS faithful.

**Out of scope — deferred, documented, NOT half-implemented:**

- **Geometry queries** (`query-hit`/`query-rect`/`query-describe`/`query-layout`)
  and the **bulk `capture`/`layout` reply with a resolved layout tree** — they need
  new frame/bulk envelope schemas (2A defined only `frame`) and OpenTUI layout/hit-
  grid introspection. Export in 2C emits the sealed `frame` and exits; its frame IS
  the captured render for MVP, layout tree deferred.
- **Input forwarding** (`input-key`/`input-mousemove`/`input-click`), **tweaks**
  (`set-tweak`), **`set-theme`/`set-capabilities`**, **`navigation`/`runtime-
  warning`/`done`** — they need the phase-1 runtime capability models and input
  plumbing.
- **Queues/backpressure/coalescing/timeouts/restart budget/circuit breaker** — all
  supervisor-side, Plan **2D**.

A post-handshake inbound `kind` that is not one of {`mount` (pre-ready only),
`resize`, `set-mode`, `ping`, `shutdown`} is treated as an unimplemented/unknown
kind for the negotiated version: a fatal `MALFORMED_PROTOCOL` (§5). Later phases
widen the accepted set as they implement those families. The supervisor (2D) only
sends the spine kinds to a 2C host.

## Interfaces consumed (verbatim from 2A/2B/infra — do not redefine)

- `host/protocol` (`src/host/protocol/index.ts`): `ProtocolError`
  (`new ProtocolError({ code, reason, cause? })`, `.code`, `.reason`),
  `ProtocolViolationCode`; `ClientHelloV1`, `HostHelloV1`, `ControlEnvelope`,
  `FrameEnvelope`, `FrameIdentity`, `StyledRun`, `Color`,
  `RuntimeDeclarationBundleV1`, `PublicLimits`; `decodeClientHello(bytes)
  → ProtocolError | ClientHelloV1`, `encodeHostHello(hello) → ProtocolError |
  Uint8Array`, `decodeControlEnvelope(bytes) → ProtocolError | ControlEnvelope`,
  `encodeControlEnvelope(env) → ProtocolError | Uint8Array`, `encodeFrameEnvelope(
  frame) → ProtocolError | Uint8Array`; `PROTOCOL_HARD_LIMITS`,
  `validatePublicLimits`, `validateRuntimeDeclarationBundle`;
  shape guards from `./model/shape` are **internal to protocol** — 2C re-derives the
  few it needs as small local guards (see Task 5) rather than reaching into a
  submodule's `model/`.
- `host/render` (`src/host/render/index.ts`): `createHeadlessRenderer(size) →
  Promise<RenderHandle>`, `RenderHandle` (`mount(node)`, `render()`, `capture()
  → CapturedFrame`, `destroy()` — **`resize(size)` added in Task 3**),
  `CapturedFrame` (`{ width, height, rows: StyledRun[][] }`).
- `host/types.ts`: `HostMode`, `InteractionMode`, `Size` (**`TerminalCapabilities`
  added in Task 4**).
- `infrastructure/framing` (`src/infrastructure/framing/index.ts`): `FrameDecoder`
  (`feed(chunk) → FramingError | WireFrame[]`), `WireFrame`
  (`{ messageClass: "control" | "data", payload: Uint8Array }`), `FramingError`.
- `@opentui/react`: `createElement` (re-exported from React at
  `@opentui/react/src/index.d.ts`; covered by `skipLibCheck`, so the untyped-`react`
  error is suppressed while the binding still resolves). **Do NOT** `import
  { createElement } from "react"` — the repo has no `@types/react` and `react`
  ships no `.d.ts`, so that is a `TS7016` compile error.
- `@opentui/react/jsx-runtime`, `@opentui/react/jsx-dev-runtime`: namespace objects
  re-exporting React's `jsx`/`jsxs`/`jsxDEV`/`Fragment`.

## File Structure

```text
src/host/
  types.ts                         + TerminalCapabilities (append)               (Task 4)
  render/
    types.ts                       + RenderHandle.resize(size)                   (Task 3)
    model/renderer.ts              + resize() on the returned handle             (Task 3)
    model/renderer.test.tsx        + resize test                                 (Task 3)
  session/
    model/
      resolver.ts                  registerRuntimeResolver()                     (Task 1)
      resolver.test.ts             (+ fixtures/probe-page.tsx)                    (Task 1)
      source-mount.ts              computeSourceHash, scanPageImports, loadPage   (Tasks 2, 5)
      source-mount.test.ts         (+ fixtures/*.tsx)                            (Tasks 2, 5)
      host-state-machine.ts        createHostSession()                          (Tasks 6-8)
      host-state-machine.test.tsx
      entry.ts                     parseHostArgs, runHostStdio                   (Task 9)
      entry.test.ts
    fixtures/                      real .tsx pages imported by tests
      probe-page.tsx               valid facade page (no pragma)                 (Task 1)
      forbidden-react.tsx          imports "react" — rejected by scan            (Task 5)
      forbidden-relative.tsx       imports "./x" — rejected by scan              (Task 5)
    types.ts                       body DTOs, OutboundMessage, deps, LoadedPage  (Task 5)
    index.ts                       public entry
```

---

### Task 1: Runtime resolver — three specifiers, fail-open

**Files:**
- Modify: `tsconfig.json` (exclude the fixtures dir from the typecheck)
- Create: `src/host/session/model/resolver.ts`
- Create: `src/host/session/model/resolver.test.ts`
- Create: `src/host/session/fixtures/probe-page.tsx`
- Create: `src/host/session/index.ts`

**Interfaces:**
- Consumes: `plugin` from `bun`; `* as runtime` from `../../../runtime`;
  `* as jsxRuntime` from `@opentui/react/jsx-runtime`;
  `* as jsxDevRuntime` from `@opentui/react/jsx-dev-runtime`.
- Produces: `registerRuntimeResolver(): void` — idempotent; registers the three
  specifiers via `Bun.plugin` `build.module` with `loader: "object"`. Fails open
  (no allowlist enforcement — that is the import rescan's job, Task 2/5).

- [ ] **Step 0: Exclude the fixtures dir from tsc (do this FIRST)**

The fixture `.tsx` pages carry **no** `@jsxImportSource` pragma (a real saved page
has none — Spike A), and they import `@termcraft/runtime` (resolved only at runtime
by the plugin). Under `include: ["src"]`, `tsc` would type-check them and fail with
`TS7026` (no `JSX.IntrinsicElements`), `TS7016` (no `react/jsx-runtime` decl), and
`TS2307` (`@termcraft/runtime`). Adding a pragma is **not** a valid fix — it would
not resolve `@termcraft/runtime`. Exclude the dir instead; Bun's runtime `import()`
still transpiles and loads them for the tests.

In `tsconfig.json`, change:

```jsonc
  "exclude": ["docs/spikes"]
```

to:

```jsonc
  "exclude": ["docs/spikes", "src/host/session/fixtures"]
```

- [ ] **Step 1: Write the fixture page (a real, resolvable facade page)**

`src/host/session/fixtures/probe-page.tsx` — **no `@jsxImportSource` pragma**
(a real saved page has none; the transform emits `react/jsx-runtime`, which the
resolver serves):

```tsx
import { definePage } from "@termcraft/runtime"

export const meta = definePage({
  kitApiVersion: 1,
  title: "Probe page",
  minSize: { w: 10, h: 2 },
  theme: "dark-default",
})

export default function ProbePage() {
  return (
    <box>
      <text>hi-from-fixture</text>
    </box>
  )
}
```

- [ ] **Step 2: Write the failing test**

`src/host/session/model/resolver.test.ts`:

```ts
import { describe, expect, test } from "bun:test"

import { registerRuntimeResolver } from "./resolver"

const pagePath = `${import.meta.dir}/../fixtures/probe-page.tsx`

describe("registerRuntimeResolver", () => {
  test("lets an external .tsx page import @termcraft/runtime", async () => {
    registerRuntimeResolver()
    const page = (await import(pagePath)) as {
      meta: { kitApiVersion: number; title: string }
      default: unknown
    }
    expect(page.meta.kitApiVersion).toBe(1)
    expect(page.meta.title).toBe("Probe page")
    expect(typeof page.default).toBe("function")
  })

  test("is idempotent — a second call does not throw", () => {
    expect(() => {
      registerRuntimeResolver()
      registerRuntimeResolver()
    }).not.toThrow()
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test src/host/session/model/resolver.test.ts`
Expected: FAIL — cannot resolve `./resolver`.

- [ ] **Step 4: Write the implementation**

`src/host/session/model/resolver.ts`:

```ts
import { plugin } from "bun"

import * as jsxDevRuntime from "@opentui/react/jsx-dev-runtime"
import * as jsxRuntime from "@opentui/react/jsx-runtime"
import * as runtime from "../../../runtime"

let registered = false

/**
 * Register the `Bun.plugin` runtime resolver (Spike A / runtime-api §3.1). It
 * serves THREE specifiers so a real JSX page loads inside the compiled binary,
 * where the page's own directory has no `node_modules`:
 *   - `@termcraft/runtime`   → the embedded facade;
 *   - `react/jsx-runtime`    → React's production JSX helpers (via OpenTUI's
 *                              re-export), what the transform emits under
 *                              `NODE_ENV=production`;
 *   - `react/jsx-dev-runtime`→ React's development JSX helpers, the default the
 *                              transform emits otherwise.
 * Both helper subpaths are registered UNCONDITIONALLY: the mode is only reliably
 * detectable via `Bun.env.NODE_ENV`, while `process.env.NODE_ENV` dot access is
 * inlined to `"development"` in the compiled binary and lies forever — branching
 * on it breaks every page from an env var the host never sees.
 *
 * The resolver FAILS OPEN: it does not check the allowlist. A page that reached
 * it with an explicit `react/jsx-runtime` import would resolve and run — the
 * allowlist is enforced only by the import rescan (`scanPageImports`, before the
 * dynamic import) and the Gate's source scan (phase 3). Idempotent: a repeat call
 * is a no-op, because `Bun.plugin` has process-global effect.
 */
export function registerRuntimeResolver(): void {
  if (registered) return
  registered = true
  plugin({
    name: "termcraft-runtime-resolver",
    setup(build) {
      build.module("@termcraft/runtime", () => ({
        exports: runtime as Record<string, unknown>,
        loader: "object",
      }))
      build.module("react/jsx-runtime", () => ({
        exports: jsxRuntime as Record<string, unknown>,
        loader: "object",
      }))
      build.module("react/jsx-dev-runtime", () => ({
        exports: jsxDevRuntime as Record<string, unknown>,
        loader: "object",
      }))
    },
  })
}
```

`src/host/session/index.ts`:

```ts
export { registerRuntimeResolver } from "./model/resolver"
```

- [ ] **Step 5: Run tests and typecheck**

Run: `bun test src/host/session && bun x tsc --noEmit`
Expected: PASS, exit 0. (If `@opentui/react/jsx-runtime` type import trips
`verbatimModuleSyntax`, use `import * as jsxRuntime` as shown — a namespace value
import, not a type import. If `build.module`'s `loader: "object"` typing rejects
the namespace, cast to `Record<string, unknown>` as shown; the runtime shape is
proven by the probe.)

- [ ] **Step 6: Commit**

```bash
git add src/host/session
git commit -m "feat: add host runtime resolver (three specifiers, fail-open)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Source hash + import rescan — the two pure gatekeepers

**Files:**
- Create: `src/host/session/model/source-mount.ts`
- Create: `src/host/session/model/source-mount.test.ts`
- Create: `src/host/session/fixtures/forbidden-react.tsx`
- Create: `src/host/session/fixtures/forbidden-relative.tsx`
- Modify: `src/host/session/index.ts`

**Interfaces:**
- Consumes: `Bun.CryptoHasher`, `Bun.Transpiler`; `ProtocolError` from
  `../../protocol`.
- Produces:
  - `computeSourceHash(bytes: Uint8Array): string` — lowercase-hex SHA-256.
  - `scanPageImports(sourceText: string): ProtocolError | void` — `void` when every
    module edge is exactly `@termcraft/runtime`; a `ProtocolError`
    (`MALFORMED_PROTOCOL`) naming the first forbidden specifier otherwise.

- [ ] **Step 1: Write the forbidden fixtures**

`src/host/session/fixtures/forbidden-react.tsx`:

```tsx
import { definePage } from "@termcraft/runtime"
import { useState } from "react"

export const meta = definePage({
  kitApiVersion: 1,
  title: "Forbidden react",
  minSize: { w: 10, h: 2 },
  theme: "dark-default",
})

export default function Bad() {
  useState(0)
  return <text>bad</text>
}
```

`src/host/session/fixtures/forbidden-relative.tsx`:

```tsx
import { definePage } from "@termcraft/runtime"
export { helper } from "./neighbour.ts"

export const meta = definePage({
  kitApiVersion: 1,
  title: "Forbidden relative",
  minSize: { w: 10, h: 2 },
  theme: "dark-default",
})

export default function Bad() {
  return <text>bad</text>
}
```

- [ ] **Step 2: Write the failing test**

`src/host/session/model/source-mount.test.ts`:

```ts
import { describe, expect, test } from "bun:test"

import { ProtocolError } from "../../protocol"
import { computeSourceHash, scanPageImports } from "./source-mount"

describe("computeSourceHash", () => {
  test("is the lowercase-hex SHA-256 of the exact bytes", () => {
    const hash = computeSourceHash(new TextEncoder().encode("hello world\n"))
    expect(hash).toBe(
      "a948904f2f0f479b8f8197694b30184b0d2ed1c1cd2a1ec0fb85d299a192a447",
    )
    expect(hash).toHaveLength(64)
  })

  test("differs for a one-byte change", () => {
    const a = computeSourceHash(new TextEncoder().encode("a"))
    const b = computeSourceHash(new TextEncoder().encode("b"))
    expect(a).not.toBe(b)
  })
})

describe("scanPageImports", () => {
  test("accepts a page importing only @termcraft/runtime", () => {
    const src = `import { definePage, Panel } from "@termcraft/runtime"
import type { PageMeta } from "@termcraft/runtime"
export default function P() { return null }`
    expect(scanPageImports(src)).toBeUndefined()
  })

  test("rejects a bare react import", () => {
    const src = `import { useState } from "react"`
    const result = scanPageImports(src)
    expect(result).toBeInstanceOf(ProtocolError)
    expect((result as ProtocolError).code).toBe("MALFORMED_PROTOCOL")
    expect((result as ProtocolError).reason).toContain("react")
  })

  test("rejects a relative re-export", () => {
    const src = `export { x } from "./sibling.ts"`
    expect(scanPageImports(src)).toBeInstanceOf(ProtocolError)
  })

  test("rejects a dynamic import of a forbidden module", () => {
    const src = `const m = () => import("@termcraft/kit")`
    const result = scanPageImports(src)
    expect(result).toBeInstanceOf(ProtocolError)
    expect((result as ProtocolError).reason).toContain("@termcraft/kit")
  })

  test("rejects an @opentui side-effect import", () => {
    const src = `import "@opentui/core"`
    expect(scanPageImports(src)).toBeInstanceOf(ProtocolError)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test src/host/session/model/source-mount.test.ts`
Expected: FAIL — cannot resolve `./source-mount`.

- [ ] **Step 4: Write the implementation**

`src/host/session/model/source-mount.ts`:

```ts
import { ProtocolError } from "../../protocol"

/** The one legal authored module edge (runtime-api §2). */
const RUNTIME_SPECIFIER = "@termcraft/runtime"

/** Lowercase-hex SHA-256 over the exact source bytes (host-supervision §3.1). */
export function computeSourceHash(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
}

/**
 * Re-scan a page's source for module edges before linking it (runtime-api §3.1,
 * §7.2 — "the host repeats the same import scan"). This is a defense-in-depth
 * backstop: the Gate's AST scan (phase 3) is authoritative, and the resolver
 * fails open, so a hand-edited canonical file or an old historical snapshot that
 * bypassed the Gate is caught here before any page code runs.
 *
 * Uses `Bun.Transpiler.scanImports`, which reports every code-loading edge —
 * `import-statement` (incl. `export … from`), `dynamic-import`, and `require` —
 * using Bun's real parser, not a regex. Any specifier other than the exact root
 * `@termcraft/runtime` is a `MALFORMED_PROTOCOL` violation. Type-only edges are
 * erased by the transform and load no code, so `scanImports` may omit them; the
 * Gate's AST scan (phase 3) remains the authority for the type-only rule.
 */
export function scanPageImports(sourceText: string): ProtocolError | void {
  const transpiler = new Bun.Transpiler({ loader: "tsx" })
  const imports = transpiler.scanImports(sourceText)
  for (const record of imports) {
    if (record.path !== RUNTIME_SPECIFIER) {
      return new ProtocolError({
        code: "MALFORMED_PROTOCOL",
        reason: `forbidden import ${JSON.stringify(record.path)}; a page may import only "${RUNTIME_SPECIFIER}"`,
      })
    }
  }
}
```

Append to `src/host/session/index.ts`:

```ts
export { computeSourceHash, scanPageImports } from "./model/source-mount"
```

- [ ] **Step 5: Run tests and typecheck**

Run: `bun test src/host/session && bun x tsc --noEmit`
Expected: PASS, exit 0. (If `Bun.Transpiler`'s `scanImports` return type is not in
`@types/bun`, its records are `{ kind: string; path: string }` — read `.path`
only. If `scanImports` throws on genuinely un-parseable source, that is a separate
concern handled at `loadPage` where the bytes are actually imported; `scanPageImports`
receives already-decoded text and Bun's scanner tolerates partial/edge syntax.)

- [ ] **Step 6: Commit**

```bash
git add src/host/session
git commit -m "feat: add host source-hash recompute + import rescan

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `host/render` — add `RenderHandle.resize(size)`

**Files:**
- Modify: `src/host/render/types.ts` (add `resize` to `RenderHandle`)
- Modify: `src/host/render/model/renderer.ts` (implement `resize`)
- Modify: `src/host/render/model/renderer.test.tsx` (add a resize test)

**Interfaces:**
- Consumes: `CliRenderer.resize(width, height)` (public, `@opentui/core@0.4.5`
  `renderer.d.ts:510` — "Programmatically resize the renderer to new dimensions.
  Use this for externally-driven resize events").
- Produces: `RenderHandle.resize(size: Size): void` — resize the live renderer in
  place, preserving the mounted React tree and its Reatom atom state (no re-mount).

- [ ] **Step 1: Write the failing test**

Append to `src/host/render/model/renderer.test.tsx` (inside the existing
`describe("headless renderer", …)`):

```tsx
  test("resize changes the captured dimensions without re-mounting", async () => {
    const handle = await createHeadlessRenderer({ w: 10, h: 3 })
    open = handle
    handle.mount(
      <box>
        <text>resize-me</text>
      </box>,
    )
    await handle.render()
    expect(handle.capture().width).toBe(10)

    handle.resize({ w: 24, h: 5 })
    await handle.render()
    const frame = handle.capture()
    expect(frame.width).toBe(24)
    expect(frame.height).toBe(5)
    expect((frame.rows[0] ?? []).map((r) => r.text).join("")).toContain("resize-me")
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/host/render/model/renderer.test.tsx`
Expected: FAIL — `handle.resize is not a function`.

- [ ] **Step 3: Write the implementation**

In `src/host/render/types.ts`, add to the `RenderHandle` interface (after
`capture()`):

```ts
  /** Resize the live renderer, preserving the mounted tree and its atom state. */
  resize(size: RenderSize): void
```

In `src/host/render/model/renderer.ts`, add a `resize` method to the returned
handle object (after `capture()`):

```ts
    resize(size) {
      renderer.resize(size.w, size.h)
    },
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test src/host/render/model/renderer.test.tsx && bun x tsc --noEmit`
Expected: PASS, exit 0. (If the captured `buffer.width` does not update after
`renderer.resize` + `intermediateRender()` + `idle()`, the fake stdout's
`columns`/`rows` may still outrank it — the renderer's own `resize` should update
its buffers regardless; if not, additionally set `stdout.columns`/`stdout.rows` on
the shim before `renderer.resize`. Keep the invariant: after resize + render, the
captured dims equal the requested size. Record any deviation.)

- [ ] **Step 5: Commit**

```bash
git add src/host/render
git commit -m "feat: add in-place resize to the headless render handle

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: `host/types.ts` — `TerminalCapabilities`

**Files:**
- Modify: `src/host/types.ts` (append `TerminalCapabilities`)
- Modify: `src/host/index.ts` (export it)

**Interfaces:**
- Produces: `TerminalCapabilities` — the color/geometry capability set announced at
  mount. MVP carries color depth only; later phases widen it (viewport/color).

- [ ] **Step 1: Write the failing test**

`src/host/types.test.ts` (create):

```ts
import { describe, expect, test } from "bun:test"

import type { TerminalCapabilities } from "./types"

describe("TerminalCapabilities", () => {
  test("carries a color depth", () => {
    const caps: TerminalCapabilities = { colorDepth: 24 }
    expect(caps.colorDepth).toBe(24)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/host/types.test.ts`
Expected: FAIL — `TerminalCapabilities` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/host/types.ts`:

```ts
/**
 * Terminal color/geometry capabilities announced at mount (host-supervision §3.1)
 * and echoed into the runtime's viewport/color capability model. MVP carries the
 * color depth only (4/8/24-bit); later phases widen this (mouse, unicode width).
 */
export interface TerminalCapabilities {
  readonly colorDepth: number
}
```

Modify `src/host/index.ts`:

```ts
export type { HostMode, InteractionMode, Size, TerminalCapabilities } from "./types"
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test src/host/types.test.ts && bun x tsc --noEmit`
Expected: PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/host/types.ts src/host/index.ts src/host/types.test.ts
git commit -m "feat: add TerminalCapabilities to the host vocabulary

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Session types + `loadPage`

**Files:**
- Modify: `src/host/protocol/model/errors.ts` (add `SOURCE_HASH_MISMATCH` code)
- Create: `src/host/session/types.ts`
- Modify: `src/host/session/model/source-mount.ts` (add `loadPage`)
- Modify: `src/host/session/model/source-mount.test.ts` (add `loadPage` tests)
- Modify: `src/host/session/index.ts`

**Interfaces:**
- Consumes: `registerRuntimeResolver`, `computeSourceHash`, `scanPageImports`;
  `ProtocolError` from `../../protocol`; `Size` from `../types`.
- Produces:
  - `src/host/session/types.ts` — all body DTOs, the outbound-message union, the
    state-machine deps, `LoadedPage`, `ValidatedPageMeta`.
  - `loadPage(args: LoadPageArgs): Promise<ProtocolError | LoadedPage>` — reads the
    supervisor-supplied path, verifies the hash, rescans imports, dynamic-imports
    through the resolver, and validates `meta` + the default export.

- [ ] **Step 0: Add the `SOURCE_HASH_MISMATCH` protocol code (do this FIRST)**

Host-supervision §12 (line 791) requires a **distinct** typed code for a mount-time
source-hash mismatch (`SOURCE_HASH_MISMATCH`; §10 classifies it as a deterministic
failure that opens the circuit immediately — not a generic malformed frame). The
2A `ProtocolViolationCode` union has no such member yet. In
`src/host/protocol/model/errors.ts`, add it to the union:

```ts
export type ProtocolViolationCode =
  | "MALFORMED_PROTOCOL"
  | "OVERSIZED_MESSAGE"
  | "FRAME_TOO_LARGE"
  | "PROTOCOL_NEGOTIATION_FAILED"
  | "RUNTIME_INTEGRITY_MISMATCH"
  | "KIT_API_MISMATCH"
  | "SOURCE_HASH_MISMATCH"
```

Run `bun x tsc --noEmit` after this edit — it must stay exit 0 (the union only
widens; no existing code narrows on it).

- [ ] **Step 1: Write `src/host/session/types.ts`**

```ts
import type {
  ControlEnvelope,
  FrameEnvelope,
  FrameIdentity,
  HostHelloV1,
  ProtocolError,
  PublicLimits,
  RuntimeDeclarationBundleV1,
} from "../protocol"
import type { HostMode, InteractionMode, Size, TerminalCapabilities } from "../types"
import type { RenderHandle } from "../render"

/** A page's static metadata after structural validation of the imported module. */
export interface ValidatedPageMeta {
  readonly kitApiVersion: number
  readonly title: string
  readonly minSize: Size
  readonly theme: string
}

/** A page module loaded and validated by `loadPage`, ready to mount. */
export interface LoadedPage {
  readonly meta: ValidatedPageMeta
  /** The page's default export — a component `createElement` mounts as the root. */
  readonly component: unknown
  /** The recomputed lowercase-hex source hash (equals the expected hash). */
  readonly sourceHash: string
}

export interface LoadPageArgs {
  readonly sourcePath: string
  readonly expectedSourceHash: string
}

/** The `mount` request body (host-supervision §6.5). */
export interface MountRequestBody {
  readonly sourcePath: string
  readonly expectedSourceHash: string
  readonly mode: HostMode
  readonly interactionMode: InteractionMode
  readonly size: Size
  readonly theme: string
  readonly capabilities: TerminalCapabilities
  readonly deterministic: boolean
}

/** The accepted `ready` response body (host-supervision §6.6). */
export interface ReadyBody {
  readonly meta: ValidatedPageMeta
  readonly size: Size
  readonly interactionMode: InteractionMode
  readonly frameIdentity: FrameIdentity
  /** Tweak declarations — empty in MVP (set-tweak is a later phase). */
  readonly tweaks: readonly never[]
}

/** The `set-mode` request body (host-supervision §7). */
export interface SetModeRequestBody {
  readonly interactionMode: InteractionMode
}

/** A correlated response body: either an accepted echo or a typed refusal. */
export type ResponseBody =
  | { readonly ok: true; readonly [key: string]: unknown }
  | { readonly ok: false; readonly code: string; readonly reason: string }

/** The `heartbeat` body (host-supervision §9). */
export interface HeartbeatBody {
  readonly hostTick: number
  readonly lastFrameSeq: string
}

/**
 * A logical outbound message from the state machine. The entry encodes each with
 * the 2A codecs and writes the framed bytes to stdout; tests capture these
 * directly, so the machine is testable without real stdio.
 */
export type OutboundMessage =
  | { readonly type: "host-hello"; readonly payload: HostHelloV1 }
  | { readonly type: "control"; readonly payload: ControlEnvelope }
  | { readonly type: "frame"; readonly payload: FrameEnvelope }

/** A request for the process to exit after flushing stdout (Spike D). */
export interface ExitRequest {
  readonly code: number
  readonly reason: string
}

/** Injected dependencies of a host session (all boundaries are injectable). */
export interface HostSessionDeps {
  readonly runtimeDeclaration: RuntimeDeclarationBundleV1
  readonly limits: PublicLimits
  readonly loadPage: (args: LoadPageArgs) => Promise<ProtocolError | LoadedPage>
  readonly createRenderer: (size: Size) => Promise<RenderHandle>
  /** Monotonic milliseconds (host-supervision §9 — all durations are monotonic). */
  readonly now: () => number
  readonly send: (message: OutboundMessage) => void
  readonly requestExit: (request: ExitRequest) => void
}

/** The host-side protocol driver. */
export interface HostSession {
  /** Feed one decoded control-class payload (fragmentation handled upstream). */
  receiveControlPayload(payload: Uint8Array): Promise<void>
  /** Emit one heartbeat now (called by the entry's 1s timer). */
  emitHeartbeat(): void
}

// Re-export the imported types needed by consumers of this module.
export type { ControlEnvelope, FrameEnvelope, FrameIdentity, HostHelloV1 }
```

(`ProtocolError` is imported as a **type** above — `types.ts` only names it in a
return-type position, so a value import is unnecessary and `verbatimModuleSyntax`
prefers the `import type`.)

- [ ] **Step 2: Write the failing `loadPage` tests**

Append to `src/host/session/model/source-mount.test.ts`:

```ts
import { registerRuntimeResolver } from "./resolver"
import { computeSourceHash as hashBytes, loadPage } from "./source-mount"

const fixture = (name: string) => `${import.meta.dir}/../fixtures/${name}`

async function hashOfFile(path: string): Promise<string> {
  const bytes = await Bun.file(path).bytes()
  return hashBytes(bytes)
}

describe("loadPage", () => {
  test("loads a valid facade page and validates its meta", async () => {
    registerRuntimeResolver()
    const path = fixture("probe-page.tsx")
    const loaded = await loadPage({
      sourcePath: path,
      expectedSourceHash: await hashOfFile(path),
    })
    expect(loaded).not.toBeInstanceOf(ProtocolError)
    if (loaded instanceof ProtocolError) throw loaded
    expect(loaded.meta.kitApiVersion).toBe(1)
    expect(loaded.meta.title).toBe("Probe page")
    expect(loaded.meta.minSize).toEqual({ w: 10, h: 2 })
    expect(typeof loaded.component).toBe("function")
  })

  test("rejects a source-hash mismatch with SOURCE_HASH_MISMATCH", async () => {
    const path = fixture("probe-page.tsx")
    const result = await loadPage({
      sourcePath: path,
      expectedSourceHash: "0".repeat(64),
    })
    expect(result).toBeInstanceOf(ProtocolError)
    expect((result as ProtocolError).code).toBe("SOURCE_HASH_MISMATCH")
    expect((result as ProtocolError).reason).toContain("source hash")
  })

  test("rejects a page importing a forbidden module before it runs", async () => {
    const path = fixture("forbidden-react.tsx")
    const result = await loadPage({
      sourcePath: path,
      expectedSourceHash: await hashOfFile(path),
    })
    expect(result).toBeInstanceOf(ProtocolError)
    expect((result as ProtocolError).reason).toContain("react")
  })

  test("rejects a missing source path", async () => {
    const result = await loadPage({
      sourcePath: fixture("does-not-exist.tsx"),
      expectedSourceHash: "0".repeat(64),
    })
    expect(result).toBeInstanceOf(ProtocolError)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test src/host/session/model/source-mount.test.ts`
Expected: FAIL — `loadPage` is not exported.

- [ ] **Step 4: Implement `loadPage`**

Append to `src/host/session/model/source-mount.ts` (add the imports at the top —
`errore` for the sync UTF-8 boundary):

```ts
import * as errore from "errore"

import type { LoadPageArgs, LoadedPage, ValidatedPageMeta } from "../types"
```

```ts
const malformed = (reason: string, cause?: unknown) =>
  new ProtocolError({ code: "MALFORMED_PROTOCOL", reason, cause })

const sourceHashMismatch = (reason: string) =>
  new ProtocolError({ code: "SOURCE_HASH_MISMATCH", reason })

/**
 * Load and validate a page module (host-supervision §6.5-6.6, runtime-api §7.2).
 * The supervisor supplies the immutable path and the expected hash; the host
 * reads the bytes, recomputes and verifies the hash (a mismatch is fatal — no code
 * import — and typed SOURCE_HASH_MISMATCH per §12), rescans the import surface,
 * then dynamic-imports through the resolver (which MUST already be registered) and
 * structurally validates `meta` and the default export. Every boundary
 * (`Bun.file`, the UTF-8 decode, `import()`) is wrapped and carries its `cause`: a
 * read/decode/link failure becomes a typed `ProtocolError`, never a throw.
 */
export async function loadPage(args: LoadPageArgs): Promise<ProtocolError | LoadedPage> {
  const bytes = await Bun.file(args.sourcePath)
    .bytes()
    .catch((cause) => malformed(`cannot read source at ${args.sourcePath}`, cause))
  if (bytes instanceof ProtocolError) return bytes

  const sourceHash = computeSourceHash(bytes)
  if (sourceHash !== args.expectedSourceHash) {
    return sourceHashMismatch(
      `source hash mismatch: expected ${args.expectedSourceHash}, computed ${sourceHash}`,
    )
  }

  // §5: invalid UTF-8 is a protocol violation, not a throw. TextDecoder with
  // { fatal: true } throws on bad bytes, so wrap this sync boundary (errore rule 12,
  // { try, catch } options form per the installed errore@0.14.1).
  const sourceText = errore.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    catch: (cause) => malformed("source is not valid UTF-8", cause),
  })
  if (sourceText instanceof ProtocolError) return sourceText

  const scanError = scanPageImports(sourceText)
  if (scanError instanceof ProtocolError) return scanError

  const linked = await import(args.sourcePath).catch((cause) =>
    malformed(`failed to link page at ${args.sourcePath}`, cause),
  )
  if (linked instanceof ProtocolError) return linked

  const meta = validateMeta((linked as { meta?: unknown }).meta)
  if (meta instanceof ProtocolError) return meta

  const component = (linked as { default?: unknown }).default
  if (typeof component !== "function") {
    return malformed("page default export must be a component function")
  }

  return { meta, component, sourceHash }
}

const THEME_MAX = 64
const TITLE_MAX = 256

/** Structurally validate the imported `meta` (runtime-api §4 static contract). */
function validateMeta(value: unknown): ProtocolError | ValidatedPageMeta {
  if (value === null || typeof value !== "object") {
    return malformed("page meta must be an object")
  }
  const meta = value as Record<string, unknown>
  const kitApiVersion = meta.kitApiVersion
  if (typeof kitApiVersion !== "number" || !Number.isSafeInteger(kitApiVersion) || kitApiVersion <= 0) {
    return malformed("meta.kitApiVersion must be a positive integer")
  }
  if (typeof meta.title !== "string" || meta.title.length === 0 || meta.title.length > TITLE_MAX) {
    return malformed("meta.title must be a bounded non-empty string")
  }
  if (typeof meta.theme !== "string" || meta.theme.length === 0 || meta.theme.length > THEME_MAX) {
    return malformed("meta.theme must be a bounded non-empty string")
  }
  const size = validateSize(meta.minSize)
  if (size instanceof ProtocolError) return size
  return { kitApiVersion, title: meta.title, minSize: size, theme: meta.theme }
}

const AXIS_MAX = 2048

function validateSize(value: unknown): ProtocolError | { w: number; h: number } {
  if (value === null || typeof value !== "object") return malformed("size must be an object")
  const size = value as Record<string, unknown>
  const w = size.w
  const h = size.h
  if (typeof w !== "number" || !Number.isSafeInteger(w) || w <= 0 || w > AXIS_MAX) {
    return malformed(`size.w must be a positive integer <= ${AXIS_MAX}`)
  }
  if (typeof h !== "number" || !Number.isSafeInteger(h) || h <= 0 || h > AXIS_MAX) {
    return malformed(`size.h must be a positive integer <= ${AXIS_MAX}`)
  }
  return { w, h }
}
```

Append to `src/host/session/index.ts`:

```ts
export { loadPage } from "./model/source-mount"
export type {
  ExitRequest,
  HeartbeatBody,
  HostSession,
  HostSessionDeps,
  LoadPageArgs,
  LoadedPage,
  MountRequestBody,
  OutboundMessage,
  ReadyBody,
  ResponseBody,
  SetModeRequestBody,
  ValidatedPageMeta,
} from "./types"
```

- [ ] **Step 5: Run tests and typecheck**

Run: `bun test src/host/session && bun x tsc --noEmit`
Expected: PASS, exit 0. (`loadPage`'s `.catch` returns a `ProtocolError`, so the
union is `ProtocolError | Uint8Array` etc. — the `instanceof ProtocolError` early
returns narrow it. If `Bun.file(path).bytes()` rejects for a missing file with a
non-`Error` reason, the `.catch` still maps it. `validateSize`'s return uses a
plain `{w,h}`; assign it to the `Size`-typed field — structurally identical.)

- [ ] **Step 6: Commit**

```bash
git add src/host/session
git commit -m "feat: add host session types + page load/validate path

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: State machine — handshake (`client.hello` → `host.hello`)

**Files:**
- Create: `src/host/session/model/host-state-machine.ts`
- Create: `src/host/session/model/host-state-machine.test.tsx`
- Modify: `src/host/session/index.ts`

**Interfaces:**
- Consumes: `decodeClientHello`, `encodeHostHello` (via the entry — the machine
  emits logical `host-hello`), `ProtocolError`, `PROTOCOL_HARD_LIMITS`,
  `ClientHelloV1`, `HostHelloV1`, `PublicLimits` from `../../protocol`;
  the `HostSessionDeps`/`HostSession`/`OutboundMessage` types from `../types`.
- Produces: `createHostSession(deps: HostSessionDeps): HostSession`. In this task it
  handles only the pre-handshake phase: decode `client.hello`, echo identity,
  negotiate limits (per-field min), emit `host.hello`, advance to `awaiting-mount`.
  A malformed `client.hello` requests exit (no `error` envelope — the host has no
  identity to echo yet).

- [ ] **Step 1: Write the failing test**

`src/host/session/model/host-state-machine.test.tsx` (**pragma first line**):

```tsx
/** @jsxImportSource @opentui/react */
import { describe, expect, test } from "bun:test"

import {
  encodeClientHello,
  PROTOCOL_HARD_LIMITS,
  type ClientHelloV1,
  type HostHelloV1,
  type PublicLimits,
  type RuntimeDeclarationBundleV1,
} from "../../protocol"
import type { HostSessionDeps, OutboundMessage } from "../types"
import { createHostSession } from "./host-state-machine"

const RUNTIME_DECLARATION: RuntimeDeclarationBundleV1 = {
  module: "@termcraft/runtime",
  currentKitApiVersion: 1,
  supportedKitApiVersions: [1],
  publicCapabilityIds: ["theme:dark-default"],
}

const SESSION_ID = "01920000-0000-7000-8000-000000000000"
const NONCE = "0123456789abcdef0123456789abcdef"

const clientHello = (over: Partial<ClientHelloV1> = {}): ClientHelloV1 => ({
  framingVersion: 1,
  kind: "client.hello",
  sessionId: SESSION_ID,
  nonce: NONCE,
  offeredFramingVersions: [1],
  offeredProtocolVersions: [1],
  mode: "preview",
  pageSlug: "dashboard",
  sourceHash: "a".repeat(64),
  sourceKitApiVersion: 1,
  runtimeDeclaration: RUNTIME_DECLARATION,
  limits: PROTOCOL_HARD_LIMITS,
  ...over,
})

interface Harness {
  readonly out: OutboundMessage[]
  readonly exits: { code: number; reason: string }[]
  readonly deps: HostSessionDeps
}

function harness(over: Partial<HostSessionDeps> = {}): Harness {
  const out: OutboundMessage[] = []
  const exits: { code: number; reason: string }[] = []
  const deps: HostSessionDeps = {
    runtimeDeclaration: RUNTIME_DECLARATION,
    limits: PROTOCOL_HARD_LIMITS,
    loadPage: async () => ({ meta: { kitApiVersion: 1, title: "t", minSize: { w: 4, h: 1 }, theme: "dark-default" }, component: () => null, sourceHash: "a".repeat(64) }),
    createRenderer: async () => { throw new Error("not used in this task") },
    now: () => 1000,
    send: (m) => out.push(m),
    requestExit: (r) => exits.push(r),
    ...over,
  }
  return { out, exits, deps }
}

// Encode a client.hello to the raw control payload the state machine decodes.
function helloPayload(hello: ClientHelloV1): Uint8Array {
  const framed = encodeClientHello(hello)
  if (framed instanceof Error) throw framed
  // encodeClientHello prepends the 8-byte frame header; the state machine
  // receives the PAYLOAD (the entry strips the header via FrameDecoder).
  return framed.slice(8)
}

describe("host session — handshake", () => {
  test("answers a valid client.hello with a host.hello echoing identity", async () => {
    const h = harness()
    const session = createHostSession(h.deps)
    await session.receiveControlPayload(helloPayload(clientHello()))

    expect(h.out).toHaveLength(1)
    const first = h.out[0]!
    expect(first.type).toBe("host-hello")
    const hello = (first as { payload: HostHelloV1 }).payload
    expect(hello.kind).toBe("host.hello")
    expect(hello.sessionId).toBe(SESSION_ID)
    expect(hello.nonce).toBe(NONCE)
    expect(hello.selectedFramingVersion).toBe(1)
    expect(hello.selectedProtocolVersion).toBe(1)
    expect(hello.runtimeDeclaration).toEqual(RUNTIME_DECLARATION)
  })

  test("negotiates limits to the per-field minimum of client and host", async () => {
    const h = harness()
    const session = createHostSession(h.deps)
    const stricter: PublicLimits = { ...PROTOCOL_HARD_LIMITS, maxFrameWidth: 100 }
    await session.receiveControlPayload(helloPayload(clientHello({ limits: stricter })))
    const hello = (h.out[0] as { payload: HostHelloV1 }).payload
    expect(hello.limits.maxFrameWidth).toBe(100)
    expect(hello.limits.controlPayloadBytes).toBe(PROTOCOL_HARD_LIMITS.controlPayloadBytes)
  })

  test("a malformed client.hello requests exit and emits no host.hello", async () => {
    const h = harness()
    const session = createHostSession(h.deps)
    await session.receiveControlPayload(new TextEncoder().encode("{ not json"))
    expect(h.out).toHaveLength(0)
    expect(h.exits).toHaveLength(1)
    expect(h.exits[0]!.code).toBe(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/host/session/model/host-state-machine.test.tsx`
Expected: FAIL — cannot resolve `./host-state-machine`. (Also add
`encodeClientHello` to `src/host/protocol/index.ts`'s exports if not already there —
it is, per 2A.)

- [ ] **Step 3: Write the implementation**

`src/host/session/model/host-state-machine.ts`:

```ts
import {
  decodeClientHello,
  ProtocolError,
  type HostHelloV1,
  type PublicLimits,
} from "../../protocol"
import type { HostSession, HostSessionDeps, OutboundMessage } from "../types"

type Phase = "awaiting-hello" | "awaiting-mount" | "ready" | "closed"

/**
 * The host-side protocol driver (host-supervision §6-§7). It consumes decoded
 * control-class payloads and emits logical outbound messages through `deps.send`,
 * so it is testable without real stdio. State transitions are serialized: the
 * entry awaits each `receiveControlPayload` before feeding the next, so wire order
 * is process order (§7). A fatal `ProtocolError` past handshake emits a best-effort
 * `error` envelope, then requests exit; before handshake it only requests exit
 * (no identity to echo).
 */
export function createHostSession(deps: HostSessionDeps): HostSession {
  let phase: Phase = "awaiting-hello"
  let identity: { sessionId: string; nonce: string } | null = null
  let messageCounter = 1n

  const nextMessageId = () => {
    const id = messageCounter.toString()
    messageCounter += 1n
    return id
  }

  async function receiveControlPayload(payload: Uint8Array): Promise<void> {
    if (phase === "closed") return
    if (phase === "awaiting-hello") return handleHello(payload)
    // Tasks 7-8 dispatch mount/resize/set-mode/ping/shutdown here.
    fail(new ProtocolError({ code: "MALFORMED_PROTOCOL", reason: `unexpected message in phase ${phase}` }))
  }

  function handleHello(payload: Uint8Array): void {
    const hello = decodeClientHello(payload)
    if (hello instanceof ProtocolError) return failPreHandshake(hello)

    identity = { sessionId: hello.sessionId, nonce: hello.nonce }
    const hostHello: HostHelloV1 = {
      framingVersion: 1,
      kind: "host.hello",
      sessionId: hello.sessionId,
      nonce: hello.nonce,
      selectedFramingVersion: 1,
      selectedProtocolVersion: 1,
      runtimeDeclaration: deps.runtimeDeclaration,
      limits: negotiateLimits(hello.limits),
    }
    deps.send({ type: "host-hello", payload: hostHello })
    phase = "awaiting-mount"
  }

  /** Effective limits are the per-field minimum of client offer and host caps (§6). */
  function negotiateLimits(client: PublicLimits): PublicLimits {
    const cap = deps.limits
    return {
      controlPayloadBytes: Math.min(client.controlPayloadBytes, cap.controlPayloadBytes),
      framePayloadBytes: Math.min(client.framePayloadBytes, cap.framePayloadBytes),
      maxFrameWidth: Math.min(client.maxFrameWidth, cap.maxFrameWidth),
      maxFrameHeight: Math.min(client.maxFrameHeight, cap.maxFrameHeight),
      maxFrameCells: Math.min(client.maxFrameCells, cap.maxFrameCells),
    }
  }

  /** Pre-handshake fatal: no identity to echo, so just exit (supervisor's 3s deadline). */
  function failPreHandshake(error: ProtocolError): void {
    phase = "closed"
    deps.requestExit({ code: 1, reason: error.reason })
  }

  /** Post-handshake fatal: emit a best-effort typed `error`, then exit (§12). */
  function fail(error: ProtocolError): void {
    if (identity !== null) {
      deps.send({
        type: "control",
        payload: {
          protocolVersion: 1,
          kind: "error",
          sessionId: identity.sessionId,
          nonce: identity.nonce,
          messageId: nextMessageId(),
          body: { code: error.code, reason: error.reason },
        },
      })
    }
    phase = "closed"
    deps.requestExit({ code: 1, reason: error.reason })
  }

  function emitHeartbeat(): void {
    // Implemented in Task 8.
  }

  return { receiveControlPayload, emitHeartbeat }
}
```

> **Note to the implementer:** Tasks 7 and 8 add `mount`/`resize`/`set-mode`/`ping`/
> `shutdown`/`heartbeat` handling **inside** this same closure, reusing `phase`,
> `identity`, `nextMessageId`, `fail`, and `deps`. Keep them in one
> `createHostSession` so the mutable state stays private. Do not split into a class.
> tsconfig sets no `noUnusedLocals`, so no placeholder lines are needed between
> tasks; Task 7's `handleMount` and Task 8's handlers supply the real uses of the
> closure state and imports.

Append to `src/host/session/index.ts`:

```ts
export { createHostSession } from "./model/host-state-machine"
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test src/host/session/model/host-state-machine.test.tsx && bun x tsc --noEmit`
Expected: PASS, exit 0. (If `tsc` flags the placeholder `void` lines as errors under
a stricter setting, delete them and instead reference `PROTOCOL_HARD_LIMITS` where
Task 7/8 needs it; they exist only to keep the imports live between tasks.)

- [ ] **Step 5: Commit**

```bash
git add src/host/session
git commit -m "feat: add host state machine handshake (client.hello -> host.hello)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: State machine — `mount` → `ready` + first `frame`

**Files:**
- Modify: `src/host/session/model/host-state-machine.ts`
- Modify: `src/host/session/model/host-state-machine.test.tsx`

**Interfaces:**
- Consumes: `decodeControlEnvelope`, `encodeFrameEnvelope` (entry-side),
  `FrameEnvelope`, `FrameIdentity`, `ControlEnvelope` from `../../protocol`;
  `createHeadlessRenderer` via `deps.createRenderer`; `loadPage` via `deps.loadPage`;
  `createElement` from `@opentui/react` (NOT `react` — no `@types/react`);
  `RenderHandle` from `../../render`; `HostMode`/`InteractionMode` from `../../types`;
  `MountRequestBody`, `ReadyBody` from `../types`.
- Produces: post-handshake dispatch of the `mount` request → validate identity +
  body → `loadPage` → `createRenderer(size)` → mount `createElement(component)` →
  render → capture → seal frame (`frameSeq` "1") → emit `ready` (with meta, accepted
  size, effective interaction mode, initial `FrameIdentity`) → emit the first
  `frame`. Mount failure → typed `error` + exit. One-shot modes (`smoke`/`export`)
  exit 0 after the first frame.

- [ ] **Step 1: Write the failing test**

Append to `host-state-machine.test.tsx`. Add a real renderer + a controllable
fixture component, and drive `mount` after the handshake:

```tsx
import { createHeadlessRenderer, type RenderHandle } from "../../render"
import {
  decodeControlEnvelope,
  encodeControlEnvelope,
  type ControlEnvelope,
  type FrameEnvelope,
} from "../../protocol"
import { afterEach } from "bun:test"

let liveRenderer: RenderHandle | null = null
afterEach(() => {
  liveRenderer?.destroy()
  liveRenderer = null
})

const FixtureComponent = () => (
  <box>
    <text>mounted-ok</text>
  </box>
)

function mountEnvelope(over: Partial<ControlEnvelope["body"]> = {}, sessionId = SESSION_ID, nonce = NONCE): Uint8Array {
  const envelope: ControlEnvelope = {
    protocolVersion: 1,
    kind: "mount",
    sessionId,
    nonce,
    messageId: "1",
    requestId: "1",
    body: {
      sourcePath: "/unused/in/fake/loadPage.tsx",
      expectedSourceHash: "a".repeat(64),
      mode: "preview",
      interactionMode: "static",
      size: { w: 16, h: 3 },
      theme: "dark-default",
      capabilities: { colorDepth: 24 },
      deterministic: true,
      ...over,
    },
  }
  const framed = encodeControlEnvelope(envelope)
  if (framed instanceof Error) throw framed
  return framed.slice(8)
}

async function handshaken(over: Partial<HostSessionDeps> = {}) {
  const h = harness({
    createRenderer: (size) => {
      return createHeadlessRenderer(size).then((r) => {
        liveRenderer = r
        return r
      })
    },
    loadPage: async () => ({
      meta: { kitApiVersion: 1, title: "Dashboard", minSize: { w: 16, h: 3 }, theme: "dark-default" },
      component: FixtureComponent,
      sourceHash: "a".repeat(64),
    }),
    ...over,
  })
  const session = createHostSession(h.deps)
  await session.receiveControlPayload(helloPayload(clientHello()))
  h.out.length = 0 // drop the host.hello
  return { h, session }
}

describe("host session — mount", () => {
  test("mount emits ready then the first frame, both under one identity", async () => {
    const { h, session } = await handshaken()
    await session.receiveControlPayload(mountEnvelope())

    expect(h.out).toHaveLength(2)
    const ready = (h.out[0] as { payload: ControlEnvelope }).payload
    expect(ready.kind).toBe("ready")
    expect(ready.responseTo).toBe("1")
    expect(ready.sessionId).toBe(SESSION_ID)
    const readyBody = ready.body as unknown as {
      meta: { title: string }
      size: { w: number; h: number }
      interactionMode: string
      frameIdentity: { frameSeq: string; sourceHash: string }
    }
    expect(readyBody.meta.title).toBe("Dashboard")
    expect(readyBody.size).toEqual({ w: 16, h: 3 })
    expect(readyBody.interactionMode).toBe("static")
    expect(readyBody.frameIdentity.frameSeq).toBe("1")

    const frame = (h.out[1] as { payload: FrameEnvelope }).payload
    expect(frame.kind).toBe("frame")
    expect(frame.frameSeq).toBe("1")
    expect(frame.width).toBe(16)
    expect(frame.sourceHash).toBe("a".repeat(64))
    expect((frame.rows[0] ?? []).map((r) => r.text).join("")).toContain("mounted-ok")
  })

  test("preview mount stays alive (no exit)", async () => {
    const { h, session } = await handshaken()
    await session.receiveControlPayload(mountEnvelope())
    expect(h.exits).toHaveLength(0)
  })

  test("smoke mount emits ready+frame then exits 0 (one-shot)", async () => {
    const { h, session } = await handshaken()
    await session.receiveControlPayload(mountEnvelope({ mode: "smoke" }))
    expect(h.out).toHaveLength(2)
    expect(h.exits).toHaveLength(1)
    expect(h.exits[0]!.code).toBe(0)
  })

  test("a non-preview mount forces effective static even if interactive requested", async () => {
    const { h, session } = await handshaken()
    await session.receiveControlPayload(
      mountEnvelope({ mode: "historical", interactionMode: "interactive" }),
    )
    const ready = (h.out[0] as { payload: ControlEnvelope }).payload
    expect((ready.body as unknown as { interactionMode: string }).interactionMode).toBe("static")
  })

  test("a loadPage failure emits a typed error and exits", async () => {
    const { h, session } = await handshaken({
      loadPage: async () => new ProtocolError({ code: "MALFORMED_PROTOCOL", reason: "source hash mismatch" }),
    })
    await session.receiveControlPayload(mountEnvelope())
    const errorMsg = h.out.find((m) => m.type === "control" && (m as { payload: ControlEnvelope }).payload.kind === "error")
    expect(errorMsg).toBeDefined()
    expect(h.exits).toHaveLength(1)
    expect(h.exits[0]!.code).toBe(1)
  })

  test("an inbound envelope with the wrong nonce is fatal", async () => {
    const { h, session } = await handshaken()
    await session.receiveControlPayload(mountEnvelope({}, SESSION_ID, "f".repeat(32)))
    expect(h.exits).toHaveLength(1)
  })
})
```

Also `import { ProtocolError } from "../../protocol"` at the top of the test if not
already imported.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/host/session/model/host-state-machine.test.tsx`
Expected: FAIL — mount is not handled (the placeholder `fail(...)` fires, or no
output).

- [ ] **Step 3: Extend the implementation**

In `host-state-machine.ts`, add imports (`createElement` comes from
`@opentui/react`, which re-exports it — `react` has no `.d.ts`; `RenderHandle` is
two levels up in `host/render`):

```ts
import { createElement } from "@opentui/react"

import {
  decodeControlEnvelope,
  type ControlEnvelope,
  type FrameEnvelope,
  type FrameIdentity,
} from "../../protocol"
import type { RenderHandle } from "../../render"
import type { HostMode, InteractionMode } from "../../types"
import type { MountRequestBody, ReadyBody } from "../types"
```

Add incarnation state near the top of the closure (declare `lastFrameSeq` and
`effectiveMode` now — `handleMount` sets them and Task 8's handlers read them;
tsconfig has no `noUnusedLocals`, so unread-until-Task-8 is fine):

```ts
  let renderer: RenderHandle | null = null
  let sourceHash: string | null = null
  let mountedMode: HostMode | null = null
  let frameCounter = 1n
  let lastFrameSeq = "0"
  let effectiveMode: InteractionMode = "static"
```

Replace the post-handshake branch of `receiveControlPayload`:

```ts
  async function receiveControlPayload(payload: Uint8Array): Promise<void> {
    if (phase === "closed") return
    if (phase === "awaiting-hello") return handleHello(payload)

    const envelope = decodeControlEnvelope(payload)
    if (envelope instanceof ProtocolError) return fail(envelope)
    const identityError = checkIdentity(envelope)
    if (identityError instanceof ProtocolError) return fail(identityError)

    if (phase === "awaiting-mount") {
      if (envelope.kind === "mount") return handleMount(envelope)
      // Task 8 adds `shutdown` acceptance in this phase (§6: shutdown valid pre-ready).
      return fail(unknownKind(envelope.kind, phase))
    }
    // phase === "ready" — resize/set-mode/ping/shutdown handled in Task 8.
    return fail(unknownKind(envelope.kind, phase))
  }

  function checkIdentity(envelope: ControlEnvelope): ProtocolError | null {
    if (identity === null) return new ProtocolError({ code: "MALFORMED_PROTOCOL", reason: "no negotiated identity" })
    if (envelope.sessionId !== identity.sessionId || envelope.nonce !== identity.nonce) {
      return new ProtocolError({ code: "MALFORMED_PROTOCOL", reason: "envelope identity does not match the negotiated session" })
    }
    return null
  }

  function unknownKind(kind: string, inPhase: Phase): ProtocolError {
    return new ProtocolError({ code: "MALFORMED_PROTOCOL", reason: `kind ${JSON.stringify(kind)} is not accepted in phase ${inPhase}` })
  }
```

Add the mount handler:

```ts
  async function handleMount(envelope: ControlEnvelope): Promise<void> {
    if (envelope.requestId === undefined) return fail(new ProtocolError({ code: "MALFORMED_PROTOCOL", reason: "mount must carry a requestId" }))
    const request = parseMountRequest(envelope.body)
    if (request instanceof ProtocolError) return fail(request)

    const loaded = await deps.loadPage({
      sourcePath: request.sourcePath,
      expectedSourceHash: request.expectedSourceHash,
    })
    if (loaded instanceof ProtocolError) return fail(loaded)

    const handle = await deps.createRenderer(request.size)
    renderer = handle
    sourceHash = loaded.sourceHash
    mountedMode = request.mode

    handle.mount(createElement(loaded.component as never))
    await handle.render()
    const captured = handle.capture()

    const frameIdentity = sealFrameIdentity()
    // §4: only preview honors a requested interactive mode; historical/smoke/export
    // are always effectively static.
    const initialMode: InteractionMode =
      request.mode === "preview" ? request.interactionMode : "static"

    const readyBody: ReadyBody = {
      meta: loaded.meta,
      size: { w: captured.width, h: captured.height },
      interactionMode: initialMode,
      frameIdentity,
      tweaks: [],
    }
    deps.send({
      type: "control",
      payload: {
        protocolVersion: 1,
        kind: "ready",
        sessionId: identity!.sessionId,
        nonce: identity!.nonce,
        messageId: nextMessageId(),
        responseTo: envelope.requestId,
        body: readyBody as unknown as ControlEnvelope["body"],
      },
    })
    emitFrame(captured, frameIdentity)
    lastFrameSeq = frameIdentity.frameSeq
    effectiveMode = initialMode
    phase = "ready"

    // §11.3/§11.4: smoke and export are one-shot. Both exit 0 after the first
    // frame (Spike D — the entry, not this handler, calls process.exit). NOTE:
    // export's `frame` here is the documented non-conformant MVP stand-in (see
    // Scope); the conformant `capture`+layout reply is deferred to 2D.
    if (request.mode === "smoke" || request.mode === "export") {
      phase = "closed"
      deps.requestExit({ code: 0, reason: `${request.mode} one-shot complete` })
    }
  }

  function sealFrameIdentity(): FrameIdentity {
    const frameSeq = frameCounter.toString()
    frameCounter += 1n
    return {
      sessionId: identity!.sessionId,
      nonce: identity!.nonce,
      sourceHash: sourceHash!,
      frameSeq,
    }
  }

  function emitFrame(captured: { width: number; height: number; rows: FrameEnvelope["rows"] }, frameIdentity: FrameIdentity): void {
    const frame: FrameEnvelope = {
      protocolVersion: 1,
      kind: "frame",
      sessionId: frameIdentity.sessionId,
      nonce: frameIdentity.nonce,
      sourceHash: frameIdentity.sourceHash,
      frameSeq: frameIdentity.frameSeq,
      width: captured.width,
      height: captured.height,
      rows: captured.rows,
    }
    deps.send({ type: "frame", payload: frame })
  }
```

Add the body parser (small local guards — do not reach into `protocol/model/shape`):

```ts
  function parseMountRequest(body: ControlEnvelope["body"]): ProtocolError | MountRequestBody {
    const bad = (reason: string) => new ProtocolError({ code: "MALFORMED_PROTOCOL", reason })
    const sourcePath = body.sourcePath
    if (typeof sourcePath !== "string" || sourcePath.length === 0 || sourcePath.length > 4096) return bad("mount.sourcePath must be a bounded non-empty string")
    const expectedSourceHash = body.expectedSourceHash
    if (typeof expectedSourceHash !== "string" || !/^[0-9a-f]{64}$/.test(expectedSourceHash)) return bad("mount.expectedSourceHash must be 64 lowercase hex")
    const mode = body.mode
    if (mode !== "preview" && mode !== "historical" && mode !== "smoke" && mode !== "export") return bad("mount.mode must be a host mode")
    const interactionMode = body.interactionMode
    if (interactionMode !== "static" && interactionMode !== "interactive") return bad("mount.interactionMode must be static|interactive")
    const size = parseSize(body.size)
    if (size instanceof ProtocolError) return size
    const theme = body.theme
    if (typeof theme !== "string" || theme.length === 0 || theme.length > 64) return bad("mount.theme must be a bounded non-empty string")
    const capabilities = body.capabilities
    if (capabilities === null || typeof capabilities !== "object" || Array.isArray(capabilities)) return bad("mount.capabilities must be an object")
    const colorDepth = (capabilities as { colorDepth?: unknown }).colorDepth
    if (typeof colorDepth !== "number" || !Number.isSafeInteger(colorDepth) || colorDepth <= 0) return bad("mount.capabilities.colorDepth must be a positive integer")
    const deterministic = body.deterministic
    if (typeof deterministic !== "boolean") return bad("mount.deterministic must be a boolean")
    return { sourcePath, expectedSourceHash, mode, interactionMode, size, theme, capabilities: { colorDepth }, deterministic }
  }

  // The param is widened to `| undefined`: callers pass element-access expressions
  // (`body.size`) which are `JsonValue | undefined` under noUncheckedIndexedAccess,
  // whereas the bare indexed-access type is not. The first guard rejects undefined.
  function parseSize(value: ControlEnvelope["body"][string] | undefined): ProtocolError | { w: number; h: number } {
    const bad = (reason: string) => new ProtocolError({ code: "MALFORMED_PROTOCOL", reason })
    if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return bad("size must be an object")
    const w = (value as { w?: unknown }).w
    const h = (value as { h?: unknown }).h
    if (typeof w !== "number" || !Number.isSafeInteger(w) || w <= 0 || w > 2048) return bad("size.w must be a positive integer <= 2048")
    if (typeof h !== "number" || !Number.isSafeInteger(h) || h <= 0 || h > 2048) return bad("size.h must be a positive integer <= 2048")
    return { w, h }
  }
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test src/host/session/model/host-state-machine.test.tsx && bun x tsc --noEmit`
Expected: PASS, exit 0.

**Empirical notes for the implementer (adjust within the invariants):**
- `createElement(loaded.component as never)` mounts the page's default export as the
  React root; this is exactly what JSX `<Page/>` compiles to and renders both plain
  function components and (later) `reatomComponent`s. `createElement` is imported from
  `@opentui/react` (re-export) because `react` ships no `.d.ts`. If `tsc` rejects the
  `as never`, keep `component: unknown` in `LoadedPage` and cast at the call site;
  do NOT `import … from "react"` for a `FunctionComponent` type — that is `TS7016`.
- If the smoke one-shot test observes the renderer never destroyed (a leaked handle),
  the entry — not the state machine — owns `renderer.destroy()` on exit (Task 9). In
  the unit test, the `afterEach` destroys `liveRenderer`. Do **not** call
  `process.exit` or `destroy` inside the state machine's mount handler.

- [ ] **Step 5: Commit**

```bash
git add src/host/session
git commit -m "feat: add host mount -> ready + first frame (one-shot smoke/export exit)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: State machine — `resize`, `set-mode`, `ping`, heartbeat, `shutdown`

**Files:**
- Modify: `src/host/session/model/host-state-machine.ts`
- Modify: `src/host/session/model/host-state-machine.test.tsx`

**Interfaces:**
- Produces: `ready`-phase dispatch of `resize` (re-render → new `frame`, `frameSeq`
  increments), `set-mode` (correlated accepted/refused response echoing effective
  mode), `ping` (correlated `{ ok: true }` response), `shutdown` (→ `shutdown-ack`
  response, then exit 0); and `emitHeartbeat()` (a `heartbeat` control envelope
  carrying the monotonic `hostTick` and last `frameSeq`).

- [ ] **Step 1: Write the failing tests**

Append to `host-state-machine.test.tsx`:

```tsx
async function readied(over: Partial<HostSessionDeps> = {}) {
  const started = await handshaken(over)
  await started.session.receiveControlPayload(mountEnvelope())
  started.h.out.length = 0 // drop ready + first frame
  return started
}

function controlEnvelope(kind: string, body: ControlEnvelope["body"], requestId?: string): Uint8Array {
  const envelope: ControlEnvelope = {
    protocolVersion: 1,
    kind,
    sessionId: SESSION_ID,
    nonce: NONCE,
    messageId: "9",
    ...(requestId !== undefined ? { requestId } : {}),
    body,
  }
  const framed = encodeControlEnvelope(envelope)
  if (framed instanceof Error) throw framed
  return framed.slice(8)
}

describe("host session — ready-phase control", () => {
  test("resize re-renders and emits a new frame with an incremented frameSeq", async () => {
    const { h, session } = await readied()
    await session.receiveControlPayload(controlEnvelope("resize", { size: { w: 24, h: 4 } }))
    const frames = h.out.filter((m) => m.type === "frame") as { payload: FrameEnvelope }[]
    expect(frames).toHaveLength(1)
    expect(frames[0]!.payload.frameSeq).toBe("2")
    expect(frames[0]!.payload.width).toBe(24)
  })

  test("ping gets a correlated ok response echoing kind ping", async () => {
    const { h, session } = await readied()
    await session.receiveControlPayload(controlEnvelope("ping", {}, "5"))
    const control = h.out.filter((m) => m.type === "control") as { payload: ControlEnvelope }[]
    expect(control).toHaveLength(1)
    expect(control[0]!.payload.kind).toBe("ping")
    expect(control[0]!.payload.responseTo).toBe("5")
    expect((control[0]!.payload.body as { ok: boolean }).ok).toBe(true)
  })

  test("set-mode to interactive is accepted in preview and echoes the effective mode", async () => {
    const { h, session } = await readied()
    await session.receiveControlPayload(controlEnvelope("set-mode", { interactionMode: "interactive" }, "6"))
    const response = (h.out.find((m) => m.type === "control") as { payload: ControlEnvelope }).payload
    expect(response.kind).toBe("set-mode")
    expect(response.responseTo).toBe("6")
    expect((response.body as { ok: boolean; interactionMode: string }).ok).toBe(true)
    expect((response.body as { interactionMode: string }).interactionMode).toBe("interactive")
  })

  test("set-mode to interactive is refused for a historical mount", async () => {
    // A historical mount ONLY — no extra `readied()` preview renderer to leak
    // (a leaked live OpenTUI renderer is the Spike-D hang condition).
    const historical = await handshaken()
    await historical.session.receiveControlPayload(mountEnvelope({ mode: "historical" }))
    historical.h.out.length = 0
    await historical.session.receiveControlPayload(controlEnvelope("set-mode", { interactionMode: "interactive" }, "7"))
    const response = (historical.h.out.find((m) => m.type === "control") as { payload: ControlEnvelope }).payload
    expect((response.body as { ok: boolean }).ok).toBe(false)
    expect((response.body as { code: string }).code).toBe("HISTORICAL_PREVIEW_READ_ONLY")
  })

  test("emitHeartbeat sends a heartbeat carrying the last frameSeq", async () => {
    const { h, session } = await readied()
    session.emitHeartbeat()
    const beat = (h.out.find((m) => m.type === "control") as { payload: ControlEnvelope }).payload
    expect(beat.kind).toBe("heartbeat")
    expect((beat.body as { lastFrameSeq: string }).lastFrameSeq).toBe("1")
    expect(typeof (beat.body as { hostTick: number }).hostTick).toBe("number")
  })

  test("shutdown acks then requests exit 0", async () => {
    const { h, session } = await readied()
    await session.receiveControlPayload(controlEnvelope("shutdown", {}, "8"))
    const ack = (h.out.find((m) => m.type === "control") as { payload: ControlEnvelope }).payload
    expect(ack.kind).toBe("shutdown-ack")
    expect(ack.responseTo).toBe("8")
    expect(h.exits).toHaveLength(1)
    expect(h.exits[0]!.code).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/host/session/model/host-state-machine.test.tsx`
Expected: FAIL — resize/ping/set-mode/shutdown/heartbeat unhandled.

- [ ] **Step 3: Extend the implementation**

The `lastFrameSeq` and `effectiveMode` closure vars are already declared in Task 7
and set by `handleMount`. This task adds the handlers that read/update them, accepts
`shutdown` in both phases, and implements `emitHeartbeat` — no new closure vars.

In `receiveControlPayload`, add `shutdown` to the **awaiting-mount** branch and the
full **ready**-phase dispatch (replace the two branches from Task 7):

```ts
    if (phase === "awaiting-mount") {
      if (envelope.kind === "mount") return handleMount(envelope)
      if (envelope.kind === "shutdown") return handleShutdown(envelope)
      return fail(unknownKind(envelope.kind, phase))
    }
    // phase === "ready"
    if (envelope.kind === "resize") return handleResize(envelope)
    if (envelope.kind === "set-mode") return handleSetMode(envelope)
    if (envelope.kind === "ping") return handlePing(envelope)
    if (envelope.kind === "shutdown") return handleShutdown(envelope)
    return fail(unknownKind(envelope.kind, phase))
```

Add the handlers:

```ts
  async function handleResize(envelope: ControlEnvelope): Promise<void> {
    if (renderer === null) return fail(new ProtocolError({ code: "MALFORMED_PROTOCOL", reason: "resize before mount" }))
    const size = parseSize(envelope.body.size)
    if (size instanceof ProtocolError) return fail(size)
    renderer.resize(size)
    await renderer.render()
    const captured = renderer.capture()
    const frameIdentity = sealFrameIdentity()
    emitFrame(captured, frameIdentity)
    lastFrameSeq = frameIdentity.frameSeq
  }

  function handleSetMode(envelope: ControlEnvelope): void {
    if (envelope.requestId === undefined) return fail(new ProtocolError({ code: "MALFORMED_PROTOCOL", reason: "set-mode must carry a requestId" }))
    const requested = envelope.body.interactionMode
    if (requested !== "static" && requested !== "interactive") return fail(new ProtocolError({ code: "MALFORMED_PROTOCOL", reason: "set-mode.interactionMode must be static|interactive" }))
    const allowed = mountedMode === "preview" || requested === "static"
    if (!allowed) {
      // The only reachable refusal in 2C is a historical mount (smoke/export are
      // one-shot and exit before `ready`). §3.2 names HISTORICAL_PREVIEW_READ_ONLY
      // as THE typed read-only refusal for a historical session.
      sendResponse(envelope.requestId, "set-mode", { ok: false, code: "HISTORICAL_PREVIEW_READ_ONLY", reason: `${mountedMode} mode cannot accept interactive` })
      return
    }
    effectiveMode = requested
    sendResponse(envelope.requestId, "set-mode", { ok: true, interactionMode: requested })
  }

  function handlePing(envelope: ControlEnvelope): void {
    if (envelope.requestId === undefined) return fail(new ProtocolError({ code: "MALFORMED_PROTOCOL", reason: "ping must carry a requestId" }))
    // Echo the request kind (§7 has no `pong` in the closed family); correlate by responseTo.
    sendResponse(envelope.requestId, "ping", { ok: true })
  }

  function handleShutdown(envelope: ControlEnvelope): void {
    if (envelope.requestId !== undefined) {
      sendResponse(envelope.requestId, "shutdown-ack", { ok: true })
    } else {
      sendControl("shutdown-ack", { ok: true })
    }
    phase = "closed"
    deps.requestExit({ code: 0, reason: "graceful shutdown" })
  }

  function sendResponse(responseTo: string, kind: string, body: Record<string, unknown>): void {
    deps.send({
      type: "control",
      payload: {
        protocolVersion: 1,
        kind,
        sessionId: identity!.sessionId,
        nonce: identity!.nonce,
        messageId: nextMessageId(),
        responseTo,
        body: body as ControlEnvelope["body"],
      },
    })
  }

  function sendControl(kind: string, body: Record<string, unknown>): void {
    deps.send({
      type: "control",
      payload: {
        protocolVersion: 1,
        kind,
        sessionId: identity!.sessionId,
        nonce: identity!.nonce,
        messageId: nextMessageId(),
        body: body as ControlEnvelope["body"],
      },
    })
  }
```

Implement `emitHeartbeat`:

```ts
  function emitHeartbeat(): void {
    if (identity === null || phase === "closed") return
    sendControl("heartbeat", { hostTick: deps.now(), lastFrameSeq })
  }
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test src/host/session/model/host-state-machine.test.tsx && bun x tsc --noEmit`
Expected: PASS, exit 0. (`lastFrameSeq`/`effectiveMode` were declared in Task 7, so
there is no duplicate binding here. `effectiveMode` is set by mount and set-mode and
read by the future input-gating phase; it is not read in 2C, which is fine — tsconfig
has no `noUnusedLocals`. `ControlEnvelope["body"]` is `{ readonly [k: string]:
JsonValue }`; the `as ControlEnvelope["body"]` casts on the response bodies bridge the
plain records — the wire round-trips through JSON anyway.)

- [ ] **Step 5: Commit**

```bash
git add src/host/session
git commit -m "feat: add host resize/set-mode/ping/heartbeat/shutdown handling

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 9: The `_host --stdio` entry

**Files:**
- Create: `src/host/session/model/entry.ts`
- Create: `src/host/session/model/entry.test.ts`
- Modify: `src/host/session/index.ts`

**Interfaces:**
- Consumes: `FrameDecoder` from `../../../infrastructure/framing`; the 2A encoders
  (`encodeHostHello`, `encodeControlEnvelope`, `encodeFrameEnvelope`) from
  `../../protocol`; `createHostSession`, `registerRuntimeResolver`, `loadPage`;
  `createHeadlessRenderer` from `../../render`; `PROTOCOL_HARD_LIMITS`,
  `RuntimeDeclarationBundleV1`.
- Produces:
  - `parseHostArgs(argv: string[]): boolean` — `true` iff the args request
    `_host --stdio` (compiled: `[exe, "_host", "--stdio"]`; `bun run`:
    `[bun, script, "_host", "--stdio"]`). Robust: the tokens `"_host"` and
    `"--stdio"` both present, `_host` before `--stdio`.
  - `runHostStdio(io: HostStdioIo): Promise<void>` — wires the byte transport:
    reads `io.input`, feeds a `FrameDecoder`, drives a `HostSession`, encodes each
    outbound message and calls `io.output`, runs the heartbeat timer via `io.now`,
    and on `ExitRequest` destroys the renderer, flushes, and calls `io.exit`.

- [ ] **Step 1: Write the failing test**

`src/host/session/model/entry.test.ts`:

```ts
import { describe, expect, test } from "bun:test"

import { FrameDecoder, type WireFrame } from "../../../infrastructure/framing"
import {
  decodeControlEnvelope,
  decodeHostHello,
  encodeClientHello,
  encodeControlEnvelope,
  PROTOCOL_HARD_LIMITS,
  type ClientHelloV1,
  type ControlEnvelope,
  type RuntimeDeclarationBundleV1,
} from "../../protocol"
import { parseHostArgs, runHostStdio } from "./entry"

describe("parseHostArgs", () => {
  test("accepts a compiled-binary _host --stdio argv", () => {
    expect(parseHostArgs(["C:/termcraft.exe", "_host", "--stdio"])).toBe(true)
  })
  test("accepts a bun run _host --stdio argv", () => {
    expect(parseHostArgs(["bun", "/src/main.ts", "_host", "--stdio"])).toBe(true)
  })
  test("rejects a normal launch", () => {
    expect(parseHostArgs(["C:/termcraft.exe"])).toBe(false)
  })
  test("rejects _host without --stdio", () => {
    expect(parseHostArgs(["C:/termcraft.exe", "_host"])).toBe(false)
  })
})

const RUNTIME_DECLARATION: RuntimeDeclarationBundleV1 = {
  module: "@termcraft/runtime",
  currentKitApiVersion: 1,
  supportedKitApiVersions: [1],
  publicCapabilityIds: ["theme:dark-default"],
}
const SESSION_ID = "01920000-0000-7000-8000-000000000000"
const NONCE = "0123456789abcdef0123456789abcdef"

const clientHelloFrame = (): Uint8Array => {
  const hello: ClientHelloV1 = {
    framingVersion: 1, kind: "client.hello", sessionId: SESSION_ID, nonce: NONCE,
    offeredFramingVersions: [1], offeredProtocolVersions: [1], mode: "preview",
    pageSlug: "dashboard", sourceHash: "a".repeat(64), sourceKitApiVersion: 1,
    runtimeDeclaration: RUNTIME_DECLARATION, limits: PROTOCOL_HARD_LIMITS,
  }
  const framed = encodeClientHello(hello)
  if (framed instanceof Error) throw framed
  return framed
}

describe("runHostStdio (in-memory transport)", () => {
  test("negotiates a host.hello from a client.hello fed as framed bytes", async () => {
    const output: Uint8Array[] = []
    const exits: number[] = []
    let resolveExit: () => void
    const exited = new Promise<void>((r) => { resolveExit = r })

    async function* input() {
      yield clientHelloFrame()
      // Give the host a moment to answer, then close the input to end the run.
      await new Promise((r) => setTimeout(r, 50))
    }

    await runHostStdio({
      argv: ["exe", "_host", "--stdio"],
      input: input(),
      output: (bytes) => output.push(bytes),
      now: () => 1000,
      exit: (code) => { exits.push(code); resolveExit() },
      deps: {
        runtimeDeclaration: RUNTIME_DECLARATION,
        limits: PROTOCOL_HARD_LIMITS,
        createRenderer: async () => { throw new Error("no mount in this test") },
      },
    })

    // Decode the host's framed output.
    const decoder = new FrameDecoder()
    const frames: WireFrame[] = []
    for (const chunk of output) {
      const fed = decoder.feed(chunk)
      if (fed instanceof Error) throw fed
      frames.push(...fed)
    }
    expect(frames.length).toBeGreaterThanOrEqual(1)
    const hostHello = decodeHostHello(frames[0]!.payload)
    if (hostHello instanceof Error) throw hostHello
    expect(hostHello.kind).toBe("host.hello")
    expect(hostHello.sessionId).toBe(SESSION_ID)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/host/session/model/entry.test.ts`
Expected: FAIL — cannot resolve `./entry`.

- [ ] **Step 3: Write the implementation**

`src/host/session/model/entry.ts`:

```ts
import { FrameDecoder } from "../../../infrastructure/framing"
import {
  encodeControlEnvelope,
  encodeFrameEnvelope,
  encodeHostHello,
  PROTOCOL_HARD_LIMITS,
  ProtocolError,
  type RuntimeDeclarationBundleV1,
} from "../../protocol"
import { createHeadlessRenderer } from "../../render"
import { createHostSession } from "./host-state-machine"
import { loadPage } from "./source-mount"
import { registerRuntimeResolver } from "./resolver"
import type { ExitRequest, OutboundMessage, HostSessionDeps } from "../types"

const HEARTBEAT_INTERVAL_MS = 1000

/** True iff argv requests `_host --stdio` (compiled or `bun run`; Spike E). */
export function parseHostArgs(argv: string[]): boolean {
  const hostIndex = argv.indexOf("_host")
  if (hostIndex === -1) return false
  return argv.indexOf("--stdio") > hostIndex
}

/** The transport-and-lifecycle dependencies of the `_host` child. */
export interface HostStdioIo {
  readonly argv: string[]
  readonly input: AsyncIterable<Uint8Array>
  readonly output: (bytes: Uint8Array) => void
  readonly now: () => number
  readonly exit: (code: number) => void
  readonly deps: {
    readonly runtimeDeclaration: RuntimeDeclarationBundleV1
    readonly limits: typeof PROTOCOL_HARD_LIMITS
    readonly createRenderer?: HostSessionDeps["createRenderer"]
  }
}

/**
 * Run the host-side protocol loop over an injected byte transport. It feeds a
 * `FrameDecoder` from `io.input`, drives a `HostSession`, encodes each outbound
 * logical message with the 2A codecs and writes it via `io.output`, ticks the
 * heartbeat on `io.now`, and on the session's `ExitRequest` stops the heartbeat,
 * destroys the live renderer, flushes, and calls `io.exit` (Spike D — the child
 * never self-exits). A framing/decoder failure terminates the incarnation.
 */
export async function runHostStdio(io: HostStdioIo): Promise<void> {
  registerRuntimeResolver()

  let liveRenderer: { destroy(): void } | null = null
  let exited = false
  let resolveDone: () => void = () => {}
  const done = new Promise<void>((resolve) => { resolveDone = resolve })

  const performExit = (request: ExitRequest) => {
    if (exited) return
    exited = true
    clearInterval(heartbeat)
    liveRenderer?.destroy()
    liveRenderer = null
    io.exit(request.code)
    resolveDone()
  }

  const encodeOutbound = (message: OutboundMessage): ProtocolError | Uint8Array => {
    if (message.type === "host-hello") return encodeHostHello(message.payload)
    if (message.type === "frame") return encodeFrameEnvelope(message.payload)
    return encodeControlEnvelope(message.payload)
  }

  const session = createHostSession({
    runtimeDeclaration: io.deps.runtimeDeclaration,
    limits: io.deps.limits,
    loadPage,
    createRenderer: async (size) => {
      const renderer = await (io.deps.createRenderer ?? createHeadlessRenderer)(size)
      liveRenderer = renderer
      return renderer
    },
    now: io.now,
    send: (message) => {
      const bytes = encodeOutbound(message)
      if (bytes instanceof ProtocolError) {
        performExit({ code: 1, reason: bytes.reason })
        return
      }
      io.output(bytes)
    },
    requestExit: performExit,
  })

  const heartbeat = setInterval(() => session.emitHeartbeat(), HEARTBEAT_INTERVAL_MS)

  const decoder = new FrameDecoder()
  const pump = (async () => {
    try {
      for await (const chunk of io.input) {
        if (exited) break
        const frames = decoder.feed(chunk)
        if (frames instanceof Error) {
          performExit({ code: 1, reason: frames.message })
          return
        }
        for (const frame of frames) {
          if (exited) break
          // stdout is protocol-only; the child only receives control-class inbound.
          await session.receiveControlPayload(frame.payload)
        }
      }
    } catch (cause) {
      // A live stdin stream can throw mid-iteration; route it to a typed exit so
      // the heartbeat interval is never leaked (the error is not swallowed — it
      // drives termination and surfaces in the exit reason).
      performExit({ code: 1, reason: `stdin iteration failed: ${String(cause)}` })
    }
  })()

  // The race ends on either signal (input closed, or an exit requested). The
  // `finally` guarantees the heartbeat interval is cleared on every path, so a
  // pump rejection can never leak it.
  try {
    await Promise.race([done, pump])
  } finally {
    clearInterval(heartbeat)
    if (!exited) resolveDone()
  }
  await done
}
```

Append to `src/host/session/index.ts`:

```ts
export { parseHostArgs, runHostStdio } from "./model/entry"
export type { HostStdioIo } from "./model/entry"
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test src/host/session && bun x tsc --noEmit`
Expected: PASS, exit 0.

**Empirical notes for the implementer:**
- The `done`/`pump` race ends the run when either the input closes (test) or an
  exit is requested (production one-shot / shutdown). Keep the invariant: the
  promise resolves after either signal, the heartbeat interval is always cleared,
  and `io.exit` is called exactly once. If the in-memory test hangs, the input
  generator must complete (it does — it `yield`s once then returns after 50 ms).
- The real `main.ts` (phase 8) calls `runHostStdio` with `input: Bun.stdin.stream()`
  (or `process.stdin` as an async iterable), `output: (b) => sink.write(b)` on a
  `Bun.stdout.writer()`, `now: () => Bun.nanoseconds() / 1e6`, and
  `exit: (code) => process.exit(code)`, after `await sink.flush()`. Wiring `main.ts`
  is **out of scope for 2C** (phase 8 composition root); this task delivers the
  reusable `runHostStdio` + `parseHostArgs` and proves them over an in-memory
  transport. Record this boundary in the report.

- [ ] **Step 5: Commit**

```bash
git add src/host/session
git commit -m "feat: add _host --stdio entry (byte transport + heartbeat + exit)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 10: Full-suite gate, hang check, ledger, architecture docs

**Files:**
- Modify: `.superpowers/sdd/progress.md`
- Modify: `docs/architecture/code-structure.md` (Source anchors — if a `host/session`
  anchor is warranted) and any `docs/architecture/` doc whose Source anchors point at
  the host-supervision spec sections this slice now realizes in code.

- [ ] **Step 1: Full suite + hang check**

Run: `bun test`
Expected: PASS — phase-0, runtime, all `host/protocol`, `host/render`, and the new
`host/session` suites green — **and the command returns to the shell within a few
seconds** (no hang). Every live renderer is destroyed via `afterEach`/entry exit; no
test calls `process.exit`.

If `bun test` hangs, apply the Plan-2B Task-6 hang mitigation in order (confirm every
renderer is destroyed first). Record any test-split in the report and handoff; do not
hide it.

- [ ] **Step 2: Typecheck**

Run: `bun x tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Update the SDD progress ledger**

Append a `## Plan 2C — host session — COMPLETE` section to
`.superpowers/sdd/progress.md` mirroring the 2A/2B entries: commit range, final gate
counts (tests pass/fail, tsc exit), deviations, and the documented deferrals
(geometry/capture-layout/input/tweaks → later phases; `main.ts` wiring → phase 8).

- [ ] **Step 4: Update architecture docs**

Per CLAUDE.md "Architecture docs maintenance" + the architecture-update skill: move
the affected `docs/architecture/` Source anchors for the host-supervision
handshake/mount/protocol-loop from the spec sections to the real
`src/host/session/*` paths now that they exist. If `docs/architecture/` has a
host-supervision process doc, update its walkthrough to reference the state machine.

- [ ] **Step 5: Commit**

```bash
git add .superpowers/sdd/progress.md docs/architecture
git commit -m "docs: record phase-2C host-session completion + architecture anchors

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-review checklist (run before implementing)

- **Spec coverage (host-supervision §6/§7 + runtime-api §3.1/§7.2):**
  - resolver three specifiers, fail-open, unconditional, `Bun.env` note → Task 1
  - source-hash recompute + import rescan (`scanImports`, robust) → Task 2, 5
  - mount: path validation, hash verify, import rescan, dynamic import, meta
    validation → Task 5
  - handshake: identity echo, version selection, per-field limit min → Task 6
  - mount → ready (meta, accepted size, effective interaction mode, initial
    FrameIdentity) + first frame; effective-static for non-preview → Task 7
  - one-shot smoke/export `process.exit()` after first frame → Task 7 (state) + 9 (exit)
  - resize (new frame, frameSeq++), set-mode (accept/refuse echo), ping, heartbeat
    (hostTick + lastFrameSeq), shutdown → shutdown-ack + exit → Task 8
  - identity mismatch fatal (§10.1); no-resync fatal error + exit (§5/§12) → Task 6-8
  - `_host --stdio` arg parse + byte transport + heartbeat timer + exit → Task 9
- **Deferrals documented, not half-built:** geometry queries, bulk capture/layout,
  input, tweaks, set-theme/capabilities, navigation, queues/backpressure/timeouts/
  restart (2D), `main.ts` wiring (phase 8) — stated in Scope + Tasks 7/9.
- **Type reuse:** `ProtocolError`/DTOs/codecs from `host/protocol`; `RenderHandle`/
  `createHeadlessRenderer` from `host/render`; `FrameDecoder` from
  `infrastructure/framing`; `HostMode`/`Size`/`TerminalCapabilities` from
  `host/types`. Nothing redefined.
- **Type consistency:** `MountRequestBody`, `ReadyBody`, `OutboundMessage`,
  `HostSessionDeps`, `LoadedPage`, `ValidatedPageMeta` defined once in
  `session/types.ts` (Task 5) and consumed verbatim by Tasks 6-9.
- **errore:** `.catch`/`errore.try` only at Bun boundaries (`Bun.file`, `import()`);
  errors as values; `instanceof ProtocolError` early returns; no silent swallow.
- **Traps honored:** resolver never branches on `process.env.NODE_ENV` (dot access);
  fixtures carry no pragma; `.test.tsx`/state-machine tests carry the pragma; one-shot
  exit is the entry's job, not the state machine's; every renderer destroyed.
- **No placeholders:** every step has complete code and an exact run command.
```
