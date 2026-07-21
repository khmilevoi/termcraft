import type { PreviewFrameV1, PreviewGeometryQueryResultV1, PreviewSession } from "core/ports";
import type { FailureDtoV1, FrameIdentityV1, FrameTokenV1, UUIDv7 } from "core/protocol";
import { uuidv7 } from "infrastructure/uuid";
import type { PreviewSessionHandle } from "ui/kernel";

import { TEST_NONCE, TEST_SHA } from "./events";

/**
 * A controllable `PreviewSession` + handle for tests. Frames are delivered through an async
 * queue so a test can `pushFrame(...)` and have the preview component's `for await` loop see
 * it; `end()` closes the stream. Geometry/ack are canned — 7E tests override what they need.
 */
export interface FakePreviewSession {
  readonly handle: PreviewSessionHandle;
  /** Pushes one frame to the `frames` async-iterable consumers. */
  pushFrame(frame: PreviewFrameV1): void;
  /** Closes the `frames` stream. */
  end(): void;
  /** Raw geometry-query calls the session received. */
  readonly queries: readonly { frameToken: FrameTokenV1; query: unknown }[];
}

export interface FakePreviewOptions {
  readonly previewSessionId?: UUIDv7;
  readonly pageSlug?: string;
  readonly geometryResult?: PreviewGeometryQueryResultV1;
  readonly ackResult?: (frameToken: FrameTokenV1) => Error | FrameIdentityV1;
}

export function createFakePreviewSession(options: FakePreviewOptions = {}): FakePreviewSession {
  const previewSessionId = options.previewSessionId ?? uuidv7();
  const pageSlug = options.pageSlug ?? "main";
  const queries: { frameToken: FrameTokenV1; query: unknown }[] = [];

  const buffer: PreviewFrameV1[] = [];
  const waiters: ((result: IteratorResult<PreviewFrameV1>) => void)[] = [];
  let closed = false;

  function pushFrame(frame: PreviewFrameV1): void {
    const waiter = waiters.shift();
    if (waiter !== undefined) {
      waiter({ value: frame, done: false });
      return;
    }
    buffer.push(frame);
  }

  function end(): void {
    closed = true;
    for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  const frames: AsyncIterable<PreviewFrameV1> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<PreviewFrameV1>> {
          const buffered = buffer.shift();
          if (buffered !== undefined) return Promise.resolve({ value: buffered, done: false });
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
  };

  const session: PreviewSession = {
    identity: {
      mode: "preview",
      pageSlug,
      sourceHash: TEST_SHA,
      kitApiVersion: 1,
      sessionId: previewSessionId,
    },
    mode: "preview",
    interactionMode: "static",
    frames,
    resize(): Promise<FailureDtoV1 | undefined> {
      return Promise.resolve(undefined);
    },
    setMode(): Promise<FailureDtoV1 | undefined> {
      return Promise.resolve(undefined);
    },
    setTheme(): Promise<FailureDtoV1 | undefined> {
      return Promise.resolve(undefined);
    },
    retry(): Promise<FailureDtoV1 | undefined> {
      return Promise.resolve(undefined);
    },
    close(): Promise<void> {
      end();
      return Promise.resolve();
    },
    query(frameToken, query): Promise<FailureDtoV1 | PreviewGeometryQueryResultV1> {
      queries.push({ frameToken, query });
      return Promise.resolve(options.geometryResult ?? { result: {}, resolvedAnchor: null });
    },
  };

  const handle: PreviewSessionHandle = {
    previewSessionId,
    session,
    acknowledgeDisplay(frameToken): Error | FrameIdentityV1 {
      if (options.ackResult !== undefined) return options.ackResult(frameToken);
      return {
        previewSessionId,
        nonce: TEST_NONCE,
        sourceHash: TEST_SHA,
        frameSeq: "1",
      };
    },
  };

  return { handle, pushFrame, end, queries };
}
