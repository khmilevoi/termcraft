import { describe, expect, test } from "bun:test";

import { context } from "@reatom/core";

import { createEventBus } from "core/mailbox";
import type { PublishableEventV1 } from "core/mailbox";
import type { EventPayloadByKindV1 } from "core/protocol";

import { createKernelCounters } from "./counters";
import { publishOperationEvents } from "./operation-publish";

/**
 * `publishOperationEvents` — the shared revision/publish semantics `kernel.ts`'s own
 * `runLaunchedOperation` (launchOperation's terminal batch) and `publishOperationEvent`
 * (the live-publish primitive, kernel-assembly Task 9 Step C3 deliverable B) both call,
 * rather than each hand-rolling its own copy of "advance iff non-empty, then publish
 * through the SAME bus." Tested directly against a real `createKernelCounters()` +
 * `createEventBus(...)` pair — the same construction `event-bus.test.ts` itself uses —
 * rather than a hand-rolled fake bus, so this proves the REAL wiring, not an approximation.
 */

/** A minimal valid `kernel.snapshot` payload minus `eventSeq` — mirrors `event-bus.test.ts`'s own fixture. */
function fakeSnapshotPayload(): Omit<EventPayloadByKindV1["kernel.snapshot"], "eventSeq"> {
  return {
    models: {
      project: { phase: "closed", trust: null },
      turn: { phase: "idle", activeTurnId: null, commitIntentRecorded: false },
      restore: { phase: "idle" },
      commit: { phase: "idle" },
      export: { phase: "idle" },
      preview: { phase: "disabled", sourceKind: null },
      migration: { phase: "idle" },
    },
    projectId: null,
    activePageSlug: null,
    activeChatId: null,
    trust: null,
    capabilities: [],
    pageDescriptors: [],
    gitStatus: { repositoryId: "repo", head: null, sequencerState: "none", scopes: {} },
    agentIdentity: null,
  };
}

/** A trivial, always-schema-valid event: `selection.changed`'s payload may be bare `null`. */
function selectionEvent(): PublishableEventV1<"selection.changed"> {
  return { kind: "selection.changed", payload: null };
}

describe("publishOperationEvents", () => {
  test("an empty batch returns null, advances no revision, and publishes nothing", () => {
    context.start(() => {
      const counters = createKernelCounters();
      const eventBus = createEventBus({ counters, buildSnapshotPayload: fakeSnapshotPayload });
      const before = counters.stateRevision();

      const result = publishOperationEvents({ counters, eventBus }, []);

      expect(result).toBeNull();
      expect(counters.stateRevision()).toBe(before);
    });
  });

  test("a non-empty batch advances the revision by exactly one and publishes schema-valid envelopes", () => {
    context.start(() => {
      const counters = createKernelCounters();
      const eventBus = createEventBus({ counters, buildSnapshotPayload: fakeSnapshotPayload });
      const before = BigInt(counters.stateRevision());

      const result = publishOperationEvents({ counters, eventBus }, [selectionEvent()]);

      if (result === null || result instanceof Error) throw new Error("expected envelopes");
      expect(BigInt(counters.stateRevision())).toBe(before + 1n);
      expect(result).toHaveLength(1);
      const [envelope] = result;
      if (envelope === undefined) throw new Error("expected exactly one envelope");
      expect(envelope.stateRevision).toBe(counters.stateRevision());
      expect(envelope.kind).toBe("selection.changed");
    });
  });

  test("callable any number of times over one operation's lifetime, each call bumping the revision once", () => {
    context.start(() => {
      const counters = createKernelCounters();
      const eventBus = createEventBus({ counters, buildSnapshotPayload: fakeSnapshotPayload });
      const before = BigInt(counters.stateRevision());

      const first = publishOperationEvents({ counters, eventBus }, [selectionEvent()]);
      const second = publishOperationEvents({ counters, eventBus }, [selectionEvent()]);
      const third = publishOperationEvents({ counters, eventBus }, [selectionEvent()]);

      if (first instanceof Error || second instanceof Error || third instanceof Error) {
        throw new Error("expected every call to publish");
      }
      expect(BigInt(counters.stateRevision())).toBe(before + 3n);
    });
  });

  test("a batch whose payload fails its own schema returns the EventBusPayloadError and still advances the revision (mirrors publishTransition's own all-or-nothing validation)", () => {
    context.start(() => {
      const counters = createKernelCounters();
      const eventBus = createEventBus({ counters, buildSnapshotPayload: fakeSnapshotPayload });
      const before = BigInt(counters.stateRevision());

      const malformed = {
        kind: "selection.changed",
        payload: { not: "the real shape" },
      } as unknown as PublishableEventV1;
      const result = publishOperationEvents({ counters, eventBus }, [malformed]);

      expect(result instanceof Error).toBe(true);
      // The revision bump happens BEFORE the publish call — this documents that ordering
      // rather than hiding it: a schema-invalid event is a defensive-only, unreachable-in-
      // practice case (every event a handler builds already passed its own kind's schema
      // before this point), so this test pins the observable behavior, not a design goal.
      expect(BigInt(counters.stateRevision())).toBe(before + 1n);
    });
  });
});
