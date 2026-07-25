import type { HandlerRegistry } from "core/mailbox";
import type { CommandEnvelopeV1, CommandKindV1 } from "core/protocol";

import { chatHandlers } from "./chat";
import { type DeferredHandlerKind, deferredHandlers } from "./deferred";
import { pageHandlers, pinHandlers } from "./page-pin";
import { exportHandlers, previewHandlers } from "./preview-export";
import { projectHandlers } from "./project";
import { modelHandlers, selectionHandlers } from "./selection-model";
import { turnHandlers } from "./turn";
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
 * Kernel-assembly WP-1 task 9. STEP C1 wired four of the nine named families (`chat`,
 * `selection`+`model`, `project`, `preview`+`export`) — real, tested `FamilyHandlerMap`s
 * (`./chat.ts`, `./selection-model.ts`, `./project.ts`, `./preview-export.ts`) spread into
 * {@link totalHandlers} below, replacing their `notYetImplementedHandler` stand-ins. STEP
 * C3 wires the remaining two built families, `turn` (`./turn.ts`) and `page`+`pin`
 * (`./page-pin.ts`) — both returned NEEDS_CONTEXT investigations during Step B
 * (`.superpowers/sdd/task9-family-turn-report.md`, `task9-family-page-pin-report.md`);
 * Step C1 closed the contract gaps those two reports proved (`./types.ts`'s `HandlerContext`
 * — see its own "STEP C1 ADDITIONS" comment), and Step C2/C3 wrote both families without
 * touching `types.ts`/`kernel.ts` for either family's own command routing (Step C3 DID
 * extend `HandlerContext`/`kernel.ts` for the turn family's live-publish primitive — see
 * `./types.ts`'s own doc comment on `publishOperationEvent`).
 *
 * `turn.start` itself is STILL the sanctioned no-op inside `turnHandlers` (`./turn.ts`'s own
 * header names the exact `core/ports` gap — reading a frozen turn candidate's send-time
 * read-set append-bases — that blocks composing `runTurn` end to end); `turn.cancel` is
 * real and tested. Wiring `turnHandlers` here needs neither kind to be "fully real" — it
 * only requires `turnHandlers` to be the REAL family map (real `turn.cancel`, a documented
 * `turn.start` no-op) instead of the generic `notYetImplementedHandler` stand-in, which is
 * exactly what changed.
 *
 * `migration.*` is NOT a ninth Step B/C family still waiting its turn like the eight above —
 * MVP phase-8 task 18 re-documents it as DELIBERATELY POST-MVP, a distinct status from every
 * other kind this file has ever stood in for. The eight families above were "not yet built"
 * in the ordinary sense: each had a real target module and landed the moment its Step B/C
 * work did. Migration has no such target inside MVP at all: MVP ships exactly ONE storage
 * format version (`docs/architecture/flows/migration.md`'s walkthrough item 1 — every
 * versioned file kind, `project.toml`/`workspace.local.toml`/the transaction journal, has
 * only ever produced format version 1), so there is nothing to migrate FROM, and a migration
 * step written against a single known version has no second version to migrate FROM or TO in
 * a test — it would be unexercisable by construction, not merely untested. Writing a real
 * `migration` family handler stays out of scope until a second format version actually ships,
 * which is a post-MVP event, not a scheduling gap in this phase's own work list.
 *
 * The guard-level reasoning `./deferred.ts`'s header documents is unchanged and still the
 * reason this can never route through `deferredHandlers` either: `core/versions`'s
 * `DEFERRED_CAPABILITY_KINDS` does not include any `migration.*` kind, and the real guard
 * (`capabilities/model/guards.ts`'s `migrationFamilyReason`) evaluates ACTUAL phase legality
 * rather than rejecting unconditionally (e.g. `migration.plan` is legal from the migration
 * machine's own `idle` phase) — so `migration.*` commands can legitimately pass the guard
 * today, and routing them through `deferredHandlers` would silently no-op a guard-accepted
 * command while pretending it was never reachable. Nor can a handler return a typed rejection
 * instead of a no-op: `HandlerOutcome` (`core/mailbox`, see `./types.ts`'s own `CommandHandler`
 * doc comment) has exactly three dispositions — `no-op`/`completed`/`started` — and no fourth
 * "rejected" shape at all. The 31-code typed `UnavailableReason` vocabulary
 * (`core/protocol/model/unavailable-reason.ts`) that WOULD say "deliberately unavailable, and
 * here is why" more precisely than a bare no-op is surfaced exclusively by
 * `evaluateCapabilityGuard` and the capability projector that calls it verbatim
 * (`core/capabilities/model/projector.ts`), never by a handler — a handler is never the layer
 * that reports "rejected" (`./deferred.ts`'s own header makes the identical point for the
 * Tier-C kinds). So `noOpOutcome()` remains the only typed refusal this file's own vocabulary
 * has to offer, and it is the right one for a command MVP has already decided never to act on:
 * nothing runs, no machine transitions, no Kernel-held fact changes, no event fires. Its four
 * kinds get that well-formed no-op via {@link migrationPostMvpHandler} below — renamed from
 * the generic `notYetImplementedHandler` this map used while it still held nine families'
 * worth of stand-ins, since migration is now the only entry left in it and its own reason is
 * settled, not open; see the task report for the full writeup.
 */

/**
 * Exclusion-computed, not hand-listed — the complement of `DeferredHandlerKind` and every
 * landed family's own kinds. Today that complement resolves to EXACTLY the four
 * `migration.*` kinds (see the header above for why); the `Exclude` form is kept anyway
 * rather than switched to a literal 4-member union, because it is what makes the
 * `satisfies TotalHandlerMap` clause on {@link totalHandlers} a real exhaustiveness check —
 * a `CommandKindV1` member added anywhere without a matching family entry falls into this
 * type automatically and the compiler demands a handler for it, instead of silently
 * type-checking a map with a hole in it.
 */
type MigrationPostMvpKind = Exclude<
  CommandKindV1,
  | DeferredHandlerKind
  | "chat.create"
  | "chat.switch"
  | "selection.set"
  | "selection.clear"
  | "model.select"
  | "project.create"
  | "project.open"
  | "project.retryOpen"
  | "project.close"
  | "project.setTrust"
  | "preview.selectPage"
  | "preview.selectHistorical"
  | "preview.selectCurrent"
  | "preview.resize"
  | "preview.setThemeCapabilities"
  | "preview.setMode"
  | "preview.queryGeometry"
  | "preview.retry"
  | "preview.close"
  | "export.start"
  | "turn.start"
  | "turn.cancel"
  | "page.renameTitle"
  | "page.removePlan"
  | "page.removeConfirm"
  | "page.removeDiscardPlan"
  | "page.reorder"
  | "pin.create"
  | "pin.setStatus"
>;

/**
 * MVP's one deliberate post-MVP refusal (task 18) — no longer a generic "not yet built"
 * stand-in, since migration is now the only family left on this slot and its own reason is
 * settled: MVP ships exactly one storage format version, so there is nothing to migrate
 * FROM, and a migration step has no second version to be exercised against in a test. See
 * this file's own header above and `docs/architecture/flows/migration.md` for the full
 * reasoning, and that header's own paragraph for why `noOpOutcome()` — not a typed
 * `UnavailableReason` — is the correct refusal shape here: `HandlerOutcome` has no rejected
 * disposition a handler could return instead, and the typed reason vocabulary is a
 * guard/projector-only concern. Still mirrors task 8's original minimal `HandlerRegistry`
 * (`kernel.ts`'s own comment: "an explicitly empty, revision-neutral no-op for every kind")
 * but WITHOUT its `console.warn` — the same fix also-fix (b) applies to `kernel.ts` itself,
 * so this handler never re-introduces the stderr noise that fix removes.
 */
function migrationPostMvpHandler(): ReturnType<typeof noOpOutcome> {
  return noOpOutcome();
}

const migrationPostMvpHandlers: CommandHandlerMap<MigrationPostMvpKind> = {
  "migration.plan": migrationPostMvpHandler,
  "migration.confirm": migrationPostMvpHandler,
  "migration.discardPlan": migrationPostMvpHandler,
  "migration.retryRecovery": migrationPostMvpHandler,
};

/**
 * The complete, 43-kind `TotalHandlerMap`: `deferredHandlers` (10, real) + the six landed
 * families' maps (29: `chatHandlers` 2, `selectionHandlers` 2, `modelHandlers` 1,
 * `projectHandlers` 5, `previewHandlers` 9, `exportHandlers` 1, `turnHandlers` 2,
 * `pageHandlers` 5, `pinHandlers` 2) + `migrationPostMvpHandlers` (4, deliberately
 * post-MVP: `migration.*` — see this file's own header for why, not merely "not yet
 * built"). The `satisfies` clause below is the compile-time exhaustiveness check the
 * task brief requires — remove, rename, or add a `CommandKindV1` member without updating one
 * of these maps and this line stops compiling; it is never a runtime surprise.
 */
export const totalHandlers = {
  ...deferredHandlers,
  ...chatHandlers,
  ...selectionHandlers,
  ...modelHandlers,
  ...projectHandlers,
  ...previewHandlers,
  ...exportHandlers,
  ...turnHandlers,
  ...pageHandlers,
  ...pinHandlers,
  ...migrationPostMvpHandlers,
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
