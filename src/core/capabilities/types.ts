import type {
  CommitState,
  ExportState,
  MigrationState,
  PreviewState,
  ProjectState,
  RestoreState,
  TurnState,
} from "core/machines";
import type { CommandKindV1, UUIDv7, UnavailableReason } from "core/protocol";

import type { CapabilityTargetByKindV1 } from "./model/target";

/**
 * `core/capabilities`'s shared vocabulary: §10.1's `CapabilityState`/`CapabilityEntry`
 * (kernel-command-contract KCC:852-865) and §10.2's `currentKernelState`
 * (KCC:907-908) — the exact read surface every family guard in `model/guards.ts` is
 * built over, and the same surface `model/projector.ts` projects from.
 *
 * This is also the REAL type behind `core/mailbox/types.ts`'s deliberately-`unknown`
 * `GuardDecision`/`KernelStateSnapshot` seams: "Neither `CapabilityTargetByKindV1` ...,
 * nor `currentKernelState` ..., nor the seven `reatom*StateMachine` factories ... exist
 * yet — 6C owns all three and has not landed. ... When 6C lands, these aliases get their
 * real types". Wiring `core/mailbox` to import from here is future work (outside 6C's own
 * file list); this file only needs to keep the two shapes structurally compatible, which
 * {@link CapabilityState} does by construction (verbatim §10.1).
 */

/**
 * §10.1's `CapabilityState` (KCC:852-857), transcribed verbatim. Structurally identical to
 * `core/mailbox/types.ts`'s `GuardDecision` on purpose — same shape, declared here as the
 * canonical copy because `core/mailbox` is the seam that will one day import FROM
 * `core/capabilities`, never the reverse (capabilities has no reason to depend on the
 * mailbox's dispatch/event-bus machinery).
 */
export type CapabilityState =
  | Readonly<{ available: true }>
  | Readonly<{ available: false; reasons: readonly [UnavailableReason, ...UnavailableReason[]] }>;

/**
 * §10.1's `CapabilityEntry<K>` (KCC:861-865), typed precisely per kind via
 * `CapabilityTargetByKindV1[K]`.
 */
export interface CapabilityEntry<K extends CommandKindV1 = CommandKindV1> {
  readonly id: K;
  readonly target: CapabilityTargetByKindV1[K];
  readonly state: CapabilityState;
}

/**
 * The loosely-typed sibling of {@link CapabilityEntry} used by `model/projector.ts`'s
 * batch and diffing operations, which are inherently heterogeneous over all 43 kinds at
 * once. Every `CapabilityEntry<K>` is structurally assignable here — `target:
 * CapabilityTargetByKindV1[K]` always satisfies `target: unknown` — so callers never need
 * to cast between the two.
 */
export interface CapabilityRecord {
  readonly id: CommandKindV1;
  readonly target: unknown;
  readonly state: CapabilityState;
}

/**
 * §10.2's `currentKernelState`: "Each command family owns a pure guard over exactly
 * `(currentKernelState, CapabilityTargetByKindV1[K])`" (KCC:907-908). Fixed here as the
 * seven `reatom*StateMachine` phases (§6's factory table) plus trust and the few active
 * identities a specific rule needs to produce a specific reason:
 *
 * - `turn.activeTurnId`/`turn.commitIntentRecorded` — §7.2's `turn.cancel` rules
 *   (`TURN_ID_MISMATCH`, `CANCEL_TOO_LATE`) and §10.4's `TURN_RUNNING` detail both need an
 *   active turn id to attach to the reason; `commitIntentRecorded` is the one bit the
 *   phase-only `TurnState` table cannot see for `finalizing`'s pre/post-intent split
 *   (mirrored in `turn-machine.ts`'s own comment on `requestCancel`'s `finalizing` edge).
 * - `preview.sourceKind` — §7.6: "Tweaks and interactive mutation are unavailable on
 *   historical source."
 *
 * Deliberately narrower than any one machine's full model (no page/chat/plan ledgers, no
 * Git projections, no token ledgers): §10.2's own next sentence draws that exact line —
 * "Payload-only content/schema, freshness, token-ledger, and operation-specific mutex
 * checks run after the guard and are not capability inputs."
 */
export interface KernelStateSnapshot {
  readonly project: Readonly<{
    readonly phase: ProjectState;
    /** `null` before `ready` is ever reached — §7.1: trust first exists at `ready`. */
    readonly trust: "trusted" | "untrusted-read-only" | null;
  }>;
  readonly turn: Readonly<{
    readonly phase: TurnState;
    /** The active turn's id, or `null` exactly when `phase === "idle"`. */
    readonly activeTurnId: UUIDv7 | null;
    /** §7.2: "In `finalizing` after durable intent [cancel] is rejected with `CANCEL_TOO_LATE`." */
    readonly commitIntentRecorded: boolean;
  }>;
  readonly restore: Readonly<{ readonly phase: RestoreState }>;
  readonly commit: Readonly<{ readonly phase: CommitState }>;
  readonly export: Readonly<{ readonly phase: ExportState }>;
  readonly preview: Readonly<{
    readonly phase: PreviewState;
    readonly sourceKind: "current" | "historical" | null;
  }>;
  readonly migration: Readonly<{ readonly phase: MigrationState }>;
}
