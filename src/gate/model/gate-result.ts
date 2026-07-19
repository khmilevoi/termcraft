import type { GateError, GateResult, GateWarning, PageDescriptor } from "../types"

/**
 * Assemble a `GateResult` from the stages' collected fatal errors + non-fatal
 * warnings + the parsed descriptor (master §6.3). `ok` is derived — a candidate
 * passes only when there are ZERO fatal errors; warnings never reject it. This is
 * the single place the pass/fail rule lives, so no stage can accidentally "pass" a
 * candidate that produced a fatal error.
 */
export function makeGateResult(
  errors: readonly GateError[],
  warnings: readonly GateWarning[],
  descriptor: PageDescriptor | null,
): GateResult {
  return { ok: errors.length === 0, errors, warnings, descriptor }
}

/** True when the candidate is safe to make canonical (no fatal errors). */
export function isPassing(result: GateResult): boolean {
  return result.ok
}
