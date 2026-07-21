import { wrap } from "@reatom/core"

import { MAX_TURN_ATTEMPT, canRetryAfterGate, type StateMachine, type TurnAction, type TurnAttempt, type TurnState } from "core/machines"
import type { GateErrorV1, GatePageDescriptorV1, GateRunner, GateWarningV1, ManifestSliceV1 } from "core/ports"
import type { PublishableEventV1 } from "core/mailbox"
import type { EventPayloadByKindV1, FailureDtoV1, UUIDv7 } from "core/protocol"
import type { PageSlug } from "entities/page"

/**
 * Gate validation over one frozen candidate — the `validating` sub-phase's own work
 * (kernel-command-contract §7.2 line 238 prose; master §6.3 step 1; §9 row for
 * `turn.gateRejected`, KCC:801).
 *
 * ENTRY ASSUMED, NOT DRIVEN: this file assumes the machine is already `validating`
 * (`candidate.ts`'s own `candidateCaptured` job) and drives only the ONE transition its own
 * outcome can legally require — `retryAfterGate` (`validating -> workspace-ready`), and only
 * while `attempt < 4` (`canRetryAfterGate`, `core/machines`). On a PASS or an EXHAUSTED
 * rejection it drives no transition at all: `beginFinalization` (pass) and
 * `beginTerminalization` (exhausted) both belong to "whichever caller decided" — the same
 * documented split `finalize.ts`/`terminalize.ts` use for the identical shape of decision.
 *
 * ORDER: the manifest-slice check (master §6.3 step 1) runs EXACTLY ONCE PER TURN, before any
 * per-page stage — never interleaved, never repeated per page. Every page then runs the full
 * `GateRunner.runPage` pipeline regardless of whether an earlier page already failed, so a
 * rejection carries the COMPLETE set of diagnostics across every page in one report, not just
 * the first failure.
 */

export interface TurnValidationDeps {
  readonly machine: StateMachine<TurnState, TurnAction>
  readonly gateRunner: GateRunner
  readonly publish: (event: PublishableEventV1<"turn.gateRejected">) => void
}

export interface TurnValidationPageInputV1 {
  readonly pageSlug: PageSlug
  readonly source: string
  readonly fileName?: string
}

export interface RunTurnValidationInputV1 {
  readonly turnId: UUIDv7
  readonly attempt: TurnAttempt
  readonly manifestText: string
  readonly pages: readonly TurnValidationPageInputV1[]
}

type TurnGateDiagnosticsV1 = EventPayloadByKindV1["turn.gateRejected"]["diagnostics"]

export type TurnValidationResultV1 =
  | { readonly kind: "passed"; readonly slice: ManifestSliceV1; readonly descriptors: readonly GatePageDescriptorV1[]; readonly warnings: readonly GateWarningV1[] }
  | { readonly kind: "retry"; readonly nextAttempt: TurnAttempt; readonly diagnostics: TurnGateDiagnosticsV1 }
  | { readonly kind: "exhausted"; readonly failure: FailureDtoV1; readonly diagnostics: TurnGateDiagnosticsV1 }

/** §7.2: "Attempts are integers 1 through 4"; `canRetryAfterGate` already excludes `MAX_TURN_ATTEMPT` from calling this. */
function nextAttemptAfter(attempt: TurnAttempt): TurnAttempt {
  if (attempt === 1) return 2
  if (attempt === 2) return 3
  return 4 // attempt === 3 (MAX_TURN_ATTEMPT - 1)
}

/**
 * `gate/types.ts`'s `GateErrorKind`/`GateWarningKind` mark `file`/`line`/`column` OPTIONAL
 * (`?`) — `core/ports/gate-runner.ts`'s narrow redraw keeps that shape verbatim, since it is
 * not itself a Kernel protocol DTO. The Kernel wire DTO (`event-payload.ts`'s
 * `TurnGateDiagnosticsV1`) is strict and NULLABLE for the same fields (this file's own
 * binding rule: "the Kernel-side echo widens them to `.nullable()`"), so an explicit
 * `undefined -> null` conversion sits at exactly this one boundary, never leaking the gap
 * to either side.
 */
function toGateErrorDto(error: GateErrorV1): TurnGateDiagnosticsV1["errors"][number] {
  return { kind: error.kind, code: error.code, message: error.message, file: error.file ?? null, line: error.line ?? null, column: error.column ?? null }
}
function toGateWarningDto(warning: GateWarningV1): TurnGateDiagnosticsV1["warnings"][number] {
  return { kind: warning.kind, message: warning.message, line: warning.line ?? null, column: warning.column ?? null }
}

function gateRetryExhaustedFailure(): FailureDtoV1 {
  return {
    code: "GATE_RETRY_EXHAUSTED",
    retryable: false,
    safeMessage: `Gate rejected the candidate after exhausting the ${MAX_TURN_ATTEMPT}-attempt budget.`,
    details: {},
  }
}

export async function runTurnValidation(deps: TurnValidationDeps, input: RunTurnValidationInputV1): Promise<TurnValidationResultV1> {
  const presentSlugs = input.pages.map((page) => page.pageSlug)
  const sliceResult = await wrap(deps.gateRunner.runManifestSlice({ manifestText: input.manifestText, presentSlugs }))

  const errors: GateErrorV1[] = [...sliceResult.errors]
  const warnings: GateWarningV1[] = []
  const descriptors: GatePageDescriptorV1[] = []

  for (const page of input.pages) {
    const pageResult = await wrap(
      deps.gateRunner.runPage({ source: page.source, slug: page.pageSlug, ...(page.fileName !== undefined ? { fileName: page.fileName } : {}) }),
    )
    errors.push(...pageResult.errors)
    warnings.push(...pageResult.warnings)
    if (pageResult.descriptor !== null) descriptors.push(pageResult.descriptor)
  }

  if (errors.length === 0) {
    const slice = sliceResult.slice ?? { pages: presentSlugs, active: null }
    return { kind: "passed", slice, descriptors, warnings }
  }

  const diagnostics: TurnGateDiagnosticsV1 = { errors: errors.map(toGateErrorDto), warnings: warnings.map(toGateWarningDto) }
  deps.publish({
    kind: "turn.gateRejected",
    payload: { turnId: input.turnId, attempt: input.attempt, retryNumber: input.attempt - 1, diagnostics },
    correlation: { turnId: input.turnId },
  })

  if (canRetryAfterGate(input.attempt)) {
    const retried = deps.machine.apply("retryAfterGate")
    if (retried.kind === "illegal") {
      console.warn(`core/turns/validation: retryAfterGate illegal (${retried.code}) for turn ${input.turnId}`)
    }
    return { kind: "retry", nextAttempt: nextAttemptAfter(input.attempt), diagnostics }
  }

  return { kind: "exhausted", failure: gateRetryExhaustedFailure(), diagnostics }
}
