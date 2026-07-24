import { type Atom, atom, wrap } from "@reatom/core";
import * as errore from "errore";

import type { FrameTokenV1, GeometryTokenV1 } from "core/protocol";
import { parsePageSlug } from "entities/page";
import type { PageSlug } from "entities/page";
import type { Dispatcher, EventOf, UiPreviewFrame } from "ui/kernel";

import type { Point, Rect } from "./overlay";

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
}

interface PreviewInteractionDeps {
  readonly dispatcher: Dispatcher;
  readonly previewFrame: Atom<UiPreviewFrame | null>;
  readonly runtimeError: Atom<Error | null>;
  readonly screen: () => string;
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
    console.error("UI preview display acknowledgement failed:", acknowledged);
    return;
  }

  deps.interaction.displayedFrameToken.set(uiFrame.frameToken);
  deps.interaction.pendingGeometry.set(null);
  deps.interaction.queuedGeometry.set(null);
  deps.interaction.pendingPin.set(null);
  deps.interaction.hover.set(null);
  deps.interaction.selectionRect.set(null);
}

/** Dispatches one latest-wins geometry query for the successfully displayed frame only. */
export function requestGeometry(
  deps: PreviewInteractionDeps,
  purpose: GeometryIntent,
  x: number,
  y: number,
): void {
  if (!Number.isSafeInteger(x) || x < 0 || !Number.isSafeInteger(y) || y < 0) return;
  if (purpose !== "hover" && deps.screen() === "read-only") return;

  const displayedFrameToken = deps.interaction.displayedFrameToken();
  const current = deps.previewFrame();
  if (displayedFrameToken === null || current === null) return;
  if (current.frameToken !== displayedFrameToken) return;

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
    return;
  }
  dispatchGeometryRequest(deps, request);
}

/** Applies a geometry event only when both of its capability correlation fields still match. */
export function handleGeometryResult(
  deps: PreviewInteractionDeps,
  envelope: EventOf<"preview.geometryResult">,
): void {
  const pending = deps.interaction.pendingGeometry();
  if (pending === null) return;
  const payload = envelope.payload;
  if (payload.frameTokenId !== pending.frameToken || payload.queryKind !== pending.queryKind)
    return;
  if (deps.interaction.displayedFrameToken() !== pending.frameToken) return;
  const current = deps.previewFrame();
  if (current === null || current.frameToken !== pending.frameToken) return;
  if (current.handle.previewSessionId !== payload.previewSessionId) return;

  if (pending.superseded) {
    promoteQueuedGeometry(deps);
    return;
  }

  deps.interaction.pendingGeometry.set(null);
  deps.interaction.queuedGeometry.set(null);
  if (pending.purpose !== "hover" && deps.screen() === "read-only") return;

  if (pending.purpose === "pin") {
    if (payload.geometryToken === null) return;
    deps.interaction.pendingPin.set({
      geometryToken: payload.geometryToken,
      point: { x: pending.x, y: pending.y },
    });
    deps.local.pinDraft.set("");
    deps.local.overlay.set("pin-input");
    return;
  }

  const hit = parseHitGeometry(payload.result);
  if (hit === null) {
    if (pending.purpose === "hover") deps.interaction.hover.set(null);
    if (pending.purpose === "select") deps.interaction.selectionRect.set(null);
    return;
  }

  deps.interaction.hover.set({ rect: hit.rect, label: hit.label });
  if (pending.purpose === "hover") return;

  deps.interaction.selectionRect.set(hit.rect);
  reportDispatchFailure(
    deps.dispatcher.dispatch("selection.set", {
      pageSlug: hit.pageSlug,
      elementId: hit.elementId,
    }),
  );
}

interface HitGeometry extends HoverGeometry {
  readonly pageSlug: PageSlug;
  readonly elementId: string;
}

function parseHitGeometry(value: unknown): HitGeometry | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  if (!("pageSlug" in value) || typeof value.pageSlug !== "string") return null;
  const pageSlug = parsePageSlug(value.pageSlug);
  if (pageSlug instanceof Error) return null;
  if (
    !("elementId" in value) ||
    typeof value.elementId !== "string" ||
    value.elementId.length === 0
  )
    return null;
  if (!("label" in value) || typeof value.label !== "string") return null;
  if (!("rect" in value)) return null;
  const rect = parseRect(value.rect);
  if (rect === null) return null;
  return {
    pageSlug,
    elementId: value.elementId,
    rect,
    label: value.label,
  };
}

function parseRect(value: unknown): Rect | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  if (!("x" in value) || !isNonNegativeInteger(value.x)) return null;
  if (!("y" in value) || !isNonNegativeInteger(value.y)) return null;
  if (!("width" in value) || !isPositiveInteger(value.width)) return null;
  if (!("height" in value) || !isPositiveInteger(value.height)) return null;
  return { x: value.x, y: value.y, width: value.width, height: value.height };
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return isNonNegativeInteger(value) && value > 0;
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
      console.error("UI geometry query dispatch failed:", error);
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
    if (result instanceof Error) console.error("UI command dispatch failed:", result);
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
