import { type Atom, atom, wrap } from "@reatom/core";
import * as errore from "errore";

import type { FrameTokenV1, GeometryTokenV1 } from "core/protocol";
import { parsePageSlug } from "entities/page";
import { log, trace } from "infrastructure/debug-log";
import { reasonLabel } from "ui/actions";
import type { Dispatcher, EventOf, UiPreviewFrame } from "ui/kernel";

import type { ElementRectIndex } from "./element-rects";
import { indexElementRects } from "./element-rects";
import type { Point, Rect } from "./overlay";

// DIAGNOSTIC (infrastructure/debug-log): added while investigating "pins don't work" — traces
// the "select"/"pin" leg of the geometry-query flow end to end (every early return, the
// dispatched request, and the eventual result). Deliberately skips "hover", which fires on
// every mouse-move and would drown the channel in noise this investigation does not need.
function tracePin(channel: string, purpose: GeometryIntent, data: Record<string, unknown>): void {
  if (purpose === "hover") return;
  trace(channel, { purpose, ...data });
}

export type GeometryIntent = "hover" | "select" | "pin";
type GeometryQueryKind = "hit" | "pin-anchor";

interface GeometryRequest {
  readonly frameToken: FrameTokenV1;
  readonly purpose: GeometryIntent;
  readonly queryKind: GeometryQueryKind;
  readonly x: number;
  readonly y: number;
}

export interface PendingGeometry extends GeometryRequest {
  readonly superseded: boolean;
}

export interface PendingPin {
  readonly geometryToken: GeometryTokenV1;
  readonly point: Point;
}

/**
 * One in-flight "the user pressed Enter in the pin popup" re-anchor query — see
 * {@link savePendingPin} for why saving asks for a fresh anchor instead of spending the
 * token the right-click already minted.
 */
export interface PendingPinSave {
  readonly frameToken: FrameTokenV1;
  readonly point: Point;
  /** The comment as it read when Enter was pressed — never re-read later, so a keystroke that lands mid-save cannot change what gets saved. */
  readonly text: string;
}

/** The element rectangles of ONE displayed frame — never carried across to the next one. */
export interface FrameElementRects {
  readonly frameToken: FrameTokenV1;
  readonly rects: ElementRectIndex;
}

export interface HoverGeometry {
  readonly rect: Rect;
  readonly label: string;
}

export interface PreviewInteractionState {
  readonly displayedFrameToken: Atom<FrameTokenV1 | null>;
  readonly pendingGeometry: Atom<PendingGeometry | null>;
  readonly queuedGeometry: Atom<GeometryRequest | null>;
  readonly pendingPin: Atom<PendingPin | null>;
  /**
   * The re-anchor query one pin save is waiting on, or `null`. Its OWN lane, for the same
   * reason `pendingElementRects` has one: `pendingGeometry` is latest-wins against the
   * pointer, and a save the next mouse-move supersedes is a save that silently never happens
   * — which is the whole defect this lane exists to end.
   */
  readonly pendingPinSave: Atom<PendingPinSave | null>;
  readonly hover: Atom<HoverGeometry | null>;
  readonly selectionRect: Atom<Rect | null>;
  /**
   * The displayed frame whose `layout` query is in flight, or `null`. Deliberately its OWN
   * lane, not `pendingGeometry`'s: that one is latest-wins against the pointer, and a pin's
   * anchor must not be superseded — and silently dropped — by the next mouse-move.
   */
  readonly pendingElementRects: Atom<FrameTokenV1 | null>;
  /** The resolved element rectangles of the displayed frame, or `null` before they land. */
  readonly elementRects: Atom<FrameElementRects | null>;
}

interface PreviewInteractionDeps {
  readonly dispatcher: Dispatcher;
  readonly previewFrame: Atom<UiPreviewFrame | null>;
  readonly runtimeError: Atom<Error | null>;
  readonly screen: () => string;
  /**
   * The page the preview is actually showing — the tab override when the user picked one, else
   * the Kernel's active slug. A `checkHit` reply names only an element (§7.1), and a selection
   * is stored as (page, element) per spec §3.2, so the page half is read here rather than
   * fabricated from a field the wire has never carried.
   */
  readonly activePageSlug: () => string | null;
  readonly local: {
    readonly overlay: { set(value: "pin-input" | null): unknown };
    readonly pinDraft: Atom<string>;
    /** Why the last pin save did not land, or `null`. Drawn in the popup's own footer row — see {@link savePendingPin}. */
    readonly pinSaveError: Atom<string | null>;
  };
  readonly interaction: PreviewInteractionState;
}

export function createPreviewInteractionState(): PreviewInteractionState {
  return {
    displayedFrameToken: atom<FrameTokenV1 | null>(null, "ui.preview.displayedFrameToken"),
    pendingGeometry: atom<PendingGeometry | null>(null, "ui.preview.pendingGeometry"),
    queuedGeometry: atom<GeometryRequest | null>(null, "ui.preview.queuedGeometry"),
    pendingPin: atom<PendingPin | null>(null, "ui.preview.pendingPin"),
    pendingPinSave: atom<PendingPinSave | null>(null, "ui.preview.pendingPinSave"),
    hover: atom<HoverGeometry | null>(null, "ui.preview.hover"),
    selectionRect: atom<Rect | null>(null, "ui.preview.selectionRect"),
    pendingElementRects: atom<FrameTokenV1 | null>(null, "ui.preview.pendingElementRects"),
    elementRects: atom<FrameElementRects | null>(null, "ui.preview.elementRects"),
  };
}

/** Records only a successful acknowledgement of the exact frame still awaiting display. */
export function acknowledgeFrame(deps: PreviewInteractionDeps, uiFrame: UiPreviewFrame): void {
  const current = deps.previewFrame();
  if (current === null) return;
  if (current.frameToken !== uiFrame.frameToken || current.handle !== uiFrame.handle) return;
  if (deps.interaction.displayedFrameToken() === uiFrame.frameToken) return;

  const acknowledged = uiFrame.handle.acknowledgeDisplay(uiFrame.frameToken);
  if (acknowledged instanceof Error) {
    deps.runtimeError.set(acknowledged);
    log.error("UI preview display acknowledgement failed:", acknowledged);
    return;
  }

  deps.interaction.displayedFrameToken.set(uiFrame.frameToken);
  deps.interaction.pendingGeometry.set(null);
  deps.interaction.queuedGeometry.set(null);
  deps.interaction.pendingPin.set(null);
  // The anchor this save was re-querying belongs to the frame just replaced, so the reply —
  // if one still arrives — is about pixels nobody is looking at. Dropped with the pin it
  // belonged to, never left in flight to create a pin against the previous render.
  deps.interaction.pendingPinSave.set(null);
  deps.interaction.hover.set(null);
  deps.interaction.selectionRect.set(null);
  // A new frame reseals the hit grid, the rectangles and the layout tree together
  // (host-supervision §7.1), so the previous frame's rectangles are not evidence about this
  // one. Dropped rather than reused: a badge drawn from stale geometry is exactly the
  // "positioning a pin against newer pixels" §7.1 exists to prevent.
  deps.interaction.pendingElementRects.set(null);
  deps.interaction.elementRects.set(null);
}

/** Dispatches one latest-wins geometry query for the successfully displayed frame only. */
export function requestGeometry(
  deps: PreviewInteractionDeps,
  purpose: GeometryIntent,
  x: number,
  y: number,
): void {
  if (!Number.isSafeInteger(x) || x < 0 || !Number.isSafeInteger(y) || y < 0) {
    tracePin("ui.preview.requestGeometry", purpose, {
      step: "refused",
      reason: "invalid coordinate",
      x,
      y,
    });
    return;
  }
  if (purpose !== "hover" && deps.screen() === "read-only") {
    tracePin("ui.preview.requestGeometry", purpose, {
      step: "refused",
      reason: "screen is read-only",
    });
    return;
  }
  // A `pin-anchor` reply carries no coordinates (`PreviewGeometryResultPayloadV1`), so the
  // only way to tell "this is the anchor for a NEW pin input" from "this is the re-anchor a
  // save is waiting on" is that never more than one of them is outstanding. A right-click
  // landing mid-save is refused rather than allowed to make the two indistinguishable.
  if (purpose === "pin" && deps.interaction.pendingPinSave() !== null) {
    tracePin("ui.preview.requestGeometry", purpose, {
      step: "refused",
      reason: "a pin save is already re-anchoring",
    });
    return;
  }

  const displayedFrameToken = deps.interaction.displayedFrameToken();
  const current = deps.previewFrame();
  if (displayedFrameToken === null || current === null) {
    tracePin("ui.preview.requestGeometry", purpose, {
      step: "refused",
      reason: "no displayed frame",
      hasDisplayedFrameToken: displayedFrameToken !== null,
      hasPreviewFrame: current !== null,
    });
    return;
  }
  if (current.frameToken !== displayedFrameToken) {
    tracePin("ui.preview.requestGeometry", purpose, {
      step: "refused",
      reason: "frame token mismatch",
      displayedFrameToken,
      currentFrameToken: current.frameToken,
    });
    return;
  }

  const queryKind = purpose === "pin" ? "pin-anchor" : "hit";
  const request: GeometryRequest = {
    frameToken: displayedFrameToken,
    purpose,
    queryKind,
    x,
    y,
  };
  const pending = deps.interaction.pendingGeometry();
  if (pending !== null) {
    deps.interaction.pendingGeometry.set({ ...pending, superseded: true });
    deps.interaction.queuedGeometry.set(request);
    tracePin("ui.preview.requestGeometry", purpose, {
      step: "queued",
      reason: "another geometry query is already pending",
      queryKind,
      x,
      y,
    });
    return;
  }
  tracePin("ui.preview.requestGeometry", purpose, { step: "dispatching", queryKind, x, y });
  dispatchGeometryRequest(deps, request);
}

/**
 * Resolves every element rectangle of the displayed frame in ONE `layout` query, so a pin's
 * badge can sit where the spec puts it — `rect.origin + (fx·width, fy·height)` of the anchored
 * element (§3.2), not of the whole frame — and so a pin whose element the render does not
 * contain can be marked "not visible" instead of drawn somewhere it never was.
 *
 * `layout` is the spec's own batch primitive (§4.2 `layoutTree`; the closed query enum
 * §10.1 fixes has no per-id batch member), so this costs no protocol change and one round
 * trip per frame regardless of how many pins the page has.
 *
 * Idempotent and safe to call on every render: it is a no-op once the query is in flight or
 * the current frame's rectangles have landed. That is also the retry — a refused query leaves
 * both atoms clear, and the next render asks again.
 */
export function requestElementRects(deps: PreviewInteractionDeps): void {
  const displayed = deps.interaction.displayedFrameToken();
  if (displayed === null) return;
  const current = deps.previewFrame();
  if (current === null || current.frameToken !== displayed) return;
  if (deps.interaction.pendingElementRects() !== null) return;
  const resolved = deps.interaction.elementRects();
  if (resolved !== null && resolved.frameToken === displayed) return;

  deps.interaction.pendingElementRects.set(displayed);
  const dispatched = deps.dispatcher.dispatch("preview.queryGeometry", {
    frameToken: displayed,
    query: { kind: "layout" },
  });
  void dispatched.then(
    wrap((result) => {
      const error =
        result instanceof Error
          ? result
          : result.status === "rejected"
            ? new GeometryQueryRejectedError({ code: result.code })
            : null;
      if (error === null) return;
      // Logged, never raised into `runtimeError` (errore rule 21): unlike a click, nothing
      // the user did is waiting on this. The cost of a refusal is that this frame's pins stay
      // unplaced until the next render retries — not a failure worth a shell-wide banner.
      log.warn("UI element-rect query failed:", error);
      if (deps.interaction.pendingElementRects() === displayed) {
        deps.interaction.pendingElementRects.set(null);
      }
    }),
  );
}

/**
 * Stores a `layout` reply as the displayed frame's rectangles, subject to the same correlation
 * checks a pointer-driven result gets: the reply must be about the frame still displayed, from
 * the session still live, and the one this lane actually asked for.
 */
function applyElementRects(
  deps: PreviewInteractionDeps,
  envelope: EventOf<"preview.geometryResult">,
): void {
  const payload = envelope.payload;
  const pending = deps.interaction.pendingElementRects();
  if (pending === null || payload.frameTokenId !== pending) return;
  deps.interaction.pendingElementRects.set(null);
  if (deps.interaction.displayedFrameToken() !== pending) return;
  const current = deps.previewFrame();
  if (current === null || current.frameToken !== pending) return;
  if (current.handle.previewSessionId !== payload.previewSessionId) return;
  if (payload.result.kind !== "layoutTree") return;

  deps.interaction.elementRects.set({
    frameToken: pending,
    rects: indexElementRects(payload.result.tree),
  });
}

// ---------------------------------------------------------------------------
// Saving a pin (the pin-loss defect, 2026-08-11)
// ---------------------------------------------------------------------------

/**
 * The anchor is gone: nothing at that point resolves any more, or the Kernel refused the
 * token this save just minted. The pin popup stays open with what the user typed, so Enter
 * retries and a re-click re-places — design's own `✗ <what> — <what to do>` error voice
 * (`design/termcraft-engine.js:1169`, `:1178`).
 */
const PIN_SAVE_ANCHOR_LOST = "✗ anchor lost — click the spot again";

/** The save never reached the Kernel at all. Retryable as-is, nothing about the anchor is known to be wrong. */
const PIN_SAVE_UNREACHABLE = "✗ pin not saved — try again";

/** Records why a save did not land, keeping the popup, the pending pin and the draft exactly as they are. */
function failPinSave(deps: PreviewInteractionDeps, message: string, reason: string): void {
  tracePin("ui.preview.pinSave", "pin", { step: "failed", reason, message });
  deps.local.pinSaveError.set(message);
}

/**
 * Saves the open pin popup: re-anchors FIRST, then creates the pin with the token that
 * re-anchor query minted.
 *
 * THE DEFECT THIS SHAPE EXISTS FOR (2026-08-11, `termcraft-debug/run-2026-08-11T10-17-11
 * -500Z-26068.jsonl`). The right-click's geometry token was previously carried, unspent,
 * through however long the user spent typing, and `pin.create` was dispatched with it on
 * Enter. The Kernel's geometry ledger keeps a token for 30 seconds (`core/preview/model/
 * geometry-token-ledger.ts`, KCC §8.1), so a comment that took longer than that to type was
 * rejected as `GEOMETRY_TOKEN_INVALID` — and since the UI closed the popup and cleared the
 * draft the instant it dispatched, the user saw the input vanish, no pin appear, and no
 * error: "I pressed Enter and nothing happened". In the recorded session two saves out of
 * six died this way, at 34.5s and 35.8s, while every save under 26s worked.
 *
 * Re-anchoring makes the token milliseconds old at the moment it is spent, so the TTL stops
 * being a deadline on typing. It also re-checks the anchor against what is on screen NOW —
 * the same question `GEOMETRY_TOKEN_STALE` asks, answered before anything is written rather
 * than after.
 *
 * Nothing local is cleared until the Kernel accepts. On any failure the popup, the pending
 * pin and the draft all stay put and {@link PreviewInteractionDeps.local.pinSaveError} says
 * why — the treatment `composer-submit`/`home-submit` (`ui/app/model/intent.ts`) already
 * give their own text.
 */
export function savePendingPin(deps: PreviewInteractionDeps): void {
  const pending = deps.interaction.pendingPin();
  if (pending === null) return;
  // A second Enter while the first is still re-anchoring would mint a second token and create
  // a second pin for one comment.
  if (deps.interaction.pendingPinSave() !== null) {
    tracePin("ui.preview.pinSave", "pin", {
      step: "ignored",
      reason: "a save is already in flight",
    });
    return;
  }
  if (deps.screen() === "read-only") {
    tracePin("ui.preview.pinSave", "pin", { step: "refused", reason: "screen is read-only" });
    return;
  }

  const displayedFrameToken = deps.interaction.displayedFrameToken();
  const current = deps.previewFrame();
  if (
    displayedFrameToken === null ||
    current === null ||
    current.frameToken !== displayedFrameToken
  ) {
    failPinSave(deps, PIN_SAVE_ANCHOR_LOST, "no displayed frame to re-anchor against");
    return;
  }

  const request: PendingPinSave = {
    frameToken: displayedFrameToken,
    point: pending.point,
    text: deps.local.pinDraft(),
  };
  deps.local.pinSaveError.set(null);
  deps.interaction.pendingPinSave.set(request);
  tracePin("ui.preview.pinSave", "pin", {
    step: "re-anchoring",
    x: request.point.x,
    y: request.point.y,
  });

  const dispatched = deps.dispatcher.dispatch("preview.queryGeometry", {
    frameToken: request.frameToken,
    query: { kind: "pin-anchor", x: request.point.x, y: request.point.y },
  });
  void dispatched.then(
    wrap((result) => {
      const error =
        result instanceof Error
          ? result
          : result.status === "rejected"
            ? new GeometryQueryRejectedError({ code: result.code })
            : null;
      if (error === null) return;
      log.error("UI pin re-anchor query failed:", error);
      // Only if THIS save is still the one in flight — a newer frame may already have
      // dropped it (`acknowledgeFrame`), and clearing the lane then would clear someone else's.
      if (deps.interaction.pendingPinSave() !== request) return;
      deps.interaction.pendingPinSave.set(null);
      failPinSave(deps, PIN_SAVE_UNREACHABLE, `re-anchor query failed: ${error.message}`);
    }),
  );
}

/**
 * Withdraws the open pin: the pending anchor AND whatever save was re-anchoring against it.
 *
 * The counterpart to {@link savePendingPin}, and beside it deliberately — the rule that makes
 * clearing `pendingPin` sufficient to cancel an in-flight save is {@link applyPinSaveResult}'s
 * own abandon check, and a caller in another module clearing these lanes by hand would be
 * authoring that correlation from outside the file that defines it. The caller still owns its
 * own layer: closing the overlay and syncing the live editor buffer are not this function's
 * business.
 */
export function cancelPendingPin(deps: PreviewInteractionDeps): void {
  deps.interaction.pendingPin.set(null);
  deps.interaction.pendingPinSave.set(null);
  deps.local.pinSaveError.set(null);
}

/**
 * Turns one re-anchor reply into `pin.create`, subject to the same correlation checks a
 * pointer-driven result gets: the reply must be about the frame still displayed, from the
 * session still live, and the one this lane actually asked for.
 */
function applyPinSaveResult(
  deps: PreviewInteractionDeps,
  envelope: EventOf<"preview.geometryResult">,
  save: PendingPinSave,
): void {
  const payload = envelope.payload;
  deps.interaction.pendingPinSave.set(null);

  // Esc closed the popup while the re-anchor was in flight — the user withdrew the pin, so
  // creating it now would be a pin they cancelled.
  if (deps.interaction.pendingPin() === null) {
    tracePin("ui.preview.pinSave", "pin", {
      step: "abandoned",
      reason: "the pin input was closed",
    });
    return;
  }

  const current = deps.previewFrame();
  if (
    payload.frameTokenId !== save.frameToken ||
    deps.interaction.displayedFrameToken() !== save.frameToken ||
    current === null ||
    current.frameToken !== save.frameToken ||
    current.handle.previewSessionId !== payload.previewSessionId
  ) {
    failPinSave(deps, PIN_SAVE_ANCHOR_LOST, "the displayed frame changed during the re-anchor");
    return;
  }
  if (payload.geometryToken === null) {
    failPinSave(deps, PIN_SAVE_ANCHOR_LOST, "the host resolved no anchor at this point");
    return;
  }

  tracePin("ui.preview.pinSave", "pin", {
    step: "creating",
    geometryToken: payload.geometryToken,
    textLength: save.text.length,
  });
  void deps.dispatcher
    .dispatch("pin.create", { geometryToken: payload.geometryToken, text: save.text })
    .then(
      wrap((result) => {
        if (result instanceof Error) {
          log.error("UI pin.create dispatch failed:", result);
          failPinSave(deps, PIN_SAVE_UNREACHABLE, `pin.create dispatch failed: ${result.message}`);
          return;
        }
        if (result.status === "rejected") {
          failPinSave(
            deps,
            `✗ ${reasonLabel(result.reasons[0])} — not saved`,
            `pin.create rejected: ${result.code}`,
          );
          return;
        }
        // `no-op` is `pin.create`'s own idempotent refusal, and its handler has exactly one
        // reason to return it: the geometry token no longer names the displayed frame
        // (`core/kernel/model/handlers/page-pin.ts`). Nothing was written, so nothing here
        // may be cleared either.
        if (result.disposition === "no-op") {
          failPinSave(deps, PIN_SAVE_ANCHOR_LOST, "the Kernel refused the freshly minted token");
          return;
        }
        tracePin("ui.preview.pinSave", "pin", { step: "created" });
        deps.interaction.pendingPin.set(null);
        // The mirror atom only: the popup unmounts with the overlay, and its editor seeds
        // itself from this atom at its next mount (`createEditorBridge`'s `readSeed`), so
        // there is no live buffer left to write through.
        deps.local.pinDraft.set("");
        deps.local.pinSaveError.set(null);
        deps.local.overlay.set(null);
      }),
    );
}

/** Applies a geometry event only when both of its capability correlation fields still match. */
export function handleGeometryResult(
  deps: PreviewInteractionDeps,
  envelope: EventOf<"preview.geometryResult">,
): void {
  // The element-rect lane owns every `layout` reply and is correlated separately — see
  // `requestElementRects`. Checked before `pendingGeometry`, which that lane never touches.
  if (envelope.payload.queryKind === "layout") return applyElementRects(deps, envelope);

  // The pin-save lane owns the ONE `pin-anchor` reply it is waiting on, for the same reason:
  // `pendingGeometry` never holds it, so the shared lane below would drop it as uncorrelated.
  // `requestGeometry` refuses a new pin request while this is set, so at most one of the two
  // pin-anchor meanings is ever outstanding.
  const pinSave = deps.interaction.pendingPinSave();
  if (pinSave !== null && envelope.payload.queryKind === "pin-anchor") {
    return applyPinSaveResult(deps, envelope, pinSave);
  }

  const pending = deps.interaction.pendingGeometry();
  if (pending === null) return;
  const payload = envelope.payload;
  if (payload.frameTokenId !== pending.frameToken || payload.queryKind !== pending.queryKind) {
    tracePin("ui.preview.geometryResult", pending.purpose, {
      step: "ignored",
      reason: "frameToken/queryKind mismatch",
      pendingQueryKind: pending.queryKind,
      payloadQueryKind: payload.queryKind,
    });
    return;
  }
  if (deps.interaction.displayedFrameToken() !== pending.frameToken) {
    tracePin("ui.preview.geometryResult", pending.purpose, {
      step: "ignored",
      reason: "displayed frame changed since the request",
    });
    return;
  }
  const current = deps.previewFrame();
  if (current === null || current.frameToken !== pending.frameToken) {
    tracePin("ui.preview.geometryResult", pending.purpose, {
      step: "ignored",
      reason: "no matching previewFrame",
    });
    return;
  }
  if (current.handle.previewSessionId !== payload.previewSessionId) {
    tracePin("ui.preview.geometryResult", pending.purpose, {
      step: "ignored",
      reason: "previewSessionId mismatch",
    });
    return;
  }

  if (pending.superseded) {
    tracePin("ui.preview.geometryResult", pending.purpose, {
      step: "superseded",
      reason: "a newer request already replaced this one",
    });
    promoteQueuedGeometry(deps);
    return;
  }

  deps.interaction.pendingGeometry.set(null);
  deps.interaction.queuedGeometry.set(null);
  if (pending.purpose !== "hover" && deps.screen() === "read-only") {
    tracePin("ui.preview.geometryResult", pending.purpose, {
      step: "dropped",
      reason: "screen became read-only",
    });
    return;
  }

  if (pending.purpose === "pin") {
    if (payload.geometryToken === null) {
      tracePin("ui.preview.geometryResult", pending.purpose, {
        step: "dropped",
        reason: "geometryToken is null — host resolved no anchor at this point",
      });
      return;
    }
    tracePin("ui.preview.geometryResult", pending.purpose, {
      step: "pin-input opened",
      geometryToken: payload.geometryToken,
    });
    deps.interaction.pendingPin.set({
      geometryToken: payload.geometryToken,
      point: { x: pending.x, y: pending.y },
    });
    deps.local.pinDraft.set("");
    deps.local.overlay.set("pin-input");
    return;
  }

  // A `hit`/`pin-anchor` reply is a `checkHit` (§7.1) and carries ONE fact: the element id
  // under the cursor. Everything else the overlays need — where that element is — comes from
  // this frame's own rectangles, the map the pin badges already read.
  const elementId = payload.result.kind === "checkHit" ? (payload.result.hit?.id ?? null) : null;
  if (elementId === null) {
    deps.interaction.hover.set(null);
    if (pending.purpose === "select") deps.interaction.selectionRect.set(null);
    return;
  }

  const resolved = deps.interaction.elementRects();
  const rect =
    resolved !== null && resolved.frameToken === pending.frameToken
      ? (resolved.rects.get(elementId) ?? null)
      : null;

  // DIVERGENCE (the same one the composer chip already carries, `deriveComposerAttach`): the
  // design's hover label is `panel "network"` — component kind plus human label, from
  // `describe`. Neither exists yet: the runtime catalog is unbuilt, so the host's own
  // `DescribedElement` has no `label` and its `kind` is an OpenTUI constructor name
  // (`BoxRenderable`), not the design's vocabulary. The element id is the one real name in
  // play, and it is what the selection chip shows for the very same element.
  deps.interaction.hover.set(rect === null ? null : { rect, label: elementId });
  if (pending.purpose === "hover") return;

  // Corners need the rectangle; the selection itself does not. A click still selects while the
  // frame's rectangles are in flight — the corner glyphs simply appear when they land.
  deps.interaction.selectionRect.set(rect);
  const active = deps.activePageSlug();
  const pageSlug = active === null ? null : parsePageSlug(active);
  if (pageSlug === null || pageSlug instanceof Error) {
    tracePin("ui.preview.geometryResult", pending.purpose, {
      step: "dropped",
      reason: "no valid active page to attribute the selection to",
      activePageSlug: active,
      elementId,
    });
    return;
  }
  reportDispatchFailure(deps.dispatcher.dispatch("selection.set", { pageSlug, elementId }));
}

class GeometryQueryRejectedError extends errore.createTaggedError({
  name: "GeometryQueryRejectedError",
  message: "geometry query command rejected with $code",
}) {}

function dispatchGeometryRequest(deps: PreviewInteractionDeps, request: GeometryRequest): void {
  deps.interaction.pendingGeometry.set({ ...request, superseded: false });
  const dispatched = deps.dispatcher.dispatch("preview.queryGeometry", {
    frameToken: request.frameToken,
    query: { kind: request.queryKind, x: request.x, y: request.y },
  });
  void dispatched.then(
    wrap((result) => {
      const error =
        result instanceof Error
          ? result
          : result.status === "rejected"
            ? new GeometryQueryRejectedError({ code: result.code })
            : null;
      if (error === null) return;
      deps.runtimeError.set(error);
      log.error("UI geometry query dispatch failed:", error);
      const pending = deps.interaction.pendingGeometry();
      if (pending === null || !sameGeometryRequest(pending, request)) return;
      promoteQueuedGeometry(deps);
    }),
  );
}

function promoteQueuedGeometry(deps: PreviewInteractionDeps): void {
  const queued = deps.interaction.queuedGeometry();
  deps.interaction.pendingGeometry.set(null);
  deps.interaction.queuedGeometry.set(null);
  if (queued === null) return;
  if (queued.purpose !== "hover" && deps.screen() === "read-only") return;
  const displayed = deps.interaction.displayedFrameToken();
  const current = deps.previewFrame();
  if (displayed !== queued.frameToken || current === null) return;
  if (current.frameToken !== queued.frameToken) return;
  dispatchGeometryRequest(deps, queued);
}

function sameGeometryRequest(left: GeometryRequest, right: GeometryRequest): boolean {
  return (
    left.frameToken === right.frameToken &&
    left.purpose === right.purpose &&
    left.queryKind === right.queryKind &&
    left.x === right.x &&
    left.y === right.y
  );
}

function reportDispatchFailure(promise: ReturnType<Dispatcher["dispatch"]>): void {
  void promise.then((result) => {
    if (result instanceof Error) log.error("UI command dispatch failed:", result);
  });
}

/** Converts one absolute terminal cell into a clamped 0-based frame-local point. */
export function frameLocalPoint(input: Readonly<{ absolute: Point; frameRect: Rect }>): Point {
  const maxX = Math.max(0, input.frameRect.width - 1);
  const maxY = Math.max(0, input.frameRect.height - 1);
  const localX = Math.trunc(input.absolute.x - input.frameRect.x);
  const localY = Math.trunc(input.absolute.y - input.frameRect.y);
  return {
    x: Math.max(0, Math.min(maxX, localX)),
    y: Math.max(0, Math.min(maxY, localY)),
  };
}
