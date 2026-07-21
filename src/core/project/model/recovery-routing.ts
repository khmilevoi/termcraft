import type {
  ExportAction,
  ExportState,
  MigrationAction,
  MigrationState,
  ProjectAction,
  ProjectState,
  RestoreAction,
  RestoreState,
  StateMachine,
} from "core/machines";
import type { CommandRejectionCode } from "core/protocol";

import type { IntendedRecoveryDomainV1 } from "../types";

/**
 * KCC §12.7 (lines 1189-1195): "During project open, journal inspection first proves
 * schema validity and durable commit intent. `kernel.project.beginRecovery` then routes
 * exactly one intended Restore, ExportPublish, or Migration journal from that domain's
 * `idle` state to `recovering`. Journals with no intent are discarded." §7.1's own
 * `beginRecovery` row (line 201) repeats the same rule for the project machine's edge.
 *
 * THE JOURNAL-INSPECTION HALF IS NOT THIS FILE'S JOB. "Journal inspection first proves
 * schema validity and durable commit intent" (§12.7) is TD §10.2's transaction
 * classification — `RecoveryService.classify`/`hasIntentRecord` — which tells you THAT a
 * transaction is intended, not WHICH of Restore/Export/Migration owns it. No port in this
 * ring exposes that domain tag: `RecoveryService.recover()` returns only aggregate
 * counts, and `classify(transactionId)` needs a `transactionId` this ring has no way to
 * enumerate from outside `store`. `open-sequence.ts` therefore takes the discovered
 * `IntendedRecoveryDomainV1 | null` as its own injected input (documented there) rather
 * than this file inventing a port that does not exist. This file's job starts once that
 * domain tag (or its absence) is already known: apply EXACTLY the `kernel.project.
 * beginRecovery` + one domain `beginRecovery` pair the spec names, atomically, and touch
 * NOTHING else.
 */

export interface RecoveryRoutingMachines {
  readonly project: StateMachine<ProjectState, ProjectAction>;
  readonly restore: StateMachine<RestoreState, RestoreAction>;
  readonly exportMachine: StateMachine<ExportState, ExportAction>;
  readonly migration: StateMachine<MigrationState, MigrationAction>;
}

export type RecoveryRoutingOutcomeV1 =
  | { readonly kind: "no-intent" }
  | { readonly kind: "routed"; readonly domain: IntendedRecoveryDomainV1 }
  | { readonly kind: "illegal"; readonly code: CommandRejectionCode };

/**
 * Routes at most one domain journal to `recovering`. `intended === null` is "Journals
 * with no intent are discarded and cannot enter recovery" (§12.7) — the project machine's
 * `beginRecovery` action is never even attempted, so `ProjectState` stays exactly where
 * the caller left it (normally `opening`) and every domain machine stays `idle`.
 */
export function routeProjectRecovery(
  machines: RecoveryRoutingMachines,
  intended: IntendedRecoveryDomainV1 | null,
): RecoveryRoutingOutcomeV1 {
  if (intended === null) return { kind: "no-intent" };

  const projectOutcome = machines.project.apply("beginRecovery");
  if (projectOutcome.kind === "illegal") return { kind: "illegal", code: projectOutcome.code };

  // §12.7: "invokes exactly one of `kernel.restore.beginRecovery`,
  // `kernel.export.beginRecovery`, or `kernel.migration.beginRecovery` from that domain's
  // `idle` state" — the project-level edge above is already committed by this point, so
  // exactly one of the three calls below runs; the other two domain machines are never
  // touched.
  if (intended === "restore") machines.restore.apply("kernel.restore.beginRecovery");
  if (intended === "export") machines.exportMachine.apply("kernel.export.beginRecovery");
  if (intended === "migration") machines.migration.apply("kernel.migration.beginRecovery");

  return { kind: "routed", domain: intended };
}
