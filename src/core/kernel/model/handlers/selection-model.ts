import { wrap } from "@reatom/core";

import { type ModelSelectionV1, selectModel, validateModelSelection } from "core/chats";
import type { PublishableEventV1 } from "core/mailbox";
import type { CommandPayloadByKindV1, EventPayloadByKindV1 } from "core/protocol";

import type { KernelDeps } from "../../types";
import {
  type CommandOutcomeV1,
  type FamilyHandlerMap,
  type HandlerContext,
  completedOutcome,
  noOpOutcome,
  startedOutcome,
} from "./types";

/**
 * Kernel-assembly WP-1 task 9, STEP B — the `selection` and `model` command families
 * (`selection.set`, `selection.clear`, `model.select`). Both families are grouped in one
 * file because `command-kind.ts`'s own `COMMAND_FAMILIES_V1` treats them as siblings with
 * the SAME defining trait: `core/capabilities/model/guards.ts`'s own header note lists both
 * among the families that "have no machine of their own among the seven" — neither family
 * ever calls `context.machines.*` or any of `HandlerContext`'s five Kernel-held mutators;
 * every handler below touches only `context.deps` and, where the real work is inherently
 * async, `context.launchOperation`.
 *
 * `model.select` COMPOSES `core/chats`'s pre-existing, already-tested
 * `validateModelSelection`/`selectModel` (`core/chats/model/model-select.ts`) rather than
 * re-deriving the same `AgentRegistry`/`ProjectStore` validate-then-persist logic here a
 * second time — "do not duplicate" (kernel-assembly plan, Global Constraints). `selection.*`
 * has no such pre-existing orchestration module (`core/chats`, `core/pins`, `core/preview`,
 * and `core/project` all exist; no `core/selection` does), so its two handlers build the
 * `selection.changed` DTO directly against `deps.pageReader`.
 *
 * SYNCHRONOUS HANDLER, ASYNC PORTS. `CommandHandler` is a plain synchronous function
 * (`(payload, context) => CommandOutcomeV1`) — but `PageReader.readSource` and
 * `ProjectStore.writeWorkspaceState` are both `Promise`-returning. `context.launchOperation`
 * is `HandlerContext`'s ONE sanctioned bridge across that boundary (`./types.ts`'s own doc
 * comment), so `selection.set` and a validated `model.select` both return
 * `startedOutcome([])` synchronously and do their real work inside a `launchOperation` `run`
 * closure. `selection.clear` and an INVALID `model.select` triple need no I/O at all
 * (`validateModelSelection` is pure) and resolve entirely synchronously.
 *
 * NO DEDICATED FAILURE EVENT EXISTS FOR EITHER FAMILY. `selection.changed`'s payload
 * (`SelectionChangedPayloadV1 = SelectionDtoV1 | null`) has no failure-shaped variant, and
 * `EventPayloadByKindV1`'s closed 43-kind map has no `model.*` member AT ALL — verified by
 * reading the map itself, not assumed. So a `run` closure that cannot complete its work (a
 * page that fails to resolve; a workspace-state write that fails) has no event to publish
 * either way — it logs (errore rule 21: an error that is not otherwise propagated must
 * leave a trace) and resolves with zero terminal events, the only shape the closed protocol
 * allows for that outcome. This is NOT the general "ran and failed" two-outcome doctrine
 * (`./types.ts`'s `CommandHandler` doc) working as designed elsewhere — it is a real
 * boundary case that doctrine doesn't have a slot for, flagged here rather than silently
 * worked around.
 *
 * TWO CONFIRMED, FLAGGED CONTRACT GAPS (not invented around — see the task brief's own
 * instruction to name a missing surface rather than patch over it with out-of-contract
 * state):
 *
 * 1. No Kernel-held storage for "the current selection" exists on `HandlerContext`. The
 *    five existing mutators (`setProjectTrust`, `setActiveTurnId`, `setCommitIntentRecorded`,
 *    `setPreviewSourceKind`, `setActivePreviewSession`) are the WHOLE non-machine mutation
 *    surface (`./types.ts`'s own doc comment) — there is no sixth `setSelection`-shaped
 *    mutator, and no accessor either. `kernel-command-contract` §12.2 says `turn.start`
 *    "captures ... authoritative selection" at send time, which requires SOME Kernel-held
 *    fact a future `turn.start` handler can read back — but `turn.start`'s own payload
 *    carries no selection field, `KernelStateSnapshot` deliberately excludes selection (it
 *    is not a capability-guard input — `capabilities/types.ts`'s own header note), and
 *    `ProjectStore`'s `WorkspaceStateV1` explicitly excludes it too ("selection ... deliberately
 *    absent ... those are live Kernel state, not persisted here" — `project-store.ts`).
 *    `selection.clear`'s outcome is therefore UNCONDITIONAL — it always emits
 *    `selection.changed(null)` regardless of whatever was selected before, mirroring
 *    `kernel.ts`'s own `close()` unconditionally nulling `activePreview` — rather than
 *    inventing a module-level atom (forbidden: no family module may hold mutable state of
 *    its own, and only `kernel.ts`/`types.ts` — off-limits to this task — may add a new
 *    Kernel-held fact). Closing this needs a sixth `HandlerContext` mutator (+ a read path)
 *    added by a task empowered to touch `kernel.ts`/`types.ts`, before `turn.start`'s own
 *    family can honor §12.2 for real.
 * 2. `model.select`'s own effect has no wire representation beyond the durable
 *    `ProjectStore` write. `kernel.snapshot`'s `agentIdentity` field (M22) is the only
 *    place a selected backend/model could ever surface, and `kernel.ts`'s own
 *    `buildAgentIdentity()` is hard-coded to always return `null` today, by its own comment,
 *    specifically because "no selection mechanism exists yet" — i.e. no Kernel-held atom for
 *    it exists either. Reflecting `model.select` in `kernel.snapshot` needs the SAME kind of
 *    new mutator (Task 8's `kernel.ts`, not this file) — out of reach here for the same
 *    reason as gap 1.
 */

// --- selection.set / selection.clear -----------------------------------------------------

/** `selection.changed`'s own DTO, derived from the closed protocol map rather than re-declared — matches `core/chats/types.ts`'s own `ChatSummaryV1` precedent. */
export type SelectionDtoV1 = NonNullable<EventPayloadByKindV1["selection.changed"]>;

function selectionChangedEvent(
  selection: SelectionDtoV1 | null,
): PublishableEventV1<"selection.changed"> {
  return { kind: "selection.changed", payload: selection };
}

/**
 * `selection.set`'s async step: resolve the page's CURRENT source hash through
 * `PageReader.readSource` — the only sanctioned way to obtain an authoritative `sourceHash`
 * (nothing on `HandlerContext`/`KernelStateSnapshot` carries one synchronously). A read
 * failure (unknown/unreadable page) has no failure-event shape to carry it (see this file's
 * header) — logged, then resolved with zero events.
 */
async function runSelectionSet(
  payload: CommandPayloadByKindV1["selection.set"],
  deps: KernelDeps,
): Promise<readonly PublishableEventV1[]> {
  const source = await wrap(deps.pageReader.readSource(payload.pageSlug));
  if ("code" in source) {
    console.warn(
      `core/kernel: selection.set could not resolve page "${payload.pageSlug}" — ${source.safeMessage}`,
    );
    return [];
  }
  return [
    selectionChangedEvent({
      pageSlug: payload.pageSlug,
      elementId: payload.elementId,
      sourceHash: source.sourceHash,
    }),
  ];
}

function handleSelectionSet(
  payload: CommandPayloadByKindV1["selection.set"],
  context: HandlerContext,
): CommandOutcomeV1 {
  context.launchOperation("kernel.selection.set", () => runSelectionSet(payload, context.deps));
  return startedOutcome([]);
}

/**
 * `selection.clear` (§8.2: "Clear selection") is UNCONDITIONAL — see this file's header,
 * gap 1: there is no Kernel-held "current selection" fact this handler could read back to
 * decide whether clearing actually changes anything, so it always transitions and always
 * emits, exactly mirroring `kernel.ts`'s own `close()` unconditionally nulling
 * `activePreview`. No I/O is needed at all.
 */
function handleSelectionClear(): CommandOutcomeV1 {
  return completedOutcome([selectionChangedEvent(null)]);
}

export const selectionHandlers: FamilyHandlerMap<"selection"> = {
  "selection.set": handleSelectionSet,
  "selection.clear": handleSelectionClear,
};

// --- model.select ---------------------------------------------------------------------------

/**
 * `model.select`'s async step: persist the ALREADY-VALIDATED triple through
 * `core/chats`'s `selectModel` (re-validates internally too — pure and cheap, so calling it
 * a second time costs nothing and keeps ONE source of truth for the validate+persist unit
 * rather than this file re-deriving `ProjectStore.writeWorkspaceState`'s call shape by
 * hand). Neither a validation rejection nor a write failure has an event to carry (see this
 * file's header) — logged, then resolved with zero events either way.
 */
async function runModelSelect(
  selection: ModelSelectionV1,
  deps: KernelDeps,
): Promise<readonly PublishableEventV1[]> {
  const result = await wrap(
    selectModel({ registry: deps.agentRegistry, projectStore: deps.projectStore }, selection),
  );
  if ("code" in result) {
    const reason = "safeMessage" in result ? result.safeMessage : result.code;
    console.warn(
      `core/kernel: model.select failed to persist "${selection.backend}/${selection.model}/${selection.effort}" — ${reason}`,
    );
  }
  // No EventKindV1 member exists for a model-selection change (this file's header, gap 2) —
  // success or failure, there is nothing to publish; the durable `ProjectStore` write is the
  // only observable effect.
  return [];
}

/**
 * `model.select` (§8.2: "Validate backend capability and store the machine-local
 * selection"). Validation runs SYNCHRONOUSLY first via `validateModelSelection` (pure, no
 * I/O) so an unknown backend/model/effort triple is a true idempotent refusal — a
 * synchronous `noOpOutcome()`, never a throw, never an async launch — exactly per the task
 * contract. Only a validated triple ever reaches `context.launchOperation`.
 */
function handleModelSelect(
  payload: CommandPayloadByKindV1["model.select"],
  context: HandlerContext,
): CommandOutcomeV1 {
  const selection: ModelSelectionV1 = {
    backend: payload.backend,
    model: payload.model,
    effort: payload.effort,
  };
  const validated = validateModelSelection(context.deps.agentRegistry, selection);
  if ("code" in validated) return noOpOutcome();

  context.launchOperation("kernel.model.select", () => runModelSelect(validated, context.deps));
  return startedOutcome([]);
}

export const modelHandlers: FamilyHandlerMap<"model"> = {
  "model.select": handleModelSelect,
};
