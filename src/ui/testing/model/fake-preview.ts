import type { PreviewFrameV1, PreviewGeometryQueryResultV1, PreviewSession } from "core/ports";
import type { FailureDtoV1, FrameIdentityV1, FrameTokenV1, UUIDv7 } from "core/protocol";
import { uuidv7 } from "infrastructure/uuid";
import type { PreviewSessionHandle, UiPreviewFrame } from "ui/kernel";

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
  /** The deterministic token paired with a frame that was pushed into this fake. */
  frameTokenFor(frame: PreviewFrameV1): FrameTokenV1;
  /** Number of open display-frame iterators, including a consumer blocked on `next()`. */
  activeFrameConsumers(): number;
  /** Closes the `frames` stream. */
  end(): void;
  /** Raw geometry-query calls the session received. */
  readonly queries: readonly { frameToken: FrameTokenV1; query: unknown }[];
  /** Exact frame tokens acknowledged by the UI, in call order. */
  readonly acknowledgements: readonly FrameTokenV1[];
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
  const acknowledgements: FrameTokenV1[] = [];

  const sourceFrames = createAsyncQueue<PreviewFrameV1>();
  const displayFrames = createAsyncQueue<UiPreviewFrame>();
  const frameTokens = new Map<PreviewFrameV1, FrameTokenV1>();

  function frameTokenFor(frame: PreviewFrameV1): FrameTokenV1 {
    const token = frameTokens.get(frame);
    if (token === undefined) throw new Error("frame was not pushed into this fake preview session");
    return token;
  }

  function pushFrame(frame: PreviewFrameV1): void {
    const frameToken = uuidv7();
    frameTokens.set(frame, frameToken);
    sourceFrames.push(frame);
    displayFrames.push({ frame, frameToken, handle });
  }

  function end(): void {
    sourceFrames.end();
    displayFrames.end();
  }

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
    frames: sourceFrames.iterable,
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
    frames: displayFrames.iterable,
    acknowledgeDisplay(frameToken): Error | FrameIdentityV1 {
      acknowledgements.push(frameToken);
      if (options.ackResult !== undefined) return options.ackResult(frameToken);
      return {
        previewSessionId,
        nonce: TEST_NONCE,
        sourceHash: TEST_SHA,
        frameSeq: "1",
      };
    },
  };

  return {
    handle,
    pushFrame,
    frameTokenFor,
    activeFrameConsumers: displayFrames.activeConsumers,
    end,
    queries,
    acknowledgements,
  };
}

function createAsyncQueue<T>() {
  const buffer: T[] = [];
  const waiters: ((result: IteratorResult<T>) => void)[] = [];
  const consumers = new Set<AsyncIterator<T>>();
  let closed = false;

  return {
    push(value: T): void {
      const waiter = waiters.shift();
      if (waiter !== undefined) {
        waiter({ value, done: false });
        return;
      }
      buffer.push(value);
    },
    end(): void {
      closed = true;
      for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true });
    },
    activeConsumers(): number {
      return consumers.size;
    },
    iterable: {
      [Symbol.asyncIterator]() {
        let waiter: ((result: IteratorResult<T>) => void) | null = null;
        let resolveNext: ((result: IteratorResult<T>) => void) | null = null;
        let done = false;
        const iterator: AsyncIterator<T> = {
          next(): Promise<IteratorResult<T>> {
            if (done) return Promise.resolve({ value: undefined, done: true });
            const buffered = buffer.shift();
            if (buffered !== undefined) return Promise.resolve({ value: buffered, done: false });
            if (closed)
              return iterator.return?.() ?? Promise.resolve({ value: undefined, done: true });
            return new Promise((resolve) => {
              resolveNext = resolve;
              waiter = (result) => {
                waiter = null;
                resolveNext = null;
                if (result.done) {
                  done = true;
                  consumers.delete(iterator);
                }
                resolve(result);
              };
              waiters.push(waiter);
            });
          },
          return(): Promise<IteratorResult<T>> {
            if (done) return Promise.resolve({ value: undefined, done: true });
            done = true;
            consumers.delete(iterator);
            if (waiter !== null) {
              const index = waiters.indexOf(waiter);
              if (index >= 0) waiters.splice(index, 1);
              waiter = null;
              resolveNext?.({ value: undefined, done: true });
              resolveNext = null;
            }
            return Promise.resolve({ value: undefined, done: true });
          },
        };
        consumers.add(iterator);
        return iterator;
      },
    } satisfies AsyncIterable<T>,
  };
}
