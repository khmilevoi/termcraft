import type { CommandResultV1, EventPayloadByKindV1 } from "core/protocol";
import type {
  AnyEventEnvelope,
  EventEnvelopeV1,
  KernelPort,
  PreviewSessionHandle,
} from "ui/kernel";

import { snapshotPayload } from "./events";

/**
 * A scriptable `KernelPort` double for `ui` tests (phase-7 plan 7A). It:
 * - delivers a configurable `kernel.snapshot` synchronously on `subscribe` (the real bus's
 *   bootstrap contract), then streams whatever the test `emit`s;
 * - records every raw command envelope `dispatch` received, for assertions;
 * - returns a canned `CommandResultV1` (accepted-completed by default, echoing the raw's
 *   `commandId`), overridable per test;
 * - hands out a preview handle the test can set.
 *
 * It lives under `ui/testing` — not `core/ports/fakes` — because `ui` may not import `core`
 * adapter fakes; this double is typed purely against the `ui`-declared `KernelPort`.
 */
export interface FakeKernel extends KernelPort {
  /** Delivers one event to every current subscriber. */
  emit(envelope: AnyEventEnvelope): void;
  /** Raw command envelopes passed to `dispatch`, in order. */
  readonly dispatched: readonly unknown[];
  /** Replaces the bootstrap snapshot payload delivered to future subscribers. */
  setSnapshot(overrides: Partial<EventPayloadByKindV1["kernel.snapshot"]>): void;
  /** Overrides the result future `dispatch` calls resolve to. */
  setDispatchResult(result: Error | CommandResultV1): void;
  /** Sets (or clears) the live preview handle `preview()` returns. */
  setPreview(handle: PreviewSessionHandle | null): void;
  /** Number of currently-registered subscribers (for lifetime assertions). */
  subscriberCount(): number;
}

export interface FakeKernelOptions {
  readonly snapshot?: Partial<EventPayloadByKindV1["kernel.snapshot"]>;
  readonly dispatchResult?: Error | CommandResultV1;
}

function acceptedFor(raw: unknown): CommandResultV1 {
  const commandId = (raw as { commandId?: unknown }).commandId;
  return {
    protocolVersion: 1,
    commandId: (typeof commandId === "string" ? commandId : "") as CommandResultV1["commandId"],
    status: "accepted",
    acceptedRevision: "0",
    resultingRevision: "0",
    disposition: "completed",
  };
}

export function createFakeKernel(options: FakeKernelOptions = {}): FakeKernel {
  const subscribers = new Set<(envelope: EventEnvelopeV1) => void>();
  const dispatched: unknown[] = [];
  let snapshotOverrides = options.snapshot ?? {};
  let dispatchResult: Error | CommandResultV1 | null = options.dispatchResult ?? null;
  let previewHandle: PreviewSessionHandle | null = null;

  return {
    dispatched,
    dispatch(raw: unknown): Promise<Error | CommandResultV1> {
      dispatched.push(raw);
      return Promise.resolve(dispatchResult ?? acceptedFor(raw));
    },
    subscribe(handler: (envelope: EventEnvelopeV1) => void): Error | (() => void) {
      // The real bus delivers one snapshot synchronously, before returning the unsubscribe.
      handler({
        protocolVersion: 1,
        kernelInstanceId: "" as never,
        eventSeq: "0",
        stateRevision: "0",
        kind: "kernel.snapshot",
        payload: snapshotPayload(snapshotOverrides),
      } as EventEnvelopeV1);
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    },
    preview(): PreviewSessionHandle | null {
      return previewHandle;
    },
    emit(envelope: AnyEventEnvelope): void {
      for (const handler of [...subscribers]) handler(envelope as EventEnvelopeV1);
    },
    setSnapshot(overrides): void {
      snapshotOverrides = overrides;
    },
    setDispatchResult(result): void {
      dispatchResult = result;
    },
    setPreview(handle): void {
      previewHandle = handle;
    },
    subscriberCount(): number {
      return subscribers.size;
    },
  };
}
