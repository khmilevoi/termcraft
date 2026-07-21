import type { CommandEnvelopeV1, CommandKindV1, UUIDv7, UnavailableReason } from "core/protocol";

import type { PublishableEventV1 } from "./model/event-bus";

/**
 * The mailbox module's own seam vocabulary (kernel-command-contract §12.1, §12.2) — the
 * shapes 6C's capability/guard layer and the seven state machines must satisfy once they
 * land, and the shapes `core/mailbox/model/dispatch.ts` and
 * `core/mailbox/model/signal-ingress.ts` are built and tested against today.
 *
 * Neither `CapabilityTargetByKindV1` (§10.1's 43-row table), nor `currentKernelState`
 * (§10.2), nor the seven `reatom*StateMachine` factories (§6's table) exist yet — 6C
 * owns all three and has not landed. Every `unknown` below is exactly that missing
 * piece, kept opaque on purpose so this module never guesses at a shape the spec does
 * not fix here (per the project's "keep the seams narrow and honest" rule). When 6C
 * lands, these aliases get their real types; `dispatch.ts`'s dispatch ORDER, revision
 * check, and lease-fencing logic do not change — they were built and tested against
 * these narrow interfaces, not against 6C's internals.
 */

// --- §12.1 step 3: capability target + guard, injected into dispatch.ts ------------

/**
 * `CapabilityTargetByKindV1[kind]` (§10.1) — 6C's 43-row table. Opaque here: dispatch
 * only ever threads it from `TargetExtractor` to `GuardRegistry`, never inspects it.
 */
export type GuardTarget = unknown;

/**
 * `currentKernelState` (§10.2: "Each command family owns a pure guard over exactly
 * `(currentKernelState, CapabilityTargetByKindV1[K])`") — the seven state machines'
 * combined read surface. Opaque here for the same reason as {@link GuardTarget}.
 */
export type KernelStateSnapshot = unknown;

/**
 * §10.1's `CapabilityState`, mirrored here rather than imported: `core/protocol` has no
 * exported type for it yet, only the UNEXPORTED `CapabilityStateV1Placeholder` in
 * `core/protocol/model/event-payload.ts` (that file's own `TODO(6C)`). Structurally
 * identical on purpose — when 6C lands the real `CapabilityState`, this alias is the one
 * line that needs to change, not `dispatch.ts`'s branching on it.
 */
export type GuardDecision =
  | Readonly<{ available: true }>
  | Readonly<{ available: false; reasons: readonly [UnavailableReason, ...UnavailableReason[]] }>;

/**
 * §10.1: "The extractor first validates `CommandPayloadByKindV1`, then normalizes the
 * listed fields." The validation half already happened in `decodeCommandEnvelope`
 * before `dispatch.ts` ever calls this — `payload` here is always the decoded,
 * schema-valid payload for `kind`, typed `unknown` only because the precise per-kind
 * return shape (`CapabilityTargetByKindV1[K]`) is 6C's, not this module's.
 */
export type TargetExtractor = (kind: CommandKindV1, payload: unknown) => GuardTarget;

/**
 * §10.2: "Each command family owns a pure guard over exactly `(currentKernelState,
 * CapabilityTargetByKindV1[K])`." `dispatch.ts` supplies `state` fresh on every call via
 * its own injected `readKernelState` — never cached across commands, so a guard always
 * sees the state as of the moment its command is being evaluated.
 */
export type GuardRegistry = (
  kind: CommandKindV1,
  target: GuardTarget,
  state: KernelStateSnapshot,
) => GuardDecision;

// --- §12.1 steps 4-5: named model action(s), injected into dispatch.ts -------------

/**
 * §12.1 step 4's "one or more named model actions in a single Reatom frame" (6C).
 * §8.3 ties `disposition` to whether state changed: `"no-op"` is "an explicitly
 * idempotent no-op was recognized" (no revision advance, no event published);
 * `"completed"`/`"started"` mean the transition occurred. `events` MUST be empty for a
 * `"no-op"` outcome — `dispatch.ts` logs (never silently drops) a handler that violates
 * this rather than trusting it blindly, per the errore rule against swallowing an error
 * that is not otherwise propagated.
 */
export interface HandlerOutcome {
  readonly disposition: "completed" | "started" | "no-op";
  readonly events: readonly PublishableEventV1[];
  readonly operationId?: UUIDv7;
}

/**
 * Cross-model orchestration is "a named Kernel action, never UI-side sequencing" (§6) —
 * this function IS that action (6C supplies the real one). `dispatch.ts` calls it at
 * most once per first-seen command, only after the revision check and guard both allow
 * it (§12.1 steps 2-3), and wraps the call in its own outer Reatom action so the handler
 * plus the revision advance plus publication land in one frame (§6: "The mailbox
 * invokes transition actions synchronously within one Reatom transaction frame").
 */
export type HandlerRegistry = (envelope: CommandEnvelopeV1) => HandlerOutcome;

// --- §12.2 step 3: backend attempt-lease fencing, injected into signal-ingress.ts ---

/**
 * The attempt lease every backend progress/completion callback carries (§12.2 step 2:
 * "`AgentRunSupervisor` creates a unique per-turn workspace and attempt lease `{turnId,
 * attempt, leaseNonce}`"). `leaseNonce` "remains internal" (§9's `turn.attemptStarted`
 * row) — it is never a DTO field; only this fencing comparison ever sees it.
 */
export interface TurnBackendLeaseV1 {
  readonly turnId: UUIDv7;
  readonly attempt: number;
  readonly leaseNonce: string;
}

/**
 * The narrow fact `signal-ingress.ts` needs from `TurnState` (§12.2 step 3: "The
 * mailbox compares all three fields with `TurnState` before calling an action"): the
 * lease currently authorized to update turn state, or `null` when no turn is active to
 * update. Injected rather than imported for the same reason as `revision-guard.ts`'s
 * `TurnCancelProbe` — the turn state machine (6C) does not exist yet, and even once it
 * does, signal-ingress must stay testable without wiring the whole state machine in.
 */
export interface TurnFenceProbe {
  readonly currentLease: () => TurnBackendLeaseV1 | null;
}
