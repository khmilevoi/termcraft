import type { PinDtoV1 } from "core/protocol";
import type { PinListRow } from "ui/chat";

/**
 * Builds `PinList`'s rows from the active page's pins (open + resolved). Numbers each open
 * pin's badge among OPEN pins only — matching `PreviewOverlays`' own numbering
 * (`ui/preview/ui/PreviewOverlays.tsx:21-25`: `pins.filter(status === "open").map((_, index) => …)`),
 * never the pin's position in the full (open+resolved) array. A resolved pin ahead of an open
 * one in mirror order must not shift the open pin's badge number — `PinListRow.index`'s own
 * JSDoc already documents this contract; this is the derivation that keeps it true.
 *
 * DIVERGENCE (M12 data-source gap, unchanged from the Task 3 wiring): the mirror carries
 * `PinDtoV1` but no per-pin anchor-resolution signal, so `visible` is `true` for every pin here
 * — dormant until a render-resolved element-id set reaches the mirror (see `Workspace.tsx`'s
 * call site for the full divergence note).
 */
export function derivePinListRows(pins: readonly PinDtoV1[]): readonly PinListRow[] {
  const openIndexByPinId = new Map(
    pins.filter((pin) => pin.status === "open").map((pin, index) => [pin.pinId, index] as const),
  );
  return pins.map((pin) => ({
    pin,
    // -1 for resolved pins: PinList never reads `index` for a resolved row (it renders `✓`).
    index: openIndexByPinId.get(pin.pinId) ?? -1,
    visible: true,
  }));
}
