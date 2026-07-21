import type { CommandPayloadByKindV1, FailureDtoV1 } from "core/protocol";
import type { Size } from "entities/page";

import type { AssertConforms } from "../index";
import type {
  InteractionModeV1,
  PreviewFrameV1,
  PreviewGeometryQueryResultV1,
  PreviewIdentityV1,
  PreviewSession,
  TerminalCapabilitiesV1,
} from "../preview-session";

/**
 * In-memory {@link PreviewSession} fake (6D task brief). `frames` is a push-based
 * async-iterable channel a test drives with `emitFrame`/`close` — no real host, no timers.
 * `interactionMode` changes ONLY on an accepted (non-failed) `setMode()` call, matching the
 * port's own doc: "changes ONLY on an accepted set-mode response — never optimistically."
 * `query()`'s success value has no natural backing state (a resolved anchor is a one-off
 * geometry fact, not a store row), so it is scripted through a one-shot queue like
 * `gate-runner.ts`'s results, rather than derived from mutable fields.
 */

/** A minimal push-based async-iterable channel — no timers, no polling, fully test-driven. */
function createFrameChannel(): {
  push(frame: PreviewFrameV1): void;
  close(): void;
  iterable: AsyncIterable<PreviewFrameV1>;
} {
  const queue: PreviewFrameV1[] = [];
  const waiting: Array<(result: IteratorResult<PreviewFrameV1>) => void> = [];
  let closed = false;
  return {
    push(frame) {
      const waiter = waiting.shift();
      if (waiter !== undefined) {
        waiter({ value: frame, done: false });
        return;
      }
      queue.push(frame);
    },
    close() {
      closed = true;
      while (waiting.length > 0) {
        const waiter = waiting.shift();
        waiter?.({ value: undefined as unknown as PreviewFrameV1, done: true });
      }
    },
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<PreviewFrameV1>> {
            const next = queue.shift();
            if (next !== undefined) return Promise.resolve({ value: next, done: false });
            if (closed)
              return Promise.resolve({ value: undefined as unknown as PreviewFrameV1, done: true });
            return new Promise((resolve) => waiting.push(resolve));
          },
        };
      },
    },
  };
}

export type PreviewSessionFailableMethod = "resize" | "setMode" | "setTheme" | "retry" | "query";

export type PreviewSessionCall =
  | { readonly method: "resize"; readonly size: Size }
  | { readonly method: "setMode"; readonly mode: InteractionModeV1 }
  | {
      readonly method: "setTheme";
      readonly theme: string;
      readonly capabilities: TerminalCapabilitiesV1;
    }
  | { readonly method: "retry" }
  | { readonly method: "close" }
  | { readonly method: "query"; readonly frameToken: string };

export interface FakePreviewSession extends PreviewSession {
  readonly calls: readonly PreviewSessionCall[];
  failNext(method: PreviewSessionFailableMethod, failure: FailureDtoV1): void;
  /** Push one frame through the `frames` async iterable. No-op (logged) after `close()`. */
  emitFrame(frame: PreviewFrameV1): void;
  /** Queues the next `query()` success result (FIFO), one shot; default when empty is an unresolved anchor. */
  queueQueryResult(result: PreviewGeometryQueryResultV1): void;
}

export function createFakePreviewSession(
  identity: PreviewIdentityV1,
  options?: {
    readonly mode?: "preview" | "historical";
    readonly interactionMode?: InteractionModeV1;
  },
): FakePreviewSession {
  const channel = createFrameChannel();
  const calls: PreviewSessionCall[] = [];
  let interactionMode = options?.interactionMode ?? "static";
  let closed = false;

  const queues: Record<PreviewSessionFailableMethod, FailureDtoV1[]> = {
    resize: [],
    setMode: [],
    setTheme: [],
    retry: [],
    query: [],
  };
  const queryResults: PreviewGeometryQueryResultV1[] = [];

  function failNext(method: PreviewSessionFailableMethod, failure: FailureDtoV1): void {
    queues[method].push(failure);
  }

  function queueQueryResult(result: PreviewGeometryQueryResultV1): void {
    queryResults.push(result);
  }

  function emitFrame(frame: PreviewFrameV1): void {
    if (closed) {
      console.warn(
        `fakes/preview-session: emitFrame after close() for session ${identity.sessionId}, ignored`,
      );
      return;
    }
    channel.push(frame);
  }

  async function resize(size: Size): Promise<FailureDtoV1 | undefined> {
    calls.push({ method: "resize", size });
    return queues.resize.shift();
  }

  async function setMode(mode: InteractionModeV1): Promise<FailureDtoV1 | undefined> {
    calls.push({ method: "setMode", mode });
    const queued = queues.setMode.shift();
    if (queued !== undefined) return queued;
    interactionMode = mode;
    return undefined;
  }

  async function setTheme(
    theme: string,
    capabilities: TerminalCapabilitiesV1,
  ): Promise<FailureDtoV1 | undefined> {
    calls.push({ method: "setTheme", theme, capabilities });
    return queues.setTheme.shift();
  }

  async function retry(): Promise<FailureDtoV1 | undefined> {
    calls.push({ method: "retry" });
    return queues.retry.shift();
  }

  async function close(): Promise<void> {
    calls.push({ method: "close" });
    closed = true;
    channel.close();
  }

  async function query(
    frameToken: string,
    _query: CommandPayloadByKindV1["preview.queryGeometry"]["query"],
  ): Promise<FailureDtoV1 | PreviewGeometryQueryResultV1> {
    calls.push({ method: "query", frameToken });
    const queuedFailure = queues.query.shift();
    if (queuedFailure !== undefined) return queuedFailure;
    return queryResults.shift() ?? { result: {}, resolvedAnchor: null };
  }

  return {
    identity,
    mode: options?.mode ?? "preview",
    get interactionMode() {
      return interactionMode;
    },
    frames: channel.iterable,
    resize,
    setMode,
    setTheme,
    retry,
    close,
    query,
    calls,
    failNext,
    emitFrame,
    queueQueryResult,
  };
}

type _Conforms = AssertConforms<PreviewSession, FakePreviewSession>;
