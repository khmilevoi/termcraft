import type { StyledRun } from "./protocol";

/** The four supervised host modes (host-supervision §3.1). */
export type HostMode = "preview" | "historical" | "smoke" | "export";

/** Effective interaction mode of a mounted host (host-supervision §3.1). */
export type InteractionMode = "static" | "interactive";

/** A terminal-cell size (columns × rows) shared across the host module. */
export interface Size {
  readonly w: number;
  readonly h: number;
}

/**
 * Terminal color/geometry capabilities announced at mount (host-supervision §3.1)
 * and echoed into the runtime's viewport/color capability model. MVP carries the
 * color depth only (4/8/24-bit); later phases widen this (mouse, unicode width).
 */
export interface TerminalCapabilities {
  readonly colorDepth: number;
}

/** The specification every host session (all four modes) is created from (§3.1). */
export interface HostSessionSpec {
  readonly mode: HostMode;
  readonly interactionMode: InteractionMode;
  readonly pageSlug: string;
  readonly sourcePath: string;
  readonly sourceHash: string;
  readonly kitApiVersion: number;
  readonly size: Size;
  readonly theme: string;
  readonly capabilities: TerminalCapabilities;
}

/**
 * A logical session's minted identity (§3.1). `sessionId` (UUIDv7) is stable
 * across automatic restart; `nonce` (32 lowercase hex) identifies one process
 * incarnation. Supervisor-minted only — never caller-supplied.
 */
export interface HostSessionIdentity {
  readonly mode: HostMode;
  readonly pageSlug: string;
  readonly sourceHash: string;
  readonly kitApiVersion: number;
  readonly sessionId: string;
  readonly nonce: string;
}

/**
 * An immutable displayed-frame value handed to the UI (host-supervision §3.2/§5.3).
 * It is the frame envelope minus the incarnation `nonce`: the facade's stable
 * identity intentionally omits it so automatic restart (2D-3) does not replace the
 * facade. `frameSeq` is the incarnation-local monotonic decimal-uint64 string.
 */
export interface PreviewFrame {
  readonly sessionId: string;
  readonly sourceHash: string;
  readonly frameSeq: string;
  readonly width: number;
  readonly height: number;
  readonly rows: StyledRun[][];
}

/** The facade's stable identity: the incarnation identity minus the volatile nonce (§3.2). */
export type PreviewIdentity = Omit<HostSessionIdentity, "nonce">;
