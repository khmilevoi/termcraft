import type { PinDtoV1 } from "core/protocol";
import type { SelectionMirror } from "ui/mirror";
import type { ShellToken } from "ui/theme";

/**
 * Everything {@link deriveComposerAttach} needs (design `wsSelect`'s `chip` + `wsPins`'
 * `attach` line, `design/termcraft-engine.js` `chatSeq:443-448`). Pure — keeps the priority
 * logic testable without a renderer, mirroring how `tabs.ts` splits derivation from painting.
 */
export interface ComposerAttachInput {
  readonly readOnly: boolean;
  readonly selection: SelectionMirror;
  /** The active page's pins (open + resolved); only `status: "open"` counts toward the line. */
  readonly openPins: readonly PinDtoV1[];
}

/**
 * Derives the Composer's single meta line (design §3.1/§3.2), priority read-only → selection →
 * open pins → none:
 * - **read-only** — the existing `read-only — Send disabled` line, `SHELL_PALETTE.red`.
 * - **selection present** — the design `wsSelect` chip (`chipTag`, glyph `▣`), e.g. `▣ gauge-cpu`.
 * - **no selection, open pins present** — `N open pins attached · sent next`, `amberHi` bold
 *   (`wsPins`' `attach` line, `chatSeq:447`).
 * - **none of the above** — `null` (Composer hides the line).
 *
 * DIVERGENCE: `Composer`'s `attach` prop renders one plain meta line (`{ text; fg }`); the
 * design's `chipTag` paints the selection chip as two tones on its own `sel` background (glyph
 * `P.amber`, text `P.selFg` bold, both on `bg:P.sel`) — a dedicated chip band, not a plain text
 * line. This MVP pass collapses that two-tone chip band onto the same single-line `attach` slot
 * Composer already has, using `selFg` for the whole line; the chip's own `sel` background and
 * the glyph's distinct `amber` tint are not reproduced (`Composer.tsx` renders `attach` as plain
 * foreground text, no background token on that prop).
 */
export function deriveComposerAttach(
  input: ComposerAttachInput,
): Readonly<{ text: string; fg: ShellToken }> | null {
  if (input.readOnly) return { text: "read-only — Send disabled", fg: "red" };
  if (input.selection !== null) return { text: `▣ ${input.selection.elementId}`, fg: "selFg" };
  const open = input.openPins.filter((pin) => pin.status === "open");
  if (open.length > 0)
    return { text: `${open.length} open pins attached · sent next`, fg: "amberHi" };
  return null;
}
