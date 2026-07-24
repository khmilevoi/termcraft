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
import {
  type CommandPayloadByKindV1,
  type FailureDtoV1,
  type Sha256Hex,
  type UUIDv7,
  canonicalHash,
} from "core/protocol";
import type { PageSlug, Size } from "entities/page";
import { uuidv7 } from "infrastructure/uuid";

import type { CommandOutcomeV1, FamilyHandlerMap, HandlerContext } from "./types";
import { completedOutcome, noOpOutcome, startedOutcome } from "./types";

/**
 * `preview-export.ts` — kernel-assembly WP-1 task 9, Step B: the `preview` family's 9
 * non-deferred kinds (`preview.forwardInput`/`preview.setTweak` are Tier-C deferred,
 * `./deferred.ts` owns them) plus the `export` family's one kind, `export.start`.
 *
 * TWO GENUINE, INDEPENDENTLY-VERIFIED CONTRACT GAPS originally bounded what this file could
 * honestly do — both reported in the family's own report (`.superpowers/sdd/
 * task9-family-preview-export-report.md`). Gap A (below) is still open. Gap B — CLOSED (MVP
 * gap closeout, `export.start` is core MVP per the maintainer decision recorded in
 * `.superpowers/sdd/task-9-report.md`'s "Gap 4 closure"/"Tasks 10-11" sections) — see
 * `handleExportStart`'s own header for the real recipe.
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
 * - `preview.close`: applies `kernel.preview.disable` and clears
 *   `HandlerContext`'s own tracked session reference — the Kernel-side half of closing that
 *   Gap A does not block. The host-side half (calling the actual session's own `close()`
 *   to release its resources) is exactly what Gap A blocks; documented on the handler.
 * - Every other Gap-A-blocked kind returns the sanctioned `noOpOutcome()` (an idempotent
 *   refusal — nothing ran, matching this project's own "two outcomes only" rule) with a
 *   doc comment naming precisely which gap blocks it and why.
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
 * THE TERMINAL EVENT: exactly one of `export.completed`/`export.failed`, matching
 * `ExportTerminalPayloadV1`'s own closed shape (`operationId`, `phase`, `destination`,
 * `generationId`, `failure`). `destination` is `EXPORT_DESTINATION` throughout. `generationId`
 * is non-null ONLY on `export.completed`, taken verbatim from `PublishExportResultV1`'s own
 * `"published"` intent — never fabricated for a failure.
 */
async function runExportStart(context: HandlerContext): Promise<readonly PublishableEventV1[]> {
  const pages = await wrap(resolveExportPageInputs(context));
  if ("code" in pages) {
    console.warn(
      `core/kernel/handlers/preview-export: export.start refused — could not resolve the project's page settings: ${pages.safeMessage}`,
    );
    return [];
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
    // handler) — both share this shape; nothing ran, so nothing to recover.
    console.warn(
      `core/kernel/handlers/preview-export: export.start's captureExportSnapshot was illegal (${captured.code})`,
    );
    return [];
  }
  if (captured.kind === "failed") {
    console.warn(
      `core/kernel/handlers/preview-export: export.start's snapshot capture failed: ${captured.failure.safeMessage}`,
    );
    return [];
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
