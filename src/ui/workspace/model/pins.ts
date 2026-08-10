import type { PinDtoV1 } from "core/protocol";
import type { PinListRow } from "ui/chat";
import type { ElementRectIndex } from "ui/preview";

/**
 * Builds `PinList`'s rows from the active page's pins (open + resolved). Numbers each open
 * pin's badge among OPEN pins only — matching `PreviewOverlays`' own numbering
 * (`ui/preview/ui/PreviewOverlays.tsx:21-25`: `pins.filter(status === "open").map((_, index) => …)`),
 * never the pin's position in the full (open+resolved) array. A resolved pin ahead of an open
 * one in mirror order must not shift the open pin's badge number — `PinListRow.index`'s own
 * JSDoc already documents this contract; this is the derivation that keeps it true.
 *
 * `visible` is the anchor-resolution signal spec §3.2 turns the "not visible in the current
 * render (hidden or removed)" row on: a pin is visible exactly when the displayed frame's own
 * render contains its element (`elementRects`, the flattened `layoutTree` reply). Passing
 * `null` — no reply yet for this frame — claims nothing either way and keeps every row in its
 * ordinary state, which is also what the preview draws while it waits.
 */
export function derivePinListRows(
  pins: readonly PinDtoV1[],
  elementRects: ElementRectIndex | null,
): readonly PinListRow[] {
  const openIndexByPinId = new Map(
    pins.filter((pin) => pin.status === "open").map((pin, index) => [pin.pinId, index] as const),
  );
  return pins.map((pin) => ({
    pin,
    // -1 for resolved pins: PinList never reads `index` for a resolved row (it renders `✓`).
    index: openIndexByPinId.get(pin.pinId) ?? -1,
    visible: elementRects === null || elementRects.has(pin.elementId),
  }));
}
