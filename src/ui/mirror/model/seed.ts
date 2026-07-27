import type { CommandKindV1, EventPayloadByKindV1 } from "core/protocol";

import type { AgentIdentity, CapabilityState, ProjectMirror } from "../types";

type SnapshotPayload = EventPayloadByKindV1["kernel.snapshot"];

/** The project slice a `kernel.snapshot` establishes. */
export function projectFromSnapshot(payload: SnapshotPayload): ProjectMirror {
  return {
    projectId: payload.projectId,
    activePageSlug: payload.activePageSlug,
    activeChatId: payload.activeChatId,
    trust: payload.trust,
    // A snapshot carries no failure field — it describes the Kernel's CURRENT state, and a
    // `blocked` open's cause reaches the UI only as `kernel.project.blockOpen`'s own metadata.
    // Seeding `null` states "nothing known to have failed", never "nothing failed".
    openFailure: null,
    // A snapshot is a CURRENT-state description; the Kernel has no "an open is in flight" field
    // on it, and this fact reaches the UI only as `kernel.project.beginOpen`/`beginCreate`.
    opening: false,
  };
}

/**
 * The agent-identity slice a `kernel.snapshot` establishes (M22) — a structural passthrough of
 * `payload.agentIdentity`, kept as its own named seed function (matching `projectFromSnapshot`/
 * `capabilitiesFromSnapshot`) so `mirror.ts`'s `kernel.snapshot` case reads uniformly.
 */
export function agentIdentityFromSnapshot(payload: SnapshotPayload): AgentIdentity {
  return payload.agentIdentity;
}

/**
 * Builds the capability map from a snapshot's capability list, keyed by command kind.
 *
 * DOCUMENTED SIMPLIFICATION: capabilities are keyed by `(id, target)` in the contract, but
 * the MVP action table's rows are single-target (turn.start, export.start, chat.create, …),
 * so the mirror collapses to a `CommandKindV1 -> CapabilityState` map — last entry per id
 * wins. Per-entity contextual actions (e.g. resolving a specific pin) read capabilities more
 * narrowly in their own slice rather than from this global map.
 */
export function capabilitiesFromSnapshot(
  payload: SnapshotPayload,
): ReadonlyMap<CommandKindV1, CapabilityState> {
  const map = new Map<CommandKindV1, CapabilityState>();
  for (const entry of payload.capabilities) map.set(entry.id, entry.state);
  return map;
}
