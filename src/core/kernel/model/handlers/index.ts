import type { HandlerRegistry } from "core/mailbox";
import type { CommandEnvelopeV1, CommandKindV1 } from "core/protocol";

import { type DeferredHandlerKind, deferredHandlers } from "./deferred";
import {
  type CommandHandlerMap,
  type CommandOutcomeV1,
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
 * Dispatches one envelope through `handlers`, with the correlation between `envelope.kind`
 * and `envelope.payload` preserved by the type checker instead of asserted by a cast.
 *
 * This is the root-cause fix for the `envelope.payload as never` cast a round-1/round-2
 * review repeatedly (and correctly, on its own narrow terms) found load-bearing: the
 * PREVIOUS design stored every handler erased to a `(payload: never, ...) => Outcome`
 * slot (sound by contravariance, see the now-removed `ErasedCommandHandler` comment this
 * replaces) and then had to force a real `payload` value into that `never` parameter by
 * hand — that forcing step was the cast, and no amount of restructuring the ERASED side
 * removes it, because the correlation was already thrown away by the time `handle` ran.
 *
 * The fix does not erase at all. `K` here is a genuine generic type parameter, not a
 * union VALUE — and `handlers[envelope.kind]`, indexing the homomorphic mapped type
 * `TotalHandlerMap` (`CommandHandlerMap<CommandKindV1> = Readonly<{[P in CommandKindV1]:
 * CommandHandler<P>}>`) by that still-generic `K`, resolves SYMBOLICALLY to
 * `CommandHandler<K>` — TypeScript's preservation rule for indexing a mapped type by the
 * same generic key it is built from. Verified directly against THIS file, not a synthetic
 * stand-in: `bun x tsc --noEmit` is clean on the call below with `K` defaulted to the
 * full `CommandKindV1` union (`envelope: CommandEnvelopeV1` — `HandlerRegistry`'s existing
 * signature, unchanged; neither `core/mailbox`'s seam type nor `decodeCommandEnvelope`'s
 * return type needed to change for this). The soundness check that actually matters was
 * done the same way `types.ts`'s own `@ts-expect-error` proofs and the export-publish
 * sequencing fix were verified (task report, "also-fix (d)"): temporarily replaced
 * `handler(envelope.payload, context)` below with a deliberately wrong payload literal
 * under `@ts-expect-error`, confirmed the directive was NOT flagged as unused (i.e. `tsc`
 * DID reject the mismatched payload — a real error was there to suppress), then reverted
 * and confirmed `git diff` on this file was clean again. Since `CommandEnvelopeV1<K>`'s
 * own `payload` field is DEFINED as `CommandPayloadByKindV1[K]`, `envelope.payload`
 * already IS `CommandPayloadByKindV1[K]` for that SAME K — the type `CommandHandler<K>`'s
 * parameter needs — with no further narrowing step, and therefore no cast, at any
 * instantiation of `K`.
 *
 * (This differs from the task brief's PREFERRED route (a) — introducing a distributed
 * `AnyCommandEnvelopeV1` and changing `decodeCommandEnvelope`'s return type — which was
 * considered and rejected, not merely not-chosen. The mechanism above only works because
 * `K` is a CALLER-SUPPLIED generic type parameter: a generic function's body is checked
 * ONCE, treating `K` as abstract, so `TotalHandlerMap[K]` and `CommandPayloadByKindV1[K]`
 * both stay symbolically parameterized by the SAME abstract `K` and line up — true no
 * matter what concrete type a given call site later instantiates `K` with, including the
 * full `CommandKindV1` union itself. `decodeCommandEnvelope`'s `kind`, by contrast, is
 * never a type parameter — it is a plain VALUE, of the wide `CommandKindV1` union type,
 * discovered from untyped `raw` input at runtime. There is no caller-supplied `K` to bind
 * there, so indexing `commandPayloadSchemas[kind]` (`command-payload.ts`) inside decode
 * hits exactly the DISTRIBUTED-union problem this file's own history already describes for
 * the old `TotalHandlerMap[envelope.kind]` design (see the paragraph above) — decode would
 * still need either a cast or a 43-armed literal `switch` (one call per literal kind, so
 * each branch's `K` is a literal, not the runtime variable) to produce a genuinely
 * correlated `AnyCommandEnvelopeV1`, which is real, invasive rework this fix does not need.
 * This function's own call site never has that problem: `envelope.payload` is already
 * typed, not `unknown` — no further schema lookup happens here at all.)
 */
function dispatchToHandler<K extends CommandKindV1>(
  handlers: TotalHandlerMap,
  envelope: CommandEnvelopeV1<K>,
  context: HandlerContext,
): CommandOutcomeV1 {
  const handler = handlers[envelope.kind];
  return handler(envelope.payload, context);
}

/**
 * Assembles a complete `TotalHandlerMap` into the `HandlerRegistry` shape `core/mailbox/
 * model/dispatch.ts` calls (`(envelope: CommandEnvelopeV1) => HandlerOutcome`). All the
 * correlation work happens in {@link dispatchToHandler} above — this function is just the
 * closure that carries `handlers` across every call.
 */
export function createHandlerRegistry(
  context: HandlerContext,
  handlers: TotalHandlerMap,
): HandlerRegistry {
  return function handle(envelope) {
    return dispatchToHandler(handlers, envelope, context);
  };
}
