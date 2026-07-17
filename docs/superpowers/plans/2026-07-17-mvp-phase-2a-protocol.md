# termcraft MVP Phase 2A — Host Protocol Wire Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `src/host/protocol/` — the closed JSON wire schemas of host
protocol v1 and a validating codec that sits on top of the phase-0
`infrastructure/framing` byte layer. Pure logic: no subprocess, no OpenTUI, no
I/O. Given a decoded `WireFrame` payload it validates into a typed protocol
message; given a typed message it encodes to bytes.

**Architecture:** `host/protocol/` is a submodule of the `host/` adapter module
(`docs/architecture/code-structure.md`). It imports `infrastructure/framing`
(the §5 outer-frame codec) and `errore`, and nothing else. The framing layer
already enforces the four fatal framing conditions and the byte-length limits;
this layer enforces the **payload** schema: UTF-8, strict JSON (duplicate keys
and unsafe-integer numbers rejected), closed per-message shapes, and the
handshake/frame invariants of host-supervision §5.1–§5.3 and runtime-api §7.1.

**Tech Stack:** TypeScript 7.0.2 (repo lockfile), Bun ≥1.3.14, `errore` ^0.14.1,
`bun:test`. tsconfig: `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`.
Two rules this causes: use `import type` for type-only imports (never mix a type
and a value in one `import {}`); and **field access on a `{ [k]: JsonValue }`
object yields `JsonValue | undefined`**, so every shape guard below takes
`JsonValue | undefined`. Prefer `String.prototype.charAt` and iterators over raw
numeric index access to avoid a second `| undefined`.

## Global Constraints

See `2026-07-17-termcraft-mvp-roadmap.md` → "Global constraints" and
`2026-07-17-mvp-phase-2-host.md` → "Global constraints" — binding for every task.
Phase-2A-critical items, verbatim:

- **errore mandatory:** `import * as errore from "errore"`; errors as values;
  `createTaggedError` for `ProtocolError` (template carries `$code` + `$reason`,
  `cause` passed at the `.catch`/`errore.try` boundary); one-line `instanceof
  Error` early returns; flat control flow; `.catch()`/`errore.try` only at the
  `JSON.parse` / `TextDecoder` boundary.
- **Reuse phase-0 framing — do not reinvent byte framing.** Import `encodeFrame`,
  `FrameDecoder`, `WireFrame`, `MessageClass`, and the limit constants from
  `src/infrastructure/framing`. The four fatal framing conditions (zero length,
  version ≠ 1, unknown class, non-zero flags) and the 256 KiB/16 MiB byte caps
  live there and are already tested.
- **Closed schemas (host-supervision §5).** Every JSON payload is a closed
  schema. Reject: invalid UTF-8; malformed JSON; non-finite numbers (JSON has no
  such literals — `JSON.parse` throws); **duplicate object keys**;
  **unsafe-integer JSON number tokens**; unknown fields; missing required fields;
  a `kind`/literal wrong for the message. `JSON.parse` alone cannot detect
  duplicate keys or unsafe-integer tokens — Task 1's strict scan is required.
- **Decimal-string identifiers.** `messageId`, `requestId`, `responseTo`, and
  `frameSeq` may exceed `Number.MAX_SAFE_INTEGER`; they are decimal **strings** on
  the wire (`/^[1-9]\d*$/`, unsigned-64-bit-bounded), never JSON numbers.
- **No resync at the codec layer.** A decode function returns a `ProtocolError`;
  it does not attempt recovery. The supervisor tears the incarnation down (§5).
- **Payload limits (§5, §5.3):** control 262,144 B; frame/bulk 16,777,216 B; frame
  v1 ≤ 2,048 cells per axis and ≤ 262,144 cells total; check `width × height`
  before use. Hello payloads are control-class.
- **Green gates after every task:** `bun test` and `bun x tsc --noEmit` both clean.
- **Commit after every task:** `feat:`/`test:` prefix, Claude co-author trailer.

## Scope notes (recorded, not silently skipped)

- **Per-row display-width equality is deferred, by design.** §5.3 requires each
  row's Unicode display width to equal `width`. Computing display width needs a
  Unicode width table; frames are produced host-side using OpenTUI's authoritative
  `span.width` (Spike B), so re-deriving width here with an independent table
  risks drift and false rejections. 2A validates structural frame consistency
  (`rows.length === height`, well-formed runs, the cell-count limit); the
  display-width sum is asserted where OpenTUI's width function is in hand — on the
  encode side in 2B and again at blit in the broker/UI. Deliberate placement, not
  an omission.
- **Per-kind control/frame *body* schemas** (`mount`, `resize`, `ready`,
  `query-*`, `layout`, `capture`, …) are **not** in 2A. 2A defines the generic
  `ControlEnvelope` (whose `body` is an unvalidated object per §5.2) and the
  preview `FrameEnvelope`. The per-kind body validators land in 2C/2D beside the
  state machine that produces and consumes them.
- **Negotiation-outcome codes** (`PROTOCOL_NEGOTIATION_FAILED`,
  `RUNTIME_INTEGRITY_MISMATCH`, `KIT_API_MISMATCH`) are supervisor **decisions**
  (2D), not codec decisions. `ProtocolViolationCode` includes them so 2C/2D reuse
  the same error type, but 2A only ever produces `MALFORMED_PROTOCOL`,
  `OVERSIZED_MESSAGE`, and `FRAME_TOO_LARGE`.

## File Structure

```text
src/host/
  types.ts                       HostMode, InteractionMode (host-shared vocab; Task 2)
  protocol/
    model/
      errors.ts                  ProtocolError, ProtocolViolationCode (Task 1)
      strict-json.ts             JsonValue, decodeUtf8, parseStrictJson (Task 1)
      shape.ts                   shape guards over JsonValue | undefined (Task 2)
      bundle.ts                  RuntimeDeclarationBundleV1 + PublicLimits validators (Task 2)
      hello.ts                   ClientHelloV1 / HostHelloV1 codec (Task 3)
      control-envelope.ts        ControlEnvelope codec (Task 4)
      frame.ts                   FrameEnvelope / StyledRun / Color codec (Task 5)
      *.test.ts                  colocated per model file (+ integration.test.ts Task 6)
    types.ts                     all protocol DTO types, created whole in Task 2
    index.ts                     public entry (grows per task, append-only exports)
```

All protocol DTO **types** are created once in Task 2's `types.ts` so later tasks
never edit a shared file mid-body; Tasks 3–5 only add a model file, its test, and
append exports to `index.ts`.

---

### Task 1: `ProtocolError` + strict JSON payload decode

**Files:**
- Create: `src/host/protocol/model/errors.ts`
- Create: `src/host/protocol/model/strict-json.ts`
- Create: `src/host/protocol/model/strict-json.test.ts`
- Create: `src/host/protocol/index.ts`

**Interfaces:**
- Consumes: `errore`.
- Produces: `ProtocolError` (tagged, `_tag: "ProtocolError"`, properties `code`,
  `reason`, `cause`), `ProtocolViolationCode` (union), `JsonValue`,
  `decodeUtf8(bytes: Uint8Array): ProtocolError | string`,
  `parseStrictJson(text: string): ProtocolError | JsonValue`,
  `decodeJsonPayload(bytes: Uint8Array): ProtocolError | JsonValue`. Every later
  task and every host/supervisor decode path routes payload bytes through
  `decodeJsonPayload` before shape validation.

- [ ] **Step 1: Write the failing test**

`src/host/protocol/model/strict-json.test.ts`:

```ts
import { describe, expect, test } from "bun:test"

import { ProtocolError } from "./errors"
import { decodeJsonPayload, decodeUtf8, parseStrictJson } from "./strict-json"

const utf8 = (text: string) => new TextEncoder().encode(text)

describe("decodeUtf8", () => {
  test("decodes valid UTF-8", () => {
    expect(decodeUtf8(utf8('{"kind":"héllo"}'))).toBe('{"kind":"héllo"}')
  })

  test("rejects invalid UTF-8 as a ProtocolError", () => {
    const result = decodeUtf8(new Uint8Array([0xff, 0xfe, 0xfd]))
    expect(result).toBeInstanceOf(ProtocolError)
    if (result instanceof ProtocolError) expect(result.code).toBe("MALFORMED_PROTOCOL")
  })
})

describe("parseStrictJson", () => {
  test("parses a valid nested value", () => {
    expect(parseStrictJson('{"a":[1,2,{"b":true}],"c":"x"}')).toEqual({
      a: [1, 2, { b: true }],
      c: "x",
    })
  })

  test("rejects malformed JSON", () => {
    expect(parseStrictJson("{not json")).toBeInstanceOf(ProtocolError)
  })

  test("rejects trailing content after the value", () => {
    expect(parseStrictJson('{"a":1} trailing')).toBeInstanceOf(ProtocolError)
  })

  test("rejects a duplicate object key at the top level", () => {
    const result = parseStrictJson('{"a":1,"a":2}')
    expect(result).toBeInstanceOf(ProtocolError)
    if (result instanceof ProtocolError) expect(result.reason).toContain("duplicate")
  })

  test("rejects a duplicate key differing only by unicode escape", () => {
    expect(parseStrictJson('{"a":1,"\\u0061":2}')).toBeInstanceOf(ProtocolError)
  })

  test("rejects a duplicate key nested inside an array", () => {
    expect(parseStrictJson('{"list":[{"k":1,"k":2}]}')).toBeInstanceOf(ProtocolError)
  })

  test("rejects an unsafe-integer JSON number token", () => {
    const result = parseStrictJson('{"id":9007199254740992}')
    expect(result).toBeInstanceOf(ProtocolError)
    if (result instanceof ProtocolError) expect(result.reason).toContain("unsafe")
  })

  test("rejects an unsafe integer nested in an array", () => {
    expect(parseStrictJson("[1,2,90071992547409931]")).toBeInstanceOf(ProtocolError)
  })

  test("rejects a number token that parses to Infinity", () => {
    const result = parseStrictJson('{"n":1e999}')
    expect(result).toBeInstanceOf(ProtocolError)
    if (result instanceof ProtocolError) expect(result.reason).toContain("non-finite")
  })

  test("rejects an unsafe integer written in exponent form", () => {
    // 1e20 = 100000000000000000000 is an integer value beyond the safe range.
    expect(parseStrictJson('{"n":1e20}')).toBeInstanceOf(ProtocolError)
  })

  test("accepts the largest safe integer", () => {
    expect(parseStrictJson('{"n":9007199254740991}')).toEqual({ n: 9007199254740991 })
  })

  test("accepts floats and exponents, not flagged as unsafe integers", () => {
    expect(parseStrictJson('{"x":1.5,"y":1e3}')).toEqual({ x: 1.5, y: 1000 })
  })

  test("does not treat a colon or brace inside a string as structure", () => {
    expect(parseStrictJson('{"a":"b:{}c","a2":1}')).toEqual({ a: "b:{}c", a2: 1 })
  })

  test("does not flag a big number that appears inside a string", () => {
    expect(parseStrictJson('{"id":"9007199254740992"}')).toEqual({
      id: "9007199254740992",
    })
  })
})

describe("decodeJsonPayload", () => {
  test("chains utf-8 + strict json", () => {
    expect(decodeJsonPayload(utf8('{"k":1}'))).toEqual({ k: 1 })
  })

  test("propagates a utf-8 error", () => {
    expect(decodeJsonPayload(new Uint8Array([0xff]))).toBeInstanceOf(ProtocolError)
  })

  test("propagates a strict-json error", () => {
    expect(decodeJsonPayload(utf8('{"a":1,"a":2}'))).toBeInstanceOf(ProtocolError)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/host/protocol`
Expected: FAIL — cannot resolve `./errors` / `./strict-json`.

- [ ] **Step 3: Write the implementation**

`src/host/protocol/model/errors.ts`:

```ts
import * as errore from "errore"

/**
 * Stable diagnostic codes for host-protocol violations (host-supervision §12).
 * 2A only ever produces MALFORMED_PROTOCOL, OVERSIZED_MESSAGE, and
 * FRAME_TOO_LARGE; the negotiation-outcome codes exist so the supervisor (2D)
 * reuses this one error type when it decides a handshake failed.
 */
export type ProtocolViolationCode =
  | "MALFORMED_PROTOCOL"
  | "OVERSIZED_MESSAGE"
  | "FRAME_TOO_LARGE"
  | "PROTOCOL_NEGOTIATION_FAILED"
  | "RUNTIME_INTEGRITY_MISMATCH"
  | "KIT_API_MISMATCH"

/**
 * A host-protocol schema violation. Fatal for the incarnation that produced it:
 * the protocol never resynchronizes after malformed input (§5). Distinct from
 * `infrastructure/framing`'s `FramingError`, which covers the byte-frame layer.
 */
export class ProtocolError extends errore.createTaggedError({
  name: "ProtocolError",
  message: "Protocol violation [$code]: $reason",
}) {}
```

`src/host/protocol/model/strict-json.ts`:

```ts
import * as errore from "errore"

import { ProtocolError } from "./errors"

/** A structurally-valid JSON value produced by the strict decoder. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true })

/** §5: invalid UTF-8 is a protocol violation. A non-streaming decode resets each call. */
export function decodeUtf8(bytes: Uint8Array): ProtocolError | string {
  // errore.try's custom-catch overload takes an OPTIONS OBJECT { try, catch } in
  // this installed version (^0.14.1) — not positional args. The catch callback is
  // typed (e: Error).
  return errore.try({
    try: () => UTF8_DECODER.decode(bytes),
    catch: (cause) =>
      new ProtocolError({
        code: "MALFORMED_PROTOCOL",
        reason: "payload is not valid UTF-8",
        cause,
      }),
  })
}

/**
 * Structurally parse JSON, then enforce the §5 rules `JSON.parse` cannot:
 * duplicate object keys, non-finite results (e.g. `1e999` parses to `Infinity`),
 * and unsafe-integer number tokens. `JSON.parse` rejects malformed input and the
 * bare `NaN`/`Infinity` literals, but not a finite-looking token like `1e999`.
 */
export function parseStrictJson(text: string): ProtocolError | JsonValue {
  const parsed = errore.try({
    try: () => JSON.parse(text) as JsonValue,
    catch: (cause) =>
      new ProtocolError({
        code: "MALFORMED_PROTOCOL",
        reason: "payload is not valid JSON",
        cause,
      }),
  })
  if (parsed instanceof ProtocolError) return parsed

  const violation = scanStrictJson(text)
  if (violation instanceof ProtocolError) return violation

  return parsed
}

/** Convenience: UTF-8 decode then strict JSON parse. */
export function decodeJsonPayload(bytes: Uint8Array): ProtocolError | JsonValue {
  const text = decodeUtf8(bytes)
  if (text instanceof ProtocolError) return text
  return parseStrictJson(text)
}

// The scanner assumes `text` is already valid JSON (JSON.parse accepted it), so
// it never has to recover from malformed structure — it only walks tokens and
// flags duplicate keys and unsafe-integer number tokens. `JSON.parse` decodes
// key string tokens so escaped and literal spellings of the same key collide.
function scanStrictJson(text: string): ProtocolError | null {
  const objectKeys: Set<string>[] = []
  const contexts: ("object" | "array")[] = []
  let expectingKey = false
  let pos = 0
  const length = text.length

  while (pos < length) {
    const ch = text.charAt(pos)
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      pos += 1
      continue
    }
    if (ch === "{") {
      contexts.push("object")
      objectKeys.push(new Set())
      expectingKey = true
      pos += 1
      continue
    }
    if (ch === "}") {
      contexts.pop()
      objectKeys.pop()
      expectingKey = false
      pos += 1
      continue
    }
    if (ch === "[") {
      contexts.push("array")
      expectingKey = false
      pos += 1
      continue
    }
    if (ch === "]") {
      contexts.pop()
      pos += 1
      continue
    }
    if (ch === ":") {
      expectingKey = false
      pos += 1
      continue
    }
    if (ch === ",") {
      expectingKey = contexts[contexts.length - 1] === "object"
      pos += 1
      continue
    }
    if (ch === '"') {
      const end = scanStringEnd(text, pos)
      if (expectingKey && contexts[contexts.length - 1] === "object") {
        const key = JSON.parse(text.slice(pos, end)) as string
        const keys = objectKeys[objectKeys.length - 1]
        if (keys) {
          if (keys.has(key)) {
            return new ProtocolError({
              code: "MALFORMED_PROTOCOL",
              reason: `duplicate object key ${JSON.stringify(key)}`,
            })
          }
          keys.add(key)
        }
        expectingKey = false
      }
      pos = end
      continue
    }
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      const end = scanNumberEnd(text, pos)
      const violation = checkNumberToken(text.slice(pos, end))
      if (violation instanceof ProtocolError) return violation
      pos = end
      continue
    }
    // true / false / null — advance one letter at a time; structure is already valid.
    pos += 1
  }
  return null
}

function scanStringEnd(text: string, start: number): number {
  let pos = start + 1
  while (pos < text.length) {
    const ch = text.charAt(pos)
    if (ch === "\\") {
      pos += 2
      continue
    }
    if (ch === '"') return pos + 1
    pos += 1
  }
  return pos
}

function scanNumberEnd(text: string, start: number): number {
  let pos = start
  while (pos < text.length) {
    const ch = text.charAt(pos)
    const isNumberChar =
      (ch >= "0" && ch <= "9") ||
      ch === "-" ||
      ch === "+" ||
      ch === "." ||
      ch === "e" ||
      ch === "E"
    if (!isNumberChar) break
    pos += 1
  }
  return pos
}

function checkNumberToken(token: string): ProtocolError | null {
  // §5: reject non-finite numbers and unsafe-integer JSON numbers. JSON.parse
  // rejects the bare NaN/Infinity literals but still parses "1e999" to Infinity
  // and "1e20" to an unsafe integer value, so exponent/float tokens must be
  // inspected too — a nested `body` number is not otherwise range-checked here.
  const value = Number(token)
  if (!Number.isFinite(value)) {
    return new ProtocolError({
      code: "MALFORMED_PROTOCOL",
      reason: `non-finite JSON number ${token}`,
    })
  }
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
    return new ProtocolError({
      code: "MALFORMED_PROTOCOL",
      reason: `unsafe integer JSON number ${token}`,
    })
  }
  return null
}
```

`src/host/protocol/index.ts`:

```ts
export { ProtocolError } from "./model/errors"
export type { ProtocolViolationCode } from "./model/errors"
export { decodeJsonPayload, decodeUtf8, parseStrictJson } from "./model/strict-json"
export type { JsonValue } from "./model/strict-json"
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test src/host/protocol && bun x tsc --noEmit`
Expected: PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/host/protocol
git commit -m "feat: add host-protocol strict JSON decode with §5 closed-schema guards

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: shape guards + all DTO types + bundle/limits validators

**Files:**
- Create: `src/host/types.ts`
- Create: `src/host/index.ts`
- Create: `src/host/protocol/types.ts`
- Create: `src/host/protocol/model/shape.ts`
- Create: `src/host/protocol/model/bundle.ts`
- Create: `src/host/protocol/model/bundle.test.ts`
- Modify: `src/host/protocol/index.ts`

**Interfaces:**
- Consumes: Task 1 (`JsonValue`, `ProtocolError`), `infrastructure/framing`
  (`CONTROL_PAYLOAD_LIMIT_BYTES`, `DATA_PAYLOAD_LIMIT_BYTES`).
- Produces:
  - `HostMode`, `InteractionMode` (in `host/types.ts`).
  - The full protocol DTO type surface (in `host/protocol/types.ts`):
    `RuntimeDeclarationBundleV1`, `PublicLimits`, `ClientHelloV1`, `HostHelloV1`,
    `ControlEnvelope`, `Color`, `StyledRun`, `FrameIdentity`, `FrameEnvelope`.
    Tasks 3–5 consume these types; their validators land there.
  - Shape guards over `JsonValue | undefined` (in `model/shape.ts`): `asObject`,
    `asArray`, `asString`, `expectExactKeys`, `isPositiveSafeInteger`,
    `isSortedUniqueNumbers`, `isSortedUniqueStrings`, `isBoundedAscii`,
    `isDecimalUint64String`, `isLowercaseHex`.
  - `PROTOCOL_HARD_LIMITS`, `validateRuntimeDeclarationBundle`,
    `validatePublicLimits` (in `model/bundle.ts`).

- [ ] **Step 1: Write the failing test**

`src/host/protocol/model/bundle.test.ts`:

```ts
import { describe, expect, test } from "bun:test"

import { validatePublicLimits, validateRuntimeDeclarationBundle } from "./bundle"
import { ProtocolError } from "./errors"
import type { JsonValue } from "./strict-json"

const bundle: JsonValue = {
  module: "@termcraft/runtime",
  currentKitApiVersion: 1,
  supportedKitApiVersions: [1],
  publicCapabilityIds: ["nav", "theme:dark-default"],
}

const limits: JsonValue = {
  controlPayloadBytes: 262144,
  framePayloadBytes: 16777216,
  maxFrameWidth: 2048,
  maxFrameHeight: 2048,
  maxFrameCells: 262144,
}

describe("validateRuntimeDeclarationBundle", () => {
  test("accepts a canonical bundle", () => {
    expect(validateRuntimeDeclarationBundle(bundle)).toEqual({
      module: "@termcraft/runtime",
      currentKitApiVersion: 1,
      supportedKitApiVersions: [1],
      publicCapabilityIds: ["nav", "theme:dark-default"],
    })
  })

  test("rejects a wrong module literal", () => {
    expect(
      validateRuntimeDeclarationBundle({ ...bundle, module: "@other/x" }),
    ).toBeInstanceOf(ProtocolError)
  })

  test("rejects an unknown field", () => {
    expect(
      validateRuntimeDeclarationBundle({ ...bundle, extra: 1 }),
    ).toBeInstanceOf(ProtocolError)
  })

  test("rejects a missing field", () => {
    const { publicCapabilityIds: _omit, ...rest } = bundle as Record<string, JsonValue>
    expect(validateRuntimeDeclarationBundle(rest)).toBeInstanceOf(ProtocolError)
  })

  test("rejects a supported set that omits the current version", () => {
    expect(
      validateRuntimeDeclarationBundle({
        ...bundle,
        currentKitApiVersion: 2,
        supportedKitApiVersions: [1],
      }),
    ).toBeInstanceOf(ProtocolError)
  })

  test("rejects an unsorted supported set", () => {
    expect(
      validateRuntimeDeclarationBundle({
        ...bundle,
        currentKitApiVersion: 2,
        supportedKitApiVersions: [2, 1],
      }),
    ).toBeInstanceOf(ProtocolError)
  })

  test("rejects a duplicate in the supported set", () => {
    expect(
      validateRuntimeDeclarationBundle({ ...bundle, supportedKitApiVersions: [1, 1] }),
    ).toBeInstanceOf(ProtocolError)
  })

  test("rejects a non-positive kit version", () => {
    expect(
      validateRuntimeDeclarationBundle({
        ...bundle,
        currentKitApiVersion: 0,
        supportedKitApiVersions: [0],
      }),
    ).toBeInstanceOf(ProtocolError)
  })

  test("rejects unsorted capability ids", () => {
    expect(
      validateRuntimeDeclarationBundle({
        ...bundle,
        publicCapabilityIds: ["theme:dark-default", "nav"],
      }),
    ).toBeInstanceOf(ProtocolError)
  })

  test("rejects an empty capability id", () => {
    expect(
      validateRuntimeDeclarationBundle({ ...bundle, publicCapabilityIds: [""] }),
    ).toBeInstanceOf(ProtocolError)
  })
})

describe("validatePublicLimits", () => {
  test("accepts limits at exactly the hard caps", () => {
    expect(validatePublicLimits(limits)).toEqual({
      controlPayloadBytes: 262144,
      framePayloadBytes: 16777216,
      maxFrameWidth: 2048,
      maxFrameHeight: 2048,
      maxFrameCells: 262144,
    })
  })

  test("rejects a control cap above the protocol hard limit", () => {
    expect(
      validatePublicLimits({ ...limits, controlPayloadBytes: 262145 }),
    ).toBeInstanceOf(ProtocolError)
  })

  test("rejects a non-positive dimension", () => {
    expect(validatePublicLimits({ ...limits, maxFrameWidth: 0 })).toBeInstanceOf(
      ProtocolError,
    )
  })

  test("rejects a non-integer field", () => {
    expect(validatePublicLimits({ ...limits, maxFrameCells: 1.5 })).toBeInstanceOf(
      ProtocolError,
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/host/protocol/model/bundle.test.ts`
Expected: FAIL — cannot resolve `./bundle`.

- [ ] **Step 3: Write the implementation**

`src/host/types.ts`:

```ts
/** The four supervised host modes (host-supervision §3.1). */
export type HostMode = "preview" | "historical" | "smoke" | "export"

/** Effective interaction mode of a mounted host (host-supervision §3.1). */
export type InteractionMode = "static" | "interactive"
```

`src/host/index.ts` (the `host/` module root public entry; grows as the
`render`/`session`/`supervisor` submodules land — `protocol/` stays an internal
detail until a consumer needs its codecs directly):

```ts
export type { HostMode, InteractionMode } from "./types"
```

`src/host/protocol/types.ts`:

```ts
import type { HostMode } from "../types"
import type { JsonValue } from "./model/strict-json"

/**
 * The public runtime declaration exchanged before host mount (runtime-api §7.1,
 * host-supervision §5.1). Both arrays are sorted, duplicate-free canonical JSON
 * arrays. Private Reatom/React/OpenTUI identities never appear.
 */
export interface RuntimeDeclarationBundleV1 {
  readonly module: "@termcraft/runtime"
  readonly currentKitApiVersion: number
  readonly supportedKitApiVersions: number[]
  readonly publicCapabilityIds: string[]
}

/** Negotiable protocol limits carried in each hello (host-supervision §5.1). */
export interface PublicLimits {
  readonly controlPayloadBytes: number
  readonly framePayloadBytes: number
  readonly maxFrameWidth: number
  readonly maxFrameHeight: number
  readonly maxFrameCells: number
}

/**
 * Pre-handshake client hello (host-supervision §5.1). Control-class, sent once by
 * the supervisor. Not a `ControlEnvelope`; outer framing version and this
 * `framingVersion` are both `1`.
 */
export interface ClientHelloV1 {
  readonly framingVersion: 1
  readonly kind: "client.hello"
  readonly sessionId: string
  readonly nonce: string
  readonly offeredFramingVersions: [1]
  readonly offeredProtocolVersions: [1]
  readonly mode: HostMode
  readonly pageSlug: string
  readonly sourceHash: string
  readonly sourceKitApiVersion: number
  readonly runtimeDeclaration: RuntimeDeclarationBundleV1
  readonly limits: PublicLimits
}

/** Pre-handshake host hello (host-supervision §5.1). Control-class. */
export interface HostHelloV1 {
  readonly framingVersion: 1
  readonly kind: "host.hello"
  readonly sessionId: string
  readonly nonce: string
  readonly selectedFramingVersion: 1
  readonly selectedProtocolVersion: 1
  readonly runtimeDeclaration: RuntimeDeclarationBundleV1
  readonly limits: PublicLimits
}

/**
 * Post-handshake control envelope (host-supervision §5.2). `messageId` is a
 * monotonic unsigned-64-bit decimal string per `(sender, nonce)` from "1"; a
 * request carries a fresh `requestId`; exactly one terminal response carries
 * `responseTo`. The per-`kind` shape of `body` is validated by 2C/2D.
 */
export interface ControlEnvelope {
  readonly protocolVersion: 1
  readonly kind: string
  readonly sessionId: string
  readonly nonce: string
  readonly messageId: string
  readonly requestId?: string
  readonly responseTo?: string
  readonly body: { readonly [key: string]: JsonValue }
}

/** A run of consecutive cells sharing one style (host-supervision §5.3). */
export type Color =
  | "default"
  | { readonly indexed: number }
  | { readonly rgb: `#${string}` }

export interface StyledRun {
  readonly text: string
  readonly fg: Color
  readonly bg: Color
  /** Bitmask: 1 bold, 2 dim, 4 italic, 8 underline, 16 inverse, 32 strikethrough. */
  readonly attrs: number
}

/** Identity of a sealed frame (host-supervision §5.3). */
export interface FrameIdentity {
  readonly sessionId: string
  readonly nonce: string
  readonly sourceHash: string
  readonly frameSeq: string
}

/** A complete protocol-v1 preview frame (host-supervision §5.3), frame/bulk class. */
export interface FrameEnvelope extends FrameIdentity {
  readonly protocolVersion: 1
  readonly kind: "frame"
  readonly width: number
  readonly height: number
  readonly rows: StyledRun[][]
}
```

`src/host/protocol/model/shape.ts`:

```ts
import { ProtocolError } from "./errors"
import type { JsonValue } from "./strict-json"

// Field access on a `{ [k]: JsonValue }` object yields `JsonValue | undefined`
// under noUncheckedIndexedAccess, so every guard accepts the widened input.
type MaybeJson = JsonValue | undefined

const malformed = (reason: string) =>
  new ProtocolError({ code: "MALFORMED_PROTOCOL", reason })

/** Narrow to a plain object (not null, not an array). */
export function asObject(
  value: MaybeJson,
  label: string,
): ProtocolError | { [key: string]: JsonValue } {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return malformed(`${label} must be a JSON object`)
  }
  return value
}

/** Narrow to an array. */
export function asArray(value: MaybeJson, label: string): ProtocolError | JsonValue[] {
  if (!Array.isArray(value)) return malformed(`${label} must be a JSON array`)
  return value
}

/** Narrow to a non-empty string within `maxLength`. */
export function asString(
  value: MaybeJson,
  label: string,
  maxLength: number,
): ProtocolError | string {
  if (typeof value !== "string") return malformed(`${label} must be a string`)
  if (value.length === 0) return malformed(`${label} must not be empty`)
  if (value.length > maxLength) return malformed(`${label} exceeds ${maxLength} characters`)
  return value
}

/** Reject unknown keys and missing required keys; optional keys may be absent. */
export function expectExactKeys(
  object: { [key: string]: JsonValue },
  required: readonly string[],
  optional: readonly string[] = [],
): ProtocolError | null {
  const allowed = new Set<string>([...required, ...optional])
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) return malformed(`unexpected field ${JSON.stringify(key)}`)
  }
  for (const key of required) {
    if (!(key in object)) return malformed(`missing required field ${JSON.stringify(key)}`)
  }
  return null
}

export function isPositiveSafeInteger(value: MaybeJson): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

export function isSortedUniqueNumbers(values: readonly number[]): boolean {
  return values.every((value, index) => index === 0 || value > (values[index - 1] ?? value))
}

export function isSortedUniqueStrings(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || value > (values[index - 1] ?? value))
}

/** Non-empty printable-ASCII string within `maxLength` (§7.1 capability ids). */
export function isBoundedAscii(value: MaybeJson, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    /^[\x21-\x7e]+$/.test(value)
  )
}

const MAX_UINT64_DECIMAL = "18446744073709551615"

/** A decimal string for an unsigned integer ≥ 1, bounded to 64 bits. */
export function isDecimalUint64String(value: MaybeJson): value is string {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return false
  if (value.length > MAX_UINT64_DECIMAL.length) return false
  if (value.length === MAX_UINT64_DECIMAL.length && value > MAX_UINT64_DECIMAL) return false
  return true
}

/** Exactly `length` lowercase hexadecimal characters. */
export function isLowercaseHex(value: MaybeJson, length: number): value is string {
  return typeof value === "string" && new RegExp(`^[0-9a-f]{${length}}$`).test(value)
}
```

`src/host/protocol/model/bundle.ts`:

```ts
import {
  CONTROL_PAYLOAD_LIMIT_BYTES,
  DATA_PAYLOAD_LIMIT_BYTES,
} from "../../../infrastructure/framing"
import type { PublicLimits, RuntimeDeclarationBundleV1 } from "../types"
import { ProtocolError } from "./errors"
import {
  asArray,
  asObject,
  expectExactKeys,
  isBoundedAscii,
  isPositiveSafeInteger,
  isSortedUniqueNumbers,
  isSortedUniqueStrings,
} from "./shape"
import type { JsonValue } from "./strict-json"

/** The protocol hard caps (§5). Client/host limits may be no larger. */
export const PROTOCOL_HARD_LIMITS: PublicLimits = {
  controlPayloadBytes: CONTROL_PAYLOAD_LIMIT_BYTES,
  framePayloadBytes: DATA_PAYLOAD_LIMIT_BYTES,
  maxFrameWidth: 2048,
  maxFrameHeight: 2048,
  maxFrameCells: 262144,
}

const CAPABILITY_ID_MAX = 128

const malformed = (reason: string) =>
  new ProtocolError({ code: "MALFORMED_PROTOCOL", reason })

export function validateRuntimeDeclarationBundle(
  value: JsonValue,
): ProtocolError | RuntimeDeclarationBundleV1 {
  const object = asObject(value, "runtimeDeclaration")
  if (object instanceof ProtocolError) return object

  const keyError = expectExactKeys(object, [
    "module",
    "currentKitApiVersion",
    "supportedKitApiVersions",
    "publicCapabilityIds",
  ])
  if (keyError instanceof ProtocolError) return keyError

  if (object.module !== "@termcraft/runtime") {
    return malformed('runtimeDeclaration.module must be "@termcraft/runtime"')
  }
  if (!isPositiveSafeInteger(object.currentKitApiVersion)) {
    return malformed("currentKitApiVersion must be a positive safe integer")
  }

  const supported = asArray(object.supportedKitApiVersions, "supportedKitApiVersions")
  if (supported instanceof ProtocolError) return supported
  if (!supported.every(isPositiveSafeInteger)) {
    return malformed("supportedKitApiVersions must be positive safe integers")
  }
  if (!isSortedUniqueNumbers(supported)) {
    return malformed("supportedKitApiVersions must be sorted and duplicate-free")
  }
  if (!supported.includes(object.currentKitApiVersion)) {
    return malformed("supportedKitApiVersions must contain currentKitApiVersion")
  }

  const capabilities = asArray(object.publicCapabilityIds, "publicCapabilityIds")
  if (capabilities instanceof ProtocolError) return capabilities
  if (!capabilities.every((id) => isBoundedAscii(id, CAPABILITY_ID_MAX))) {
    return malformed("publicCapabilityIds must be non-empty bounded ASCII strings")
  }
  if (!isSortedUniqueStrings(capabilities)) {
    return malformed("publicCapabilityIds must be sorted and duplicate-free")
  }

  return {
    module: "@termcraft/runtime",
    currentKitApiVersion: object.currentKitApiVersion,
    supportedKitApiVersions: supported,
    publicCapabilityIds: capabilities,
  }
}

export function validatePublicLimits(value: JsonValue): ProtocolError | PublicLimits {
  const object = asObject(value, "limits")
  if (object instanceof ProtocolError) return object

  const fields = [
    "controlPayloadBytes",
    "framePayloadBytes",
    "maxFrameWidth",
    "maxFrameHeight",
    "maxFrameCells",
  ] as const

  const keyError = expectExactKeys(object, fields)
  if (keyError instanceof ProtocolError) return keyError

  for (const field of fields) {
    const raw = object[field]
    if (!isPositiveSafeInteger(raw)) {
      return malformed(`${field} must be a positive safe integer`)
    }
    if (raw > PROTOCOL_HARD_LIMITS[field]) {
      return malformed(`${field} exceeds the protocol hard limit`)
    }
  }

  return {
    controlPayloadBytes: object.controlPayloadBytes as number,
    framePayloadBytes: object.framePayloadBytes as number,
    maxFrameWidth: object.maxFrameWidth as number,
    maxFrameHeight: object.maxFrameHeight as number,
    maxFrameCells: object.maxFrameCells as number,
  }
}
```

> Note: after `if (!supported.every(isPositiveSafeInteger))` and
> `capabilities.every(...)`, TypeScript narrows `supported` to `number[]` and (via
> the `as string[]` assumption in the return) `capabilities` to strings. If a `as`
> is needed on the return to satisfy tsc — `supportedKitApiVersions: supported as
> number[]`, `publicCapabilityIds: capabilities as string[]` — add it; the values
> are already proven. In `validatePublicLimits`, `raw` is narrowed to `number`
> inside the loop by the `isPositiveSafeInteger` guard, so `raw >
> PROTOCOL_HARD_LIMITS[field]` typechecks.

Append to `src/host/protocol/index.ts`:

```ts
export type {
  ClientHelloV1,
  Color,
  ControlEnvelope,
  FrameEnvelope,
  FrameIdentity,
  HostHelloV1,
  PublicLimits,
  RuntimeDeclarationBundleV1,
  StyledRun,
} from "./types"
export {
  PROTOCOL_HARD_LIMITS,
  validatePublicLimits,
  validateRuntimeDeclarationBundle,
} from "./model/bundle"
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test src/host/protocol && bun x tsc --noEmit`
Expected: PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/host
git commit -m "feat: add host DTO types + runtime-declaration/limits validators (§5.1, §7.1)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: `ClientHelloV1` / `HostHelloV1` handshake codec

**Files:**
- Create: `src/host/protocol/model/hello.ts`
- Create: `src/host/protocol/model/hello.test.ts`
- Modify: `src/host/protocol/index.ts`

**Interfaces:**
- Consumes: Task 1 (`decodeJsonPayload`), Task 2 (types, shape guards,
  `validateRuntimeDeclarationBundle`, `validatePublicLimits`),
  `infrastructure/framing` (`encodeFrame`).
- Produces: `encodeClientHello(hello: ClientHelloV1): ProtocolError | Uint8Array`,
  `decodeClientHello(payload: Uint8Array): ProtocolError | ClientHelloV1`,
  `encodeHostHello`, `decodeHostHello`. 2D's supervisor sends `client.hello` and
  decodes `host.hello`; 2C's host does the reverse.

- [ ] **Step 1: Write the failing test**

`src/host/protocol/model/hello.test.ts`:

```ts
import { describe, expect, test } from "bun:test"

import { FrameDecoder } from "../../../infrastructure/framing"
import { ProtocolError } from "./errors"
import {
  decodeClientHello,
  decodeHostHello,
  encodeClientHello,
  encodeHostHello,
} from "./hello"
import type { ClientHelloV1, HostHelloV1 } from "../types"

const runtimeDeclaration = {
  module: "@termcraft/runtime",
  currentKitApiVersion: 1,
  supportedKitApiVersions: [1],
  publicCapabilityIds: ["nav"],
} as const

const limits = {
  controlPayloadBytes: 262144,
  framePayloadBytes: 16777216,
  maxFrameWidth: 2048,
  maxFrameHeight: 2048,
  maxFrameCells: 262144,
} as const

const clientHello: ClientHelloV1 = {
  framingVersion: 1,
  kind: "client.hello",
  sessionId: "0198b1c2-0000-7000-8000-000000000000",
  nonce: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
  offeredFramingVersions: [1],
  offeredProtocolVersions: [1],
  mode: "preview",
  pageSlug: "dashboard",
  sourceHash: "a".repeat(64),
  sourceKitApiVersion: 1,
  runtimeDeclaration: { ...runtimeDeclaration, supportedKitApiVersions: [1], publicCapabilityIds: ["nav"] },
  limits: { ...limits },
}

const hostHello: HostHelloV1 = {
  framingVersion: 1,
  kind: "host.hello",
  sessionId: "0198b1c2-0000-7000-8000-000000000000",
  nonce: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
  selectedFramingVersion: 1,
  selectedProtocolVersion: 1,
  runtimeDeclaration: { ...runtimeDeclaration, supportedKitApiVersions: [1], publicCapabilityIds: ["nav"] },
  limits: { ...limits },
}

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))

function controlPayload(encoded: Uint8Array): Uint8Array {
  const frames = new FrameDecoder().feed(encoded)
  if (frames instanceof Error) throw frames
  const frame = frames[0]
  if (!frame) throw new Error("no frame decoded")
  expect(frame.messageClass).toBe("control")
  return frame.payload
}

describe("client hello", () => {
  test("round-trips through the framing layer", () => {
    const encoded = encodeClientHello(clientHello)
    if (encoded instanceof Error) throw encoded
    expect(decodeClientHello(controlPayload(encoded))).toEqual(clientHello)
  })

  test("rejects a wrong framingVersion literal", () => {
    expect(decodeClientHello(encode({ ...clientHello, framingVersion: 2 }))).toBeInstanceOf(ProtocolError)
  })

  test("rejects a wrong kind", () => {
    expect(decodeClientHello(encode({ ...clientHello, kind: "host.hello" }))).toBeInstanceOf(ProtocolError)
  })

  test("rejects a non-[1] offered array", () => {
    expect(decodeClientHello(encode({ ...clientHello, offeredProtocolVersions: [1, 2] }))).toBeInstanceOf(ProtocolError)
  })

  test("rejects an unknown mode", () => {
    expect(decodeClientHello(encode({ ...clientHello, mode: "weird" }))).toBeInstanceOf(ProtocolError)
  })

  test("rejects a malformed nonce", () => {
    expect(decodeClientHello(encode({ ...clientHello, nonce: "SHORT" }))).toBeInstanceOf(ProtocolError)
  })

  test("rejects a source hash of the wrong length", () => {
    expect(decodeClientHello(encode({ ...clientHello, sourceHash: "abc" }))).toBeInstanceOf(ProtocolError)
  })

  test("rejects an unknown field", () => {
    expect(decodeClientHello(encode({ ...clientHello, extra: true }))).toBeInstanceOf(ProtocolError)
  })
})

describe("host hello", () => {
  test("round-trips through the framing layer", () => {
    const encoded = encodeHostHello(hostHello)
    if (encoded instanceof Error) throw encoded
    expect(decodeHostHello(controlPayload(encoded))).toEqual(hostHello)
  })

  test("rejects a wrong selected framing version", () => {
    expect(decodeHostHello(encode({ ...hostHello, selectedFramingVersion: 2 }))).toBeInstanceOf(ProtocolError)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/host/protocol/model/hello.test.ts`
Expected: FAIL — cannot resolve `./hello`.

- [ ] **Step 3: Write the implementation**

`src/host/protocol/model/hello.ts`:

```ts
import { encodeFrame } from "../../../infrastructure/framing"
import type { HostMode } from "../../types"
import type {
  ClientHelloV1,
  HostHelloV1,
  PublicLimits,
  RuntimeDeclarationBundleV1,
} from "../types"
import { validatePublicLimits, validateRuntimeDeclarationBundle } from "./bundle"
import { ProtocolError } from "./errors"
import {
  asObject,
  asString,
  expectExactKeys,
  isLowercaseHex,
  isPositiveSafeInteger,
} from "./shape"
import { decodeJsonPayload } from "./strict-json"
import type { JsonValue } from "./strict-json"

const HOST_MODES = new Set<HostMode>(["preview", "historical", "smoke", "export"])
const NONCE_HEX_LENGTH = 32
const SOURCE_HASH_HEX_LENGTH = 64
const SESSION_ID_MAX = 64
const PAGE_SLUG_MAX = 32

const malformed = (reason: string) =>
  new ProtocolError({ code: "MALFORMED_PROTOCOL", reason })

function encodeControlPayload(value: object): ProtocolError | Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(value))
  const framed = encodeFrame({ messageClass: "control", payload })
  if (framed instanceof Error) {
    return new ProtocolError({
      code: "OVERSIZED_MESSAGE",
      reason: "control payload exceeds the framing limit",
      cause: framed,
    })
  }
  return framed
}

interface SharedIdentity {
  readonly sessionId: string
  readonly nonce: string
  readonly runtimeDeclaration: RuntimeDeclarationBundleV1
  readonly limits: PublicLimits
}

// Identity + bundle/limits validation shared by both hellos.
function readIdentity(object: { [key: string]: JsonValue }): ProtocolError | SharedIdentity {
  const sessionId = asString(object.sessionId, "sessionId", SESSION_ID_MAX)
  if (sessionId instanceof ProtocolError) return sessionId
  if (!isLowercaseHex(object.nonce, NONCE_HEX_LENGTH)) {
    return malformed("nonce must be 32 lowercase hex characters")
  }
  const runtimeDeclaration = validateRuntimeDeclarationBundle(object.runtimeDeclaration ?? null)
  if (runtimeDeclaration instanceof ProtocolError) return runtimeDeclaration
  const limits = validatePublicLimits(object.limits ?? null)
  if (limits instanceof ProtocolError) return limits
  return { sessionId, nonce: object.nonce, runtimeDeclaration, limits }
}

export function encodeClientHello(hello: ClientHelloV1): ProtocolError | Uint8Array {
  return encodeControlPayload(hello)
}

export function decodeClientHello(payload: Uint8Array): ProtocolError | ClientHelloV1 {
  const value = decodeJsonPayload(payload)
  if (value instanceof ProtocolError) return value
  const object = asObject(value, "client.hello")
  if (object instanceof ProtocolError) return object

  const keyError = expectExactKeys(object, [
    "framingVersion",
    "kind",
    "sessionId",
    "nonce",
    "offeredFramingVersions",
    "offeredProtocolVersions",
    "mode",
    "pageSlug",
    "sourceHash",
    "sourceKitApiVersion",
    "runtimeDeclaration",
    "limits",
  ])
  if (keyError instanceof ProtocolError) return keyError

  if (object.framingVersion !== 1) return malformed("framingVersion must be 1")
  if (object.kind !== "client.hello") return malformed('kind must be "client.hello"')
  if (!isOneArray(object.offeredFramingVersions)) {
    return malformed("offeredFramingVersions must be [1]")
  }
  if (!isOneArray(object.offeredProtocolVersions)) {
    return malformed("offeredProtocolVersions must be [1]")
  }
  if (typeof object.mode !== "string" || !HOST_MODES.has(object.mode as HostMode)) {
    return malformed("mode must be a valid host mode")
  }
  const pageSlug = asString(object.pageSlug, "pageSlug", PAGE_SLUG_MAX)
  if (pageSlug instanceof ProtocolError) return pageSlug
  if (!isLowercaseHex(object.sourceHash, SOURCE_HASH_HEX_LENGTH)) {
    return malformed("sourceHash must be 64 lowercase hex characters")
  }
  if (!isPositiveSafeInteger(object.sourceKitApiVersion)) {
    return malformed("sourceKitApiVersion must be a positive safe integer")
  }
  const identity = readIdentity(object)
  if (identity instanceof ProtocolError) return identity

  return {
    framingVersion: 1,
    kind: "client.hello",
    sessionId: identity.sessionId,
    nonce: identity.nonce,
    offeredFramingVersions: [1],
    offeredProtocolVersions: [1],
    mode: object.mode as HostMode,
    pageSlug,
    sourceHash: object.sourceHash,
    sourceKitApiVersion: object.sourceKitApiVersion,
    runtimeDeclaration: identity.runtimeDeclaration,
    limits: identity.limits,
  }
}

export function encodeHostHello(hello: HostHelloV1): ProtocolError | Uint8Array {
  return encodeControlPayload(hello)
}

export function decodeHostHello(payload: Uint8Array): ProtocolError | HostHelloV1 {
  const value = decodeJsonPayload(payload)
  if (value instanceof ProtocolError) return value
  const object = asObject(value, "host.hello")
  if (object instanceof ProtocolError) return object

  const keyError = expectExactKeys(object, [
    "framingVersion",
    "kind",
    "sessionId",
    "nonce",
    "selectedFramingVersion",
    "selectedProtocolVersion",
    "runtimeDeclaration",
    "limits",
  ])
  if (keyError instanceof ProtocolError) return keyError

  if (object.framingVersion !== 1) return malformed("framingVersion must be 1")
  if (object.kind !== "host.hello") return malformed('kind must be "host.hello"')
  if (object.selectedFramingVersion !== 1) return malformed("selectedFramingVersion must be 1")
  if (object.selectedProtocolVersion !== 1) return malformed("selectedProtocolVersion must be 1")
  const identity = readIdentity(object)
  if (identity instanceof ProtocolError) return identity

  return {
    framingVersion: 1,
    kind: "host.hello",
    sessionId: identity.sessionId,
    nonce: identity.nonce,
    selectedFramingVersion: 1,
    selectedProtocolVersion: 1,
    runtimeDeclaration: identity.runtimeDeclaration,
    limits: identity.limits,
  }
}

function isOneArray(value: JsonValue | undefined): boolean {
  return Array.isArray(value) && value.length === 1 && value[0] === 1
}
```

> Note: `object.runtimeDeclaration ?? null` and `object.limits ?? null` coerce a
> missing field (`undefined`) to `null` so the Task-2 validators — typed
> `(value: JsonValue)` — accept it and reject it as a non-object. `expectExactKeys`
> already proved the keys are present, so this only satisfies the type checker.

Append to `src/host/protocol/index.ts`:

```ts
export {
  decodeClientHello,
  decodeHostHello,
  encodeClientHello,
  encodeHostHello,
} from "./model/hello"
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test src/host/protocol && bun x tsc --noEmit`
Expected: PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/host/protocol
git commit -m "feat: add host handshake hello codec — closed §5.1 DTOs over framing

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: `ControlEnvelope` codec

**Files:**
- Create: `src/host/protocol/model/control-envelope.ts`
- Create: `src/host/protocol/model/control-envelope.test.ts`
- Modify: `src/host/protocol/index.ts`

**Interfaces:**
- Consumes: Task 1 (`decodeJsonPayload`), Task 2 (`ControlEnvelope` type, shape
  guards), `infrastructure/framing` (`encodeFrame`).
- Produces: `encodeControlEnvelope(envelope: ControlEnvelope): ProtocolError |
  Uint8Array`, `decodeControlEnvelope(payload: Uint8Array): ProtocolError |
  ControlEnvelope`. 2C/2D wrap and unwrap every post-handshake control message
  with these; per-`kind` body validators sit on top in 2C/2D.

- [ ] **Step 1: Write the failing test**

`src/host/protocol/model/control-envelope.test.ts`:

```ts
import { describe, expect, test } from "bun:test"

import { FrameDecoder } from "../../../infrastructure/framing"
import { decodeControlEnvelope, encodeControlEnvelope } from "./control-envelope"
import { ProtocolError } from "./errors"
import type { ControlEnvelope } from "../types"

const base: ControlEnvelope = {
  protocolVersion: 1,
  kind: "ready",
  sessionId: "0198b1c2-0000-7000-8000-000000000000",
  nonce: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
  messageId: "1",
  body: { effectiveInteractionMode: "static" },
}

const request: ControlEnvelope = {
  ...base,
  kind: "query-hit",
  messageId: "7",
  requestId: "7",
  body: { x: 3, y: 4 },
}

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))

function controlPayload(encoded: Uint8Array): Uint8Array {
  const frames = new FrameDecoder().feed(encoded)
  if (frames instanceof Error) throw frames
  const frame = frames[0]
  if (!frame) throw new Error("no frame")
  expect(frame.messageClass).toBe("control")
  return frame.payload
}

describe("control envelope", () => {
  test("round-trips a minimal envelope", () => {
    const encoded = encodeControlEnvelope(base)
    if (encoded instanceof Error) throw encoded
    expect(decodeControlEnvelope(controlPayload(encoded))).toEqual(base)
  })

  test("round-trips an envelope with requestId", () => {
    const encoded = encodeControlEnvelope(request)
    if (encoded instanceof Error) throw encoded
    expect(decodeControlEnvelope(controlPayload(encoded))).toEqual(request)
  })

  test("rejects a wrong protocolVersion", () => {
    expect(decodeControlEnvelope(encode({ ...base, protocolVersion: 2 }))).toBeInstanceOf(ProtocolError)
  })

  test("rejects a messageId that is not a decimal uint string", () => {
    expect(decodeControlEnvelope(encode({ ...base, messageId: "01" }))).toBeInstanceOf(ProtocolError)
  })

  test("rejects a numeric messageId", () => {
    expect(decodeControlEnvelope(encode({ ...base, messageId: 1 }))).toBeInstanceOf(ProtocolError)
  })

  test("rejects a non-object body", () => {
    expect(decodeControlEnvelope(encode({ ...base, body: 5 }))).toBeInstanceOf(ProtocolError)
  })

  test("rejects an unknown field", () => {
    expect(decodeControlEnvelope(encode({ ...base, surprise: 1 }))).toBeInstanceOf(ProtocolError)
  })

  test("round-trips an envelope with responseTo", () => {
    const response: ControlEnvelope = { ...base, kind: "set-mode-result", messageId: "9", responseTo: "7", body: {} }
    const encoded = encodeControlEnvelope(response)
    if (encoded instanceof Error) throw encoded
    expect(decodeControlEnvelope(controlPayload(encoded))).toEqual(response)
  })

  test("rejects a bad requestId", () => {
    expect(decodeControlEnvelope(encode({ ...request, requestId: "0" }))).toBeInstanceOf(ProtocolError)
  })

  test("rejects a bad responseTo", () => {
    expect(decodeControlEnvelope(encode({ ...base, responseTo: "x" }))).toBeInstanceOf(ProtocolError)
  })

  test("maps an oversized control payload to OVERSIZED_MESSAGE", () => {
    const huge: ControlEnvelope = { ...base, body: { blob: "x".repeat(300_000) } }
    const result = encodeControlEnvelope(huge)
    expect(result).toBeInstanceOf(ProtocolError)
    if (result instanceof ProtocolError) expect(result.code).toBe("OVERSIZED_MESSAGE")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/host/protocol/model/control-envelope.test.ts`
Expected: FAIL — cannot resolve `./control-envelope`.

- [ ] **Step 3: Write the implementation**

`src/host/protocol/model/control-envelope.ts`:

```ts
import { encodeFrame } from "../../../infrastructure/framing"
import type { ControlEnvelope } from "../types"
import { ProtocolError } from "./errors"
import {
  asObject,
  asString,
  expectExactKeys,
  isDecimalUint64String,
  isLowercaseHex,
} from "./shape"
import { decodeJsonPayload } from "./strict-json"

const KIND_MAX = 64
const SESSION_ID_MAX = 64
const NONCE_HEX_LENGTH = 32

const malformed = (reason: string) =>
  new ProtocolError({ code: "MALFORMED_PROTOCOL", reason })

export function encodeControlEnvelope(
  envelope: ControlEnvelope,
): ProtocolError | Uint8Array {
  // Omit the optional id fields when absent so they never serialize as null.
  const wire: Record<string, unknown> = {
    protocolVersion: envelope.protocolVersion,
    kind: envelope.kind,
    sessionId: envelope.sessionId,
    nonce: envelope.nonce,
    messageId: envelope.messageId,
    body: envelope.body,
  }
  if (envelope.requestId !== undefined) wire.requestId = envelope.requestId
  if (envelope.responseTo !== undefined) wire.responseTo = envelope.responseTo

  const payload = new TextEncoder().encode(JSON.stringify(wire))
  const framed = encodeFrame({ messageClass: "control", payload })
  if (framed instanceof Error) {
    return new ProtocolError({
      code: "OVERSIZED_MESSAGE",
      reason: "control envelope exceeds the framing limit",
      cause: framed,
    })
  }
  return framed
}

export function decodeControlEnvelope(
  payload: Uint8Array,
): ProtocolError | ControlEnvelope {
  const value = decodeJsonPayload(payload)
  if (value instanceof ProtocolError) return value
  const object = asObject(value, "control envelope")
  if (object instanceof ProtocolError) return object

  const keyError = expectExactKeys(
    object,
    ["protocolVersion", "kind", "sessionId", "nonce", "messageId", "body"],
    ["requestId", "responseTo"],
  )
  if (keyError instanceof ProtocolError) return keyError

  if (object.protocolVersion !== 1) return malformed("protocolVersion must be 1")
  const kind = asString(object.kind, "kind", KIND_MAX)
  if (kind instanceof ProtocolError) return kind
  const sessionId = asString(object.sessionId, "sessionId", SESSION_ID_MAX)
  if (sessionId instanceof ProtocolError) return sessionId
  if (!isLowercaseHex(object.nonce, NONCE_HEX_LENGTH)) {
    return malformed("nonce must be 32 lowercase hex characters")
  }
  if (!isDecimalUint64String(object.messageId)) {
    return malformed("messageId must be a decimal uint64 string")
  }
  if ("requestId" in object && !isDecimalUint64String(object.requestId)) {
    return malformed("requestId must be a decimal uint64 string")
  }
  if ("responseTo" in object && !isDecimalUint64String(object.responseTo)) {
    return malformed("responseTo must be a decimal uint64 string")
  }
  const body = asObject(object.body, "body")
  if (body instanceof ProtocolError) return body

  return {
    protocolVersion: 1,
    kind,
    sessionId,
    nonce: object.nonce,
    messageId: object.messageId,
    ...("requestId" in object ? { requestId: object.requestId as string } : {}),
    ...("responseTo" in object ? { responseTo: object.responseTo as string } : {}),
    body,
  }
}
```

Append to `src/host/protocol/index.ts`:

```ts
export {
  decodeControlEnvelope,
  encodeControlEnvelope,
} from "./model/control-envelope"
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test src/host/protocol && bun x tsc --noEmit`
Expected: PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/host/protocol
git commit -m "feat: add post-handshake control-envelope codec with §5.2 id rules

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: `FrameEnvelope` / `StyledRun` / `Color` codec

**Files:**
- Create: `src/host/protocol/model/frame.ts`
- Create: `src/host/protocol/model/frame.test.ts`
- Modify: `src/host/protocol/index.ts`

**Interfaces:**
- Consumes: Task 1 (`decodeJsonPayload`, `JsonValue`), Task 2 (`Color`,
  `StyledRun`, `FrameEnvelope` types, shape guards), `infrastructure/framing`
  (`encodeFrame`).
- Produces: `FRAME_MAX_AXIS`, `FRAME_MAX_CELLS`, `FRAME_ATTR_MASK`;
  `encodeFrameEnvelope(frame: FrameEnvelope): ProtocolError | Uint8Array`,
  `decodeFrameEnvelope(payload: Uint8Array): ProtocolError | FrameEnvelope`. 2B
  encodes captured frames; 2D decodes them at the broker.

- [ ] **Step 1: Write the failing test**

`src/host/protocol/model/frame.test.ts`:

```ts
import { describe, expect, test } from "bun:test"

import { FrameDecoder } from "../../../infrastructure/framing"
import { ProtocolError } from "./errors"
import { decodeFrameEnvelope, encodeFrameEnvelope } from "./frame"
import type { FrameEnvelope } from "../types"

const frame: FrameEnvelope = {
  protocolVersion: 1,
  kind: "frame",
  sessionId: "0198b1c2-0000-7000-8000-000000000000",
  nonce: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
  sourceHash: "a".repeat(64),
  frameSeq: "1",
  width: 3,
  height: 2,
  rows: [
    [
      { text: "ab", fg: "default", bg: { indexed: 0 }, attrs: 0 },
      { text: "c", fg: { rgb: "#ff8800" }, bg: "default", attrs: 1 },
    ],
    [{ text: "xyz", fg: "default", bg: "default", attrs: 63 }],
  ],
}

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))

function dataPayload(encoded: Uint8Array): Uint8Array {
  const frames = new FrameDecoder().feed(encoded)
  if (frames instanceof Error) throw frames
  const first = frames[0]
  if (!first) throw new Error("no frame")
  expect(first.messageClass).toBe("data")
  return first.payload
}

describe("frame envelope", () => {
  test("round-trips through the framing layer as a data-class frame", () => {
    const encoded = encodeFrameEnvelope(frame)
    if (encoded instanceof Error) throw encoded
    expect(decodeFrameEnvelope(dataPayload(encoded))).toEqual(frame)
  })

  test("rejects rows whose count differs from height", () => {
    expect(decodeFrameEnvelope(encode({ ...frame, height: 3 }))).toBeInstanceOf(ProtocolError)
  })

  test("rejects a frameSeq that is not a decimal uint string", () => {
    expect(decodeFrameEnvelope(encode({ ...frame, frameSeq: "0" }))).toBeInstanceOf(ProtocolError)
  })

  test("rejects an attrs value outside the 6-bit mask", () => {
    const bad = { ...frame, rows: [[{ text: "abc", fg: "default", bg: "default", attrs: 64 }], frame.rows[1]] }
    expect(decodeFrameEnvelope(encode(bad))).toBeInstanceOf(ProtocolError)
  })

  test("rejects an out-of-mask attrs that is a safe integer >= 2^32", () => {
    // 4294967296 = 2^32: a bitwise `& ~63` guard wraps to 0 and would wrongly
    // accept this; the numeric range check rejects it.
    const bad = { ...frame, rows: [[{ text: "abc", fg: "default", bg: "default", attrs: 4294967296 }], frame.rows[1]] }
    expect(decodeFrameEnvelope(encode(bad))).toBeInstanceOf(ProtocolError)
  })

  test("rejects an unknown color shape", () => {
    const bad = { ...frame, rows: [[{ text: "abc", fg: { hsl: 1 }, bg: "default", attrs: 0 }], frame.rows[1]] }
    expect(decodeFrameEnvelope(encode(bad))).toBeInstanceOf(ProtocolError)
  })

  test("rejects an indexed color out of 0..255", () => {
    const bad = { ...frame, rows: [[{ text: "abc", fg: { indexed: 256 }, bg: "default", attrs: 0 }], frame.rows[1]] }
    expect(decodeFrameEnvelope(encode(bad))).toBeInstanceOf(ProtocolError)
  })

  test("rejects a malformed rgb color", () => {
    const bad = { ...frame, rows: [[{ text: "abc", fg: { rgb: "#fff" }, bg: "default", attrs: 0 }], frame.rows[1]] }
    expect(decodeFrameEnvelope(encode(bad))).toBeInstanceOf(ProtocolError)
  })

  test("rejects a width above the per-axis cap", () => {
    expect(decodeFrameEnvelope(encode({ ...frame, width: 2049 }))).toBeInstanceOf(ProtocolError)
  })

  test("rejects a cell count above the total cap", () => {
    const result = decodeFrameEnvelope(encode({ ...frame, width: 2048, height: 2048 }))
    expect(result).toBeInstanceOf(ProtocolError)
    if (result instanceof ProtocolError) expect(result.code).toBe("FRAME_TOO_LARGE")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/host/protocol/model/frame.test.ts`
Expected: FAIL — cannot resolve `./frame`.

- [ ] **Step 3: Write the implementation**

`src/host/protocol/model/frame.ts`:

```ts
import { encodeFrame } from "../../../infrastructure/framing"
import type { Color, FrameEnvelope, StyledRun } from "../types"
import { ProtocolError } from "./errors"
import {
  asArray,
  asObject,
  expectExactKeys,
  isDecimalUint64String,
  isLowercaseHex,
  isPositiveSafeInteger,
} from "./shape"
import { decodeJsonPayload } from "./strict-json"
import type { JsonValue } from "./strict-json"

export const FRAME_MAX_AXIS = 2048
export const FRAME_MAX_CELLS = 262144
/** All six defined attribute bits set: 1|2|4|8|16|32. */
export const FRAME_ATTR_MASK = 63

const SESSION_ID_MAX = 64
const NONCE_HEX_LENGTH = 32
const SOURCE_HASH_HEX_LENGTH = 64

const malformed = (reason: string) =>
  new ProtocolError({ code: "MALFORMED_PROTOCOL", reason })

export function encodeFrameEnvelope(frame: FrameEnvelope): ProtocolError | Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(frame))
  const framed = encodeFrame({ messageClass: "data", payload })
  if (framed instanceof Error) {
    return new ProtocolError({
      code: "OVERSIZED_MESSAGE",
      reason: "frame payload exceeds the framing limit",
      cause: framed,
    })
  }
  return framed
}

export function decodeFrameEnvelope(payload: Uint8Array): ProtocolError | FrameEnvelope {
  const value = decodeJsonPayload(payload)
  if (value instanceof ProtocolError) return value
  const object = asObject(value, "frame")
  if (object instanceof ProtocolError) return object

  const keyError = expectExactKeys(object, [
    "protocolVersion",
    "kind",
    "sessionId",
    "nonce",
    "sourceHash",
    "frameSeq",
    "width",
    "height",
    "rows",
  ])
  if (keyError instanceof ProtocolError) return keyError

  if (object.protocolVersion !== 1) return malformed("protocolVersion must be 1")
  if (object.kind !== "frame") return malformed('kind must be "frame"')
  if (
    typeof object.sessionId !== "string" ||
    object.sessionId.length === 0 ||
    object.sessionId.length > SESSION_ID_MAX
  ) {
    return malformed("sessionId must be a bounded non-empty string")
  }
  if (!isLowercaseHex(object.nonce, NONCE_HEX_LENGTH)) {
    return malformed("nonce must be 32 lowercase hex characters")
  }
  if (!isLowercaseHex(object.sourceHash, SOURCE_HASH_HEX_LENGTH)) {
    return malformed("sourceHash must be 64 lowercase hex characters")
  }
  if (!isDecimalUint64String(object.frameSeq)) {
    return malformed("frameSeq must be a decimal uint64 string")
  }
  if (!isPositiveSafeInteger(object.width) || object.width > FRAME_MAX_AXIS) {
    return malformed(`width must be a positive integer <= ${FRAME_MAX_AXIS}`)
  }
  if (!isPositiveSafeInteger(object.height) || object.height > FRAME_MAX_AXIS) {
    return malformed(`height must be a positive integer <= ${FRAME_MAX_AXIS}`)
  }
  if (object.width * object.height > FRAME_MAX_CELLS) {
    return new ProtocolError({
      code: "FRAME_TOO_LARGE",
      reason: `frame has more than ${FRAME_MAX_CELLS} cells`,
    })
  }

  const rows = asArray(object.rows, "rows")
  if (rows instanceof ProtocolError) return rows
  if (rows.length !== object.height) return malformed("rows length must equal height")

  const parsedRows: StyledRun[][] = []
  for (const rawRow of rows) {
    const row = asArray(rawRow, "row")
    if (row instanceof ProtocolError) return row
    const parsedRow: StyledRun[] = []
    for (const rawRun of row) {
      const run = validateStyledRun(rawRun)
      if (run instanceof ProtocolError) return run
      parsedRow.push(run)
    }
    parsedRows.push(parsedRow)
  }

  return {
    protocolVersion: 1,
    kind: "frame",
    sessionId: object.sessionId,
    nonce: object.nonce,
    sourceHash: object.sourceHash,
    frameSeq: object.frameSeq,
    width: object.width,
    height: object.height,
    rows: parsedRows,
  }
}

function validateStyledRun(value: JsonValue): ProtocolError | StyledRun {
  const object = asObject(value, "run")
  if (object instanceof ProtocolError) return object
  const keyError = expectExactKeys(object, ["text", "fg", "bg", "attrs"])
  if (keyError instanceof ProtocolError) return keyError

  if (typeof object.text !== "string") return malformed("run.text must be a string")
  const fg = validateColor(object.fg, "fg")
  if (fg instanceof ProtocolError) return fg
  const bg = validateColor(object.bg, "bg")
  if (bg instanceof ProtocolError) return bg
  if (
    typeof object.attrs !== "number" ||
    !Number.isInteger(object.attrs) ||
    object.attrs < 0 ||
    object.attrs > FRAME_ATTR_MASK
  ) {
    // Explicit numeric bound, NOT `(attrs & ~MASK) !== 0`: JS bitwise `&` coerces
    // to Int32, so a safe integer >= 2^32 whose low 6 bits form a valid mask (e.g.
    // 4294967296) would wrongly pass a bitwise guard. A range check cannot wrap.
    return malformed("run.attrs must be a 6-bit attribute mask")
  }

  return { text: object.text, fg, bg, attrs: object.attrs }
}

function validateColor(value: JsonValue | undefined, label: string): ProtocolError | Color {
  if (value === "default") return "default"
  const object = asObject(value, label)
  if (object instanceof ProtocolError) {
    return malformed(`${label} must be "default", {indexed}, or {rgb}`)
  }
  if ("indexed" in object) {
    const keyError = expectExactKeys(object, ["indexed"])
    if (keyError instanceof ProtocolError) return keyError
    if (
      typeof object.indexed !== "number" ||
      !Number.isInteger(object.indexed) ||
      object.indexed < 0 ||
      object.indexed > 255
    ) {
      return malformed(`${label}.indexed must be an integer 0..255`)
    }
    return { indexed: object.indexed }
  }
  if ("rgb" in object) {
    const keyError = expectExactKeys(object, ["rgb"])
    if (keyError instanceof ProtocolError) return keyError
    if (typeof object.rgb !== "string" || !/^#[0-9a-fA-F]{6}$/.test(object.rgb)) {
      return malformed(`${label}.rgb must be #RRGGBB`)
    }
    return { rgb: object.rgb as `#${string}` }
  }
  return malformed(`${label} must be "default", {indexed}, or {rgb}`)
}
```

Append to `src/host/protocol/index.ts`:

```ts
export {
  FRAME_ATTR_MASK,
  FRAME_MAX_AXIS,
  FRAME_MAX_CELLS,
  decodeFrameEnvelope,
  encodeFrameEnvelope,
} from "./model/frame"
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test src/host/protocol && bun x tsc --noEmit`
Expected: PASS, exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/host/protocol
git commit -m "feat: add preview frame-envelope codec with §5.3 structural + cell limits

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Fragmented round-trip integration + full-suite gate

**Files:**
- Create: `src/host/protocol/model/integration.test.ts`

**Interfaces:**
- Consumes: every codec from Tasks 1–5 and `infrastructure/framing`
  (`FrameDecoder`).
- Produces: nothing new — an integration test proving the wire layer survives the
  fragmentation the framing spec guarantees (§5, §14.1) and that control- vs
  data-class routing holds end to end.

- [ ] **Step 1: Write the test**

`src/host/protocol/model/integration.test.ts`:

```ts
import { describe, expect, test } from "bun:test"

import { FrameDecoder } from "../../../infrastructure/framing"
import { decodeControlEnvelope, encodeControlEnvelope } from "./control-envelope"
import { decodeFrameEnvelope, encodeFrameEnvelope } from "./frame"
import { decodeClientHello, encodeClientHello } from "./hello"
import type { ClientHelloV1, ControlEnvelope, FrameEnvelope } from "../types"

const hello: ClientHelloV1 = {
  framingVersion: 1,
  kind: "client.hello",
  sessionId: "0198b1c2-0000-7000-8000-000000000000",
  nonce: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
  offeredFramingVersions: [1],
  offeredProtocolVersions: [1],
  mode: "smoke",
  pageSlug: "dashboard",
  sourceHash: "b".repeat(64),
  sourceKitApiVersion: 1,
  runtimeDeclaration: {
    module: "@termcraft/runtime",
    currentKitApiVersion: 1,
    supportedKitApiVersions: [1],
    publicCapabilityIds: ["nav"],
  },
  limits: {
    controlPayloadBytes: 262144,
    framePayloadBytes: 16777216,
    maxFrameWidth: 2048,
    maxFrameHeight: 2048,
    maxFrameCells: 262144,
  },
}

const envelope: ControlEnvelope = {
  protocolVersion: 1,
  kind: "heartbeat",
  sessionId: hello.sessionId,
  nonce: hello.nonce,
  messageId: "2",
  body: { tick: "42", lastFrameSeq: "5" },
}

const frame: FrameEnvelope = {
  protocolVersion: 1,
  kind: "frame",
  sessionId: hello.sessionId,
  nonce: hello.nonce,
  sourceHash: hello.sourceHash,
  frameSeq: "5",
  width: 2,
  height: 1,
  rows: [[{ text: "hi", fg: "default", bg: "default", attrs: 0 }]],
}

function encodeAll(): Uint8Array {
  const parts = [
    encodeClientHello(hello),
    encodeControlEnvelope(envelope),
    encodeFrameEnvelope(frame),
  ]
  const bytes: Uint8Array[] = []
  for (const part of parts) {
    if (part instanceof Error) throw part
    bytes.push(part)
  }
  const total = bytes.reduce((sum, part) => sum + part.byteLength, 0)
  const joined = new Uint8Array(total)
  bytes.reduce((offset, part) => {
    joined.set(part, offset)
    return offset + part.byteLength
  }, 0)
  return joined
}

describe("protocol wire integration", () => {
  test("decodes a hello + control + frame stream delivered one byte at a time", () => {
    const stream = encodeAll()
    const decoder = new FrameDecoder()
    const collected = []
    for (const byte of stream) {
      const frames = decoder.feed(new Uint8Array([byte]))
      if (frames instanceof Error) throw frames
      collected.push(...frames)
    }
    expect(collected).toHaveLength(3)

    const helloFrame = collected[0]
    const controlFrame = collected[1]
    const dataFrame = collected[2]
    if (!helloFrame || !controlFrame || !dataFrame) throw new Error("missing frame")

    expect(helloFrame.messageClass).toBe("control")
    expect(controlFrame.messageClass).toBe("control")
    expect(dataFrame.messageClass).toBe("data")

    expect(decodeClientHello(helloFrame.payload)).toEqual(hello)
    expect(decodeControlEnvelope(controlFrame.payload)).toEqual(envelope)
    expect(decodeFrameEnvelope(dataFrame.payload)).toEqual(frame)
  })
})
```

- [ ] **Step 2: Run the integration test**

Run: `bun test src/host/protocol/model/integration.test.ts`
Expected: PASS (all codecs already exist). If it fails, fix the codec it exposes.

- [ ] **Step 3: Run the full suite + typecheck**

Run: `bun test && bun x tsc --noEmit`
Expected: PASS — phase-0 suites, `runtime`, and all `host/protocol` suites green;
tsc exit 0.

- [ ] **Step 4: Commit**

```bash
git add src/host/protocol
git commit -m "test: add fragmented protocol wire round-trip + class-routing integration

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-review checklist (run before implementing)

- **Spec coverage:** §5 UTF-8/JSON/dup-key/unsafe-int/no-resync → Task 1; §5.1
  hello DTOs + §7.1 bundle canonical arrays → Tasks 2–3; §5.2 control envelope +
  decimal-string ids → Task 4; §5.3 frame/StyledRun/Color + cell limits → Task 5;
  §14.1 fragmented decode + class routing → Task 6. Display-width equality and
  per-kind bodies are the two recorded scope deferrals.
- **Type consistency:** `ProtocolError.code`/`reason` (Task 1) used by every
  validator; `JsonValue` (Task 1) threads through every guard/validator; `HostMode`
  (Task 2, `host/types.ts`) consumed by `ClientHelloV1`; `RuntimeDeclarationBundleV1`
  / `PublicLimits` (Task 2) embedded by both hellos (Task 3); `FrameIdentity`
  (Task 2) is the base of `FrameEnvelope`; all DTO types live in one `types.ts`
  written whole in Task 2 so Tasks 3–5 never edit a shared file mid-body.
- **Framing reuse:** every encoder calls `encodeFrame`; every test decodes with
  `FrameDecoder`; no byte-frame logic is re-implemented.
- **errore:** all decoders return `ProtocolError | T`; `.catch`/`errore.try` appear
  only around `JSON.parse` and `TextDecoder.decode` (Task 1); one-line
  `instanceof Error` early returns throughout.
- **noUncheckedIndexedAccess:** shape guards accept `JsonValue | undefined`; hello
  `readIdentity` coerces missing bundle/limits to `null` for the Task-2 validators.
```
