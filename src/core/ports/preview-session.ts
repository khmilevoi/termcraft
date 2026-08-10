import type {
  CommandPayloadByKindV1,
  FailureDtoV1,
  GeometryQueryResultV1,
  Sha256Hex,
} from "core/protocol";
import type { Size } from "entities/page";

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
 * slice, per the task brief's own instruction. B1 IS NOW CLOSED end to end; what the
 * closure changed about this declaration is its first parameter — see
 * {@link PreviewFrameCoordinatesV1}, which records why an opaque `FrameTokenV1` could never
 * have crossed this boundary in either direction.
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

export type InteractionModeV1 = "static" | "interactive";

/** A run of consecutive cells sharing one style (host-supervision §5.3), redrawn per C1. */
export type ColorV1 = "default" | Readonly<{ indexed: number }> | Readonly<{ rgb: `#${string}` }>;

export interface StyledRunV1 {
  readonly text: string;
  readonly fg: ColorV1;
  readonly bg: ColorV1;
  /** Bitmask: 1 bold, 2 dim, 4 italic, 8 underline, 16 inverse, 32 strikethrough. */
  readonly attrs: number;
}

/** The facade's stable identity — the incarnation identity minus the volatile nonce (host-supervision §3.2). */
export interface PreviewIdentityV1 {
  readonly mode: "preview" | "historical" | "smoke" | "export";
  readonly pageSlug: string;
  readonly sourceHash: Sha256Hex;
  readonly kitApiVersion: number;
  readonly sessionId: string;
}

/** An immutable displayed-frame value (host-supervision §3.2/§5.3). */
export interface PreviewFrameV1 {
  readonly sessionId: string;
  readonly sourceHash: Sha256Hex;
  readonly frameSeq: string;
  readonly width: number;
  readonly height: number;
  readonly rows: readonly (readonly StyledRunV1[])[];
}

/** Terminal color/geometry capabilities announced at mount (host-supervision §3.1). */
export interface TerminalCapabilitiesV1 {
  readonly colorDepth: number;
}

/**
 * The host-side answer to one geometry query (host-supervision §7; kernel-command-contract
 * §8.1/§9). `result` is the same closed §4.2 `checkHit`/`rectOf`/`describe`/`layoutTree`
 * union `core/protocol/model/event-payload.ts` closed for `preview.geometryResult`'s own
 * `result` field (M21) — imported directly from `core/protocol` rather than redeclared, so
 * the two never drift apart (ports are allowed to import `core/protocol`, never the
 * reverse). `resolvedAnchor` is set only when a `hit`/`pin-anchor` query resolves an exact
 * page, element, and finite fractional point — precisely the condition under which the
 * Kernel mints a `GeometryTokenV1` (kernel-command-contract §8.1).
 */
export interface PreviewGeometryQueryResultV1 {
  readonly result: GeometryQueryResultV1;
  readonly resolvedAnchor: Readonly<{
    pageSlug: string;
    elementId: string;
    fx: number;
    fy: number;
  }> | null;
}

/**
 * The coordinates of the frame a geometry query is ABOUT — the half of host-supervision
 * §7.1's `FrameIdentity` the Kernel genuinely owns and has already verified.
 *
 * WHY THIS IS NOT A `FrameTokenV1`, AND NOT A FULL `FrameIdentityV1` (blocker B1's last
 * mile, closed 2026-08-10 after a live run found every right-click dying here). The host's
 * child validates a query against all four fields of its own currently-sealed frame —
 * `sessionId`, `nonce`, `sourceHash`, `frameSeq` (`host/session/model/host-state-machine.ts`'s
 * `handleQuery`) — and refuses anything else with `STALE_FRAME`. Of those four the Kernel can
 * supply exactly two: `sourceHash` and `frameSeq` travel on every frame and are real. The
 * other two it structurally cannot know —
 *
 * - `nonce` is the per-incarnation value `host/types.ts`'s `PreviewFrame` DELIBERATELY drops
 *   ("the facade's stable identity intentionally omits it so automatic restart does not
 *   replace the facade"), so it never reaches `core` on any path; and
 * - the Kernel's own `FrameIdentityV1.previewSessionId` is a Kernel-minted `uuidv7`
 *   (`core/preview/model/session-commands.ts`'s `noteSessionEstablished`), a DIFFERENT value
 *   from the host's `sessionId` — passing it would be refused as a forged frame.
 *
 * So the identity is completed on the side that owns the missing half: the host facade fills
 * in whichever incarnation is live at call time (`host/supervisor/model/supervisor.ts`'s
 * `sessionFor`). This adapter boundary is the ONLY honest split — the earlier attempt to hand
 * the host an opaque `FrameTokenV1` could never work, because resolving it needs a ledger that
 * lives in `core` while completing it needs a nonce that never leaves `host`.
 */
export interface PreviewFrameCoordinatesV1 {
  readonly sourceHash: Sha256Hex;
  /** The incarnation-local monotonic decimal-uint64 string, verbatim from the frame. */
  readonly frameSeq: string;
}

export interface PreviewSession {
  readonly identity: PreviewIdentityV1;
  readonly mode: "preview" | "historical";
  /** Changes ONLY on an accepted set-mode response (§7) — never optimistically on request. */
  readonly interactionMode: InteractionModeV1;
  readonly frames: AsyncIterable<PreviewFrameV1>;
  resize(size: Size): Promise<FailureDtoV1 | undefined>;
  setMode(mode: InteractionModeV1): Promise<FailureDtoV1 | undefined>;
  /** `preview.setThemeCapabilities` (kernel-command-contract §8.2): "Change the non-persistent host-scoped preview override." */
  setTheme(theme: string, capabilities: TerminalCapabilitiesV1): Promise<FailureDtoV1 | undefined>;
  /** `preview.retry` (§8.2): "Explicitly retry a failed/circuit-open preview." */
  retry(): Promise<FailureDtoV1 | undefined>;
  close(): Promise<void>;
  /**
   * Forwards one bounded geometry query about an already-verified frame (blocker B1, closed).
   *
   * The CALLER resolves the UI's opaque `FrameTokenV1` — query-authorizing only after the
   * typed display acknowledgement (kernel-command-contract §8.1) — through
   * `FrameTokenLedger.verifyCurrent` and passes the resulting {@link PreviewFrameCoordinatesV1}
   * here; see that type's own doc for why the token itself cannot cross this boundary and why
   * the remaining identity fields are completed on the host side.
   */
  query(
    frame: PreviewFrameCoordinatesV1,
    query: CommandPayloadByKindV1["preview.queryGeometry"]["query"],
  ): Promise<FailureDtoV1 | PreviewGeometryQueryResultV1>;
}
