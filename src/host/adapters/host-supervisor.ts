import type {
  AssertConforms,
  HostSessionSpecV1,
  HostSupervisorPort,
  PreviewFrameV1,
  PreviewGeometryQueryResultV1,
  PreviewSession,
  SupervisorEventV1,
} from "core/ports";
import type { FailureDtoV1 } from "core/protocol";

import { SupervisorError, createHostSupervisor } from "../supervisor";
import type { HostSupervisorDeps, PreviewFrame, SupervisedPreviewSession } from "../supervisor";
import type { HostSessionSpec } from "../types";

/**
 * `createHostSupervisorAdapter`: the production `HostSupervisorPort` over `host`'s real
 * `createHostSupervisor` (adapter-ring plan, Task 5). The real `HostSupervisor.preview` is
 * synchronous (`SupervisedPreviewSession | SupervisorError`); the port's `preview` is
 * `Promise`-typed because composing a restart-managed `PreviewSession` on top of the
 * supervisor's queued/backoff start path is conceptually async even though today's
 * construction resolves immediately — this adapter awaits nothing extra, it just wraps the
 * synchronous result in a resolved promise, matching `core/ports/host-supervisor.ts`'s own
 * header note.
 *
 * KNOWN DIVERGENCES (documented, not fabricated — flagged in the WP-2 lane report):
 * - `resize`/`setMode`/`retry` are FIRE-AND-FORGET on `SupervisedPreviewSession` (host logs
 *   a dropped failure internally and never surfaces it to the caller). This adapter cannot
 *   recover that disposition, so it invokes the host method and resolves `undefined`
 *   immediately — never fabricating a `FailureDtoV1` for a call that may still be failing
 *   silently inside host. A future host API that returns the awaited disposition would let
 *   this genuinely report failure instead.
 * - `setTheme` has NO host implementation at all (`host/supervisor/model/preview-session.ts`'s
 *   own header: "Deferred facade methods (forwardInput, setTheme, setCapabilities, tweaks)
 *   remain intentionally absent"). This adapter returns a `HOST_PROTOCOL_FAILED` FailureDtoV1
 *   naming the gap rather than silently no-op-succeeding.
 * - `query` needs a Kernel-side `FrameTokenV1` → `FrameIdentity` ledger (the port's own header:
 *   "TODO(blocker B1): ... this method resolves and verifies it as the broker's current
 *   displayed frame"). That ledger is Kernel/composition-root state this adapter has no
 *   access to — host's own wire-level `query(frameIdentity, query)` already works
 *   (`host/supervisor/model/session.ts`), but resolving an opaque `FrameTokenV1` into a
 *   `FrameIdentity` is out of this adapter's scope. Returns the same documented
 *   `HOST_PROTOCOL_FAILED` FailureDtoV1 until that ledger exists.
 */

function toHostSessionSpec(spec: HostSessionSpecV1): HostSessionSpec {
  return {
    mode: spec.mode,
    interactionMode: spec.interactionMode,
    pageSlug: spec.pageSlug,
    sourcePath: spec.sourcePath,
    sourceHash: spec.sourceHash,
    kitApiVersion: spec.kitApiVersion,
    size: spec.size,
    theme: spec.theme,
    capabilities: spec.capabilities,
  };
}

/**
 * Buckets host's 18-member `SupervisorErrorCode` union onto the three host-related
 * `FailureDtoV1` codes the v1 operational-failure registry actually declares
 * (`core/protocol/model/failure.ts`): `HOST_CIRCUIT_OPEN` for an open crash-loop circuit,
 * `HOST_START_FAILED` for a failure to even begin an incarnation (including `HOST_CAPACITY`
 * — global-limit/queue-full is a start failure, not a protocol fault), and
 * `HOST_PROTOCOL_FAILED` for everything else (transport/handshake/mount-level faults).
 */
function toHostFailureDto(error: SupervisorError): FailureDtoV1 {
  const details = { supervisorErrorCode: String(error.code) };
  if (error.code === "CIRCUIT_OPEN") {
    return { code: "HOST_CIRCUIT_OPEN", retryable: false, safeMessage: error.message, details };
  }
  if (
    error.code === "SPAWN_FAILED" ||
    error.code === "HANDSHAKE_TIMEOUT" ||
    error.code === "MOUNT_TIMEOUT" ||
    error.code === "HOST_CAPACITY"
  ) {
    return {
      code: "HOST_START_FAILED",
      retryable: error.code === "HOST_CAPACITY",
      safeMessage: error.message,
      details,
    };
  }
  return { code: "HOST_PROTOCOL_FAILED", retryable: true, safeMessage: error.message, details };
}

const QUERY_NOT_WIRED: FailureDtoV1 = {
  code: "HOST_PROTOCOL_FAILED",
  retryable: false,
  safeMessage:
    "preview.query is not wired: resolving an opaque frameToken into a host FrameIdentity needs a Kernel-side ledger this adapter has no access to (blocker B1)",
  details: {},
};

const SET_THEME_NOT_WIRED: FailureDtoV1 = {
  code: "HOST_PROTOCOL_FAILED",
  retryable: false,
  safeMessage:
    "preview.setThemeCapabilities is not wired: host has not implemented a live theme/capability override yet",
  details: {},
};

async function* toPreviewFrames(
  source: AsyncIterable<PreviewFrame>,
): AsyncGenerator<PreviewFrameV1> {
  for await (const frame of source) {
    yield {
      sessionId: frame.sessionId,
      sourceHash: frame.sourceHash,
      frameSeq: frame.frameSeq,
      width: frame.width,
      height: frame.height,
      rows: frame.rows,
    };
  }
}

function toPreviewSession(supervised: SupervisedPreviewSession): PreviewSession {
  return {
    get identity() {
      return supervised.identity;
    },
    get mode() {
      return supervised.mode;
    },
    get interactionMode() {
      return supervised.interactionMode;
    },
    frames: toPreviewFrames(supervised.frames),
    async resize(size) {
      supervised.resize(size); // fire-and-forget — see this file's header note
      return undefined;
    },
    async setMode(mode) {
      supervised.setMode(mode); // fire-and-forget — see this file's header note
      return undefined;
    },
    async setTheme(_theme, _capabilities) {
      return SET_THEME_NOT_WIRED;
    },
    async retry() {
      supervised.retry(); // fire-and-forget — see this file's header note
      return undefined;
    },
    async close() {
      await supervised.close();
    },
    async query(_frameToken, _query): Promise<FailureDtoV1 | PreviewGeometryQueryResultV1> {
      return QUERY_NOT_WIRED;
    },
  };
}

export function createHostSupervisorAdapter(deps: HostSupervisorDeps): HostSupervisorPort {
  const listeners = new Set<(event: SupervisorEventV1) => void>();
  const supervisor = createHostSupervisor({
    ...deps,
    onEvent: (event) => {
      deps.onEvent?.(event);
      for (const listener of listeners) listener(event);
    },
  });

  async function preview(spec: HostSessionSpecV1): Promise<FailureDtoV1 | PreviewSession> {
    const result = supervisor.preview(toHostSessionSpec(spec));
    if (result instanceof SupervisorError) return toHostFailureDto(result);
    return toPreviewSession(result);
  }

  function liveCount(): number {
    return supervisor.liveCount();
  }

  async function stopAll(): Promise<void> {
    await supervisor.stopAll();
  }

  function onEvent(listener: (event: SupervisorEventV1) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return { preview, liveCount, stopAll, onEvent };
}

type _Conforms = AssertConforms<HostSupervisorPort, ReturnType<typeof createHostSupervisorAdapter>>;
