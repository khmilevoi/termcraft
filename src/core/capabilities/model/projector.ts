import { canonicalJson, type CommandKindV1 } from "core/protocol"

import type { CapabilityEntry, CapabilityRecord, KernelStateSnapshot } from "../types"
import { evaluateCapabilityGuard } from "./guards"
import type { CapabilityTargetByKindV1 } from "./target"

/**
 * The capability projector (kernel-command-contract §10.2, lines 905-921): "The capability
 * projector calls the SAME function over the current state and the same normalized
 * target." {@link projectCapability} calls {@link evaluateCapabilityGuard} directly —
 * there is no second implementation to keep in sync — which is what makes §10.2's parity
 * invariant a structural fact: "for the same state and target, a published available
 * capability must let a direct current-revision command pass the guard, and an
 * unavailable capability must reject it with the same primary code." §13.2 requires this
 * be exercised as a property test; see `projector.test.ts`.
 */
export function projectCapability<K extends CommandKindV1>(
  kind: K,
  target: CapabilityTargetByKindV1[K],
  state: KernelStateSnapshot,
): CapabilityEntry<K> {
  return { id: kind, target, state: evaluateCapabilityGuard(kind, target, state) }
}

/**
 * Projects a heterogeneous batch of `(id, target)` requests in one pass, each through the
 * same {@link evaluateCapabilityGuard}. This is `core/mailbox`'s eventual `kernel.snapshot`
 * assembly point (§9: "complete `capabilities`") and the input to {@link diffCapabilities}.
 */
export function projectCapabilities(
  requests: readonly Readonly<{ id: CommandKindV1; target: unknown }>[],
  state: KernelStateSnapshot,
): readonly CapabilityRecord[] {
  return requests.map((request) => ({
    id: request.id,
    target: request.target,
    state: evaluateCapabilityGuard(request.id, request.target, state),
  }))
}

/**
 * `kernel.capabilitiesChanged`'s payload shape (§9 row, KCC:795): "Complete replacement
 * `CapabilityEntry` values for every changed `(id,target)` key and `removed` keys for
 * targets no longer published."
 */
export interface CapabilityChangeSet {
  readonly changed: readonly CapabilityRecord[]
  readonly removed: readonly Readonly<{ id: CommandKindV1; target: unknown }>[]
}

/** A stable, key-order-independent serialization of a value, for use as a Map/Set key. */
function stableJson(value: unknown): string {
  const json = canonicalJson(value)
  if (json instanceof Error) {
    console.warn(`core/capabilities projector: failed to canonicalize a capability key/state — ${json.message}`)
    return JSON.stringify(value)
  }
  return json
}

function capabilityKey(entry: Readonly<{ id: CommandKindV1; target: unknown }>): string {
  return `${entry.id}::${stableJson(entry.target)}`
}

/**
 * Diffs two published capability sets by `(id, target)` key. An entry is `changed` when
 * its key is new, or when its key already existed but `state` differs; an entry is
 * `removed` when its key existed in `previous` and is absent from `next` — §9's "targets
 * no longer published." An unchanged key (same key, byte-identical `state`) appears in
 * neither list, which is what keeps `kernel.capabilitiesChanged` a true diff rather than a
 * repeat of the full set on every publish.
 */
export function diffCapabilities(
  previous: readonly CapabilityRecord[],
  next: readonly CapabilityRecord[],
): CapabilityChangeSet {
  const previousByKey = new Map(previous.map((entry) => [capabilityKey(entry), entry]))
  const nextKeys = new Set(next.map((entry) => capabilityKey(entry)))

  const changed = next.filter((entry) => {
    const prior = previousByKey.get(capabilityKey(entry))
    if (prior === undefined) return true
    return stableJson(prior.state) !== stableJson(entry.state)
  })

  const removed = previous
    .filter((entry) => !nextKeys.has(capabilityKey(entry)))
    .map((entry) => ({ id: entry.id, target: entry.target }))

  return { changed, removed }
}
