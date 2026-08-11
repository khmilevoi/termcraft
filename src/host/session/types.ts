import type { DesignFileEntryV1 } from "entities/design-tree";

import type {
  ControlEnvelope,
  FrameEnvelope,
  FrameIdentity,
  HostHelloV1,
  ProtocolError,
  PublicLimits,
  RuntimeDeclarationBundleV1,
} from "../protocol";
import type { LayoutNode, RenderHandle } from "../render";
import type { HostMode, InteractionMode, Size, TerminalCapabilities } from "../types";

/** A page's static metadata after structural validation of the imported module. */
export interface ValidatedPageMeta {
  readonly kitApiVersion: number;
  readonly title: string;
  readonly minSize: Size;
  /**
   * OPTIONAL (design-systems §4.6). The child never resolves it: the ACTIVE theme travels in
   * `MountRequestBody.theme`, which `core` already resolved against the project's manifest. This
   * field is the page's own DECLARATION, echoed back in `ReadyBody.meta` unchanged.
   */
  readonly theme?: string;
}

/** A page module loaded and validated by `loadPage`, ready to mount. */
export interface LoadedPage {
  readonly meta: ValidatedPageMeta;
  /** The page's default export — a component `createElement` mounts as the root. */
  readonly component: unknown;
  /** The recomputed lowercase-hex source hash (equals the expected hash). */
  readonly sourceHash: string;
}

/**
 * What one `mount` has to name for the host to verify and link a page's WHOLE closure
 * (design §6, §9.2). It replaced `sourcePath`/`expectedSourceHash` in task 15: one absolute
 * file plus one hash cannot describe a page that spans several files, and a page whose shared
 * module drifted must not mount.
 *
 * `expectedFiles` is the tree revision's own inventory — every file under `design/`, not just
 * the closure. THAT IS DELIBERATE and it is the one place this implementation reads the plan
 * more broadly than its own wording (which says `expectedClosure`):
 *
 * - it is what design §9.2 actually specifies ("the host verifies every file in the tree
 *   against the revision's inventory hashes"), and what the revision-keyed incarnation of
 *   plan 3 needs;
 * - no producer can honestly supply a closure. `core` reaches the tree through
 *   `DesignTreeReader`, which hands back `listTree()`/`readManifest()` and no import scanner;
 *   deriving a closure there would mean running the Gate's whole-tree scan on every preview
 *   mount — seconds of synchronous event-loop block per `red-debt.md`'s own measurements — and
 *   fabricating one (`[entry]`) is the silent-truncation defect this branch has ruled against
 *   repeatedly;
 * - the staleness check the plan asked for survives unchanged in strength, because the host
 *   derives the closure ITSELF and every member is hash-verified against this inventory: a
 *   structural change to a closure requires a byte change in some member, and that is exactly
 *   what a hash comparison catches.
 *
 * The host still reads only the closure, never the whole tree — see `loadPage`.
 */
export interface LoadPageArgs {
  /** The ABSOLUTE `…/design` directory this mount reads from. */
  readonly treeRoot: string;
  /** TREE-relative, exactly the string `design/pages.json` bound to the slug — never slug-derived. */
  readonly entryRelPath: string;
  /** The tree revision's inventory: `(relPath, sha256)` for every file under `treeRoot`. */
  readonly expectedFiles: readonly DesignFileEntryV1[];
}

/** The `mount` request body (host-supervision §6.5). */
export interface MountRequestBody {
  readonly treeRoot: string;
  readonly entryRelPath: string;
  readonly expectedFiles: readonly DesignFileEntryV1[];
  readonly mode: HostMode;
  readonly interactionMode: InteractionMode;
  readonly size: Size;
  readonly theme: string;
  readonly capabilities: TerminalCapabilities;
  readonly deterministic: boolean;
}

/** The accepted `ready` response body (host-supervision §6.6). */
export interface ReadyBody {
  readonly meta: ValidatedPageMeta;
  readonly size: Size;
  readonly interactionMode: InteractionMode;
  readonly frameIdentity: FrameIdentity;
  /** Tweak declarations — empty in MVP (set-tweak is a later phase). */
  readonly tweaks: readonly never[];
  /**
   * The resolved layout tree (design doc §4.2), sealed here ONLY for `smoke`/`export`
   * one-shot mounts (WP-5 Task A1, D-Q8): the one-shot child exits immediately after this
   * `ready` + the first frame (`host-state-machine.ts`'s `handleMount`), before any
   * correlated `query-layout` request could ever arrive, so the tree travels in the
   * `ready` body instead of a second round trip. Absent for `preview`/`historical`, which
   * fetch it on demand via `query-layout` instead.
   */
  readonly layout?: LayoutNode;
}

/** The `set-mode` request body (host-supervision §7). */
export interface SetModeRequestBody {
  readonly interactionMode: InteractionMode;
}

/** A correlated response body: either an accepted echo or a typed refusal. */
export type ResponseBody =
  | { readonly ok: true; readonly [key: string]: unknown }
  | { readonly ok: false; readonly code: string; readonly reason: string };

/** The `heartbeat` body (host-supervision §9). */
export interface HeartbeatBody {
  readonly hostTick: number;
  readonly lastFrameSeq: string;
}

/**
 * A logical outbound message from the state machine. The entry encodes each with
 * the 2A codecs and writes the framed bytes to stdout; tests capture these
 * directly, so the machine is testable without real stdio.
 */
export type OutboundMessage =
  | { readonly type: "host-hello"; readonly payload: HostHelloV1 }
  | { readonly type: "control"; readonly payload: ControlEnvelope }
  | { readonly type: "frame"; readonly payload: FrameEnvelope };

/** A request for the process to exit after flushing stdout (Spike D). */
export interface ExitRequest {
  readonly code: number;
  readonly reason: string;
}

/** Injected dependencies of a host session (all boundaries are injectable). */
export interface HostSessionDeps {
  readonly runtimeDeclaration: RuntimeDeclarationBundleV1;
  readonly limits: PublicLimits;
  readonly loadPage: (args: LoadPageArgs) => Promise<ProtocolError | LoadedPage>;
  readonly createRenderer: (size: Size) => Promise<RenderHandle>;
  /** Monotonic milliseconds (host-supervision §9 — all durations are monotonic). */
  readonly now: () => number;
  readonly send: (message: OutboundMessage) => void;
  readonly requestExit: (request: ExitRequest) => void;
}

/** The host-side protocol driver. */
export interface HostSession {
  /** Feed one decoded control-class payload (fragmentation handled upstream). */
  receiveControlPayload(payload: Uint8Array): Promise<void>;
  /** Emit one heartbeat now (called by the entry's 1s timer). */
  emitHeartbeat(): void;
}

// Re-export the imported types needed by consumers of this module.
export type { ControlEnvelope, DesignFileEntryV1, FrameEnvelope, FrameIdentity, HostHelloV1 };
