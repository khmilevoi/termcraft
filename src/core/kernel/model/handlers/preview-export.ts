import { wrap } from "@reatom/core";

import type { PreviewAction, PreviewState, TransitionOutcome } from "core/machines";
import type { EventCorrelationV1, PublishableEventV1 } from "core/mailbox";
import type {
  ColorCapabilityV1,
  HostSessionSpecV1,
  PreviewSizePresetV1,
  WorkspaceStateV1,
} from "core/ports";
import type { FailureDtoV1, Sha256Hex, UUIDv7 } from "core/protocol";
import type { PageSlug, Size } from "entities/page";
import { uuidv7 } from "infrastructure/uuid";

import type { CommandOutcomeV1, FamilyHandlerMap, HandlerContext } from "./types";
import { completedOutcome, noOpOutcome, startedOutcome } from "./types";

/**
 * `preview-export.ts` — kernel-assembly WP-1 task 9, Step B: the `preview` family's 9
 * non-deferred kinds (`preview.forwardInput`/`preview.setTweak` are Tier-C deferred,
 * `./deferred.ts` owns them) plus the `export` family's one kind, `export.start`.
 *
 * TWO GENUINE, INDEPENDENTLY-VERIFIED CONTRACT GAPS bound what this file can honestly do —
 * both are reported in the family's own report (`.superpowers/sdd/
 * task9-family-preview-export-report.md`), not silently guessed around. Read this header
 * before touching either family's handlers below; each blocked handler's own doc comment
 * points back here rather than re-deriving the same investigation nine times.
 *
 * GAP A — no way to read back the Kernel's own live `PreviewSession`. `HandlerContext`
 * declares `setActivePreviewSession(session): void` (a SETTER for `kernel.ts`'s own
 * `activePreview` closure variable) but NO corresponding getter. `core/preview/model/
 * session-commands.ts`'s already-landed `createPreviewSessionCommands` is exactly the
 * primitive that would resolve this — it holds `currentSession`/`lastSpec` in its OWN
 * closure and drives `resize`/`setMode`/`setThemeCapabilities`/`retry`/`close`/
 * `queryGeometry` directly against them — but `HandlerContext` has no field exposing a
 * constructed `PreviewSessionCommands` instance (nor the `frameBroker`/`frameTokenLedger`/
 * `geometryTokenLedger`/`backpressure` sub-primitives `SessionCommandsDeps` itself needs to
 * build one), and a `preview-export.ts`-local instance is not legal either: those are
 * PER-KERNEL stateful factories (`createPreviewSessionCommands`'s own comment: "two
 * kernels — or two tests — must never share live-session state"), and a family module may
 * hold no module-level mutable state of its own (`FamilyHandlerMap`'s own doc: "a family
 * module is re-importable and re-usable across as many `HandlerContext`s/tests as
 * needed"). Building a fresh one per call would reset `currentSession`/`lastSpec` on every
 * single command, which is worse than not having one. Six of the nine preview kinds need
 * to reach a PREVIOUSLY established session (`resize`, `setThemeCapabilities`, `setMode`,
 * `queryGeometry`, `retry`) or release its host resources (`close`) — Gap A blocks the
 * first five outright and leaves `close` only able to do its Kernel-side half (below).
 *
 * GAP B — `HandlerContext.machines.export` is typed `HandlerMachine<ExportState,
 * ExportAction>` (`./types.ts`'s deliberate `Pick` excluding `phaseAtom`), but every one of
 * `core/export`'s already-landed functions this family is instructed to compose
 * (`CaptureExportSnapshotDeps.machine`, `PublishExportDeps.machine`) requires the FULL
 * `StateMachine<ExportState, ExportAction>` (`phaseAtom` included). VERIFIED, not assumed:
 * a scratch probe assigning `context.machines.export` into a `CaptureExportSnapshotDeps`
 * literal was compiled with `bun x tsc --noEmit` and failed with `TS2741: Property
 * 'phaseAtom' is missing in type 'HandlerMachine<ExportState, ExportAction>' but required
 * in type 'StateMachine<ExportState, ExportAction>'` — then reverted. There is no
 * cast-free way to close this gap from this file: fabricating a stand-in `phaseAtom` would
 * be inventing Kernel state outside the contract (forbidden), and casting past the missing
 * property is exactly the type-laundering this project's rules forbid. So `export.start`
 * cannot call `captureExportSnapshot`/`runExportRendering`/`assembleExportPackage`/
 * `publishExport` at all today — see `handleExportStart`'s own comment.
 *
 * WHAT THIS FILE STILL DOES REAL WORK ON, DESPITE BOTH GAPS:
 * - `preview.selectPage`/`preview.selectCurrent` (identical routing, exactly mirroring
 *   `core/preview/model/session-commands.ts`'s own `selectPage: selectSource, selectCurrent:
 *   selectSource`): establish/switch a live session for the CURRENT source of a page,
 *   composing `HostSupervisorPort.preview` via `launchOperation`, driving
 *   `context.machines.preview` through `beginStart`/`beginSwitch` then `sessionReady`/
 *   `sessionFailed`, and setting the session/source-kind through `HandlerContext`'s two
 *   sanctioned mutators. Best-effort page-settings resolution (see `resolvePageSettings`'s
 *   own comment for its own narrower, separately-flagged gap) degrades to a real
 *   `sessionFailed`/`preview.failed` outcome, never a fabricated size/theme/version.
 * - `preview.close`: applies `kernel.preview.disable` and clears
 *   `HandlerContext`'s own tracked session reference — the Kernel-side half of closing that
 *   Gap A does not block. The host-side half (calling the actual session's own `close()`
 *   to release its resources) is exactly what Gap A blocks; documented on the handler.
 * - Every other blocked kind returns the sanctioned `noOpOutcome()` (an idempotent
 *   refusal — nothing ran, matching this project's own "two outcomes only" rule) with a
 *   doc comment naming precisely which gap blocks it and why.
 */

// -------------------------------------------------------------------------------------
// Shared: page-settings resolution (best-effort, degrades to a real failure, never a
// fabricated value)
// -------------------------------------------------------------------------------------

/**
 * A page's static `meta` facts (`entities/page`'s `PageMeta`) plus its readable
 * `sourcePath`, resolved for the CURRENT (non-historical) source only.
 *
 * NARROWER, SEPARATELY-FLAGGED GAP (distinct from Gap A/B above, reported alongside them):
 * `core/ports`'s `PageReader` gives only `listSlugs()`/`readSource(slug)` (bytes + a live
 * `sourceHash`, no settings); the one port that DOES carry `PageMeta` is `PageMetaCache`,
 * keyed by `{pageSlug, sourceHash, extractorVersion}` — and no `extractorVersion` constant
 * is owned anywhere reachable from `core/kernel` (not `KernelDeps`, not `HandlerContext`,
 * not a `core/gate`/`core/protocol` exported constant — checked). `PAGE_META_EXTRACTOR_
 * VERSION_PLACEHOLDER` below is this file's OWN placeholder for that missing owner, used
 * ONLY as a cache key component (never as fabricated PAGE DATA): a cache MISS (`null`) is
 * treated as a real, honest "cannot resolve this page's settings today" failure — this
 * function never invents a theme/size/version. Once a real owner assigns and populates a
 * canonical `extractorVersion`, this placeholder is the one line to replace.
 *
 * `sourcePath` is not fabricated either: `pages/${pageSlug}.tsx` is the real staging-store
 * page-file convention already cited by `core/turns/model/candidate.ts`
 * (`store/sandbox/model/staging-store.ts`'s `stageAllFiles`), reused verbatim here rather
 * than invented a second time.
 */
export interface ResolvedPageSettingsV1 {
  readonly sourceHash: Sha256Hex;
  readonly sourcePath: string;
  readonly kitApiVersion: number;
  readonly minSize: Size;
  readonly theme: string;
}

/** See {@link ResolvedPageSettingsV1}'s own doc — this file's placeholder cache-key component, not page data. */
export const PAGE_META_EXTRACTOR_VERSION_PLACEHOLDER = 1;

/** The real staging-store page-file convention (`core/turns/model/candidate.ts`'s own citation) — never invented here. */
function sourcePathFor(pageSlug: PageSlug): string {
  return `pages/${pageSlug}.tsx`;
}

function pageMetaUnavailableFailure(pageSlug: PageSlug): FailureDtoV1 {
  return {
    code: "PERSISTENCE_FAILED",
    retryable: true,
    safeMessage: `no resolved settings available for page "${pageSlug}"`,
    details: { pageSlug },
  };
}

async function resolvePageSettings(
  deps: HandlerContext["deps"],
  pageSlug: PageSlug,
): Promise<FailureDtoV1 | ResolvedPageSettingsV1> {
  const source = await deps.pageReader.readSource(pageSlug);
  if ("code" in source) return source;

  const cached = await deps.pageMetaCache.get({
    pageSlug,
    sourceHash: source.sourceHash,
    extractorVersion: PAGE_META_EXTRACTOR_VERSION_PLACEHOLDER,
  });
  if (cached !== null && "code" in cached) return cached;
  if (cached === null) return pageMetaUnavailableFailure(pageSlug);

  return {
    sourceHash: source.sourceHash,
    sourcePath: sourcePathFor(pageSlug),
    kitApiVersion: cached.meta.kitApiVersion,
    minSize: cached.meta.minSize,
    theme: cached.meta.theme,
  };
}

// -------------------------------------------------------------------------------------
// Shared: deriving a `HostSessionSpecV1`'s size/theme/capabilities from workspace state
// -------------------------------------------------------------------------------------

const PRESET_SIZES: Readonly<Record<PreviewSizePresetV1, Size>> = {
  "80x24": { w: 80, h: 24 },
  "120x40": { w: 120, h: 40 },
};

/** Standard terminal color-depth encodings (24-bit truecolor, 8-bit 256-color, 4-bit 16-color) — well-known conventions, not invented here. */
const COLOR_DEPTH_BY_CAPABILITY: Readonly<Record<ColorCapabilityV1, number>> = {
  truecolor: 24,
  "256": 8,
  "16": 4,
};

/**
 * `"auto"` (or an incompletely-specified `"custom"`/`"preset"`) has no container-size
 * source `core` can observe — falls back to the SAME `"80x24"` value the preset option
 * itself already names, never a separately invented number.
 */
function sizeFromWorkspaceState(state: WorkspaceStateV1): Size {
  if (
    state.previewSizeMode === "custom" &&
    state.previewCustomWidth !== null &&
    state.previewCustomHeight !== null
  ) {
    return { w: state.previewCustomWidth, h: state.previewCustomHeight };
  }
  if (state.previewSizeMode === "preset" && state.previewSizePreset !== null) {
    return PRESET_SIZES[state.previewSizePreset];
  }
  return PRESET_SIZES["80x24"];
}

function colorDepthFromWorkspaceState(state: WorkspaceStateV1): number {
  return state.colorCapability === null
    ? COLOR_DEPTH_BY_CAPABILITY["16"]
    : COLOR_DEPTH_BY_CAPABILITY[state.colorCapability];
}

// -------------------------------------------------------------------------------------
// Shared: `kernel.stateChanged` construction for a real preview-machine transition
// -------------------------------------------------------------------------------------

function previewStateChangedEvent(
  action: PreviewAction,
  transition: Extract<TransitionOutcome<PreviewState, PreviewAction>, { kind: "changed" }>,
  correlation: EventCorrelationV1,
): PublishableEventV1<"kernel.stateChanged"> {
  return {
    kind: "kernel.stateChanged",
    payload: {
      modelId: "kernel.preview.state",
      action,
      previousTag: transition.from,
      nextTag: transition.to,
      metadata: {},
    },
    correlation,
  };
}

// -------------------------------------------------------------------------------------
// preview.selectPage / preview.selectCurrent — real, end to end (best-effort settings)
// -------------------------------------------------------------------------------------

/**
 * `preview.selectPage`/`preview.selectCurrent` share one routing function, exactly
 * mirroring `core/preview/model/session-commands.ts`'s own `selectSource` (`selectPage:
 * selectSource, selectCurrent: selectSource` — both commands establish/switch to the
 * CURRENT source of the named page; the only difference between the two kinds is which
 * prior source they may be replacing, which the shared machine transition already covers
 * uniformly via `beginStart`/`beginSwitch`).
 *
 * SYNCHRONOUS half: pick `beginStart` (from `idle`/`failed`) or `beginSwitch` (from
 * `live`/`failed`, preferred when both are legal) per `preview-machine.ts`'s own table,
 * apply it, and return `startedOutcome` with the resulting `kernel.stateChanged` — nothing
 * else can be known synchronously (handlers are synchronous; every port call below is
 * async, so it must run inside `launchOperation`'s `run`, per `HandlerContext`'s own doc).
 *
 * ASYNC half (`run`): resolve the page's current-source settings (best-effort,
 * `resolvePageSettings`), derive size/theme/capabilities from `WorkspaceStateV1`, call
 * `HostSupervisorPort.preview`, and on success set the session + source-kind and emit
 * `preview.sourceChanged`; on any failure (settings unresolved, workspace-state read
 * failed, or the host call itself failed) apply `sessionFailed` and emit `preview.failed`
 * — a REAL ran-and-failed outcome, never a silently dropped no-op, since the machine DID
 * transition into `starting`/`switching` synchronously above.
 */
function selectCurrentSource(
  payload: { readonly pageSlug: PageSlug },
  context: HandlerContext,
): CommandOutcomeV1 {
  const phase = context.machines.preview.phase();
  const action: PreviewAction =
    phase === "live" ? "kernel.preview.beginSwitch" : "kernel.preview.beginStart";
  const applied = context.machines.preview.apply(action);
  if (applied.kind !== "changed") {
    // Defensive only: `capabilities/model/guards.ts`'s `previewFamilyReason` already
    // requires `beginStart`/`beginSwitch` to be legal from the CURRENT phase before
    // dispatch ever calls this handler — unreachable in a correctly-wired Kernel, kept
    // explicit per this project's rule against silently assuming success.
    return noOpOutcome();
  }

  const operationId: UUIDv7 = uuidv7();
  const correlation: EventCorrelationV1 = { operationId };
  const admissionEvent = previewStateChangedEvent(action, applied, correlation);
  const fromPhase = applied.to; // "starting" | "switching" — where `sessionFailed` fires from

  context.launchOperation("kernel.preview.selectCurrentSource", async () => {
    const settings = await wrap(resolvePageSettings(context.deps, payload.pageSlug));
    if ("code" in settings) {
      return failSession(context, payload.pageSlug, null, fromPhase, correlation, settings);
    }

    const workspace = await wrap(context.deps.projectStore.readWorkspaceState());
    if ("code" in workspace) {
      return failSession(
        context,
        payload.pageSlug,
        settings.sourceHash,
        fromPhase,
        correlation,
        workspace,
      );
    }

    const spec: HostSessionSpecV1 = {
      mode: "preview",
      interactionMode: workspace.state.renderMode,
      pageSlug: payload.pageSlug,
      sourcePath: settings.sourcePath,
      sourceHash: settings.sourceHash,
      kitApiVersion: settings.kitApiVersion,
      size: sizeFromWorkspaceState(workspace.state),
      theme: workspace.state.themeOverride ?? settings.theme,
      capabilities: { colorDepth: colorDepthFromWorkspaceState(workspace.state) },
    };

    const session = await wrap(context.deps.hostSupervisor.preview(spec));
    if ("code" in session) {
      return failSession(
        context,
        payload.pageSlug,
        settings.sourceHash,
        fromPhase,
        correlation,
        session,
      );
    }

    const readyOutcome = context.machines.preview.apply("kernel.preview.sessionReady");
    context.setActivePreviewSession(session);
    context.setPreviewSourceKind("current");

    const readyEvent =
      readyOutcome.kind === "changed"
        ? [previewStateChangedEvent("kernel.preview.sessionReady", readyOutcome, correlation)]
        : [];

    const previewSessionId: UUIDv7 = uuidv7();
    const sourceChangedEvent: PublishableEventV1<"preview.sourceChanged"> = {
      kind: "preview.sourceChanged",
      payload: {
        previewSessionId,
        pageSlug: payload.pageSlug,
        source: { kind: "current" },
        sourceHash: settings.sourceHash,
        hostMode: session.identity.mode,
      },
      correlation: { ...correlation, previewSessionId },
    };

    return [...readyEvent, sourceChangedEvent];
  });

  return startedOutcome([admissionEvent], operationId);
}

/** A fresh 32-lowercase-hex-char stand-in host nonce — mirrors `core/preview/model/session-commands.ts`'s own `mintHostNonce` for the identical documented reason (no real host nonce source exists in this port slice). */
function mintPlaceholderNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * `sourceHash` is `null` only when `resolvePageSettings` failed before ever reading the
 * page's live source (i.e. `pageReader.readSource` itself failed) — the one case with no
 * real hash to report. `PreviewFailurePayloadV1.sourceHash` is non-nullable, so this falls
 * back to 64 zero characters, a schema-valid but clearly-not-a-real-digest placeholder,
 * documented here rather than silently passed off as a real hash.
 */
function failSession(
  context: HandlerContext,
  pageSlug: PageSlug,
  sourceHash: Sha256Hex | null,
  fromPhase: PreviewState,
  correlation: EventCorrelationV1,
  failure: FailureDtoV1,
): readonly PublishableEventV1[] {
  const failedOutcome = context.machines.preview.apply("kernel.preview.sessionFailed");
  const events: PublishableEventV1[] = [];
  if (failedOutcome.kind === "changed") {
    events.push(
      previewStateChangedEvent("kernel.preview.sessionFailed", failedOutcome, correlation),
    );
  }
  const failedEvent: PublishableEventV1<"preview.failed"> = {
    kind: "preview.failed",
    payload: {
      previewSessionId: uuidv7(),
      nonce: mintPlaceholderNonce(),
      pageSlug,
      sourceHash: sourceHash ?? "0".repeat(64),
      phase: fromPhase === "switching" ? "switching" : "starting",
      failure,
    },
    correlation,
  };
  events.push(failedEvent);
  return events;
}

// -------------------------------------------------------------------------------------
// preview.selectHistorical — out of MVP scope (Git excluded from KernelDeps)
// -------------------------------------------------------------------------------------

/**
 * `preview.selectHistorical` needs a historical commit's page source bytes/hash — the
 * ONLY port that could ever supply that is `core/ports/git-history.ts`'s `GitHistory`
 * (`readPageSource(commitId, sourcePath)`), and `GitHistory` is explicitly NOT a
 * `KernelDeps` field (kernel-assembly plan's own Global Constraints: "`git-history` and
 * `git-committer` are NOT `KernelDeps` fields ... the capability projector reports git
 * capabilities unavailable via the existing Tier-C deferred guard"). This is a clean,
 * definitional scope exclusion, not a primitive that merely hasn't landed yet — there is
 * no version of this handler that could resolve a historical source without a Git port
 * this Kernel build deliberately does not wire in. Returns the sanctioned idempotent
 * no-op; nothing runs, no machine transitions, matching every other genuinely out-of-scope
 * kind's own backstop shape (`./deferred.ts`'s `rejectDeferred`).
 */
function handleSelectHistorical(): CommandOutcomeV1 {
  return noOpOutcome();
}

// -------------------------------------------------------------------------------------
// preview.resize / setThemeCapabilities / setMode / queryGeometry / retry — Gap A
// -------------------------------------------------------------------------------------

/**
 * Shared backstop for the five preview kinds Gap A blocks outright (this file's header:
 * `resize`, `setThemeCapabilities`, `setMode`, `queryGeometry`, `retry`). Each of these
 * needs to act on the Kernel's PREVIOUSLY established live `PreviewSession` (or, for
 * `retry`, the previously remembered `HostSessionSpecV1` to re-establish one) —
 * `HandlerContext` provides no way to read either back. Applying the machine's own
 * `live -> live` edge (for `resize`/`setThemeCapabilities`/`setMode`) WITHOUT the
 * corresponding session call actually succeeding would be a false record — the
 * authoritative live-session state these edges represent (§7.6) would not have actually
 * changed — so this returns the sanctioned idempotent no-op rather than a fabricated
 * "changed" transition. For `queryGeometry` specifically, the transition table's own
 * `noOp: true` edge already means the SAME shape regardless of this gap (§7.6: "do not
 * bump `stateRevision`"); what Gap A blocks there is only DELIVERING the query's own
 * result event, not the disposition.
 */
function blockedBySessionReadback(): CommandOutcomeV1 {
  return noOpOutcome();
}

// -------------------------------------------------------------------------------------
// preview.close — real, partial (Kernel-side half only; Gap A blocks the host-side half)
// -------------------------------------------------------------------------------------

/**
 * `preview.close`'s guard-checked action is `kernel.preview.disable` (verified against
 * `capabilities/model/guards.ts`'s own `previewFamilyReason`: `case "preview.close": ...
 * "kernel.preview.disable"`). This handler applies that transition and clears
 * `HandlerContext`'s own tracked session reference (`setActivePreviewSession(null)`,
 * mirroring `kernel.ts`'s own `close()` — "the only legitimate caller that clears one").
 *
 * KNOWN, DOCUMENTED GAP: it cannot also call the real `PreviewSession.close()` to release
 * the host's own resources — that needs the SAME session handle Gap A blocks reading
 * back. Until Gap A closes, closing a preview from the Kernel's own bookkeeping
 * perspective works, but the underlying host incarnation is left running until whatever
 * later mechanism (`HostSupervisorPort.stopAll`, a future fix) reaps it. No event kind
 * models "preview closed"/"preview disabled" (`core/protocol`'s closed `EventKindV1`
 * union has no such member — checked exhaustively), so the only emitted event is the
 * generic `kernel.stateChanged` for the `disable` transition.
 */
function handleClose(
  payload: { readonly previewSessionId: UUIDv7 },
  context: HandlerContext,
): CommandOutcomeV1 {
  const applied = context.machines.preview.apply("kernel.preview.disable");
  if (applied.kind !== "changed") {
    // Defensive only — the guard already required `disable` to be legal from the current
    // phase; see `selectCurrentSource`'s identical note.
    return noOpOutcome();
  }
  context.setActivePreviewSession(null);
  const event = previewStateChangedEvent("kernel.preview.disable", applied, {
    previewSessionId: payload.previewSessionId,
  });
  return completedOutcome([event]);
}

// -------------------------------------------------------------------------------------
// export.start — Gap B (verified type mismatch): documented no-op
// -------------------------------------------------------------------------------------

/**
 * `export.start` is instructed to compose `core/export`'s already-landed
 * `captureExportSnapshot -> runExportRendering -> assembleExportPackage -> publishExport`
 * chain, driving the export machine through them. It cannot: every one of those functions'
 * own `Deps` types (`CaptureExportSnapshotDeps.machine`, `PublishExportDeps.machine`)
 * requires the FULL `StateMachine<ExportState, ExportAction>` (`phase`/`phaseAtom`/`apply`/
 * `canApply`), while `HandlerContext.machines.export` is `HandlerMachine<ExportState,
 * ExportAction>` — `./types.ts`'s own deliberate `Pick` that excludes `phaseAtom` so a
 * handler can never bypass `apply()`'s transition-table legality check. This file's own
 * header documents the empirical verification (a scratch `tsc --noEmit` probe, reverted
 * after confirming the exact `TS2741` failure).
 *
 * There is no cast-free fix available from THIS file: `core/export`'s functions are not
 * this family's file to change (out of this task's declared scope — "Do NOT edit ...  any
 * other family's file", and `core/export/model/*.ts` is squarely another package's
 * deliverable, not `core/kernel/model/handlers`), and reimplementing their
 * begin/beginRendering/beginPublication/complete/fail sequencing inline here — bypassing
 * the ALREADY-LANDED, ALREADY-TESTED functions this family is explicitly told to reuse —
 * would violate the kernel-assembly plan's own "do not duplicate" constraint far more than
 * leaving this as a documented gap does. So `export.start` never begins the machine at
 * all (an untouched `idle` phase is always safe to leave, unlike a `preparing` phase this
 * file could start but never legally finish without duplicating `core/export`'s own
 * internal transitions) and returns the sanctioned idempotent no-op.
 *
 * A second, narrower, compounding gap applies too: even were Gap B closed, resolving the
 * ordered `ExportPageInputV1[]` `captureExportSnapshot` needs hits the exact same
 * page-settings-resolution gap `resolvePageSettings` documents above (`sourcePath`/
 * `theme`/`minSize`/`kitApiVersion` for EVERY project page, not just one).
 */
function handleExportStart(): CommandOutcomeV1 {
  return noOpOutcome();
}

// -------------------------------------------------------------------------------------
// The exported family maps
// -------------------------------------------------------------------------------------

export const previewHandlers: FamilyHandlerMap<"preview"> = {
  "preview.selectPage": selectCurrentSource,
  "preview.selectCurrent": selectCurrentSource,
  "preview.selectHistorical": handleSelectHistorical,
  "preview.resize": blockedBySessionReadback,
  "preview.setThemeCapabilities": blockedBySessionReadback,
  "preview.setMode": blockedBySessionReadback,
  "preview.queryGeometry": blockedBySessionReadback,
  "preview.retry": blockedBySessionReadback,
  "preview.close": handleClose,
};

export const exportHandlers: FamilyHandlerMap<"export"> = {
  "export.start": handleExportStart,
};
