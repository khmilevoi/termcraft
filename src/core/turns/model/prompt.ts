import * as errore from "errore"

import type { TurnAttempt } from "core/machines"
import type { EventPayloadByKindV1 } from "core/protocol"

/**
 * Folding a rejected attempt's Gate diagnostics into the RETRY attempt's prompt
 * (kernel-command-contract §7.2's retry arc; master §6.3's determinism-warning vocabulary).
 *
 * Pure and port-free: `validation.ts` decides WHETHER a retry happens (Gate rejection,
 * `attempt < 4`) and hands this module exactly the diagnostics it emitted on
 * `turn.gateRejected` — this module only turns them into prompt text, and never re-derives
 * the retry decision itself.
 *
 * THE FRESHNESS BARRIER: diagnostics are meaningful ONLY for the attempt immediately after
 * the one Gate rejected — `nextAttempt === rejectedAttempt + 1`, §7.2's own increment rule
 * for a retry ("increments `attempt`"). Anything else (the same attempt again, a skipped
 * attempt, or a caller accidentally re-folding stale diagnostics from an earlier rejection
 * into a LATER attempt's prompt) is refused rather than silently rendered — a stale fold
 * would tell the agent to fix a problem in the wrong attempt's context.
 *
 * DETERMINISM WARNINGS ONLY: of Gate's five warning kinds, exactly two are about
 * non-determinism (`unguarded-timer`, `unguarded-randomness` — code that would break
 * Export/replay by depending on wall-clock time or unseeded randomness). The other three
 * (`dropped-id`, `unpointed-element`, `unlisted-navigation`) are UI-contract warnings with no
 * bearing on a Gate REJECTION retry, so they are deliberately excluded from the fold.
 */

export type TurnGateDiagnosticsV1 = EventPayloadByKindV1["turn.gateRejected"]["diagnostics"]
type TurnGateErrorDtoV1 = TurnGateDiagnosticsV1["errors"][number]
type TurnGateWarningDtoV1 = TurnGateDiagnosticsV1["warnings"][number]
type GateWarningKindV1 = TurnGateWarningDtoV1["kind"]

export class StaleGateDiagnosticsError extends errore.createTaggedError({
  name: "StaleGateDiagnosticsError",
  message: "diagnostics from rejected attempt $rejectedAttempt cannot fold into attempt $nextAttempt's prompt — only attempt $rejectedAttempt + 1 may consume them",
}) {}

export interface TurnGateFoldInputV1 {
  /** The attempt Gate rejected — whose diagnostics these are. */
  readonly rejectedAttempt: TurnAttempt
  /** The attempt this fold is FOR. */
  readonly nextAttempt: TurnAttempt
  readonly diagnostics: TurnGateDiagnosticsV1
}

/** Gate's own two non-determinism warning kinds (master §6.3) — see this file's header. */
const DETERMINISM_WARNING_KINDS: ReadonlySet<GateWarningKindV1> = new Set(["unguarded-timer", "unguarded-randomness"])

function isDeterminismWarning(warning: TurnGateWarningDtoV1): boolean {
  return DETERMINISM_WARNING_KINDS.has(warning.kind)
}

function formatPosition(line: number | null, column: number | null): string {
  if (line === null) return ""
  return column === null ? ` line ${line}` : ` line ${line}:${column}`
}

function formatGateError(error: TurnGateErrorDtoV1): string {
  const location = error.file === null ? "" : ` in ${error.file}`
  return `- [${error.kind}/${error.code}]${location}${formatPosition(error.line, error.column)}: ${error.message}`
}

function formatGateWarning(warning: TurnGateWarningDtoV1): string {
  return `- [${warning.kind}]${formatPosition(warning.line, warning.column)}: ${warning.message}`
}

const GATE_ERRORS_HEADER = "Gate rejected the previous attempt with the following errors. Fix every one before anything else:"
const DETERMINISM_WARNINGS_HEADER =
  "Gate also flagged non-deterministic code (breaks Export/replay). Remove the wall-clock/randomness dependency:"

/**
 * Renders `input.diagnostics` into prompt text for `input.nextAttempt`, or refuses with
 * {@link StaleGateDiagnosticsError} when the freshness barrier does not hold. An empty
 * result (`""`) means there is nothing worth folding — the caller should not append a blank
 * section (see {@link appendPromptFold}).
 */
export function foldGateDiagnosticsIntoPrompt(input: TurnGateFoldInputV1): StaleGateDiagnosticsError | string {
  if (input.nextAttempt !== input.rejectedAttempt + 1) {
    return new StaleGateDiagnosticsError({ rejectedAttempt: input.rejectedAttempt, nextAttempt: input.nextAttempt })
  }

  const sections: string[] = []

  if (input.diagnostics.errors.length > 0) {
    sections.push([GATE_ERRORS_HEADER, ...input.diagnostics.errors.map(formatGateError)].join("\n"))
  }

  const determinismWarnings = input.diagnostics.warnings.filter(isDeterminismWarning)
  if (determinismWarnings.length > 0) {
    sections.push([DETERMINISM_WARNINGS_HEADER, ...determinismWarnings.map(formatGateWarning)].join("\n"))
  }

  return sections.join("\n\n")
}

/** Appends a non-empty fold to `baseUserMessage`, separated by a blank line; an empty fold leaves the message untouched. */
export function appendPromptFold(baseUserMessage: string, fold: string): string {
  if (fold.length === 0) return baseUserMessage
  return `${baseUserMessage}\n\n${fold}`
}
