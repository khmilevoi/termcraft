import type { HandlerRegistry } from "core/mailbox";
import type { CommandKindV1 } from "core/protocol";

import { type DeferredHandlerKind, deferredHandlers } from "./deferred";
import {
  type CommandHandlerMap,
  type HandlerContext,
  type TotalHandlerMap,
  noOpOutcome,
} from "./types";

/**
 * `core/kernel/model/handlers` — the MVP command handler registry (kernel-assembly WP-1
 * task 9). STEP A (this commit) lands the shared skeleton every per-family handler module
 * builds against (`./types.ts`) plus the one family that IS real today, the Tier-C
 * deferred rejection handler (`./deferred.ts`). STEP B (separate work, five parallel
 * implementers) replaces each `notYetImplementedHandler` entry below, one family at a
 * time, with that family's real `FamilyHandlerMap`.
 *
 * `createHandlerRegistry` itself does not change shape between Step A and Step B — it has
 * always taken one complete, 43-kind `TotalHandlerMap` and returned the `HandlerRegistry`
 * `core/mailbox/model/dispatch.ts` calls. What changes is only WHICH map this file passes
 * it: today, `deferredHandlers` (10 kinds) plus `notYetImplementedHandlers` (the other 33);
 * later, `deferredHandlers` plus nine real family maps spread together.
 *
 * NOT wired into `createKernel` yet — that is kernel-assembly Task 9's own Step 3/Step C,
 * intentionally out of this commit's scope (per the task brief).
 */

/**
 * The 9 named families Step B implements (`project`, `chat`, `page`, `pin`, `selection`,
 * `turn`, `preview`, `export`, `model`) plus `migration` — 29 + 4 = 33 kinds, exactly
 * `CommandKindV1`'s other 33 members once `deferredHandlers`'s 10 are removed.
 *
 * `migration.*` is grouped HERE, not with `deferredHandlers`, despite the kernel-assembly
 * plan's Global Constraints text listing "restore/commit/migration" as one Tier-C group.
 * See `./deferred.ts`'s own header comment for the full investigation: `core/versions`'s
 * `DEFERRED_CAPABILITY_KINDS` does not include any `migration.*` kind, and the real guard
 * (`capabilities/model/guards.ts`'s `migrationFamilyReason`) evaluates ACTUAL phase
 * legality against `MIGRATION_TRANSITION_TABLE` rather than rejecting unconditionally —
 * so `migration.*` commands can legitimately pass the guard today. Routing them through
 * `deferredHandlers` would silently no-op a guard-accepted command while pretending it was
 * never reachable, which is not what a Tier-C kind actually is. Until a `migration` family
 * module lands (or a deliberate decision extends `core/versions` to cover it), its four
 * kinds get the exact same well-formed no-op every other unbuilt family gets — flagged
 * here, not silently guessed; see the task report for the full writeup.
 */
type NotYetImplementedKind = Exclude<CommandKindV1, DeferredHandlerKind>;

/**
 * The shared stand-in for every kind whose real family module has not landed yet. Mirrors
 * task 8's original minimal `HandlerRegistry` (`kernel.ts`'s own comment: "an explicitly
 * empty, revision-neutral no-op for every kind") but WITHOUT its `console.warn` — the
 * same fix also-fix (b) applies to `kernel.ts` itself, so this stand-in never re-introduces
 * the stderr noise that fix removes.
 */
function notYetImplementedHandler(): ReturnType<typeof noOpOutcome> {
  return noOpOutcome();
}

const notYetImplementedHandlers: CommandHandlerMap<NotYetImplementedKind> = {
  "project.create": notYetImplementedHandler,
  "project.open": notYetImplementedHandler,
  "project.retryOpen": notYetImplementedHandler,
  "project.close": notYetImplementedHandler,
  "project.setTrust": notYetImplementedHandler,
  "turn.start": notYetImplementedHandler,
  "turn.cancel": notYetImplementedHandler,
  "chat.create": notYetImplementedHandler,
  "chat.switch": notYetImplementedHandler,
  "model.select": notYetImplementedHandler,
  "page.renameTitle": notYetImplementedHandler,
  "page.removePlan": notYetImplementedHandler,
  "page.removeConfirm": notYetImplementedHandler,
  "page.removeDiscardPlan": notYetImplementedHandler,
  "page.reorder": notYetImplementedHandler,
  "preview.selectPage": notYetImplementedHandler,
  "preview.selectHistorical": notYetImplementedHandler,
  "preview.selectCurrent": notYetImplementedHandler,
  "preview.resize": notYetImplementedHandler,
  "preview.setThemeCapabilities": notYetImplementedHandler,
  "preview.setMode": notYetImplementedHandler,
  "preview.queryGeometry": notYetImplementedHandler,
  "preview.retry": notYetImplementedHandler,
  "preview.close": notYetImplementedHandler,
  "selection.set": notYetImplementedHandler,
  "selection.clear": notYetImplementedHandler,
  "pin.create": notYetImplementedHandler,
  "pin.setStatus": notYetImplementedHandler,
  "export.start": notYetImplementedHandler,
  "migration.plan": notYetImplementedHandler,
  "migration.confirm": notYetImplementedHandler,
  "migration.discardPlan": notYetImplementedHandler,
  "migration.retryRecovery": notYetImplementedHandler,
};

/**
 * Step A's complete, 43-kind `TotalHandlerMap`: `deferredHandlers` (10, real) plus
 * `notYetImplementedHandlers` (33, stand-in). The `satisfies` clause below is the
 * compile-time exhaustiveness check the task brief requires — remove, rename, or add a
 * `CommandKindV1` member without updating one of the two maps above and this line stops
 * compiling; it is never a runtime surprise.
 */
export const totalHandlers = {
  ...deferredHandlers,
  ...notYetImplementedHandlers,
} satisfies TotalHandlerMap;

/**
 * The uniform shape every per-kind handler is stored as ONLY inside this function's own
 * lookup — never in a family module's own map. `never` is deliberate: function-parameter
 * contravariance means `(payload: SpecificPayload, ctx) => Outcome` is assignable to
 * `(payload: never, ctx) => Outcome` for EVERY `SpecificPayload` (nothing needs to satisfy
 * `never` for the assignment itself to type-check — a slot that only promises to accept
 * `never` accepts strictly less than any real handler, so any real handler is a valid
 * substitute). This is what lets `handlers` (a precisely-typed, 43-key `TotalHandlerMap`)
 * assign into `Record<CommandKindV1, ErasedCommandHandler>` below with NO cast at all —
 * TypeScript checks it property-by-property, exactly like assigning any other object type.
 */
type ErasedCommandHandler = (
  payload: never,
  context: HandlerContext,
) => ReturnType<typeof noOpOutcome>;

/**
 * Assembles a complete `TotalHandlerMap` into the `HandlerRegistry` shape `core/mailbox/
 * model/dispatch.ts` calls (`(envelope: CommandEnvelopeV1) => HandlerOutcome`).
 *
 * `envelope.kind: CommandKindV1` is a WIDE union (not a literal), so indexing `handlers`
 * (a homomorphic mapped type keyed by that exact union) with it produces the DISTRIBUTED
 * union of all 43 per-kind handler types — a shape TypeScript can never soundly CALL with
 * a plain `envelope.payload` (doing so would require the argument to satisfy the
 * INTERSECTION of all 43 payload shapes, which is generally empty). Pre-converting
 * `handlers` to the uniform `Record<CommandKindV1, ErasedCommandHandler>` (see that type's
 * own comment — a cast-free, property-checked assignment) sidesteps the problem entirely:
 * every value now shares the exact same type, so indexing by any `CommandKindV1` gives
 * back that one uniform type, not a union. The ONE remaining cast — `envelope.payload as
 * never` — restates a fact `decodeCommandEnvelope` already checked (payload validated
 * against `CommandPayloadByKindV1[envelope.kind]` before dispatch ever calls a handler),
 * exactly like `core/mailbox/model/dispatch.ts`'s own `toRevisionGuardCommand` narrowing
 * cast for `turn.cancel` — never a `type-laundering `unknown`/`any` bounce.
 */
export function createHandlerRegistry(
  context: HandlerContext,
  handlers: TotalHandlerMap,
): HandlerRegistry {
  const erased: Readonly<Record<CommandKindV1, ErasedCommandHandler>> = handlers;

  return function handle(envelope) {
    const handler = erased[envelope.kind];
    return handler(envelope.payload as never, context);
  };
}
