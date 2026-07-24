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
  readonly theme: string;
}

/** A page module loaded and validated by `loadPage`, ready to mount. */
export interface LoadedPage {
  readonly meta: ValidatedPageMeta;
  /** The page's default export — a component `createElement` mounts as the root. */
  readonly component: unknown;
  /** The recomputed lowercase-hex source hash (equals the expected hash). */
  readonly sourceHash: string;
}

export interface LoadPageArgs {
  readonly sourcePath: string;
  readonly expectedSourceHash: string;
}

/** The `mount` request body (host-supervision §6.5). */
export interface MountRequestBody {
  readonly sourcePath: string;
  readonly expectedSourceHash: string;
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
export type { ControlEnvelope, FrameEnvelope, FrameIdentity, HostHelloV1 };
