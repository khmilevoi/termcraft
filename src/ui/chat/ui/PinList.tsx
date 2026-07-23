import type { PinDtoV1 } from "core/protocol";
import { SHELL_PALETTE, shellAttrs } from "ui/theme";

const BOLD = shellAttrs({ bold: true });

/**
 * Design spec §3.2 (`docs/superpowers/specs/2026-07-13-termcraft-design.md:196-197`): the exact
 * marker copy a pin gets in the chat pin list when its anchor does not resolve in the current
 * render. Verbatim — no claim is made about the version, because a hidden element can reappear.
 */
const NOT_VISIBLE = "not visible in the current render (hidden or removed)";

/**
 * One row for {@link PinList} — a pin plus the presentation facts the mirror doesn't carry yet.
 */
export interface PinListRow {
  readonly pin: PinDtoV1;
  /** Matches the preview overlay's badge number (`index+1`) — the open pin's position among
   * open pins, not among all pins on the page. */
  readonly index: number;
  /**
   * Whether the pin's anchor resolves in the current render (host-render concern, §4.2 —
   * `rectOf`). The mirror carries no per-pin anchor-resolution signal yet (`PinDtoV1` has no
   * such field, and `pins.changed` never reports one); see `Workspace.tsx`'s call site for the
   * dormant-orphan divergence this MVP pass documents rather than fabricates.
   */
  readonly visible: boolean;
}

export interface PinListProps {
  readonly id: string;
  readonly pageSlug: string;
  readonly pins: readonly PinListRow[];
}

/**
 * The chat panel's pin list (design `design/08-pin-comments.dc.html`, engine `wsPins` +
 * `chatSeq`'s `e.pins` branch, `design/termcraft-engine.js:433-437,510-513`). Three row states:
 * - **open** — numbered inverse-amber badge (`badge()`: `fg:P.bg, bg:P.amber, bold:true`), dim text.
 * - **resolved** — green `✓` (not bold, per the engine's bare `put(...,{fg:P.green})` call),
 *   faint text.
 * - **orphan** (open, anchor unresolved) — amberDim `⚠` (also not bold in the engine source),
 *   faint text, plus the §3.2 marker copy verbatim.
 *
 * DIVERGENCE (plan sketch vs. engine source): the WP-9 task sketch marks both `✓` and `⚠` bold;
 * the engine's `put()` calls for those glyphs carry no `bold` key (only `badge()`'s numbered
 * open-pin mark sets `bold:true`). Followed the engine source — the design's ground truth per
 * CLAUDE.md — over the plan's sketch: `✓`/`⚠` render without the bold attribute.
 */
export function PinList(props: PinListProps) {
  if (props.pins.length === 0) return null;
  return (
    <box id={props.id} flexDirection="column">
      <text id={`${props.id}-head`} fg={SHELL_PALETTE.faint} attributes={BOLD}>
        {`PINS · ${props.pageSlug}`}
      </text>
      {props.pins.map((row) => {
        const rowId = `${props.id}-row-${row.pin.pinId}`;
        const resolved = row.pin.status === "resolved";
        const orphan = !resolved && !row.visible;
        return (
          // keyed intrinsic wrapper — function components carry no `key` in this repo's
          // no-@types/react environment; the row box takes it instead (matches ChatRecord).
          <box key={row.pin.pinId} id={rowId} flexDirection="row">
            {resolved ? (
              <text id={`${rowId}-mark`} fg={SHELL_PALETTE.green}>
                {"✓ "}
              </text>
            ) : orphan ? (
              <text id={`${rowId}-mark`} fg={SHELL_PALETTE.amberDim}>
                {"⚠ "}
              </text>
            ) : (
              <text
                id={`${rowId}-mark`}
                fg={SHELL_PALETTE.bg}
                bg={SHELL_PALETTE.amber}
                attributes={BOLD}
              >
                {String(row.index + 1)}
              </text>
            )}
            <text
              id={`${rowId}-text`}
              fg={resolved || orphan ? SHELL_PALETTE.faint : SHELL_PALETTE.dim}
            >
              {orphan ? ` ${row.pin.text} · ${NOT_VISIBLE}` : ` ${row.pin.text}`}
            </text>
          </box>
        );
      })}
    </box>
  );
}
