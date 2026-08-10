import { type Atom, atom, wrap } from "@reatom/core";
import * as errore from "errore";

import type { FrameTokenV1, GeometryTokenV1 } from "core/protocol";
import { parsePageSlug } from "entities/page";
import { log, trace } from "infrastructure/debug-log";
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
  };
  readonly interaction: PreviewInteractionState;
}

export function createPreviewInteractionState(): PreviewInteractionState {
  return {
    displayedFrameToken: atom<FrameTokenV1 | null>(null, "ui.preview.displayedFrameToken"),
    pendingGeometry: atom<PendingGeometry | null>(null, "ui.preview.pendingGeometry"),
    queuedGeometry: atom<GeometryRequest | null>(null, "ui.preview.queuedGeometry"),
    pendingPin: atom<PendingPin | null>(null, "ui.preview.pendingPin"),
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

/** Applies a geometry event only when both of its capability correlation fields still match. */
export function handleGeometryResult(
  deps: PreviewInteractionDeps,
  envelope: EventOf<"preview.geometryResult">,
): void {
  // The element-rect lane owns every `layout` reply and is correlated separately — see
  // `requestElementRects`. Checked before `pendingGeometry`, which that lane never touches.
  if (envelope.payload.queryKind === "layout") return applyElementRects(deps, envelope);

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
