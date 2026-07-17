# termcraft MVP Phase 0 — Scaffold, Entities, Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the `src/` skeleton and the first working, fully-tested code:
spec-pinned entity vocabulary (page slug/meta, `AgentEvent`, `TurnFence`) and
domain-free infrastructure (host-protocol framing codec, UUIDv7, clock).

**Architecture:** Follows `docs/architecture/code-structure.md`: `entities/`
holds pure domain vocabulary (no ports, no I/O), `infrastructure/` holds
domain-free technical capabilities (fails the "knows what a Page is" test →
does not belong there). Every module folder follows the `CLAUDE.md` shape:
code in `model/` subfolders, `types.ts` and `index.ts` at the module root.

**Tech Stack:** TypeScript 7.0.2 (repo lockfile), Bun ≥1.3.14, `errore`
^0.14.1, `bun:test`.

## Global Constraints

See `2026-07-17-termcraft-mvp-roadmap.md` → "Global constraints" — binding
for every task here. Phase-0-critical items, verbatim:

- errore: namespace import `import * as errore from "errore"`; errors as
  values; `createTaggedError`; one-line `instanceof Error` early returns.
- Page slug mask: `^[a-z0-9][a-z0-9-]{0,31}$` minus Windows device names
  `con`, `nul`, `aux`, `prn`, `com1`–`com9`, `lpt1`–`lpt9` (master spec §6.2).
- `AgentEvent` taxonomy verbatim from master spec §6.1.
- Framing (host-supervision spec §5): 8-byte outer header — offset 0: 4-byte
  unsigned **big-endian** payload length `N` (excludes header); offset 4:
  1 byte framing version = `1`; offset 5: 1 byte message class (`1` control,
  `2` frame/bulk data); offset 6: 2 bytes flags, **must be zero**; offset 8:
  `N` bytes UTF-8 JSON payload. Limits: control 262,144 bytes; frame/bulk
  16,777,216 bytes; global pre-classification ceiling 16,777,216 bytes —
  reject `N` above the ceiling **after reading the 4-byte length prefix and
  before allocating a payload buffer**; check the class-specific cap after
  reading the four framing bytes. **The four fatal framing conditions, §5
  verbatim: "Lengths of zero, unsupported framing versions, unknown classes,
  and non-zero flags are fatal framing errors."** `N = 0` is fatal because
  every payload is UTF-8 JSON and empty bytes are not valid JSON; it is
  detectable from the 4-byte length prefix alone, alongside the ceiling
  check. The reader must tolerate arbitrary fragmentation: "a prefix, fixed
  header, or payload may arrive one byte at a time". A framing violation is
  fatal — no resynchronization (a lost frame boundary could reinterpret
  attacker-controlled bytes as a fresh header).
- Imports are extensionless (`from "../types"`) — `allowImportingTsExtensions`
  is not enabled in `tsconfig.json` and this plan does not change tsconfig.
- All identities outside pages are lowercase canonical UUIDv7.
- Typecheck command: `bun x tsc --noEmit` (expect exit 0; the pre-code tree
  reports TS18003 until Task 1 lands its first file — that is the known
  starting state, not a failure of this plan).
- Commit after every task; prefix `feat:` (implementation+tests together),
  co-author trailer per repo convention.

## File Structure

```text
src/
  entities/
    page/
      model/
        slug.ts            parsePageSlug + InvalidPageSlugError
        slug.test.ts
      types.ts             PageSlug (branded), Size, PageMeta
      index.ts
    turn/
      types.ts             AgentEvent, AgentToolOp, TokenUsage, TurnFence
      types.test.ts        exhaustiveness/narrowing test
      index.ts
  infrastructure/
    uuid/
      model/
        uuidv7.ts
        uuidv7.test.ts
      index.ts
    clock/
      model/
        system-clock.ts
        system-clock.test.ts
      types.ts             Clock
      index.ts
    framing/
      model/
        constants.ts       header size, version, limits
        errors.ts          FramingError
        encode.ts          encodeFrame
        encode.test.ts
        decoder.ts         FrameDecoder (buffering push parser)
        decoder.test.ts
      types.ts             MessageClass, WireFrame
      index.ts
```

Nothing else. No `main.ts` (phase 8), no chat/pin entities (phase 4 — their
JSON schemas are normed by the storage-identity spec).

---

### Task 1: Page entity — slug, size, meta

**Files:**
- Create: `src/entities/page/types.ts`
- Create: `src/entities/page/model/slug.ts`
- Create: `src/entities/page/model/slug.test.ts`
- Create: `src/entities/page/index.ts`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `PageSlug` (branded string), `Size { w, h }`,
  `PageMeta { kitApiVersion, title, minSize, theme }`,
  `parsePageSlug(raw: string): InvalidPageSlugError | PageSlug`,
  `InvalidPageSlugError` (tagged, `_tag: "InvalidPageSlugError"`,
  properties `slug`, `reason`). Later phases (gate, store, core) call
  `parsePageSlug` for every slug that crosses a boundary.

- [ ] **Step 1: Write the failing test**

`src/entities/page/model/slug.test.ts`:

```ts
import { describe, expect, test } from "bun:test"

import type { PageSlug } from "../types"
import { InvalidPageSlugError, parsePageSlug } from "./slug"

describe("parsePageSlug", () => {
  test.each(["dashboard", "a", "0", "page-2", "a".repeat(32), "console"])(
    "accepts %j",
    (raw) => {
      // `.toBe` is typed to the actual's `InvalidPageSlugError | PageSlug`;
      // a plain string is not assignable to the branded PageSlug, so the
      // expected side is cast — at runtime the value IS the input string.
      expect(parsePageSlug(raw)).toBe(raw as PageSlug)
    },
  )

  test.each([
    "",
    "-leading-dash",
    "Upper",
    "under_score",
    "a".repeat(33),
    "с-кириллицей",
    "dot.name",
  ])("rejects %j by mask", (raw) => {
    const result = parsePageSlug(raw)
    expect(result).toBeInstanceOf(InvalidPageSlugError)
    if (result instanceof InvalidPageSlugError) {
      expect(result.slug).toBe(raw)
      expect(result.reason).toContain("mask")
    }
  })

  test.each([
    "con", "nul", "aux", "prn",
    "com1", "com5", "com9",
    "lpt1", "lpt4", "lpt9",
  ])("rejects Windows device name %j", (raw) => {
    const result = parsePageSlug(raw)
    expect(result).toBeInstanceOf(InvalidPageSlugError)
    if (result instanceof InvalidPageSlugError) {
      expect(result.reason).toContain("Windows")
    }
  })

  test("com0 and lpt0 are not reserved", () => {
    expect(parsePageSlug("com0")).toBe("com0" as PageSlug)
    expect(parsePageSlug("lpt0")).toBe("lpt0" as PageSlug)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/entities/page`
Expected: FAIL — `Cannot find module './slug'` (or equivalent resolution error).

- [ ] **Step 3: Write the implementation**

`src/entities/page/types.ts`:

```ts
declare const pageSlugBrand: unique symbol

/**
 * A validated page slug — the page's stable identity, its directory name
 * under `.termcraft/pages/`, and its Git-history identity (master spec §3.3).
 * Obtain one only through `parsePageSlug`.
 */
export type PageSlug = string & { readonly [pageSlugBrand]: true }

/** A terminal-cell size (columns × rows). */
export interface Size {
  readonly w: number
  readonly h: number
}

/** The static `meta` export of a page module (master spec §5.1). */
export interface PageMeta {
  readonly kitApiVersion: number
  readonly title: string
  readonly minSize: Size
  readonly theme: string
}
```

`src/entities/page/model/slug.ts`:

```ts
import * as errore from "errore"

import type { PageSlug } from "../types"

export class InvalidPageSlugError extends errore.createTaggedError({
  name: "InvalidPageSlugError",
  message: "Invalid page slug $slug: $reason",
}) {}

// Master spec §6.2: a slug is a directory name on disk.
const PAGE_SLUG_MASK = /^[a-z0-9][a-z0-9-]{0,31}$/

const WINDOWS_RESERVED_NAMES = new Set([
  "con",
  "nul",
  "aux",
  "prn",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
])

export function parsePageSlug(raw: string) {
  if (!PAGE_SLUG_MASK.test(raw)) {
    return new InvalidPageSlugError({
      slug: raw,
      reason: "does not match the slug mask ^[a-z0-9][a-z0-9-]{0,31}$",
    })
  }
  if (WINDOWS_RESERVED_NAMES.has(raw)) {
    return new InvalidPageSlugError({
      slug: raw,
      reason: "is a reserved Windows device name",
    })
  }
  return raw as PageSlug
}
```

`src/entities/page/index.ts`:

```ts
export type { PageMeta, PageSlug, Size } from "./types"
export { InvalidPageSlugError, parsePageSlug } from "./model/slug"
```

- [ ] **Step 4: Run tests and typecheck to verify they pass**

Run: `bun test src/entities/page`
Expected: PASS (all cases).

Run: `bun x tsc --noEmit`
Expected: exit 0, no diagnostics (TS18003 is gone now that `src` has files).

- [ ] **Step 5: Commit**

```bash
git add src/entities/page
git commit -m "feat: add page entity — branded slug with mask + device-name validation

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Turn entity — AgentEvent taxonomy and TurnFence

**Files:**
- Create: `src/entities/turn/types.ts`
- Create: `src/entities/turn/types.test.ts`
- Create: `src/entities/turn/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `AgentEvent` (discriminated union, master spec §6.1 verbatim),
  `AgentToolOp`, `TokenUsage { inputTokens, outputTokens, contextPercent }`,
  `TurnFence { turnId, attempt, leaseNonce }`. The `agent` module (phase 5)
  normalizes vendor events into `AgentEvent`; `core` (phase 6) and `ui`
  (phase 7) consume it. `TokenUsage.contextPercent` is `number | null` —
  null when the backend reports no context share (§3.9: no usage, no
  indicator).

- [ ] **Step 1: Write the failing test**

`src/entities/turn/types.test.ts`:

```ts
import { describe, expect, test } from "bun:test"

import type { AgentEvent, TurnFence } from "./types"

// Compile-time exhaustiveness: adding a variant breaks this switch.
function describeEvent(event: AgentEvent): string {
  switch (event.kind) {
    case "reasoning":
      return `reasoning:${event.text}`
    case "tool":
      return `tool:${event.op}:${event.target}`
    case "final":
      return `final:${event.text}`
    case "usage":
      return `usage:${event.tokens.inputTokens}/${event.tokens.outputTokens}`
    case "error":
      return `error:${event.message}`
  }
}

describe("AgentEvent", () => {
  test("narrows every variant of the §6.1 taxonomy", () => {
    const events: AgentEvent[] = [
      { kind: "reasoning", text: "planning" },
      { kind: "tool", op: "edit", target: "pages/main.tsx" },
      { kind: "final", text: "done" },
      {
        kind: "usage",
        tokens: { inputTokens: 10, outputTokens: 5, contextPercent: null },
      },
      { kind: "error", message: "boom" },
    ]
    expect(events.map(describeEvent)).toEqual([
      "reasoning:planning",
      "tool:edit:pages/main.tsx",
      "final:done",
      "usage:10/5",
      "error:boom",
    ])
  })

  test("TurnFence carries turnId, attempt, leaseNonce", () => {
    const fence: TurnFence = {
      turnId: "0198b1c2-0000-7000-8000-000000000000",
      attempt: 1,
      leaseNonce: "a1b2c3",
    }
    expect(fence.attempt).toBe(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/entities/turn`
Expected: FAIL — cannot resolve `./types`.

- [ ] **Step 3: Write the implementation**

`src/entities/turn/types.ts`:

```ts
/** Tool-step categories the UI renders as `✓ read main.tsx` (master spec §6.1). */
export type AgentToolOp = "read" | "edit" | "run" | "search" | "other"

/** Backend-reported token usage; feeds the composer's context indicator (§3.9). */
export interface TokenUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  /** 0–100 share of the backend's context window; null when unreported. */
  readonly contextPercent: number | null
}

/**
 * The normalized agent stream — the turn's only live output (master spec
 * §6.1). Backends map vendor events into this; kernel and UI never see
 * vendor shapes. Vendor events with no mapping are dropped silently.
 */
export type AgentEvent =
  | { readonly kind: "reasoning"; readonly text: string }
  | {
      readonly kind: "tool"
      readonly op: AgentToolOp
      readonly target: string
    }
  | { readonly kind: "final"; readonly text: string }
  | { readonly kind: "usage"; readonly tokens: TokenUsage }
  | { readonly kind: "error"; readonly message: string }

/**
 * Fences one agent run (master spec §6.2). Events carrying a stale fence
 * are ignored; retries get a fresh `{attempt, leaseNonce}` in the same
 * turn workspace.
 */
export interface TurnFence {
  readonly turnId: string
  readonly attempt: number
  readonly leaseNonce: string
}
```

`src/entities/turn/index.ts`:

```ts
export type { AgentEvent, AgentToolOp, TokenUsage, TurnFence } from "./types"
```

- [ ] **Step 4: Run tests and typecheck to verify they pass**

Run: `bun test src/entities/turn && bun x tsc --noEmit`
Expected: PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/entities/turn
git commit -m "feat: add turn entity — AgentEvent taxonomy and TurnFence

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: UUIDv7 infrastructure

**Files:**
- Create: `src/infrastructure/uuid/model/uuidv7.ts`
- Create: `src/infrastructure/uuid/model/uuidv7.test.ts`
- Create: `src/infrastructure/uuid/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `uuidv7(): string` — canonical lowercase UUIDv7. Every non-page
  identity in later phases (chat, turn, record, pin, command, transaction)
  calls this.

- [ ] **Step 1: Write the failing test**

`src/infrastructure/uuid/model/uuidv7.test.ts`:

```ts
import { describe, expect, test } from "bun:test"

import { uuidv7 } from "./uuidv7"

const UUID_V7_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe("uuidv7", () => {
  test("produces canonical lowercase v7 ids", () => {
    for (let i = 0; i < 100; i += 1) {
      expect(uuidv7()).toMatch(UUID_V7_SHAPE)
    }
  })

  test("ids generated in sequence sort in generation order", () => {
    const ids = Array.from({ length: 100 }, () => uuidv7())
    expect([...ids].sort()).toEqual(ids)
  })

  test("ids are unique", () => {
    const ids = Array.from({ length: 1000 }, () => uuidv7())
    expect(new Set(ids).size).toBe(ids.length)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/infrastructure/uuid`
Expected: FAIL — cannot resolve `./uuidv7`.

- [ ] **Step 3: Write the implementation**

`src/infrastructure/uuid/model/uuidv7.ts`:

```ts
/**
 * Canonical lowercase UUIDv7. Bun's implementation embeds a millisecond
 * timestamp plus a monotonic sub-millisecond counter, so in-process ids
 * sort in generation order — storage relies on that for record ordering.
 */
export function uuidv7(): string {
  return Bun.randomUUIDv7()
}
```

`src/infrastructure/uuid/index.ts`:

```ts
export { uuidv7 } from "./model/uuidv7"
```

- [ ] **Step 4: Run tests and typecheck to verify they pass**

Run: `bun test src/infrastructure/uuid && bun x tsc --noEmit`
Expected: PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/uuid
git commit -m "feat: add uuidv7 infrastructure over Bun.randomUUIDv7

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Clock infrastructure

**Files:**
- Create: `src/infrastructure/clock/types.ts`
- Create: `src/infrastructure/clock/model/system-clock.ts`
- Create: `src/infrastructure/clock/model/system-clock.test.ts`
- Create: `src/infrastructure/clock/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Clock { now(): Date }`, `systemClock: Clock`. Anything that
  timestamps records or measures deadlines takes a `Clock` so tests can
  inject a fake.

- [ ] **Step 1: Write the failing test**

`src/infrastructure/clock/model/system-clock.test.ts`:

```ts
import { describe, expect, test } from "bun:test"

import type { Clock } from "../types"
import { systemClock } from "./system-clock"

describe("systemClock", () => {
  test("returns the current time as a Date", () => {
    const before = Date.now()
    const observed = systemClock.now().getTime()
    const after = Date.now()
    expect(observed).toBeGreaterThanOrEqual(before)
    expect(observed).toBeLessThanOrEqual(after)
  })

  test("a fake Clock is substitutable", () => {
    const fixed = new Date("2026-07-17T12:00:00.000Z")
    const fake: Clock = { now: () => fixed }
    expect(fake.now().toISOString()).toBe("2026-07-17T12:00:00.000Z")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/infrastructure/clock`
Expected: FAIL — cannot resolve `./system-clock`.

- [ ] **Step 3: Write the implementation**

`src/infrastructure/clock/types.ts`:

```ts
/** Injectable time source; production uses `systemClock`, tests use fakes. */
export interface Clock {
  readonly now: () => Date
}
```

`src/infrastructure/clock/model/system-clock.ts`:

```ts
import type { Clock } from "../types"

export const systemClock: Clock = {
  now: () => new Date(),
}
```

`src/infrastructure/clock/index.ts`:

```ts
export type { Clock } from "./types"
export { systemClock } from "./model/system-clock"
```

- [ ] **Step 4: Run tests and typecheck to verify they pass**

Run: `bun test src/infrastructure/clock && bun x tsc --noEmit`
Expected: PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/clock
git commit -m "feat: add injectable clock infrastructure

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Framing — types, constants, errors, encoder

**Files:**
- Create: `src/infrastructure/framing/types.ts`
- Create: `src/infrastructure/framing/model/constants.ts`
- Create: `src/infrastructure/framing/model/errors.ts`
- Create: `src/infrastructure/framing/model/encode.ts`
- Create: `src/infrastructure/framing/model/encode.test.ts`
- Create: `src/infrastructure/framing/index.ts` (encoder exports; Task 6 adds
  the decoder export)

**Interfaces:**
- Consumes: nothing.
- Produces: `MessageClass = "control" | "data"`,
  `WireFrame { messageClass, payload: Uint8Array }`,
  `encodeFrame(frame: WireFrame): FramingError | Uint8Array` — returns a
  `FramingError` for an empty payload (`N = 0` is a fatal framing condition,
  §5) and for a payload over its class limit,
  `FramingError` (tagged, property `reason`), and the exported constants
  `FRAME_HEADER_BYTES = 8`, `FRAMING_VERSION = 1`,
  `CONTROL_PAYLOAD_LIMIT_BYTES = 262_144`,
  `DATA_PAYLOAD_LIMIT_BYTES = 16_777_216`,
  `GLOBAL_PAYLOAD_CEILING_BYTES = 16_777_216`. The `host` module (phase 2)
  builds its protocol directly on these; JSON encoding/decoding of payloads
  is deliberately *not* this module's job (it is domain-free byte framing).

- [ ] **Step 1: Write the failing test**

`src/infrastructure/framing/model/encode.test.ts`:

```ts
import { describe, expect, test } from "bun:test"

import {
  CONTROL_PAYLOAD_LIMIT_BYTES,
  FRAME_HEADER_BYTES,
  FRAMING_VERSION,
} from "./constants"
import { encodeFrame } from "./encode"
import { FramingError } from "./errors"

describe("encodeFrame", () => {
  test("lays out the 8-byte header per host-supervision §5", () => {
    const payload = new TextEncoder().encode(`{"kind":"hello"}`)
    const encoded = encodeFrame({ messageClass: "control", payload })
    if (encoded instanceof Error) throw encoded

    expect(encoded.byteLength).toBe(FRAME_HEADER_BYTES + payload.byteLength)
    const view = new DataView(encoded.buffer, encoded.byteOffset)
    expect(view.getUint32(0, false)).toBe(payload.byteLength) // big-endian N
    expect(view.getUint8(4)).toBe(FRAMING_VERSION)
    expect(view.getUint8(5)).toBe(1) // control class code
    expect(view.getUint16(6, false)).toBe(0) // flags must be zero
    expect(encoded.slice(FRAME_HEADER_BYTES)).toEqual(payload)
  })

  test("data class encodes class code 2", () => {
    const encoded = encodeFrame({
      messageClass: "data",
      payload: new Uint8Array([1, 2, 3]),
    })
    if (encoded instanceof Error) throw encoded
    expect(encoded[5]).toBe(2)
  })

  test("an empty payload is a FramingError (N = 0 is fatal, §5)", () => {
    const result = encodeFrame({
      messageClass: "control",
      payload: new Uint8Array(0),
    })
    expect(result).toBeInstanceOf(FramingError)
  })

  test("control payload at exactly the limit is accepted", () => {
    const encoded = encodeFrame({
      messageClass: "control",
      payload: new Uint8Array(CONTROL_PAYLOAD_LIMIT_BYTES),
    })
    expect(encoded).not.toBeInstanceOf(Error)
  })

  test("control payload above the limit is a FramingError", () => {
    const result = encodeFrame({
      messageClass: "control",
      payload: new Uint8Array(CONTROL_PAYLOAD_LIMIT_BYTES + 1),
    })
    expect(result).toBeInstanceOf(FramingError)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/infrastructure/framing`
Expected: FAIL — cannot resolve `./constants` / `./encode`.

- [ ] **Step 3: Write the implementation**

`src/infrastructure/framing/types.ts`:

```ts
/** Host-supervision §5: `1` = control, `2` = frame/bulk data. */
export type MessageClass = "control" | "data"

/** One framed message; payload bytes are opaque to this layer. */
export interface WireFrame {
  readonly messageClass: MessageClass
  readonly payload: Uint8Array
}
```

`src/infrastructure/framing/model/constants.ts`:

```ts
// Host-supervision protocol §5 — fixed outer frame layout, version 1:
// [0..3] u32 big-endian payload length N (header excluded)
// [4]    framing version = 1
// [5]    message class: 1 control, 2 frame/bulk data
// [6..7] flags, must be zero
// [8..]  N bytes UTF-8 JSON payload
export const FRAME_HEADER_BYTES = 8
export const FRAMING_VERSION = 1
export const CONTROL_PAYLOAD_LIMIT_BYTES = 262_144
export const DATA_PAYLOAD_LIMIT_BYTES = 16_777_216
export const GLOBAL_PAYLOAD_CEILING_BYTES = 16_777_216
```

`src/infrastructure/framing/model/errors.ts`:

```ts
import * as errore from "errore"

/**
 * A framing violation. Fatal for the stream that produced it: after a lost
 * frame boundary, resynchronization could reinterpret attacker-controlled
 * payload bytes as a fresh header (host-supervision §5).
 */
export class FramingError extends errore.createTaggedError({
  name: "FramingError",
  message: "Framing violation: $reason",
}) {}
```

`src/infrastructure/framing/model/encode.ts`:

```ts
import type { WireFrame } from "../types"
import {
  CONTROL_PAYLOAD_LIMIT_BYTES,
  DATA_PAYLOAD_LIMIT_BYTES,
  FRAME_HEADER_BYTES,
  FRAMING_VERSION,
} from "./constants"
import { FramingError } from "./errors"

const CLASS_CODES = { control: 1, data: 2 } as const

const CLASS_LIMITS = {
  control: CONTROL_PAYLOAD_LIMIT_BYTES,
  data: DATA_PAYLOAD_LIMIT_BYTES,
} as const

export function encodeFrame(frame: WireFrame): FramingError | Uint8Array {
  // §5: a length of zero is a fatal framing condition — every payload is
  // UTF-8 JSON, and empty bytes cannot be valid JSON. Refuse to produce one.
  if (frame.payload.byteLength === 0) {
    return new FramingError({
      reason: "payload of zero bytes is not a valid frame",
    })
  }

  const limit = CLASS_LIMITS[frame.messageClass]
  if (frame.payload.byteLength > limit) {
    return new FramingError({
      reason: `${frame.messageClass} payload of ${frame.payload.byteLength} bytes exceeds the ${limit}-byte class limit`,
    })
  }

  const encoded = new Uint8Array(FRAME_HEADER_BYTES + frame.payload.byteLength)
  const view = new DataView(encoded.buffer)
  view.setUint32(0, frame.payload.byteLength, false)
  view.setUint8(4, FRAMING_VERSION)
  view.setUint8(5, CLASS_CODES[frame.messageClass])
  // Bytes 6–7 stay zero: flags must be zero in framing version 1.
  encoded.set(frame.payload, FRAME_HEADER_BYTES)
  return encoded
}
```

`src/infrastructure/framing/index.ts`:

```ts
export type { MessageClass, WireFrame } from "./types"
export {
  CONTROL_PAYLOAD_LIMIT_BYTES,
  DATA_PAYLOAD_LIMIT_BYTES,
  FRAME_HEADER_BYTES,
  FRAMING_VERSION,
  GLOBAL_PAYLOAD_CEILING_BYTES,
} from "./model/constants"
export { FramingError } from "./model/errors"
export { encodeFrame } from "./model/encode"
```

- [ ] **Step 4: Run tests and typecheck to verify they pass**

Run: `bun test src/infrastructure/framing && bun x tsc --noEmit`
Expected: PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/framing
git commit -m "feat: add host-protocol frame encoder with §5 header layout and limits

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Framing — buffering push decoder

**Files:**
- Create: `src/infrastructure/framing/model/decoder.ts`
- Create: `src/infrastructure/framing/model/decoder.test.ts`
- Modify: `src/infrastructure/framing/index.ts` (add the decoder export)

**Interfaces:**
- Consumes: Task 5's constants, `FramingError`, `WireFrame`.
- Produces: `class FrameDecoder { feed(chunk: Uint8Array): FramingError | WireFrame[] }`.
  Contract: `feed` accepts arbitrary fragmentation (Spike E: frames really
  split across stdio `data` events); returns every frame completed by this
  chunk (possibly `[]`); a violation poisons the decoder — the same
  `FramingError` is returned for this and every later `feed`, and any frames
  parsed earlier in the failing chunk are dropped (the stream is torn down
  anyway). The fatal conditions (§5) are: `N = 0`, `N` above the global
  ceiling or the class cap, framing version ≠ 1, unknown class code, and
  non-zero flags. Payloads are copied out; callers may reuse the fed chunk.

- [ ] **Step 1: Write the failing test**

`src/infrastructure/framing/model/decoder.test.ts`:

```ts
import { describe, expect, test } from "bun:test"

import {
  CONTROL_PAYLOAD_LIMIT_BYTES,
  FRAME_HEADER_BYTES,
  GLOBAL_PAYLOAD_CEILING_BYTES,
} from "./constants"
import { FrameDecoder } from "./decoder"
import { encodeFrame } from "./encode"
import { FramingError } from "./errors"

function mustEncode(
  messageClass: "control" | "data",
  payload: Uint8Array,
): Uint8Array {
  const encoded = encodeFrame({ messageClass, payload })
  if (encoded instanceof Error) throw encoded
  return encoded
}

describe("FrameDecoder", () => {
  test("round-trips a single control frame", () => {
    const payload = new TextEncoder().encode(`{"kind":"hello"}`)
    const decoder = new FrameDecoder()
    const frames = decoder.feed(mustEncode("control", payload))
    if (frames instanceof Error) throw frames
    expect(frames).toHaveLength(1)
    expect(frames[0]?.messageClass).toBe("control")
    expect(frames[0]?.payload).toEqual(payload)
  })

  test("tolerates byte-at-a-time delivery", () => {
    const payload = new TextEncoder().encode(`{"seq":1}`)
    const encoded = mustEncode("data", payload)
    const decoder = new FrameDecoder()
    const collected: unknown[] = []
    for (const [index, byte] of encoded.entries()) {
      const frames = decoder.feed(new Uint8Array([byte]))
      if (frames instanceof Error) throw frames
      if (index < encoded.byteLength - 1) expect(frames).toHaveLength(0)
      collected.push(...frames)
    }
    expect(collected).toHaveLength(1)
  })

  test("emits several frames arriving in one chunk", () => {
    const parts = [
      mustEncode("control", new TextEncoder().encode(`{"a":1}`)),
      mustEncode("data", new Uint8Array([1, 2, 3])),
      mustEncode("control", new TextEncoder().encode(`{"z":9}`)),
    ]
    const joined = new Uint8Array(
      parts.reduce((total, part) => total + part.byteLength, 0),
    )
    parts.reduce((offset, part) => {
      joined.set(part, offset)
      return offset + part.byteLength
    }, 0)

    const decoder = new FrameDecoder()
    const frames = decoder.feed(joined)
    if (frames instanceof Error) throw frames
    expect(frames.map((frame) => frame.messageClass)).toEqual([
      "control",
      "data",
      "control",
    ])
    expect(frames[2]?.payload).toEqual(new TextEncoder().encode(`{"z":9}`))
  })

  test("rejects a zero-length frame from the length prefix alone (§5)", () => {
    const header = new Uint8Array(4) // N = 0
    const decoder = new FrameDecoder()
    expect(decoder.feed(header)).toBeInstanceOf(FramingError)
  })

  test("a length header containing 0x0A / 0x0D bytes survives (Spike E)", () => {
    // N = 10 → length bytes 00 00 00 0A; N = 13 → 00 00 00 0D.
    for (const size of [10, 13]) {
      const payload = new Uint8Array(size).fill(0x61)
      const decoder = new FrameDecoder()
      const frames = decoder.feed(mustEncode("data", payload))
      if (frames instanceof Error) throw frames
      expect(frames[0]?.payload).toEqual(payload)
    }
  })

  test("rejects N above the global ceiling from the length prefix alone", () => {
    const header = new Uint8Array(4)
    new DataView(header.buffer).setUint32(
      0,
      GLOBAL_PAYLOAD_CEILING_BYTES + 1,
      false,
    )
    const decoder = new FrameDecoder()
    expect(decoder.feed(header)).toBeInstanceOf(FramingError)
  })

  test("rejects a control frame above its class limit", () => {
    const header = new Uint8Array(FRAME_HEADER_BYTES)
    const view = new DataView(header.buffer)
    view.setUint32(0, CONTROL_PAYLOAD_LIMIT_BYTES + 1, false)
    view.setUint8(4, 1)
    view.setUint8(5, 1)
    const decoder = new FrameDecoder()
    expect(decoder.feed(header)).toBeInstanceOf(FramingError)
  })

  test.each([
    ["version", (view: DataView) => view.setUint8(4, 2)],
    ["class", (view: DataView) => view.setUint8(5, 3)],
    ["flags", (view: DataView) => view.setUint16(6, 1, false)],
  ])("rejects a corrupt %s byte", (_name, corrupt) => {
    const encoded = mustEncode("control", new Uint8Array([0x7b, 0x7d]))
    const view = new DataView(encoded.buffer, encoded.byteOffset)
    corrupt(view)
    const decoder = new FrameDecoder()
    expect(decoder.feed(encoded)).toBeInstanceOf(FramingError)
  })

  test("stays poisoned after a violation", () => {
    const bad = new Uint8Array(4)
    new DataView(bad.buffer).setUint32(
      0,
      GLOBAL_PAYLOAD_CEILING_BYTES + 1,
      false,
    )
    const decoder = new FrameDecoder()
    const first = decoder.feed(bad)
    expect(first).toBeInstanceOf(FramingError)

    const fine = mustEncode("control", new Uint8Array([0x7b, 0x7d]))
    const second = decoder.feed(fine)
    expect(second).toBe(first)
  })

  test("copies payload bytes out of the fed chunk", () => {
    const payload = new Uint8Array([1, 2, 3, 4])
    const encoded = mustEncode("data", payload)
    const decoder = new FrameDecoder()
    const frames = decoder.feed(encoded)
    if (frames instanceof Error) throw frames
    encoded.fill(0)
    expect(frames[0]?.payload).toEqual(new Uint8Array([1, 2, 3, 4]))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/infrastructure/framing`
Expected: encode tests PASS; decoder tests FAIL — cannot resolve `./decoder`.

- [ ] **Step 3: Write the implementation**

`src/infrastructure/framing/model/decoder.ts`:

```ts
import type { MessageClass, WireFrame } from "../types"
import {
  CONTROL_PAYLOAD_LIMIT_BYTES,
  DATA_PAYLOAD_LIMIT_BYTES,
  FRAME_HEADER_BYTES,
  FRAMING_VERSION,
  GLOBAL_PAYLOAD_CEILING_BYTES,
} from "./constants"
import { FramingError } from "./errors"

const CLASS_BY_CODE: Record<number, MessageClass> = {
  1: "control",
  2: "data",
}

const CLASS_LIMITS: Record<MessageClass, number> = {
  control: CONTROL_PAYLOAD_LIMIT_BYTES,
  data: DATA_PAYLOAD_LIMIT_BYTES,
}

/**
 * Buffering push parser for the §5 outer frame layout. Fragmentation is the
 * normal case (Spike E measured 5 stdio events for 3 logical frames), so
 * `feed` buffers partial prefixes, headers, and payloads. A violation
 * poisons the decoder permanently — the transport must be torn down.
 */
export class FrameDecoder {
  private buffered = new Uint8Array(0)
  private failure: FramingError | null = null

  feed(chunk: Uint8Array): FramingError | WireFrame[] {
    if (this.failure !== null) return this.failure

    this.buffered = appendBytes(this.buffered, chunk)
    const frames: WireFrame[] = []
    while (true) {
      if (this.buffered.byteLength < 4) return frames
      const view = new DataView(
        this.buffered.buffer,
        this.buffered.byteOffset,
        this.buffered.byteLength,
      )

      // §5: a length of zero is a fatal framing error, and N above the
      // global ceiling is rejected before allocating a payload buffer —
      // both detectable from the 4-byte length prefix alone.
      const payloadLength = view.getUint32(0, false)
      if (payloadLength === 0) {
        return this.poison("payload length of zero is not a valid frame")
      }
      if (payloadLength > GLOBAL_PAYLOAD_CEILING_BYTES) {
        return this.poison(
          `payload length ${payloadLength} exceeds the global ${GLOBAL_PAYLOAD_CEILING_BYTES}-byte ceiling`,
        )
      }

      if (this.buffered.byteLength < FRAME_HEADER_BYTES) return frames
      const version = view.getUint8(4)
      if (version !== FRAMING_VERSION) {
        return this.poison(
          `framing version ${version} is not the supported version ${FRAMING_VERSION}`,
        )
      }
      const classCode = view.getUint8(5)
      const messageClass = CLASS_BY_CODE[classCode] ?? null
      if (messageClass === null) {
        return this.poison(`unknown message class code ${classCode}`)
      }
      const flags = view.getUint16(6, false)
      if (flags !== 0) {
        return this.poison(`flags ${flags} must be zero in framing version 1`)
      }
      const classLimit = CLASS_LIMITS[messageClass]
      if (payloadLength > classLimit) {
        return this.poison(
          `${messageClass} payload of ${payloadLength} bytes exceeds the ${classLimit}-byte class limit`,
        )
      }

      if (this.buffered.byteLength < FRAME_HEADER_BYTES + payloadLength) {
        return frames
      }
      // slice() copies, so emitted payloads never alias the fed chunk.
      const payload = this.buffered.slice(
        FRAME_HEADER_BYTES,
        FRAME_HEADER_BYTES + payloadLength,
      )
      frames.push({ messageClass, payload })
      this.buffered = this.buffered.slice(FRAME_HEADER_BYTES + payloadLength)
    }
  }

  private poison(reason: string): FramingError {
    this.failure = new FramingError({ reason })
    this.buffered = new Uint8Array(0)
    return this.failure
  }
}

function appendBytes(current: Uint8Array, next: Uint8Array): Uint8Array {
  if (next.byteLength === 0) return current
  const joined = new Uint8Array(current.byteLength + next.byteLength)
  joined.set(current, 0)
  joined.set(next, current.byteLength)
  return joined
}
```

Update `src/infrastructure/framing/index.ts` — append:

```ts
export { FrameDecoder } from "./model/decoder"
```

- [ ] **Step 4: Run tests and typecheck to verify they pass**

Run: `bun test src/infrastructure/framing && bun x tsc --noEmit`
Expected: PASS (encode + decoder suites), exit 0.

- [ ] **Step 5: Run the full suite**

Run: `bun test`
Expected: PASS — entities/page, entities/turn, uuid, clock, framing all green.

- [ ] **Step 6: Commit**

```bash
git add src/infrastructure/framing
git commit -m "feat: add buffering frame decoder — fragmentation-tolerant, poisoning on violation

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
