import type { CommandPayloadByKindV1, FailureDtoV1, FrameTokenV1, Sha256Hex } from "core/protocol"
import type { Size } from "entities/page"

/**
 * `PreviewSession` per the kernel contract (host-supervision §3.2, §7; kernel-command-
 * contract §8.1-§8.2, §9): the UI-facing preview facade the Kernel drives directly.
 * Narrowed from `host/supervisor/types.ts`'s real `PreviewSession` per decision C1 — that
 * facade already carries `identity`/`mode`/`interactionMode`/`frames`/`resize`/`setMode`/
 * `retry`/`close`, but its own header comment records that "deferred facade methods
 * (forwardInput, setTheme, setCapabilities, geometry query, tweaks) are intentionally
 * absent" — this port ADDS `setTheme` and `query`, which is exactly blocker B1 becoming
 * visible: "`PreviewSession.query(frameToken, query)` does not exist in `host/`, and no
 * `query-hit`/`pin-anchor` control kind exists on the wire. `GeometryTokenV1` can therefore
 * never be minted and `pin.create` is unimplementable... Resolution: add the wire query
 * kind plus `query()` to `host` in 6D." Declaring `query` here — before `host` implements
 * it — is how that requirement becomes visible to the sibling agent closing B1 in this same
 * slice, per the task brief's own instruction.
 *
 * Every method returns `FailureDtoV1` rather than `host`'s `ProtocolError`/`SupervisorError`
 * (mapped at the composition-root adapter boundary, the same principle decision C1 applies
 * to `store`'s tagged errors) — `core` imports no error class from `host`.
 *
 * `query`'s second parameter reuses `CommandPayloadByKindV1["preview.queryGeometry"]`'s
 * `query` field type directly from `core/protocol` rather than re-declaring the closed
 * hit/rect/describe/layout/pin-anchor union a third time — that DTO IS the wire shape this
 * method resolves, so importing its type (not a value) keeps the two definitions from
 * drifting apart while staying inside `core/`'s own protocol submodule (never `host`).
 */

export type InteractionModeV1 = "static" | "interactive"

/** A run of consecutive cells sharing one style (host-supervision §5.3), redrawn per C1. */
export type ColorV1 = "default" | Readonly<{ indexed: number }> | Readonly<{ rgb: `#${string}` }>

export interface StyledRunV1 {
  readonly text: string
  readonly fg: ColorV1
  readonly bg: ColorV1
  /** Bitmask: 1 bold, 2 dim, 4 italic, 8 underline, 16 inverse, 32 strikethrough. */
  readonly attrs: number
}

/** The facade's stable identity — the incarnation identity minus the volatile nonce (host-supervision §3.2). */
export interface PreviewIdentityV1 {
  readonly mode: "preview" | "historical" | "smoke" | "export"
  readonly pageSlug: string
  readonly sourceHash: Sha256Hex
  readonly kitApiVersion: number
  readonly sessionId: string
}

/** An immutable displayed-frame value (host-supervision §3.2/§5.3). */
export interface PreviewFrameV1 {
  readonly sessionId: string
  readonly sourceHash: Sha256Hex
  readonly frameSeq: string
  readonly width: number
  readonly height: number
  readonly rows: readonly (readonly StyledRunV1[])[]
}

/** Terminal color/geometry capabilities announced at mount (host-supervision §3.1). */
export interface TerminalCapabilitiesV1 {
  readonly colorDepth: number
}

/**
 * The host-side answer to one geometry query (host-supervision §7; kernel-command-contract
 * §8.1/§9). `result` stays the closed per-`queryKind` body host-supervision defines — not
 * yet drafted upstream, hence `core/protocol/model/event-payload.ts`'s own placeholder
 * schema for `preview.geometryResult` — so this port carries the same bounded-record
 * placeholder rather than inventing a shape the wire protocol does not fix yet.
 * `resolvedAnchor` is set only when a `hit`/`pin-anchor` query resolves an exact page,
 * element, and finite fractional point — precisely the condition under which the Kernel
 * mints a `GeometryTokenV1` (kernel-command-contract §8.1).
 */
export interface PreviewGeometryQueryResultV1 {
  readonly result: Readonly<Record<string, unknown>>
  readonly resolvedAnchor: Readonly<{ pageSlug: string; elementId: string; fx: number; fy: number }> | null
}

export interface PreviewSession {
  readonly identity: PreviewIdentityV1
  readonly mode: "preview" | "historical"
  /** Changes ONLY on an accepted set-mode response (§7) — never optimistically on request. */
  readonly interactionMode: InteractionModeV1
  readonly frames: AsyncIterable<PreviewFrameV1>
  resize(size: Size): Promise<FailureDtoV1 | undefined>
  setMode(mode: InteractionModeV1): Promise<FailureDtoV1 | undefined>
  /** `preview.setThemeCapabilities` (kernel-command-contract §8.2): "Change the non-persistent host-scoped preview override." */
  setTheme(theme: string, capabilities: TerminalCapabilitiesV1): Promise<FailureDtoV1 | undefined>
  /** `preview.retry` (§8.2): "Explicitly retry a failed/circuit-open preview." */
  retry(): Promise<FailureDtoV1 | undefined>
  close(): Promise<void>
  /**
   * TODO(blocker B1): not implemented by `host` at the time this port is declared — see
   * this file's header. `frameToken` is opaque and query-authorizing only after the UI's
   * typed display acknowledgement (kernel-command-contract §8.1); this method resolves and
   * verifies it as the broker's current displayed frame before forwarding the bounded query.
   */
  query(
    frameToken: FrameTokenV1,
    query: CommandPayloadByKindV1["preview.queryGeometry"]["query"],
  ): Promise<FailureDtoV1 | PreviewGeometryQueryResultV1>
}
