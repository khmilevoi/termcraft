import type { FailureDtoV1 } from "core/protocol";

import type { HostSessionSpecV1, HostSupervisorPort, SupervisorEventV1 } from "../host-supervisor";
import type { AssertConforms } from "../index";
import type { PreviewSession } from "../preview-session";
import { createFakePreviewSession } from "./preview-session";

/**
 * In-memory {@link HostSupervisorPort} fake (6D task brief). `preview()` composes a fresh
 * {@link createFakePreviewSession} per call (mirroring blocker B4's resolution — this port
 * returns `PreviewSession`, not `PreviewHandle` — "host composes them") and wraps its
 * `close()` so closing the session ALSO retires it from this supervisor's own bookkeeping,
 * exactly as a real composed session would: `liveCount()` and `stopAll()` stay accurate
 * without the test having to manually track which sessions are still open.
 */

export type HostSupervisorFailableMethod = "preview";

export type HostSupervisorCall =
  | {
      readonly method: "preview";
      readonly pageSlug: string;
      /**
       * The spec's session key alongside the page it names (design-tree phase 2 Task 10) — the
       * real supervisor's `keyOf` is `(pageSlug, treeRevision)`, so recording only the slug
       * could not tell "the same session was reused" from "a second one was established".
       */
      readonly treeRevision: string;
      /**
       * The ENTRY file's own hash. Recorded next to the revision precisely because they are
       * DIFFERENT questions: a shared-module edit moves the revision and leaves this untouched,
       * which is exactly the case a test needs to be able to state.
       */
      readonly sourceHash: string;
    }
  | { readonly method: "liveCount" }
  | { readonly method: "stopAll" };

export interface FakeHostSupervisorPort extends HostSupervisorPort {
  readonly calls: readonly HostSupervisorCall[];
  failNext(method: HostSupervisorFailableMethod, failure: FailureDtoV1): void;
  /**
   * Deliver a lifecycle diagnostic to every `onEvent` subscriber, as the real supervisor's
   * own sink does. `preview()`/`close()` already emit `spawning`/`ready`/`stopped` themselves;
   * this is the seam for the ones no fake call produces — above all `circuitOpened`, which a
   * real host reaches only by crash-looping a live child.
   */
  emit(event: SupervisorEventV1): void;
}

export function createFakeHostSupervisorPort(): FakeHostSupervisorPort {
  const sessions = new Map<string, PreviewSession>();
  const listeners = new Set<(event: SupervisorEventV1) => void>();
  const calls: HostSupervisorCall[] = [];
  let nextSessionId = 0;

  const queues: Record<HostSupervisorFailableMethod, FailureDtoV1[]> = { preview: [] };

  function failNext(method: HostSupervisorFailableMethod, failure: FailureDtoV1): void {
    queues[method].push(failure);
  }

  function emit(event: SupervisorEventV1): void {
    for (const listener of listeners) listener(event);
  }

  async function preview(spec: HostSessionSpecV1): Promise<FailureDtoV1 | PreviewSession> {
    calls.push({
      method: "preview",
      pageSlug: spec.pageSlug,
      treeRevision: spec.treeRevision,
      sourceHash: spec.sourceHash,
    });
    const queued = queues.preview.shift();
    if (queued !== undefined) return queued;

    nextSessionId += 1;
    const sessionId = `fake-session-${nextSessionId}`;
    const key = sessionId;
    emit({
      type: "spawning",
      key,
      sessionId,
      pageSlug: spec.pageSlug,
      sourceHashPrefix: spec.sourceHash.slice(0, 8),
    });

    const inner = createFakePreviewSession(
      {
        mode: spec.mode,
        pageSlug: spec.pageSlug,
        sourceHash: spec.sourceHash,
        kitApiVersion: spec.kitApiVersion,
        sessionId,
      },
      {
        mode: spec.mode === "historical" ? "historical" : "preview",
        interactionMode: spec.interactionMode,
      },
    );
    const session: PreviewSession = {
      ...inner,
      async close() {
        await inner.close();
        sessions.delete(key);
        emit({
          type: "stopped",
          key,
          sessionId,
          pageSlug: spec.pageSlug,
          sourceHashPrefix: spec.sourceHash.slice(0, 8),
        });
      },
    };
    sessions.set(key, session);
    emit({
      type: "ready",
      key,
      sessionId,
      pageSlug: spec.pageSlug,
      sourceHashPrefix: spec.sourceHash.slice(0, 8),
    });
    return session;
  }

  function liveCount(): number {
    calls.push({ method: "liveCount" });
    return sessions.size;
  }

  async function stopAll(): Promise<void> {
    calls.push({ method: "stopAll" });
    await Promise.all([...sessions.values()].map((session) => session.close()));
  }

  function onEvent(listener: (event: SupervisorEventV1) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return { preview, liveCount, stopAll, onEvent, emit, calls, failNext };
}

type _Conforms = AssertConforms<HostSupervisorPort, FakeHostSupervisorPort>;
