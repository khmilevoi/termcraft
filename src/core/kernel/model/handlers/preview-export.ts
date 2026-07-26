import { wrap } from "@reatom/core";

import {
  type CaptureExportSnapshotDeps,
  type ExportPageInputV1,
  type ExportRenderJobDeps,
  type ExportSnapshotV1,
  type PublishExportDeps,
  type PublishExportInputV1,
  assembleExportPackage,
  captureExportSnapshot,
  computeExportSizeLadder,
  publishExport,
  runExportRendering,
} from "core/export";
import type { PreviewAction, PreviewState, TransitionOutcome } from "core/machines";
import type { EventCorrelationV1, PublishableEventV1 } from "core/mailbox";
import type {
  ColorCapabilityV1,
  HostSessionSpecV1,
  PreviewSizePresetV1,
  WorkspaceStateV1,
} from "core/ports";
import type { PreviewCommandOutcomeV1 } from "core/preview";
import {
  type CommandPayloadByKindV1,
  type FailureDtoV1,
  type Sha256Hex,
  type UUIDv7,
  canonicalHash,
  isUuidv7,
} from "core/protocol";
import type { PageSlug, Size } from "entities/page";
import { uuidv7 } from "infrastructure/uuid";

import type { CommandOutcomeV1, FamilyHandlerMap, HandlerContext } from "./types";
import { noOpOutcome, startedOutcome } from "./types";

/**
 * `preview-export.ts` — kernel-assembly WP-1 task 9, Step B: the `preview` family's 9
 * non-deferred kinds (`preview.forwardInput`/`preview.setTweak` are Tier-C deferred,
 * `./deferred.ts` owns them) plus the `export` family's one kind, `export.start`.
 *
 * TWO GENUINE, INDEPENDENTLY-VERIFIED CONTRACT GAPS originally bounded what this file could
 * honestly do — both reported in the family's own report (`.superpowers/sdd/
 * task9-family-preview-export-report.md`). Gap B — CLOSED (MVP gap closeout, `export.start`
 * is core MVP per the maintainer decision recorded in `.superpowers/sdd/task-9-report.md`'s
 * "Gap 4 closure"/"Tasks 10-11" sections) — see `handleExportStart`'s own header for the
 * real recipe. Gap A — CLOSED for all six kinds it used to block (MVP blocker fix bundle,
 * Task 10, spec §2.3); see "GAP A — MOSTLY CLOSED" below for what closed and the one
 * narrower gap Task 10 found and left open.
 *
 * GAP A — MOSTLY CLOSED. The original justification ("`HandlerContext` provides no way to
 * read the Kernel's own live `PreviewSession` back") went stale the moment
 * `HandlerContext.currentPreviewSession`/`previewSessionCommands` landed (kernel-assembly
 * Task 16) — this file simply never called them. `resize`, `setThemeCapabilities`,
 * `setMode`, `retry`, `queryGeometry` and `close` now route through
 * `context.previewSessionCommands` for real (see each handler's own header) instead of the
 * retired `blockedBySessionReadback` no-op backstop. `retry` routes for real too, but a
 * SEPARATE gap this task found (its own header, "TASK 10's OWN DOCUMENTED GAP") means it is
 * rejected every time in THIS build — not a Gap A regression, a different, narrower issue.
 *
 * ONE NARROWER GAP TASK 10 FOUND AND DELIBERATELY DID NOT PAPER OVER: `PreviewSessionCommands
 * .selectPage`/`.selectCurrent` (`core/preview/model/session-commands.ts`) apply the machine
 * transition, reserve a backpressure slot, and call `HostSupervisorPort.preview` themselves,
 * but their return type (`PreviewCommandOutcomeV1`) reports only accepted/rejected/failed —
 * it never hands the established `PreviewSession` BACK to the caller. That session is exactly
 * what `HandlerContext.setActivePreviewSession` needs to set `kernel.ts`'s own `activePreview`
 * closure, which is in turn exactly what `KernelPort.currentPreview()` reads
 * (`entrypoint/model/create-shell.ts`'s `toKernelPort().preview()`) to stream real frames to
 * the UI. Routing `selectCurrentSource`'s ESTABLISHING call through `previewSessionCommands
 * .selectPage` as originally sketched would leave `activePreview` permanently `null` — the
 * preview would never actually render, the one thing this whole task exists to fix. So
 * `selectCurrentSource` (below) keeps calling `HostSupervisorPort.preview` directly and
 * `context.setActivePreviewSession` (which already forwards to `previewSessionCommands
 * .noteSessionEstablished` in the real `kernel.ts` — see that function's own comment), and
 * gets ONLY the `sourcePath` fix from this task. The cost: the ESTABLISHING call alone does
 * not reserve a backpressure slot the way `resize`/`setMode`/... now do. Flagged, not
 * silently dropped — closing it for real needs either a session-returning variant of
 * `selectPage`/`selectCurrent` on `PreviewSessionCommands`, or `kernel.ts` itself bridging the
 * two, neither of which is this task's declared file scope (`preview-export.ts` alone).
 *
 * WHAT THIS FILE DOES REAL WORK ON:
 * - `preview.selectPage`/`preview.selectCurrent` (identical routing, exactly mirroring
 *   `core/preview/model/session-commands.ts`'s own `selectPage: selectSource, selectCurrent:
 *   selectSource`): establish/switch a live session for the CURRENT source of a page,
 *   composing `HostSupervisorPort.preview` via `launchOperation`, driving
 *   `context.machines.preview` through `beginStart`/`beginSwitch` then `sessionReady`/
 *   `sessionFailed`, and setting the session/source-kind through `HandlerContext`'s two
 *   sanctioned mutators. Best-effort page-settings resolution (see `resolvePageSettings`'s
 *   own comment for its own narrower, separately-flagged gap) degrades to a real
 *   `sessionFailed`/`preview.failed` outcome, never a fabricated size/theme/version.
 * - `preview.resize`/`setThemeCapabilities`/`setMode`/`retry`/`queryGeometry`: each a thin
 *   `launchOperation`-wrapped delegation onto `context.previewSessionCommands`'s own
 *   already-tested method, translating its `accepted`/`rejected`/`failed` (or, for
 *   `queryGeometry`, `resolved`/`rejected`/`failed`) outcome into the matching real event —
 *   never a fabricated one. See each handler's own header.
 * - `preview.close`: calls `context.previewSessionCommands.close()` (which applies
 *   `kernel.preview.disable`, clears the frame broker and both token ledgers, and — the
 *   half Gap A used to block — calls the real session's own `close()`, releasing the host's
 *   resources for real) and clears `HandlerContext`'s own tracked session reference.
 * - `export.start` composes `core/export`'s full capture/render/assemble/publish chain for
 *   real — see `handleExportStart`'s own header.
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
 * `sourcePath` is not fabricated either: {@link canonicalPageSourcePath} (below) is the real
 * CANONICAL page-storage convention the host child resolves with `Bun.file` — see that
 * function's own doc comment for the full citation and for the substitution bug this task
 * (MVP blocker fix bundle, Task 10) corrected here.
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

/** The directory canonical project state lives in, under the project root (storage-identity §4). */
const PROJECT_STATE_DIRNAME = ".termcraft";

/**
 * CANONICAL page storage, ABSOLUTE — the host child resolves this with `Bun.file(sourcePath)`
 * inside a fresh scratch directory (`host/session/model/source-mount.ts`), so a relative path
 * never resolves there.
 *
 * CORRECTED 2026-07-26 (MVP blocker fix bundle, Task 10): this used to return the agent
 * WORKSPACE's flat `pages/<slug>.tsx` — the exact substitution Gap G made on the turn path
 * (`handlers/turn.ts`). It was invisible because the preview router's session-establishing entry
 * points had never executed in production. `store/safe-fs/model/limits.ts:134-135` states the
 * distinction in prose; `core` may not import `store`, so the convention is transcribed here.
 */
function canonicalPageSourcePath(projectRoot: string, pageSlug: PageSlug): string {
  return `${projectRoot}/${PROJECT_STATE_DIRNAME}/pages/${pageSlug}/page.tsx`;
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
    sourcePath: canonicalPageSourcePath(deps.projectStore.root, pageSlug),
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
 * `resolvePageSettings`, now resolving `sourcePath` through {@link canonicalPageSourcePath} —
 * Task 10's fix), derive size/theme/capabilities from `WorkspaceStateV1`, call
 * `HostSupervisorPort.preview` directly, and on success set the session + source-kind
 * (`context.setActivePreviewSession`, which also seeds `context.previewSessionCommands`'s
 * own frame-token incarnation identity — see that setter's doc in `kernel.ts`) and emit
 * `preview.sourceChanged`; on any failure (settings unresolved, workspace-state read
 * failed, or the host call itself failed) apply `sessionFailed` and emit `preview.failed`
 * — a REAL ran-and-failed outcome, never a silently dropped no-op, since the machine DID
 * transition into `starting`/`switching` synchronously above.
 *
 * Deliberately still calls `HostSupervisorPort.preview` directly here rather than routing
 * through `context.previewSessionCommands.selectPage`/`.selectCurrent` — see this file's own
 * header, "ONE NARROWER GAP TASK 10 FOUND", for why: that router never hands the established
 * `PreviewSession` back to its caller, and this handler needs the real session object for
 * `context.setActivePreviewSession` (the one thing `KernelPort.currentPreview()` — real frame
 * delivery — reads).
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

    // FIX ROUND 1, FINDING 3: the Kernel-minted id `setActivePreviewSession` (just above)
    // just seeded into `previewSessionCommands` via `noteSessionEstablished` — never a
    // second, locally-minted `uuidv7()`. That second mint was the root of three different
    // `previewSessionId`s in circulation for one live session (this file's own header,
    // "ONE NARROWER GAP"; `core/kernel/types.ts`'s `Kernel.currentPreviewSessionId` doc).
    const previewSessionId = context.previewSessionCommands.currentPreviewSessionId();
    if (previewSessionId === null || !isUuidv7(previewSessionId)) {
      // Defensive only: `setActivePreviewSession` above always calls
      // `noteSessionEstablished`, which mints a fresh id unconditionally — should be
      // unreachable. The session/source-kind are already set correctly; only the
      // `preview.sourceChanged` event (which needs a real id) is skipped here rather than
      // built with a fabricated one.
      console.warn(
        "core/kernel/handlers/preview-export: selectCurrentSource established a session but previewSessionCommands has no valid live previewSessionId — preview.sourceChanged skipped",
      );
      return readyEvent;
    }

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
// preview.resize / setThemeCapabilities / setMode / retry / queryGeometry — real, routed
// through the composed session router (Gap A closure, spec §2.3)
// -------------------------------------------------------------------------------------

/**
 * The `live -> live` self-edge every one of `resize`/`setMode`/`setThemeCapabilities` is
 * the ONLY legal source/target pair for (`core/machines/model/preview-machine.ts`'s own
 * table) — a real, revision-advancing transition (none of the three is marked `noOp: true`,
 * unlike `queryGeometry`/`forwardInput`), so it is built and returned for publication
 * whenever `context.previewSessionCommands` reports the underlying call `accepted`, never
 * silently applied and dropped (Global Constraint: "a transition applied and an event not
 * published desynchronises every subscriber").
 */
function liveSelfLoopEvent(
  action: PreviewAction,
  correlation: EventCorrelationV1,
): PublishableEventV1<"kernel.stateChanged"> {
  return previewStateChangedEvent(
    action,
    { kind: "changed", from: "live", to: "live" },
    correlation,
  );
}

/**
 * Shared translation for the three simple `live -> live` preview commands
 * (`resize`/`setMode`/`setThemeCapabilities`): call `previewSessionCommands`'s own method,
 * publish {@link liveSelfLoopEvent} on `"accepted"`. On `"rejected"` (`OPERATION_BUSY` —
 * defensive only, the capability guard already required a live-legal phase before dispatch
 * ever reached this handler) or `"failed"` (a genuine host-side failure): no event kind in
 * `core/protocol`'s closed `EventKindV1` union carries an ad-hoc command failure for a
 * command that isn't session-establishment or geometry (checked: `preview.failed`'s own
 * payload is scoped to `starting`/`switching`/`live`-phase SESSION failures, not a single
 * mutating call) — an unreported refusal, but never a silent one (errore rule 21), matching
 * `runExportStart`'s own "POST-MVP GAP" precedent for the identical shape of situation.
 *
 * FIX ROUND 1, FINDING 4: the trace carries the refusal's own content — `outcome.reason.code`
 * for `"rejected"`, `outcome.failure.safeMessage` for `"failed"` — not just `outcome.kind`.
 * A bare `"was failed, not accepted"` satisfied rule 21's letter but not its purpose: this is
 * the ONLY trace these three commands leave, so it has to carry a diagnosis. Matches
 * `handleRetry`'s own logging for the identical two outcome kinds.
 */
async function runSimpleLiveCommand(
  label: string,
  action: PreviewAction,
  correlation: EventCorrelationV1,
  call: () => Promise<PreviewCommandOutcomeV1>,
): Promise<readonly PublishableEventV1[]> {
  const outcome = await wrap(call());
  if (outcome.kind === "rejected") {
    console.warn(
      `core/kernel/handlers/preview-export: ${label} was rejected (${outcome.reason.code})`,
    );
    return [];
  }
  if (outcome.kind === "failed") {
    console.warn(
      `core/kernel/handlers/preview-export: ${label} failed: ${outcome.failure.safeMessage}`,
    );
    return [];
  }
  return [liveSelfLoopEvent(action, correlation)];
}

/** `preview.resize` — a one-line delegation onto `context.previewSessionCommands.resize`. */
function handleResize(
  payload: CommandPayloadByKindV1["preview.resize"],
  context: HandlerContext,
): CommandOutcomeV1 {
  const operationId: UUIDv7 = uuidv7();
  const correlation: EventCorrelationV1 = { previewSessionId: payload.previewSessionId };
  context.launchOperation("kernel.preview.resize", () =>
    runSimpleLiveCommand("preview.resize", "kernel.preview.resize", correlation, () =>
      context.previewSessionCommands.resize({ w: payload.width, h: payload.height }),
    ),
  );
  return startedOutcome([], operationId);
}

/** `preview.setMode` — a one-line delegation onto `context.previewSessionCommands.setMode`. */
function handleSetMode(
  payload: CommandPayloadByKindV1["preview.setMode"],
  context: HandlerContext,
): CommandOutcomeV1 {
  const operationId: UUIDv7 = uuidv7();
  const correlation: EventCorrelationV1 = { previewSessionId: payload.previewSessionId };
  context.launchOperation("kernel.preview.setMode", () =>
    runSimpleLiveCommand("preview.setMode", "kernel.preview.setMode", correlation, () =>
      context.previewSessionCommands.setMode(payload.mode),
    ),
  );
  return startedOutcome([], operationId);
}

/** `preview.setThemeCapabilities` — a one-line delegation onto `context.previewSessionCommands.setThemeCapabilities`. */
function handleSetThemeCapabilities(
  payload: CommandPayloadByKindV1["preview.setThemeCapabilities"],
  context: HandlerContext,
): CommandOutcomeV1 {
  const operationId: UUIDv7 = uuidv7();
  const correlation: EventCorrelationV1 = { previewSessionId: payload.previewSessionId };
  context.launchOperation("kernel.preview.setThemeCapabilities", () =>
    runSimpleLiveCommand(
      "preview.setThemeCapabilities",
      "kernel.preview.setThemeCapabilities",
      correlation,
      () =>
        context.previewSessionCommands.setThemeCapabilities(
          payload.themeId,
          payload.terminalCapabilities,
        ),
    ),
  );
  return startedOutcome([], operationId);
}

/**
 * `preview.retry` — routes `context.previewSessionCommands.retry()`, which internally
 * applies TWO transitions in sequence on success (`retryCircuit`: `circuit-open ->
 * starting`, then either `sessionReady`: `starting -> live` or `sessionFailed`:
 * `starting -> failed`, `core/preview/model/session-commands.ts`'s own `retry`/
 * `establishSession`) — every edge that actually applied is built and returned for
 * publication, never collapsed into one and never silently dropped. `fromPhase` is read
 * before the async call: `retryCircuit`'s only legal source is `circuit-open` (the
 * capability guard already required it).
 *
 * TASK 10's OWN DOCUMENTED GAP, LOAD-BEARING HERE: `retryCircuit` applies (and the machine
 * genuinely moves to `"starting"`) BEFORE `session-commands.ts`'s own `retry()` checks
 * whether it has a remembered `HostSessionSpecV1` (its private `lastSpec`) to reissue.
 * `lastSpec` is set ONLY by that module's own `selectSource` — and `selectCurrentSource`
 * (above) deliberately does NOT call it (see this file's header, "ONE NARROWER GAP") — so
 * in THIS build `lastSpec` is always `null` and `retry` ALWAYS lands on that "no remembered
 * spec" branch, reported as `{kind: "rejected", reason: {code: "CAPABILITY_UNAVAILABLE"}}`.
 * `fromPhase` is compared against the phase read back AFTER the call: if they differ,
 * `retryCircuit` applied and its own `kernel.stateChanged` is published regardless of what
 * `retry()` ultimately reports; only a phase that never moved at all (the
 * OPERATION_BUSY-illegal case, defensive, unreachable under a correct guard) publishes
 * nothing.
 *
 * FIX ROUND 1, FINDING 1 (CRITICAL) — RECOVER, DO NOT STRAND. Collapsing the "no remembered
 * spec" outcome into the SAME idempotent-no-op shape `blockedBySessionReadback` used to
 * return would be a false record (the machine really did move), but the first cut of this
 * handler stopped there and left the machine sitting at `"starting"` — a phase with only one
 * legal exit (`close`, to `"disabled"`), reachable by no OTHER `preview.*` command
 * (`sessionReady`/`sessionFailed` need `starting`/`switching`/`live` as their OWN caller,
 * never a bare retry payload driving them; `beginStart`/`beginSwitch` need `idle`/`failed`/
 * `live`). One retry with no remembered spec would have killed preview for the life of the
 * process the moment `kernel.preview.openCircuit` gets a real production caller. This branch
 * now applies `kernel.preview.sessionFailed` itself (`starting -> failed` is a legal row,
 * `preview-machine.ts`'s own table) and publishes THAT transition too, alongside
 * `retryCircuit` — from `failed`, `beginStart`/`beginSwitch`/`openCircuit` are legal again,
 * so a subsequent `preview.selectPage`/`selectCurrent` recovers preview normally.
 *
 * FIX ROUND 1, FINDING 2 — sync `activePreview` with whichever session `retry()` actually
 * leaves behind. `context.previewSessionCommands`'s own `currentSession`/`currentSession()`
 * already reflects the truth (`establishSession`'s own success/failure tail sets it
 * directly), but `kernel.ts`'s `activePreview` — what `KernelPort.currentPreview()` and
 * `create-shell.ts:412` actually stream frames from — does NOT move unless
 * `context.setActivePreviewSession` is called. Without this, a successful retry would leave
 * the router holding the NEW session while `activePreview` (and the UI) kept the OLD, dead
 * one — exactly the two-owners bug this file's Step 4 deviation exists to avoid, reproduced
 * on the retry path. So every branch that changes `session-commands.ts`'s own tracked
 * session now calls `context.setActivePreviewSession` to match: the new session on
 * `"accepted"`, `null` on `"failed"` or the recovered-to-`"failed"` `"rejected"` case.
 * `setActivePreviewSession` also re-invokes `previewSessionCommands.noteSessionEstablished`
 * on a non-null session (`kernel.ts`'s own comment) — a harmless, if redundant, SECOND
 * re-mint of the identity `establishSession` already seeded a moment earlier (nothing reads
 * the first mint in between; no frame is published until the caller's own frame loop runs).
 *
 * On a re-establishment FAILURE (`outcome.kind === "failed"`): no `preview.failed` event is
 * built. That payload requires `pageSlug`/`sourceHash` (§9), and this command's own payload
 * carries only `previewSessionId` (§10.4) — the page identity retry re-uses lives ONLY in
 * `session-commands.ts`'s private `lastSpec`, which `PreviewSessionCommands` does not
 * re-expose. A documented, narrow gap (mirrors `runExportStart`'s own "POST-MVP GAP"), not a
 * fabricated payload.
 */
function handleRetry(
  payload: CommandPayloadByKindV1["preview.retry"],
  context: HandlerContext,
): CommandOutcomeV1 {
  const fromPhase = context.machines.preview.phase();
  const operationId: UUIDv7 = uuidv7();
  const correlation: EventCorrelationV1 = { previewSessionId: payload.previewSessionId };
  context.launchOperation("kernel.preview.retry", async () => {
    const outcome = await wrap(context.previewSessionCommands.retry());
    const toPhase = context.machines.preview.phase();

    if (outcome.kind === "rejected" && toPhase === fromPhase) {
      // `retryCircuit` itself was illegal (`OPERATION_BUSY`) — defensive only, the
      // capability guard already required `circuit-open`. Nothing moved; nothing to
      // publish.
      console.warn(
        `core/kernel/handlers/preview-export: preview.retry was rejected (${outcome.reason.code})`,
      );
      return [];
    }

    // `retryCircuit` DID apply (`circuit-open -> starting`) in every remaining branch —
    // reported even when what follows is refused or fails, so a real transition is never
    // silently dropped (Global Constraint: an applied transition must be returned for
    // publication).
    const events: PublishableEventV1[] = [
      previewStateChangedEvent(
        "kernel.preview.retryCircuit",
        { kind: "changed", from: fromPhase, to: "starting" },
        correlation,
      ),
    ];

    if (outcome.kind === "rejected") {
      // `session-commands.ts`'s own defensive "no remembered spec to reissue" branch — see
      // this handler's own header, "FIX ROUND 1, FINDING 1", for why this is reachable in
      // THIS build (Task 10's documented `lastSpec` gap) and why it must recover the
      // machine rather than leave it stranded at `"starting"`.
      console.warn(
        `core/kernel/handlers/preview-export: preview.retry had no remembered spec to reissue (${outcome.reason.code}) — recovering the preview machine to "failed" instead of leaving it stranded at "starting"`,
      );
      const recovered = context.machines.preview.apply("kernel.preview.sessionFailed");
      if (recovered.kind === "changed") {
        events.push(
          previewStateChangedEvent("kernel.preview.sessionFailed", recovered, correlation),
        );
      } else {
        // Defensive only: `sessionFailed` is legal from `starting` per the machine's own
        // table, and `retryCircuit` just moved it there in this same synchronous run —
        // should be unreachable.
        console.warn(
          `core/kernel/handlers/preview-export: preview.retry's recovery sessionFailed was ${recovered.kind} — defensive, should be unreachable from "starting"`,
        );
      }
      context.setActivePreviewSession(null);
      return events;
    }
    if (outcome.kind === "failed") {
      console.warn(
        `core/kernel/handlers/preview-export: preview.retry's re-established session failed: ${outcome.failure.safeMessage}`,
      );
      events.push(
        previewStateChangedEvent(
          "kernel.preview.sessionFailed",
          { kind: "changed", from: "starting", to: toPhase },
          correlation,
        ),
      );
      context.setActivePreviewSession(null);
      return events;
    }
    events.push(
      previewStateChangedEvent(
        "kernel.preview.sessionReady",
        { kind: "changed", from: "starting", to: toPhase },
        correlation,
      ),
    );
    // FIX ROUND 1, FINDING 2: see this handler's own header — sync `activePreview` with the
    // session the router's own `establishSession` already put into its private tracking.
    context.setActivePreviewSession(context.previewSessionCommands.currentSession());
    return events;
  });
  return startedOutcome([], operationId);
}

/**
 * `preview.queryGeometry` — verifies the frame token first (`context.frameTokenLedger
 * .verifyCurrent`, the SAME ledger instance `context.previewSessionCommands` holds
 * internally — §12.6 item 5's "verifies that frame token before any host request"), then
 * routes the resolved query onto `context.previewSessionCommands.queryGeometry`. Its
 * `noOp: true` transition-table edge (§7.6) means no `kernel.stateChanged` is built here —
 * this kind never bumps `stateRevision` — only the query's own `preview.geometryResult`
 * event, built ONLY on a `"resolved"` outcome, matching `blockedBySessionReadback`'s own
 * former reasoning for this one kind ("what Gap A blocks there is only DELIVERING the
 * query's own result event, not the disposition"). `frameIdentity` comes from the SAME
 * `verifyCurrent` call the router redundantly repeats internally (a pure read, no side
 * effect) — the router's own `PreviewQueryOutcomeV1` does not re-expose it.
 */
function handleQueryGeometry(
  payload: CommandPayloadByKindV1["preview.queryGeometry"],
  context: HandlerContext,
): CommandOutcomeV1 {
  const operationId: UUIDv7 = uuidv7();
  context.launchOperation("kernel.preview.queryGeometry", async () => {
    const verification = context.frameTokenLedger.verifyCurrent(payload.frameToken);
    if (!verification.ok) {
      console.warn(
        `core/kernel/handlers/preview-export: preview.queryGeometry's frame token was ${verification.code}`,
      );
      return [];
    }

    const outcome = await wrap(
      context.previewSessionCommands.queryGeometry(payload.frameToken, payload.query),
    );
    if (outcome.kind !== "resolved") {
      console.warn(
        `core/kernel/handlers/preview-export: preview.queryGeometry was ${outcome.kind}`,
      );
      return [];
    }

    const previewSessionId = context.previewSessionCommands.currentPreviewSessionId();
    if (previewSessionId === null || !isUuidv7(previewSessionId)) {
      console.warn(
        "core/kernel/handlers/preview-export: preview.queryGeometry resolved but no valid live previewSessionId is registered",
      );
      return [];
    }

    const event: PublishableEventV1<"preview.geometryResult"> = {
      kind: "preview.geometryResult",
      payload: {
        previewSessionId,
        frameTokenId: payload.frameToken,
        frameIdentity: verification.identity,
        queryKind: payload.query.kind,
        result: outcome.result.result,
        geometryToken: outcome.geometryToken,
      },
      correlation: { previewSessionId },
    };
    return [event];
  });
  return startedOutcome([], operationId);
}

// -------------------------------------------------------------------------------------
// preview.close — real, end to end (Gap A closure)
// -------------------------------------------------------------------------------------

/**
 * `preview.close`'s guard-checked action is `kernel.preview.disable` (verified against
 * `capabilities/model/guards.ts`'s own `previewFamilyReason`: `case "preview.close": ...
 * "kernel.preview.disable"`). Now routes through `context.previewSessionCommands.close()`,
 * which applies that SAME transition itself, clears the frame broker and both token
 * ledgers, and — the half Gap A used to block — calls the real `PreviewSession.close()`,
 * releasing the host's own resources for real. Because the router owns the transition, this
 * handler must NOT also apply it (a second `apply("kernel.preview.disable")` would be
 * illegal, already-disabled) — `fromPhase` is only READ, before launching, purely so the
 * eventual `kernel.stateChanged` can report it; the `toPhase` is read back after the router
 * settles. `context.setActivePreviewSession(null)` is kept, mirroring `kernel.ts`'s own
 * `close()` ("the only legitimate caller that clears one").
 *
 * Because releasing the host session is genuinely async (`await session.close()`), this can
 * no longer resolve synchronously — like `selectCurrentSource`, it returns a zero-event
 * `startedOutcome` and does the real work (and publishes its own `kernel.stateChanged`)
 * inside `launchOperation`.
 */
function handleClose(
  payload: { readonly previewSessionId: UUIDv7 },
  context: HandlerContext,
): CommandOutcomeV1 {
  const fromPhase = context.machines.preview.phase();
  if (!context.machines.preview.canApply("kernel.preview.disable")) {
    // Defensive only — the guard already required `disable` to be legal from the current
    // phase; see `selectCurrentSource`'s identical note.
    return noOpOutcome();
  }

  const operationId: UUIDv7 = uuidv7();
  const correlation: EventCorrelationV1 = { previewSessionId: payload.previewSessionId };
  context.launchOperation("kernel.preview.close", async () => {
    const outcome = await wrap(context.previewSessionCommands.close());
    if (outcome.kind !== "accepted") {
      // Defensive only: `canApply` already confirmed `disable` was legal from `fromPhase`
      // synchronously above, and nothing else can move a single-slot preview machine
      // concurrently in a correctly-wired Kernel.
      console.warn(
        `core/kernel/handlers/preview-export: preview.close's router call was ${outcome.kind} — defensive, should be unreachable`,
      );
      return [];
    }
    context.setActivePreviewSession(null);
    const toPhase = context.machines.preview.phase();
    const event = previewStateChangedEvent(
      "kernel.preview.disable",
      { kind: "changed", from: fromPhase, to: toPhase },
      correlation,
    );
    return [event];
  });
  return startedOutcome([], operationId);
}

// -------------------------------------------------------------------------------------
// export.start — real, end to end (Gap B closure)
// -------------------------------------------------------------------------------------

/** The project-relative export destination directory — the `.termcraft/export` convention already established by `ui/app`'s own export-popup fixtures (`App.test.tsx`, `intent.test.ts`) and the gap-closeout plan's own M6 citation (`.termcraft/export/current.json`), reused verbatim rather than invented a second time. This Kernel slice never varies it — `publishExport`'s own `plan.operations`/`plan.payloads` (WP-5 Task B3) are the real per-file/pointer operations `buildExportPublishOperations` builds from `assembled.files`, below. */
const EXPORT_DESTINATION = ".termcraft/export";

/**
 * `ExportRenderJobDeps.rendererVersion` (`core/export/model/render-jobs.ts`'s own header):
 * "an injected string ... a caller-chosen build/renderer identity" — no `core/ports`/
 * `KernelDeps` surface owns a renderer build-version string today (checked: neither
 * `ExportRenderPort` nor any other `KernelDeps` field carries one). Mirrors
 * `PAGE_META_EXTRACTOR_VERSION_PLACEHOLDER` above: a documented placeholder, used only as a
 * render-cache key component (`buildExportRenderKey`), never fabricated render OUTPUT —
 * once a real owner assigns a canonical renderer-build identity, this is the one line to
 * replace.
 */
export const EXPORT_RENDERER_VERSION_PLACEHOLDER = "1";

interface ExportSnapshotDigestEntryV1 {
  readonly pageSlug: string;
  readonly sourceHash: string;
  readonly manifestIndex: number;
}

/**
 * The "immutable source-snapshot digest" `export.started`'s own payload names (§9, KCC:811)
 * — a canonical hash over the captured snapshot's own page identity/order/content-hash
 * facts (`pageSlug`, `sourceHash`, `manifestIndex`), mirroring `core/project/model/
 * page-remove-plan.ts`'s own `computePageOrderHash` precedent (`canonicalHash(...)` over an
 * ordered projection of the real facts, never the raw bytes themselves — `canonicalHash` has
 * no defined encoding for `Uint8Array`, and `sourceHash` already IS the canonical content
 * hash those bytes were read under). `capturedAt` (a timestamp) is deliberately excluded:
 * this digest names WHAT was captured, not WHEN.
 */
function exportSnapshotDigest(snapshot: ExportSnapshotV1): Sha256Hex {
  const entries: ExportSnapshotDigestEntryV1[] = snapshot.pages.map((page) => ({
    pageSlug: page.pageSlug,
    sourceHash: page.sourceHash,
    manifestIndex: page.manifestIndex,
  }));
  const digest = canonicalHash(entries);
  if (digest instanceof Error) {
    // Defensive only: every field above is a plain string/finite number, which
    // `canonicalHash` always accepts — unreachable in practice, kept explicit per errore's
    // rule against silently assuming success. Falls back to the same "64 zero hex
    // characters" placeholder `failSession` above already uses for an honestly-unavailable
    // digest, never a fabricated-looking real one.
    console.warn(
      `core/kernel/handlers/preview-export: could not canonicalize the export snapshot digest (defensive, should be unreachable): ${digest.message}`,
    );
    return "0".repeat(64);
  }
  return digest;
}

/**
 * Every project page's `ExportPageInputV1` (§7.5/§12.5: "the exact ordered page list ... and
 * resolved settings"), in manifest order — `manifestIndex` is each page's own position in
 * `PageReader.listSlugs()`'s own returned order, the project's real page order (§11.4's
 * "project page order (manifest order)"). Reuses `resolvePageSettings` above VERBATIM for
 * every page — this file's own header used to name this exact extension as export.start's
 * "second, narrower, compounding gap"; it closes the same way `resolvePageSettings`'s own
 * single-page call site already does: no new port, no fabricated value, an honest
 * `FailureDtoV1` refusal on the first page whose settings cannot be resolved.
 */
async function resolveExportPageInputs(
  context: HandlerContext,
): Promise<FailureDtoV1 | readonly ExportPageInputV1[]> {
  const slugs = await context.deps.pageReader.listSlugs();
  if ("code" in slugs) return slugs;

  const pages: ExportPageInputV1[] = [];
  for (const [manifestIndex, pageSlug] of slugs.entries()) {
    const settings = await resolvePageSettings(context.deps, pageSlug);
    if ("code" in settings) return settings;
    pages.push({
      pageSlug,
      sourcePath: settings.sourcePath,
      manifestIndex,
      minSize: settings.minSize,
      theme: settings.theme,
      kitApiVersion: settings.kitApiVersion,
    });
  }
  return pages;
}

/**
 * Builds a schema-valid `export.failed` for a failure that happens BEFORE the export machine
 * ever leaves `"idle"` — see `runExportStart`'s own header, "NOT COVERED BY THAT INVARIANT",
 * for exactly which two branches reach here. `EXPORT_PHASES_V1` (`core/protocol/model/
 * event-payload.ts`) now includes `"idle"` for exactly this window, reusing `ExportState`'s
 * own `"idle"` member name rather than inventing one. No `export.started` ever precedes this —
 * that event's own payload (`pageCount`/`renderJobCount`) requires a captured snapshot this
 * window never reaches — so this is the first and only event a client ever sees for the
 * operation. A fresh `operationId` is minted here because the normal mint point (after a
 * successful capture, below) is never reached either.
 */
function preCaptureExportFailure(failure: FailureDtoV1): PublishableEventV1<"export.failed"> {
  const operationId: UUIDv7 = uuidv7();
  return {
    kind: "export.failed",
    payload: {
      operationId,
      phase: "idle",
      destination: EXPORT_DESTINATION,
      generationId: null,
      failure,
    },
    correlation: { operationId },
  };
}

/** Applies `kernel.export.fail` (`rendering -> idle`) directly — the one transition neither `assembleExportPackage` nor `publishExport` ever applies for a failure THEY detect before touching the machine (see `runExportStart`'s own header, "MACHINE OWNERSHIP"). Defensive-only illegality is logged, never silently assumed. */
function forceExportFail(context: HandlerContext, reason: string): void {
  const outcome = context.exportRunner.machine.apply("kernel.export.fail");
  if (outcome.kind === "illegal") {
    console.warn(
      `core/kernel/handlers/preview-export: export.start's post-render fail transition was illegal while handling "${reason}" — defensive, should be unreachable from "rendering"`,
    );
  }
}

/**
 * The whole `export.start` composition (Gap B, CLOSED), run inside `launchOperation`'s own
 * async closure — mirrors `turn.ts`'s own `runTurnStart` recipe: `handleExportStart` returns
 * `startedOutcome([])` synchronously (no admission event; `kernel.export.begin` itself is
 * applied INSIDE `captureExportSnapshot`, not by this handler directly — matching how
 * `runTurn`'s own internal admission moves `RunTurnDeps.machine` without a `turn.ts`-built
 * `kernel.stateChanged` of its own), then drives `captureExportSnapshot -> runExportRendering
 * -> assembleExportPackage -> publishExport` in that fixed order, never around them.
 *
 * MACHINE OWNERSHIP, PHASE BY PHASE:
 * - `idle -> preparing -> rendering` (or `-> idle` on a capture failure): entirely owned by
 *   `captureExportSnapshot` itself (`CaptureExportSnapshotDeps.machine` — the real, full
 *   `context.exportRunner.machine`, Gap B's own fix).
 * - `rendering`: `runExportRendering`/`assembleExportPackage` never touch the machine at all
 *   (§13.4's own structural proof — neither Deps carries `machine`). A FAILED render is
 *   caught by `assembleExportPackage`'s own wholesale refusal; since neither it nor
 *   `publishExport` (whose own identical check runs BEFORE ever touching the machine) will
 *   ever apply `kernel.export.fail` for this case ("the caller decides what happens next ...
 *   typically: never call publishExport at all" — `package.ts`'s own header), this function
 *   applies it directly via {@link forceExportFail} — the one place in this whole chain a
 *   transition is applied outside a composed function.
 * - `rendering -> publishing -> idle` (or `-> idle` via `failBeforeIntent`): entirely owned
 *   by `publishExport` itself.
 *
 * LIVE EVENTS (`context.publishOperationEvent`, matching `turn.ts`'s own `RunTurnDeps.publish`
 * mapping): `export.started` fires once the snapshot is captured (the earliest point
 * `sourceSnapshotDigest`/`pageCount`/`renderJobCount` are honestly known); `export.progress`
 * fires at each of the two phase boundaries this batched composition can actually observe —
 * once ALL renders have settled (`phase: "rendering"`) and again once publication begins
 * (`phase: "publishing"`). `completedJobs`/`totalJobs` are real counts, but `pageSlug`/
 * `sizeBytes` are always `null`: neither `runExportRendering` nor `publishExport` exposes a
 * PER-JOB completion hook (both are landed, already-tested BATCH compositions — see each
 * file's own header), so finer-grained live progress is not obtainable without altering a
 * landed module this task must compose, never reimplement — flagged here, not smoothed over
 * with a fabricated per-job breakdown.
 *
 * THE TERMINAL EVENT: exactly one of `export.completed`/`export.failed` from the moment
 * `captureExportSnapshot` reports `"captured"` onward, matching `ExportTerminalPayloadV1`'s
 * own closed shape (`operationId`, `phase`, `destination`, `generationId`, `failure`).
 * `destination` is `EXPORT_DESTINATION` throughout. `generationId` is non-null ONLY on
 * `export.completed`, taken verbatim from `PublishExportResultV1`'s own `"published"` intent
 * — never fabricated for a failure.
 *
 * PRE-CAPTURE FAILURES (formerly a documented protocol gap, now closed for two of the three
 * branches below `resolveExportPageInputs` hits BEFORE a snapshot is ever captured —
 * `resolveExportPageInputs` itself failing, and `captureExportSnapshot` returning `"failed"`):
 * both branches already have a genuine `FailureDtoV1` in hand, and the export machine is
 * provably `"idle"` at the moment each is reported — either never touched at all
 * (`resolveExportPageInputs` runs before `captureExportSnapshot` ever applies `kernel.export.
 * begin`) or forced back to `"idle"` from `"preparing"` by `snapshot.ts`'s own `kernel.export.
 * fail` on a page-read failure. `EXPORT_PHASES_V1` (`core/protocol/model/event-payload.ts`) now
 * includes `"idle"` — a real `ExportState` member, not an invented phase — precisely so these
 * two branches can report {@link preCaptureExportFailure} instead of only a `console.warn`; a
 * client that saw `disposition: "started"` now always gets exactly one terminal event.
 *
 * POST-MVP GAP (finding #12, part 1 — evaluated on evidence, not inherited) — `captureExportSnapshot`
 * returning `"illegal"` (a genuine `NO_PAGES` refusal, or a defensive-only illegal `kernel.export.
 * begin`): unlike the two branches above, this one carries only a `CommandRejectionCode`
 * (`CaptureExportSnapshotResultV1`'s `"illegal"` variant), never a `FailureDtoV1`.
 *
 * All 30 members of `OPERATIONAL_FAILURE_CODES_V1` (`core/protocol/model/failure.ts`) were read
 * and none fits: they name post-dispatch operational failures (a backend crashing, a gate
 * retry exhausting, a Git command failing, ...), not an admission-time "there is nothing to
 * package" refusal — the nearest neighbors (`RESOURCE_LIMIT_EXCEEDED`, `EXPORT_SNAPSHOT_STALE`,
 * `PERSISTENCE_FAILED`) each describe a different failure shape. Adding a 31st code was also
 * evaluated and rejected, for two independent reasons: (1) `NO_PAGES` already has a home in a
 * DIFFERENT closed vocabulary — `CommandRejectionCode`/`UnavailableReason`
 * (`core/protocol/model/command-result.ts`, `core/protocol/model/unavailable-reason.ts`) — the
 * exact code the admission guard itself reports when export's capability is unavailable for a
 * zero-page project; folding it into `OPERATIONAL_FAILURE_CODES_V1` too would blend two
 * vocabularies the spec keeps deliberately separate, not just append a member; (2)
 * `OPERATIONAL_FAILURE_CODES_V1` is transcribed verbatim from kernel-command-contract §11.2's own
 * table (`failure.ts`'s own header) with a pinned closure test (`failure.test.ts`) asserting its
 * exact 30-member tuple and order — inventing a 31st member not in that table would be a spec-table
 * change, not a local one. Re-documented here as an explicit post-MVP gap (kernel-command-contract
 * exit criterion 8's permitted third outcome) rather than left silently open: this branch still
 * returns `[]` with only a `console.warn` — an unreported refusal that still leaves a trace — until
 * a protocol-level decision either adds a real `CommandRejectionCode -> FailureDtoV1` mapping or
 * extends §11.2's own table with a fitting code.
 */
async function runExportStart(context: HandlerContext): Promise<readonly PublishableEventV1[]> {
  const pages = await wrap(resolveExportPageInputs(context));
  if ("code" in pages) {
    // The export machine is still `"idle"` (this runs before `captureExportSnapshot` ever
    // applies `kernel.export.begin`) — a real, schema-valid `export.failed` with `phase:
    // "idle"`, see `preCaptureExportFailure`'s own header.
    console.warn(
      `core/kernel/handlers/preview-export: export.start refused — could not resolve the project's page settings: ${pages.safeMessage}`,
    );
    return [preCaptureExportFailure(pages)];
  }

  const captureDeps: CaptureExportSnapshotDeps = {
    machine: context.exportRunner.machine,
    projectWrite: context.deps.projectWrite,
    pageReader: context.deps.pageReader,
    clock: context.deps.clock,
  };
  const captured = await wrap(captureExportSnapshot(captureDeps, { pages }));
  if (captured.kind === "illegal") {
    // Either a genuine `NO_PAGES` refusal or a defensive-only illegal `begin` (the guard
    // already confirmed `idle -> preparing` legality before dispatch ever reached this
    // handler) — both share this shape; nothing ran, so nothing to recover. STILL NO TERMINAL
    // EVENT HERE: unlike the two branches this file now closes, `CaptureExportSnapshotResultV1`'s
    // `"illegal"` variant carries only a `CommandRejectionCode`, never a `FailureDtoV1` —
    // see `runExportStart`'s own header, "POST-MVP GAP", for why this one branch stays a
    // documented gap (an unreported refusal, but never a silent one — this warn is the trace).
    console.warn(
      `core/kernel/handlers/preview-export: export.start's captureExportSnapshot was illegal (${captured.code})`,
    );
    return [];
  }
  if (captured.kind === "failed") {
    // `captureExportSnapshot` already forced the machine back `"preparing" -> "idle"`
    // (`snapshot.ts`'s own `kernel.export.fail` on a page-read failure) before returning
    // this — a real, schema-valid `export.failed` with `phase: "idle"`, see
    // `preCaptureExportFailure`'s own header.
    console.warn(
      `core/kernel/handlers/preview-export: export.start's snapshot capture failed: ${captured.failure.safeMessage}`,
    );
    return [preCaptureExportFailure(captured.failure)];
  }

  const { snapshot } = captured;
  const operationId: UUIDv7 = uuidv7();
  const correlation: EventCorrelationV1 = { operationId };
  const ladder = computeExportSizeLadder(snapshot.pages);

  context.publishOperationEvent({
    kind: "export.started",
    payload: {
      operationId,
      sourceSnapshotDigest: exportSnapshotDigest(snapshot),
      pageCount: snapshot.pages.length,
      renderJobCount: ladder.length,
      destination: EXPORT_DESTINATION,
    },
    correlation,
  });

  const renderDeps: ExportRenderJobDeps = {
    renderPort: context.deps.exportRender,
    renderCache: context.deps.renderCache,
    rendererVersion: EXPORT_RENDERER_VERSION_PLACEHOLDER,
  };
  const renders = await wrap(runExportRendering(renderDeps, snapshot));

  context.publishOperationEvent({
    kind: "export.progress",
    payload: {
      operationId,
      phase: "rendering",
      completedJobs: renders.length,
      totalJobs: ladder.length,
      pageSlug: null,
      sizeBytes: null,
    },
    correlation,
  });

  const assembled = assembleExportPackage({
    snapshot,
    renders,
    runtimeDeclaration: context.deps.exportRender.runtimeDeclaration,
  });

  if (assembled.kind === "failed") {
    forceExportFail(context, "a render failed");
    return [
      {
        kind: "export.failed",
        payload: {
          operationId,
          phase: "rendering",
          destination: EXPORT_DESTINATION,
          generationId: null,
          failure: assembled.failure,
        },
        correlation,
      },
    ];
  }

  const currentPages = await wrap(resolveExportPageInputs(context));
  if ("code" in currentPages) {
    console.warn(
      `core/kernel/handlers/preview-export: export.start refused to publish — could not re-resolve current page settings: ${currentPages.safeMessage}`,
    );
    forceExportFail(context, "could not re-resolve current page settings before publish");
    return [
      {
        kind: "export.failed",
        payload: {
          operationId,
          phase: "rendering",
          destination: EXPORT_DESTINATION,
          generationId: null,
          failure: currentPages,
        },
        correlation,
      },
    ];
  }

  // Publishing is genuinely about to begin — the re-resolve above already succeeded, so
  // this progress event can never be followed by a terminal failure for a phase never
  // entered (the bug this ordering fixes: emitting it before the re-resolve let a client
  // see progress("publishing") followed by a "rendering"-phase export.failed).
  context.publishOperationEvent({
    kind: "export.progress",
    payload: {
      operationId,
      phase: "publishing",
      completedJobs: ladder.length,
      totalJobs: ladder.length,
      pageSlug: null,
      sizeBytes: null,
    },
    correlation,
  });

  const publishDeps: PublishExportDeps = {
    machine: context.exportRunner.machine,
    projectWrite: context.deps.projectWrite,
    pageReader: context.deps.pageReader,
    clock: context.deps.clock,
    exportPublish: context.deps.exportPublish,
  };
  const publishInput: PublishExportInputV1 = {
    snapshot,
    currentPages,
    renders: renders.map((render) => ({ pageSlug: render.pageSlug, outcome: render.outcome })),
    files: assembled.files,
  };
  const published = await wrap(publishExport(publishDeps, publishInput));

  if (published.kind === "illegal") {
    // Defensive only: `rendering` is always a legal source for `kernel.export.
    // beginPublication` at this point — export is a single-slot operation, so nothing else
    // could have moved this machine concurrently in a correctly-wired Kernel.
    console.warn(
      `core/kernel/handlers/preview-export: export.start's beginPublication was illegal (${published.code})`,
    );
    return [];
  }

  if (published.kind === "failed" || published.kind === "stale") {
    return [
      {
        kind: "export.failed",
        payload: {
          operationId,
          phase: "publishing",
          destination: EXPORT_DESTINATION,
          generationId: null,
          failure: published.failure,
        },
        correlation,
      },
    ];
  }

  return [
    {
      kind: "export.completed",
      payload: {
        operationId,
        phase: "publishing",
        destination: EXPORT_DESTINATION,
        generationId: published.intent.generationId,
        failure: null,
      },
      correlation,
    },
  ];
}

function handleExportStart(
  _payload: CommandPayloadByKindV1["export.start"],
  context: HandlerContext,
): CommandOutcomeV1 {
  context.launchOperation("kernel.export.run", () => runExportStart(context));
  return startedOutcome([]);
}

// -------------------------------------------------------------------------------------
// The exported family maps
// -------------------------------------------------------------------------------------

export const previewHandlers: FamilyHandlerMap<"preview"> = {
  "preview.selectPage": selectCurrentSource,
  "preview.selectCurrent": selectCurrentSource,
  "preview.selectHistorical": handleSelectHistorical,
  "preview.resize": handleResize,
  "preview.setThemeCapabilities": handleSetThemeCapabilities,
  "preview.setMode": handleSetMode,
  "preview.queryGeometry": handleQueryGeometry,
  "preview.retry": handleRetry,
  "preview.close": handleClose,
};

export const exportHandlers: FamilyHandlerMap<"export"> = {
  "export.start": handleExportStart,
};
