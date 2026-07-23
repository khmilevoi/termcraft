import type { EventKindV1, EventPayloadByKindV1 } from "core/protocol";
import { uuidv7 } from "infrastructure/uuid";
import type { EventCorrelationV1, EventOf } from "ui/kernel";

/**
 * Test builders for well-formed `EventEnvelopeV1`s and `kernel.snapshot` payloads. Shared by
 * `FakeKernel` and the mirror/screen tests so envelope shape lives in one place. Values are
 * schema-shaped (canonical UUIDv7 ids, 64/32-hex hashes, RFC3339 timestamps) even though the
 * mirror reducer does not validate — keeping them valid means the same builders drive the
 * FakeKernel and any future validation without change.
 */

/** A fixed valid 64-char lowercase SHA-256 hex, for tests that don't care about the value. */
export const TEST_SHA = "0".repeat(64);
/** A fixed valid 32-char lowercase host nonce. */
export const TEST_NONCE = "0".repeat(32);
/** A fixed valid RFC3339 UTC timestamp. */
export const TEST_TS = "2026-07-22T00:00:00.000Z";
/** A stable kernel-instance id for a test session. */
export const TEST_KERNEL_INSTANCE_ID = uuidv7();

let nextSeq = 1;

/** Resets the monotonic `eventSeq` counter — call in `beforeEach` for deterministic sequences. */
export function resetEventSeq(): void {
  nextSeq = 1;
}

export interface EventOptions {
  readonly eventSeq?: string;
  readonly stateRevision?: string;
  readonly kernelInstanceId?: string;
  readonly correlation?: EventCorrelationV1;
}

/** Builds one `EventEnvelopeV1<K>` with sensible, overridable envelope fields. */
export function event<K extends EventKindV1>(
  kind: K,
  payload: EventPayloadByKindV1[K],
  options: EventOptions = {},
): EventOf<K> {
  const seq = options.eventSeq ?? String(nextSeq++);
  const base = {
    protocolVersion: 1 as const,
    kernelInstanceId: options.kernelInstanceId ?? TEST_KERNEL_INSTANCE_ID,
    eventSeq: seq,
    stateRevision: options.stateRevision ?? seq,
    kind,
    payload,
  };
  return (
    options.correlation === undefined ? base : { ...base, correlation: options.correlation }
  ) as EventOf<K>;
}

/**
 * Builds a complete `kernel.snapshot` payload; `overrides` merge over an empty-project
 * default. Every model sits at its machine's real initial phase (§7.1-§7.7's `initial`).
 */
export function snapshotPayload(
  overrides: Partial<EventPayloadByKindV1["kernel.snapshot"]> = {},
): EventPayloadByKindV1["kernel.snapshot"] {
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
    gitStatus: { repositoryId: "test-repo", head: null, sequencerState: "idle", scopes: {} },
    agentIdentity: null,
    eventSeq: "0",
    ...overrides,
  };
}

/** Builds a `kernel.snapshot` envelope from a partial payload. */
export function snapshot(
  overrides: Partial<EventPayloadByKindV1["kernel.snapshot"]> = {},
  options: EventOptions = {},
): EventOf<"kernel.snapshot"> {
  return event("kernel.snapshot", snapshotPayload(overrides), options);
}
