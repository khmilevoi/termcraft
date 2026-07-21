import type { CommandKindV1, EventPayloadByKindV1 } from "core/protocol";

import type { CapabilityState, ProjectMirror } from "../types";

type SnapshotPayload = EventPayloadByKindV1["kernel.snapshot"];

/** The project slice a `kernel.snapshot` establishes. */
export function projectFromSnapshot(payload: SnapshotPayload): ProjectMirror {
  return {
    projectId: payload.projectId,
    activePageSlug: payload.activePageSlug,
    activeChatId: payload.activeChatId,
    trust: payload.trust,
  };
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
