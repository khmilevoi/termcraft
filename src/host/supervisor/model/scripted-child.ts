// TEST DOUBLE — a deterministic in-memory SpawnedChild + reply framers. Not part
// of the public supervisor surface (never re-exported from index.ts). Lets the
// transport/handshake/session suites drive the supervisor with no subprocess
// (host-supervision §14.4 "scripted fake host"). Framing/encoding reuse 2A.
import { encodeFrame } from "infrastructure/framing";

import {
  ProtocolError,
  encodeControlEnvelope,
  encodeFrameEnvelope,
  encodeHostHello,
} from "../../protocol";
import type { ControlEnvelope, FrameEnvelope, HostHelloV1 } from "../../protocol";
import type { ChildStdin, SpawnedChild } from "../types";

/** Frame a `host.hello` (control class) with the 2A codec. */
export function frameHostHello(hello: HostHelloV1): ProtocolError | Uint8Array {
  return encodeHostHello(hello);
}
/** Frame any post-handshake control envelope (`ready`, `shutdown-ack`, `heartbeat`, `error`, …). */
export function frameControl(envelope: ControlEnvelope): ProtocolError | Uint8Array {
  return encodeControlEnvelope(envelope);
}
/** Alias for a `ready` control envelope, for reader intent. */
export const frameReady = frameControl;
/** Frame a full `frame` envelope (data class) with the 2A codec. */
export function frameFrame(frame: FrameEnvelope): ProtocolError | Uint8Array {
  return encodeFrameEnvelope(frame);
}
/** Frame arbitrary raw control-class bytes (for malformed-input tests). */
export function frameRawControl(payload: Uint8Array): Uint8Array {
  const framed = encodeFrame({ messageClass: "control", payload });
  if (framed instanceof Error) throw framed;
  return framed;
}

export interface ScriptedChild extends SpawnedChild {
  emit(bytes: Uint8Array): void;
  endStdout(): void;
  emitStderr(bytes: Uint8Array): void;
  simulateExit(options?: { code?: number; signal?: string }): void;
  readonly written: Uint8Array[];
  onWrite?: (bytes: Uint8Array) => void;
  /**
   * Test control (§8 outbound-queue backpressure tests): while held, `stdin.write` returns
   * a promise that stays pending until `releaseWrites()` — the write is still recorded
   * (`written`/`onWrite` fire immediately, matching real stdin's synchronous buffering), but
   * the CALLER'S `await writeFramed(...)` does not resolve, so a queue's own drain loop
   * genuinely cannot advance past the held write. Lets a test fill a bounded outbound queue
   * to its real capacity without racing microtask timing.
   */
  holdWrites(): void;
  releaseWrites(): void;
}

/** A minimal async queue: `push`/`end` producer, `[Symbol.asyncIterator]` consumer. */
function createByteQueue() {
  const buffer: Uint8Array[] = [];
  let done = false;
  let wake: (() => void) | null = null;
  const signal = () => {
    const w = wake;
    wake = null;
    w?.();
  };
  return {
    push(bytes: Uint8Array) {
      if (done) return;
      buffer.push(bytes);
      signal();
    },
    end() {
      done = true;
      signal();
    },
    async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      while (true) {
        if (buffer.length > 0) {
          yield buffer.shift() as Uint8Array;
          continue;
        }
        if (done) return;
        await new Promise<void>((resolve) => (wake = resolve));
      }
    },
  };
}

/**
 * A scripted child. `stdin.write` captures bytes (and calls `onWrite`, letting a
 * test auto-respond to the supervisor's messages); `emit`/`endStdout` drive the
 * stdout stream; `simulateExit`/`kill` resolve `exited`. `kill()` mirrors the
 * D2 forced-kill shape (code 143, `signalCode:"SIGTERM"`).
 */
export function createScriptedChild(onWrite?: (bytes: Uint8Array) => void): ScriptedChild {
  const stdout = createByteQueue();
  const stderr = createByteQueue();
  const written: Uint8Array[] = [];
  let exitCode: number | null = null;
  let signalCode: string | null = null;
  let settled = false;
  const { promise: exited, resolve: resolveExited } = Promise.withResolvers<number>();

  const settle = (code: number, signal: string | null) => {
    if (settled) return;
    settled = true;
    exitCode = signal === null ? code : null;
    signalCode = signal;
    stdout.end();
    stderr.end();
    resolveExited(code);
  };

  let holding = false;
  let heldWrites: (() => void)[] = [];

  const stdin: ChildStdin = {
    write(bytes) {
      written.push(bytes);
      child.onWrite?.(bytes);
      if (!holding) return true;
      return new Promise<void>((resolve) => heldWrites.push(resolve));
    },
    flush() {
      return true;
    },
    end() {
      return true;
    },
  };

  const child: ScriptedChild = {
    stdin,
    stdout,
    stderr,
    exited,
    get exitCode() {
      return exitCode;
    },
    get signalCode() {
      return signalCode;
    },
    kill() {
      settle(143, "SIGTERM");
    },
    emit: (bytes) => stdout.push(bytes),
    endStdout: () => stdout.end(),
    emitStderr: (bytes) => stderr.push(bytes),
    simulateExit: (options) => settle(options?.code ?? 0, options?.signal ?? null),
    holdWrites: () => {
      holding = true;
    },
    releaseWrites: () => {
      holding = false;
      const resolvers = heldWrites;
      heldWrites = [];
      for (const resolve of resolvers) resolve();
    },
    written,
    onWrite,
  };
  return child;
}
