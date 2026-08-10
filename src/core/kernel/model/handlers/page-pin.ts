import { wrap } from "@reatom/core";

import type { PublishableEventV1 } from "core/mailbox";
import { createPin, setPinStatus } from "core/pins";
import type { DesignTreeReader, PageMutations } from "core/ports";
import { readPageEntrySource, readPageOrder } from "core/project";
import {
  type ConfirmPageRemoveDeps,
  type RenameTitleDeps,
  type ReorderDeps,
  confirmPageRemove,
  discardPageRemovePlan,
  renameTitle,
  reorder,
} from "core/project/model/page-mutations";
import type { CommandPayloadByKindV1 } from "core/protocol";
import { log } from "infrastructure/debug-log";

import type { CommandOutcomeV1, FamilyHandlerMap, HandlerContext } from "./types";
import { completedOutcome, noOpOutcome, startedOutcome } from "./types";

/**
 * `page.renameTitle` / `page.reorder` / `page.removePlan` / `page.removeConfirm` /
 * `page.removeDiscardPlan` / `pin.create` / `pin.setStatus` (kernel-assembly WP-1 task 9,
 * Step C2 — the `page`+`pin` family, grouped in one file the same way `selection-model.ts`
 * groups its own two sibling families).
 *
 * Step B's own investigation (`.superpowers/sdd/task9-family-page-pin-report.md`) returned
 * NEEDS_CONTEXT for every one of these seven commands: `RenameTitleDeps`/`ReorderDeps`/
 * `ConfirmPageRemoveDeps` all hard-require a per-Kernel `PageRemovePlanLedger`
 * (surface 1), `pin.create` hard-requires a per-Kernel `FrameTokenLedger`/
 * `GeometryTokenLedger` pair (surface 2), and `pin.setStatus` hard-requires a pin-to-page
 * resolution primitive `core/ports/pin-store.ts` never had (surface 3). Step C1 closed
 * surfaces 1 and 2 on `HandlerContext` (`pageRemovePlanLedger`/`frameTokenLedger`/
 * `geometryTokenLedger` — see `./types.ts`'s own "STEP C1 ADDITIONS"); this task closed
 * surface 3 (`PinReader.readEvents`/`findPageForPin`, `core/ports/pin-store.ts`, its own
 * commit). Every command below is now buildable without inventing state outside either
 * contract.
 *
 * NO MACHINE OF ITS OWN. `page`/`pin` are both named, among `chat`/`model`/`selection`/
 * `history`, as families with no state machine among the seven `KernelMachines`
 * (`./types.ts`'s own comment) — no handler here ever calls `context.machines.*` or any of
 * `HandlerContext`'s five ordinary Kernel-held mutators. `page.removeDiscardPlan` is the one
 * exception to "always async": `discardPageRemovePlan` (`core/project/model/
 * page-mutations.ts`) is a plain synchronous function with no port I/O at all, so its
 * handler resolves synchronously too — `completedOutcome`/`noOpOutcome`, matching its own
 * two-armed `"discarded" | "not-found"` result exactly (something happened vs. nothing did).
 * Every other handler is genuinely async (a port call, a mutex acquisition, or both) and
 * follows `chat.ts`/`selection-model.ts`'s own established shape for a no-machine family:
 * return `startedOutcome([])` synchronously with no admission events (nothing is knowable
 * about the outcome until the async work settles), then do the real work inside exactly one
 * `context.launchOperation` `run` closure, `wrap`-ing every awaited call — including a call
 * into an already-`wrap`-internally-composed model function, matching `handlers/project.ts`'s
 * own precedent (`await wrap(scanOrphanTurns(...))`) — since crossing THIS file's own
 * `await` is itself a fresh async boundary regardless of what the callee does internally.
 *
 * FLAGGED GAP, NOT INVENTED: `page.renameTitle`/`page.reorder`/`page.removeConfirm`'s
 * natural completion event is `page.descriptorsChanged` (`core/protocol/model/
 * event-payload.ts`'s own closed reason enum names `"rename-title"`/`"reorder-pages"`/
 * `"remove-page"` for exactly these three cases) — but assembling one needs a full
 * Gate-based descriptor rebuild (`core/project/model/descriptors.ts`'s
 * `buildPageDescriptorsChangedPayload` + `context.deps.gateRunner.runPage` over every page,
 * matching `handlers/project.ts`'s own `buildPageDescriptors` helper) to produce BOTH a
 * "before" and an "after" descriptor list, since `HandlerContext` has no primitive for
 * reading back "the currently known descriptor list" (`handlers/project.ts`'s own header
 * flags the identical gap for `kernel.snapshot`'s hardcoded `pageDescriptors` field). Unlike
 * `handlers/project.ts`'s own family brief, which explicitly named `descriptors.ts` reuse as
 * part of ITS deliverable, this task's own brief names only the five `page.*`/two `pin.*`
 * model functions above — never `descriptors.ts`/`GateRunner` — and the original
 * investigation report's own per-command breakdown never flagged Gate/descriptor assembly as
 * a blocker for `renameTitle`/`reorder` either (only the ledger gap). So the real mutation
 * always runs (the correct, observable side effect happens for real), but no
 * `page.descriptorsChanged` event is built here — flagged explicitly, once, rather than
 * silently reinvented per handler below. Building it is a well-scoped follow-up for whoever
 * next revises this family, reusing `handlers/project.ts`'s own already-established pattern.
 */

function pageStoreOf(context: HandlerContext): DesignTreeReader & PageMutations {
  return { ...context.deps.designReader, ...context.deps.pageMutations };
}

// ---------------------------------------------------------------------------
// page.renameTitle
// ---------------------------------------------------------------------------

async function runPageRenameTitle(
  payload: CommandPayloadByKindV1["page.renameTitle"],
  context: HandlerContext,
): Promise<readonly PublishableEventV1[]> {
  const deps: RenameTitleDeps = {
    pageStore: pageStoreOf(context),
    planLedger: context.pageRemovePlanLedger,
  };
  const failure = await wrap(renameTitle(deps, payload.pageSlug, payload.title));
  if (failure !== undefined) {
    log.warn(
      `core/kernel: page.renameTitle failed for "${payload.pageSlug}": ${failure.safeMessage}`,
    );
  }
  // See this file's header — `page.descriptorsChanged` is a documented, flagged gap, not
  // built here either way.
  return [];
}

function handlePageRenameTitle(
  payload: CommandPayloadByKindV1["page.renameTitle"],
  context: HandlerContext,
): CommandOutcomeV1 {
  context.launchOperation("kernel.page.renameTitle", () => runPageRenameTitle(payload, context));
  return startedOutcome([]);
}

// ---------------------------------------------------------------------------
// page.reorder
// ---------------------------------------------------------------------------

async function runPageReorder(
  payload: CommandPayloadByKindV1["page.reorder"],
  context: HandlerContext,
): Promise<readonly PublishableEventV1[]> {
  const deps: ReorderDeps = {
    pageStore: pageStoreOf(context),
    planLedger: context.pageRemovePlanLedger,
  };
  const result = await wrap(reorder(deps, payload.pageSlugs));
  if ("code" in result) {
    log.warn(`core/kernel: page.reorder failed: ${result.safeMessage}`);
  } else if (result.kind === "invalid-permutation") {
    log.warn("core/kernel: page.reorder rejected a non-permutation pageSlugs list");
  }
  // See this file's header — `page.descriptorsChanged` is a documented, flagged gap.
  return [];
}

function handlePageReorder(
  payload: CommandPayloadByKindV1["page.reorder"],
  context: HandlerContext,
): CommandOutcomeV1 {
  context.launchOperation("kernel.page.reorder", () => runPageReorder(payload, context));
  return startedOutcome([]);
}

// ---------------------------------------------------------------------------
// page.removePlan
// ---------------------------------------------------------------------------

async function runPageRemovePlan(
  payload: CommandPayloadByKindV1["page.removePlan"],
  context: HandlerContext,
): Promise<readonly PublishableEventV1[]> {
  const { designReader, projectStore } = context.deps;

  // ONE manifest read for both facts below: the page order the plan freezes, and the entry
  // whose bytes give the plan its `sourceHash`. Reading it twice would let the two disagree.
  const pages = await wrap(readPageOrder(designReader));
  if ("code" in pages) {
    log.warn(`core/kernel: page.removePlan could not list pages: ${pages.safeMessage}`);
    return [];
  }
  const orderedPageSlugs = pages.map((entry) => entry.slug);

  const source = await wrap(readPageEntrySource(designReader, payload.pageSlug, pages));
  if ("code" in source) {
    log.warn(
      `core/kernel: page.removePlan could not read "${payload.pageSlug}": ${source.safeMessage}`,
    );
    return [];
  }

  const workspace = await wrap(projectStore.readWorkspaceState());
  if ("code" in workspace) {
    log.warn(
      `core/kernel: page.removePlan could not read workspace state: ${workspace.safeMessage}`,
    );
    return [];
  }

  const plan = context.pageRemovePlanLedger.mint({
    pageSlug: payload.pageSlug,
    sourceHash: source.sourceHash,
    orderedPageSlugs,
    activePageSlug: workspace.state.activePageSlug,
  });
  if (plan instanceof Error) {
    log.warn(`core/kernel: page.removePlan could not mint a plan: ${plan.message}`);
    return [];
  }

  return [{ kind: "page.removePlanReady", payload: plan }];
}

function handlePageRemovePlan(
  payload: CommandPayloadByKindV1["page.removePlan"],
  context: HandlerContext,
): CommandOutcomeV1 {
  context.launchOperation("kernel.page.removePlan", () => runPageRemovePlan(payload, context));
  return startedOutcome([]);
}

// ---------------------------------------------------------------------------
// page.removeConfirm
// ---------------------------------------------------------------------------

async function runPageRemoveConfirm(
  payload: CommandPayloadByKindV1["page.removeConfirm"],
  context: HandlerContext,
): Promise<readonly PublishableEventV1[]> {
  const deps: ConfirmPageRemoveDeps = {
    pageStore: pageStoreOf(context),
    projectStore: context.deps.projectStore,
    planLedger: context.pageRemovePlanLedger,
    mutex: context.deps.projectWrite,
  };
  const result = await wrap(confirmPageRemove(deps, payload.pageRemovePlanId));

  if (result.kind === "failure") {
    log.warn(`core/kernel: page.removeConfirm failed: ${result.failure.safeMessage}`);
  } else if (result.kind === "stale") {
    log.warn(
      `core/kernel: page.removeConfirm rejected as stale: ${result.driftedFields.join(", ")}`,
    );
  } else if (result.kind === "not-found") {
    log.warn(
      `core/kernel: page.removeConfirm found no matching active plan for "${payload.pageRemovePlanId}"`,
    );
  }
  // See this file's header — a successful removal's natural completion event
  // (`page.descriptorsChanged`, reason "remove-page") is a documented, flagged gap.
  return [];
}

function handlePageRemoveConfirm(
  payload: CommandPayloadByKindV1["page.removeConfirm"],
  context: HandlerContext,
): CommandOutcomeV1 {
  context.launchOperation("kernel.page.removeConfirm", () =>
    runPageRemoveConfirm(payload, context),
  );
  return startedOutcome([]);
}

// ---------------------------------------------------------------------------
// page.removeDiscardPlan
// ---------------------------------------------------------------------------

/**
 * The one synchronous handler in this file: `discardPageRemovePlan` (`core/project/model/
 * page-mutations.ts`) does no port I/O at all (its own doc comment: "Synchronous — no
 * port I/O at all"), so there is no async boundary to bridge through `launchOperation` here.
 * `"discarded"` genuinely transitioned Kernel-held ledger state (`completedOutcome`);
 * `"not-found"` changed nothing (`noOpOutcome`) — matching the model function's own two-armed
 * result exactly, and `CommandHandler`'s own two-outcome doctrine (idempotent refusal vs.
 * something ran).
 */
function handlePageRemoveDiscardPlan(
  payload: CommandPayloadByKindV1["page.removeDiscardPlan"],
  context: HandlerContext,
): CommandOutcomeV1 {
  const result = discardPageRemovePlan(
    { planLedger: context.pageRemovePlanLedger },
    payload.pageRemovePlanId,
  );
  return result.kind === "discarded" ? completedOutcome([]) : noOpOutcome();
}

// ---------------------------------------------------------------------------
// pin.create
// ---------------------------------------------------------------------------

/**
 * Composes `core/pins/model/create.ts`'s already-tested `createPin` wholesale, rather than
 * duplicating its token-ledger checks here — `FrameTokenLedger.currentIdentity()`/
 * `GeometryTokenLedger.consume()` are both synchronous, so a pre-check split (mirroring
 * `selection-model.ts`'s own sync `validateModelSelection` before `model.select` launches)
 * was considered, but `consume()` has a side effect (it deletes the entry): a separate
 * synchronous pre-check would consume the token once for the decision and `createPin` would
 * then try to consume it AGAIN inside `launchOperation`, always failing as
 * `GEOMETRY_TOKEN_INVALID` on a token that was actually still good. Calling `createPin`
 * exactly once, unconditionally inside `launchOperation`, avoids that double-consume bug
 * entirely and matches `chat.ts`'s own precedent for an async command whose port call might
 * legitimately fail or reject: always `startedOutcome([])`, never a pre-emptive `noOpOutcome`.
 */
function handlePinCreate(
  payload: CommandPayloadByKindV1["pin.create"],
  context: HandlerContext,
): CommandOutcomeV1 {
  context.launchOperation("kernel.pin.create", async () => {
    const result = await wrap(
      createPin(
        {
          pinMutations: context.deps.pinMutations,
          clock: context.deps.clock,
          frameTokenLedger: context.frameTokenLedger,
          geometryTokenLedger: context.geometryTokenLedger,
        },
        { geometryToken: payload.geometryToken, text: payload.text },
      ),
    );

    // `FailureDtoV1` and `CreatePinResultV1`'s own `{kind:"rejected", code}` member BOTH
    // carry a `code` field — `"code" in result` alone cannot tell them apart. `kind` exists
    // only on `CreatePinResultV1`'s two members, so it is the correct first discriminator.
    if (!("kind" in result)) {
      log.warn(`core/kernel: pin.create failed: ${result.safeMessage}`);
      return [];
    }
    if (result.kind === "rejected") {
      log.warn(`core/kernel: pin.create rejected: ${result.code}`);
      return [];
    }
    return [{ kind: "pins.changed", payload: result.payload }];
  });

  return startedOutcome([]);
}

// ---------------------------------------------------------------------------
// pin.setStatus
// ---------------------------------------------------------------------------

/**
 * `core/ports/pin-store.ts`'s own `findPageForPin` result is `FailureDtoV1 | PageSlug | null`
 * — `PageSlug` is a branded STRING (`entities/page/types.ts`), not an object, so
 * `"code" in resolved` would throw at runtime for the string case (`in` requires an object
 * operand) rather than narrowing false, matching this ring's established convention for a
 * `FailureDtoV1 | (bare primitive)` union (`handlers/project.ts`'s own `resolveTrust`
 * comment: "a bare string union ... `"code" in x` would throw on it"). `typeof === "string"`
 * is the safe narrowing check instead.
 */
async function runPinSetStatus(
  payload: CommandPayloadByKindV1["pin.setStatus"],
  context: HandlerContext,
): Promise<readonly PublishableEventV1[]> {
  const { pinReader, pinMutations, clock } = context.deps;

  const resolved = await wrap(pinReader.findPageForPin(payload.pinId));
  if (resolved === null) {
    log.warn(`core/kernel: pin.setStatus found no page for pinId "${payload.pinId}"`);
    return [];
  }
  if (typeof resolved !== "string") {
    log.warn(
      `core/kernel: pin.setStatus could not resolve pinId "${payload.pinId}"'s page: ${resolved.safeMessage}`,
    );
    return [];
  }
  const pageSlug = resolved;

  const priorEvents = await wrap(pinReader.readEvents(pageSlug));
  if ("code" in priorEvents) {
    log.warn(
      `core/kernel: pin.setStatus could not read the pin log for "${pageSlug}": ${priorEvents.safeMessage}`,
    );
    return [];
  }

  const result = await wrap(
    setPinStatus(
      { pinMutations, clock },
      { pageSlug, pinId: payload.pinId, status: payload.status, priorEvents },
    ),
  );
  if ("code" in result) {
    log.warn(`core/kernel: pin.setStatus failed: ${result.safeMessage}`);
    return [];
  }
  if (result.kind === "not-found") {
    log.warn(
      `core/kernel: pin.setStatus found no pin "${payload.pinId}" on page "${pageSlug}"`,
    );
    return [];
  }

  return [{ kind: "pins.changed", payload: result.payload }];
}

function handlePinSetStatus(
  payload: CommandPayloadByKindV1["pin.setStatus"],
  context: HandlerContext,
): CommandOutcomeV1 {
  context.launchOperation("kernel.pin.setStatus", () => runPinSetStatus(payload, context));
  return startedOutcome([]);
}

// ---------------------------------------------------------------------------
// The family maps
// ---------------------------------------------------------------------------

export const pageHandlers: FamilyHandlerMap<"page"> = {
  "page.renameTitle": handlePageRenameTitle,
  "page.removePlan": handlePageRemovePlan,
  "page.removeConfirm": handlePageRemoveConfirm,
  "page.removeDiscardPlan": handlePageRemoveDiscardPlan,
  "page.reorder": handlePageReorder,
};

export const pinHandlers: FamilyHandlerMap<"pin"> = {
  "pin.create": handlePinCreate,
  "pin.setStatus": handlePinSetStatus,
};
