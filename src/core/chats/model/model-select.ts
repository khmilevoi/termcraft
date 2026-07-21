import type { AgentRegistry, ProjectStore } from "core/ports"
import type { FailureDtoV1 } from "core/protocol"

import type { ModelSelectionRejectionV1, ModelSelectionV1 } from "../types"

/**
 * `model.select` (kernel-command-contract §8.2): "Validate backend capability and store
 * the machine-local selection." `core/capabilities/model/guards.ts`'s own header states
 * `model.select` "has no machine of its own among the seven" state machines, so no guard
 * validates the (backend, model, effort) triple against `AgentRegistry.list()` before this
 * function runs — THIS is where that validation actually happens.
 *
 * No §11.1 code names "unknown backend/model/effort" specifically. `core/capabilities/
 * model/guards.ts` already established the precedent for exactly this situation — "No
 * §11.1 code names ... this reuses `CAPABILITY_UNAVAILABLE`, §11.1's own designated
 * fallback 'for a guard reason that has no more specific public code'" — so this module
 * reuses the SAME fallback rather than inventing a new closed-union member.
 */

/** Pure validation: does `AgentRegistry.list()` actually offer this exact (backend, model, effort) triple? */
export function validateModelSelection(
  registry: AgentRegistry,
  selection: ModelSelectionV1,
): ModelSelectionRejectionV1 | ModelSelectionV1 {
  const backend = registry.list().find((candidate) => candidate.backendId === selection.backend)
  if (backend === undefined) return { code: "CAPABILITY_UNAVAILABLE" }

  const model = backend.models.find((candidate) => candidate.model === selection.model)
  if (model === undefined) return { code: "CAPABILITY_UNAVAILABLE" }

  if (!model.efforts.includes(selection.effort as (typeof model.efforts)[number])) {
    return { code: "CAPABILITY_UNAVAILABLE" }
  }

  return selection
}

export interface SelectModelDeps {
  readonly registry: AgentRegistry
  readonly projectStore: ProjectStore
}

export type SelectModelResultV1 = { readonly kind: "selected" }

export async function selectModel(
  deps: SelectModelDeps,
  selection: ModelSelectionV1,
): Promise<FailureDtoV1 | ModelSelectionRejectionV1 | SelectModelResultV1> {
  const validated = validateModelSelection(deps.registry, selection)
  if ("code" in validated) return validated

  const written = await deps.projectStore.writeWorkspaceState({
    backend: validated.backend,
    model: validated.model,
    effort: validated.effort,
  })
  if (written !== undefined) return written

  return { kind: "selected" }
}
