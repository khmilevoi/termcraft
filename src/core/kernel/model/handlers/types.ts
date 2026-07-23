import type { KernelStateSnapshot } from "core/capabilities";
import type {
  CommitAction,
  CommitState,
  ExportAction,
  ExportState,
  MigrationAction,
  MigrationState,
  PreviewAction,
  PreviewState,
  ProjectAction,
  ProjectState,
  RestoreAction,
  RestoreState,
  StateMachine,
  TurnAction,
  TurnState,
} from "core/machines";
import type { HandlerOutcome, PublishableEventV1 } from "core/mailbox";
import type { CommandFamilyV1, CommandKindV1, CommandPayloadByKindV1, UUIDv7 } from "core/protocol";

import type { KernelDeps } from "../../types";

/**
 * Kernel-assembly WP-1 task 9, STEP A — the shared skeleton every per-family handler
 * module (Step B) is built against. This file is deliberately the ONLY thing a family
 * implementer needs to read beyond their own family's command list: the `HandlerContext`
 * they receive, the function shape their family module must export, and the helpers that
 * make a malformed `HandlerOutcome` impossible to construct.
 *
 * Everything here is derived FROM `core/kernel/model/kernel.ts`'s real internals (read
 * that file's own comments for the "why" behind each piece):
 * - `deps: KernelDeps` — the exact port surface `createKernel` was given (§7's ports).
 * - `machines: KernelMachines` — the same seven `StateMachine` objects `kernel.ts` holds
 *   in its own closure, so a handler drives a machine the SAME way `kernel.ts` reads its
 *   phase (`machine.apply(action)` / `machine.phase()` / `machine.canApply(action)`),
 *   never a second, parallel way to move the same state. Each machine is typed as
 *   {@link HandlerMachine}, a `Pick` that deliberately drops `phaseAtom` — the directly
 *   settable atom is not part of the type a handler can reach, so `apply()`'s
 *   transition-table legality check cannot be bypassed by a stray `.set(...)`.
 * - `readKernelState` — `kernel.ts`'s own `readKernelState`, unchanged: the guard already
 *   ran this before a handler is ever reached, but §10.2's own line ("Payload-only
 *   content/schema, freshness, token-ledger, and operation-specific mutex checks run
 *   AFTER the guard") means a handler legitimately needs a fresh read too, e.g. to decide
 *   which branch of its own operation-specific logic applies.
 * - the four named mutators — `kernel.ts`'s own comment names the FOUR Kernel-held facts
 *   `KernelStateSnapshot` needs beyond the seven bare phases: `project.trust`,
 *   `turn.activeTurnId`, `turn.commitIntentRecorded`, `preview.sourceKind`. Those are the
 *   ONLY fields a handler may ever change outside a machine's own `apply()` — one named
 *   mutator per field, deliberately, NOT a blanket `setState(patch)`: a reviewer reading
 *   this interface sees the Kernel's ENTIRE non-machine mutation surface in four lines,
 *   not an open-ended patch shape a handler could use to touch a fact it has no business
 *   touching (e.g. nothing here lets a `chat.*` handler reach into `preview.sourceKind`).
 *
 * `context.deps.clock` is the injected `Clock` (kernel-assembly plan's Task 7) — there is
 * no separate `clock` field on `HandlerContext` itself; it already lives on `KernelDeps`,
 * and duplicating it here would just be a second name for the same value.
 */

// --- The seven machines, grouped ---------------------------------------------------------

/**
 * The view of a `StateMachine` a handler is given — `phase`/`apply`/`canApply` only, NEVER
 * `phaseAtom`. `StateMachine` (`core/machines`) exposes `phaseAtom` as a directly settable
 * `Atom` because `state-machine.ts`'s own `apply()` needs `phaseAtom.set(edge.to)`
 * internally (`state-machine.ts:98`) — but that is an implementation detail of the factory,
 * not something a family handler may ever touch. `context.machines.<domain>.phaseAtom.set(...)`
 * would move a machine's phase WITHOUT going through `apply()`'s transition-table legality
 * check — exactly the "stray `.set(...)`" bypass `HandlerContext`'s own doc comment below
 * promises does not exist. Picking only the read/legal-transition members here is what makes
 * that promise true at the type level: a handler typed against `HandlerContext` cannot even
 * NAME `context.machines.<domain>.phaseAtom`, let alone call `.set()` on it, without first
 * writing a separate, independently-flagged unsafe cast (itself forbidden project-wide).
 */
export type HandlerMachine<Phase extends string, Action extends string> = Pick<
  StateMachine<Phase, Action>,
  "phase" | "apply" | "canApply"
>;

/**
 * The same seven `StateMachine` objects `kernel.ts`'s own `createKernel` constructs and
 * holds (`reatom*StateMachine()`, one call per domain) — injected here, never rebuilt, so
 * a handler's `apply()` call lands on the EXACT atom `readKernelState`/the capability
 * guard/the projector all observe. Typed as {@link HandlerMachine}, not the full
 * `StateMachine`, so `phaseAtom` is excluded from the surface a handler can reach (see that
 * type's own comment). `chat`/`model`/`page`/`selection`/`pin`/`history` have no machine of
 * their own among the seven (`core/capabilities/model/guards.ts`'s own `familySpecificReason`
 * header note) — their handlers only ever touch `context.deps`.
 */
export interface KernelMachines {
  readonly project: HandlerMachine<ProjectState, ProjectAction>;
  readonly turn: HandlerMachine<TurnState, TurnAction>;
  readonly restore: HandlerMachine<RestoreState, RestoreAction>;
  readonly commit: HandlerMachine<CommitState, CommitAction>;
  readonly export: HandlerMachine<ExportState, ExportAction>;
  readonly preview: HandlerMachine<PreviewState, PreviewAction>;
  readonly migration: HandlerMachine<MigrationState, MigrationAction>;
}

/** `KernelStateSnapshot["project"]["trust"]` by another name — never re-declared as a fresh literal union. */
export type ProjectTrustV1 = KernelStateSnapshot["project"]["trust"];

/** `KernelStateSnapshot["preview"]["sourceKind"]` by another name — see {@link ProjectTrustV1}. */
export type PreviewSourceKindV1 = KernelStateSnapshot["preview"]["sourceKind"];

// --- The handler context -----------------------------------------------------------------

/**
 * Everything a command handler is given. Every family module (Step B) and the Tier-C
 * deferred handler (this step) share this ONE shape — no family gets a bespoke context.
 *
 * The four mutators are the WHOLE Kernel-held, non-machine mutation surface:
 * - `setProjectTrust` — `project.setTrust` (and `project.create`'s creation-defaults
 *   trust) is the only legitimate caller; `kernel.ts`'s `trustAtom`.
 * - `setActiveTurnId` — `turn.start`'s admission (recording the fresh turn id) and its
 *   terminal outcomes (clearing it back to `null`) are the only legitimate callers;
 *   `kernel.ts`'s `activeTurnIdAtom`.
 * - `setCommitIntentRecorded` — the turn finalize/terminalize path that records or clears
 *   durable commit intent (§7.2's `finalizing` pre/post-intent split); `kernel.ts`'s
 *   `commitIntentRecordedAtom`.
 * - `setPreviewSourceKind` — `preview.selectPage`/`selectHistorical`/`selectCurrent` are
 *   the only legitimate callers; `kernel.ts`'s `previewSourceKindAtom`.
 *
 * No handler may reach a machine's `phaseAtom` or any of these four facts through any
 * other route — this interface IS the whole surface, so a reviewer checking "what can a
 * handler change?" only has to read these ten members (six read paths, four write paths),
 * never grep the whole `handlers/` tree for a stray `.set(...)`. This is enforced by the
 * type, not just by this comment: `KernelMachines`'s per-machine type is
 * {@link HandlerMachine}, a `Pick` that omits `phaseAtom` entirely, so
 * `context.machines.<domain>.phaseAtom` does not type-check — see that type's own comment.
 */
export interface HandlerContext {
  readonly deps: KernelDeps;
  readonly machines: KernelMachines;
  /** `kernel.ts`'s own `readKernelState`, re-exposed verbatim — always a fresh read, never cached. */
  readonly readKernelState: () => KernelStateSnapshot;
  readonly setProjectTrust: (trust: ProjectTrustV1) => void;
  readonly setActiveTurnId: (turnId: UUIDv7 | null) => void;
  readonly setCommitIntentRecorded: (recorded: boolean) => void;
  readonly setPreviewSourceKind: (sourceKind: PreviewSourceKindV1) => void;
}

// --- The well-formed outcome, made hard to get wrong ---------------------------------------

/**
 * The value every command handler returns — `HandlerOutcome` (`core/mailbox`) by another
 * name, kept as a local alias so this file's own doc comments have one name to point at.
 *
 * "Design so families cannot produce a malformed outcome" (Task 9 brief) is enforced here
 * by SHAPE, not by a branded/opaque type: a branded type can only ever be constructed by
 * bouncing an object literal through `unknown` first (TypeScript refuses a direct `as` when
 * the brand's property is entirely absent from the literal), and this project's own rule
 * is NO `unknown`/`any`-bounce cast, ever — inventing one just to brand this type would be
 * exactly the "type-laundering" the rule forbids. Instead, `noOpOutcome`/`completedOutcome`/
 * `startedOutcome` below are the only THREE outcome shapes `HandlerOutcome` actually has
 * (§8.3's three dispositions), each hard-coded to the one valid `{disposition, events}`
 * pairing for it — `noOpOutcome` does not even accept an `events` parameter, so the one
 * malformed shape `dispatch.ts`'s own `applyTransition` already defends against
 * ("no-op" with non-empty `events`) is simply not expressible by calling it. A family
 * author CAN still hand-write a raw object literal instead of calling these — nothing in
 * the type system forbids that, matching how `HandlerOutcome`'s own doc comment already
 * documents dispatch trusting (and defensively logging, never silently dropping, a
 * violation of) whatever a handler returns — but every family module Step A/B ships uses
 * only these three constructors, so a reviewer checking "did this handler build a valid
 * outcome?" only has to confirm it called one of them.
 */
export type CommandOutcomeV1 = HandlerOutcome;

/** The revision-neutral no-op every Tier-C/not-yet-implemented handler (and some real ones) returns. */
export function noOpOutcome(): CommandOutcomeV1 {
  return { disposition: "no-op", events: [] };
}

/** A completed, revision-advancing outcome — `events` publish, `operationId` is set only when supplied. */
export function completedOutcome(
  events: readonly PublishableEventV1[],
  operationId?: UUIDv7,
): CommandOutcomeV1 {
  const base = { disposition: "completed" as const, events };
  return operationId === undefined ? base : { ...base, operationId };
}

/** A started (async work kicked off), revision-advancing outcome — same shape rules as {@link completedOutcome}. */
export function startedOutcome(
  events: readonly PublishableEventV1[],
  operationId?: UUIDv7,
): CommandOutcomeV1 {
  const base = { disposition: "started" as const, events };
  return operationId === undefined ? base : { ...base, operationId };
}

// --- The per-kind handler function, and the maps families export --------------------------

/**
 * One command kind's handler: the already-decoded, already-guard-checked payload in, a
 * {@link CommandOutcomeV1} out. Never a rejection — by the time `dispatch.ts` calls a
 * handler, `core/capabilities`'s guard has already run (§12.1 step 3) and returned
 * `available`; a handler that finds a payload-only reason to refuse (freshness, a token
 * ledger miss, an operation-specific mutex — §10.2's own list of what runs "after the
 * guard") still returns a `CommandOutcomeV1`, just a `"no-op"` one, exactly like a Tier-C
 * kind's outcome shape. `HandlerOutcome` (`core/mailbox`) has no rejected disposition of
 * its own — see that type's own doc comment — so there is nothing else this signature
 * could return.
 */
export type CommandHandler<K extends CommandKindV1 = CommandKindV1> = (
  payload: CommandPayloadByKindV1[K],
  context: HandlerContext,
) => CommandOutcomeV1;

/** A handler map over an arbitrary, explicit subset of `CommandKindV1` — e.g. the Tier-C deferred set, which spans four families and only PART of `preview`. */
export type CommandHandlerMap<K extends CommandKindV1> = Readonly<{
  [P in K]: CommandHandler<P>;
}>;

/** Every `CommandKindV1` member whose dot-prefix is `F` — the precise per-family kind subset. */
export type CommandKindOfFamily<F extends CommandFamilyV1> = Extract<
  CommandKindV1,
  `${F}.${string}`
>;

/**
 * The 10 Tier-C deferred kinds — `4 restore.* + 3 commit.* + history.open + 2 preview.*`
 * (`restore.plan/confirm/discardPlan/retryRecord`, `commit.plan/confirm/discardPlan`,
 * `history.open`, `preview.forwardInput`, `preview.setTweak`) — declared here, not in
 * `./deferred.ts`, purely so {@link FamilyHandlerMap} below can `Exclude` them without
 * `types.ts` importing FROM `./deferred.ts` (that file already imports `CommandHandlerMap`/
 * `noOpOutcome` from here; the reverse direction would make the two files circularly
 * dependent). `./deferred.ts` imports this exact type and re-exports it unchanged, so
 * `import { type DeferredHandlerKind } from "./deferred"` (`./index.ts`'s existing call
 * site) keeps resolving to the same type — `types.ts` is just its one declaration site now,
 * shared with `FamilyHandlerMap`'s own use below. See `./deferred.ts`'s own header comment
 * for the full "why exactly these 10, why not `migration.*`" investigation.
 */
export type DeferredHandlerKind =
  | "restore.plan"
  | "restore.confirm"
  | "restore.discardPlan"
  | "restore.retryRecord"
  | "commit.plan"
  | "commit.confirm"
  | "commit.discardPlan"
  | "history.open"
  | "preview.forwardInput"
  | "preview.setTweak";

/**
 * The shape EVERY per-family module (Step B) exports: a `Readonly` map from its own
 * family's `CommandKindV1` members to their handlers — MINUS whichever of those members
 * are already Tier-C deferred ({@link DeferredHandlerKind}, owned by `./deferred.ts`'s
 * `deferredHandlers`, never by a family module). For most families `CommandKindOfFamily<F>`
 * and `DeferredHandlerKind` don't overlap at all, so the `Exclude` is a no-op and
 * `FamilyHandlerMap<F>` is exactly what it looks like it should be.
 *
 * `"preview"` is the one family where it DOES overlap: `CommandKindOfFamily<"preview">` has
 * 11 members, 2 of which (`preview.forwardInput`, `preview.setTweak`) are Tier-C deferred —
 * so `FamilyHandlerMap<"preview">` is exactly the OTHER 9. A preview module typed against
 * it cannot even NAME the 2 deferred kinds in its own object literal (excess-property
 * checking on a literal assigned to this type rejects unknown keys), let alone accidentally
 * un-defer one by supplying a real handler for it — closing the "spread-order decides which
 * handler wins" trap that a wider `FamilyHandlerMap<"preview">` would otherwise leave open
 * at Step-B assembly (`{...deferredHandlers, ...previewFamily}`): with this narrower type
 * the two maps share zero keys, so there is nothing left for spread order to decide.
 *
 * `"restore"`/`"commit"`/`"history"` are the opposite extreme: EVERY one of their kinds is
 * Tier-C deferred, so `FamilyHandlerMap<"restore">` etc. resolve to the empty map —
 * correctly, since none of them has a Step-B family module (the task brief: "Tier-C
 * families (restore, commit, migration) ... get a single deferred-rejection handler
 * each"). `"migration"` has no member in `DeferredHandlerKind` at all (see `./deferred.ts`'s
 * header comment for why), so `FamilyHandlerMap<"migration">` is unaffected, still its full
 * 4-kind map — matching the task report's flagged not-yet-implemented (not Tier-C) status
 * for it.
 *
 * Nothing else about the shape changes — still no default export, no side effects, no
 * module-level mutable state (a family module is re-importable and re-usable across as
 * many `HandlerContext`s/tests as needed).
 */
export type FamilyHandlerMap<F extends CommandFamilyV1> = CommandHandlerMap<
  Exclude<CommandKindOfFamily<F>, DeferredHandlerKind>
>;

/** The complete, 43-kind map `createHandlerRegistry` (`./index.ts`) consumes. */
export type TotalHandlerMap = CommandHandlerMap<CommandKindV1>;
