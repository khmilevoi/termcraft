import type { DesignFileEntryV1 } from "entities/design-tree";

import type { StyledRun } from "./protocol";

export type { DesignFileEntryV1 };

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

/**
 * The specification every host session (all four modes) is created from (§3.1).
 *
 * `treeRoot`/`entryRelPath`/`expectedFiles` REPLACED a single `sourcePath` in task 15 (design
 * §6, §9.2): a page spans its whole closure now, so the mount names the tree it reads from and
 * the inventory it expects to find there rather than one file. `sourceHash` STAYS, and stays
 * the ENTRY file's own hash: it names this incarnation's source (`HostSessionIdentity`, every
 * `FrameEnvelope`, the supervisor's `sourceHashPrefix` diagnostics), and the supervisor checks
 * that it agrees with the entry's row in `expectedFiles` before it mounts, so identity and
 * verification can never describe different bytes. `loadPage` verifies the rest of the closure
 * against `expectedFiles` the same way.
 *
 * WHAT `sourceHash` IS NO LONGER is the supervisor's SESSION KEY — {@link
 * HostSessionSpec.treeRevision} is (design-tree phase 2 Task 10).
 */
export interface HostSessionSpec {
  readonly mode: HostMode;
  readonly interactionMode: InteractionMode;
  readonly pageSlug: string;
  /** The ABSOLUTE `…/design` directory this session mounts from. */
  readonly treeRoot: string;
  /** TREE-relative — the `entry` `design/pages.json` bound to `pageSlug`. */
  readonly entryRelPath: string;
  /** The tree revision's inventory: `(relPath, sha256)` for every file under `treeRoot`. */
  readonly expectedFiles: readonly DesignFileEntryV1[];
  /** The ENTRY file's own hash — this incarnation's source, see the interface header. */
  readonly sourceHash: string;
  /**
   * `computeTreeRevision` over the sorted inventory (`entities/design-tree`) — the key
   * `supervisor.ts`'s `keyOf` identifies one logical session by (design-tree phase 2 Task 10).
   *
   * `(pageSlug, sourceHash)` was that key until then, and it could not see a shared-module edit:
   * rewriting a module the page imports moves no ENTRY hash, so the supervisor matched the
   * existing key and returned the LIVE child, whose module registry still held the old module.
   * The revision covers every file under `treeRoot`, entry included.
   *
   * Carried by all four modes, not only `preview`: a one-shot smoke/export mount has no session
   * to key, but it does render one specific revision of one specific tree, and naming it is what
   * keeps this field a fact about the mount rather than a supervisor-only annotation.
   */
  readonly treeRevision: string;
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
