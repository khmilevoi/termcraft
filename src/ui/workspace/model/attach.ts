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
  /**
   * The workspace's active page slug. `selection` is only used when it matches this — see the
   * page-scoping DIVERGENCE note below.
   */
  readonly activePageSlug: string | null;
  /** The active page's pins (open + resolved); only `status: "open"` counts toward the line. */
  readonly openPins: readonly PinDtoV1[];
  /**
   * Whether a turn is currently `running` (finding §2.5, phase-8 Task 16) — feeds the two
   * turn-time attach lines below. See {@link deriveComposerAttach}'s own doc comment for the
   * exact design sources; both are distinct screens, not one generic "a turn is running" line.
   */
  readonly turnRunning: boolean;
  /**
   * The composer's current draft text. Only its emptiness and its `/`-prefix are read here —
   * `intent.ts`'s `slash-open` is the only path that ever sets the composer to a string starting
   * with `/`, so this is a reliable proxy for "the slash menu is open" without threading the
   * overlay atom into a function that is otherwise pure UI-state derivation.
   */
  readonly composerValue: string;
}

/**
 * Derives the Composer's single meta line (design §3.1/§3.2), priority read-only → selection →
 * open pins → turn-time line → none:
 * - **read-only** — the existing `read-only — Send disabled` line, `SHELL_PALETTE.red`.
 * - **selection present** — the design `wsSelect` chip (`chipTag`, glyph `▣`), e.g. `▣ gauge-cpu`.
 * - **no selection, open pins present** — `N open pins attached · sent next`, `amberHi` bold
 *   (`wsPins`' `attach` line, `chatSeq:447`).
 * - **no selection/pins, a turn is running, and `/` is the local-command prefix** —
 *   `send refused — / still runs commands`, `amberHi` (`wsSlashTurn`,
 *   `design/termcraft-engine.js:988-999`, the `:998` `attach` literal — "the menu opened during
 *   a turn... / still opens local command mode").
 * - **no selection/pins, a turn is running, and there is a non-slash draft** —
 *   `⏎ send disabled — draft kept`, `amberHi` (`wsGenTyping`,
 *   `design/termcraft-engine.js:259-277`, the `:268` `attach` literal — its own comment: "the
 *   composer holding a draft while the turn runs. The input is alive... and the refusal lives
 *   above it"; prose confirmed at `design/03-workspace-generating.dc.html`'s `ws-gen-typing-120`
 *   paragraph: "Holding a draft it looks alive, because it is... the line above the caret reads
 *   ⏎ send disabled — draft kept").
 * - **no selection/pins, a turn is running, and the composer is empty** — `null`. The design's
 *   plainer `workspace(w,h,'gen')`/`drawChat` path (`:198-256`) shows no attach line at all for
 *   this state, only the faint placeholder — matching the same `03-workspace-generating.dc.html`
 *   prose: "Empty, it shows the faint ❯ generating… esc to cancel placeholder with no caret."
 * - **none of the above** — `null` (Composer hides the line).
 *
 * DIVERGENCE: `Composer`'s `attach` prop renders one plain meta line (`{ text; fg }`); the
 * design's `chipTag` paints the selection chip as two tones on its own `sel` background (glyph
 * `P.amber`, text `P.selFg` bold, both on `bg:P.sel`) — a dedicated chip band, not a plain text
 * line. This MVP pass collapses that two-tone chip band onto the same single-line `attach` slot
 * Composer already has, using `selFg` for the whole line; the chip's own `sel` background and
 * the glyph's distinct `amber` tint are not reproduced (`Composer.tsx` renders `attach` as plain
 * foreground text, no background token on that prop). The engine also paints both of these
 * lines BOLD: `chipTag`'s chip text (`termcraft-engine.js:380`,
 * `this.text(...,{fg:P.selFg,bg:P.sel,bold:true})`) and `chatSeq`'s "N open pins attached" line
 * (`termcraft-engine.js:447`, `this.ctext(...,{fg:o.attachFg||P.amberHi,bold:true},maxX)`) — a
 * third dropped attribute `Composer`'s plain `attach` line shares with the two above (it renders
 * with no `attributes` at all, `Composer.tsx`'s `-attach` text node), not just the `sel`
 * background and the glyph's `amber` tint.
 *
 * DIVERGENCE (plan sketch vs. page-scoping, fixed deliberately): the plan's original sketch
 * consumed `mirror.selection()` unfiltered — but the mirror only clears `selection` on a fresh
 * `kernel.snapshot` (`mirror.ts`'s `kernel.snapshot` case), never on a page switch. Left
 * unfiltered, a selection made on page A would still chip page B's composer after switching
 * pages with no intervening snapshot — the sibling open-pins branch IS already page-scoped (its
 * `openPins` are the caller's per-page slice, `mirror.pinsByPage().get(activePageSlug)`), so
 * selection was the one latent gap. `activePageSlug` is threaded into this input the same way
 * pins already are, and the selection branch only fires when `selection.pageSlug` matches it;
 * a same-page-mismatch selection falls through to the open-pins line, exactly like no selection.
 */
export function deriveComposerAttach(
  input: ComposerAttachInput,
): Readonly<{ text: string; fg: ShellToken }> | null {
  if (input.readOnly) return { text: "read-only — Send disabled", fg: "red" };
  const selectionOnActivePage =
    input.selection !== null && input.selection.pageSlug === input.activePageSlug
      ? input.selection
      : null;
  if (selectionOnActivePage !== null)
    return { text: `▣ ${selectionOnActivePage.elementId}`, fg: "selFg" };
  const open = input.openPins.filter((pin) => pin.status === "open");
  if (open.length > 0)
    return { text: `${open.length} open pins attached · sent next`, fg: "amberHi" };
  if (!input.turnRunning) return null;
  if (input.composerValue.startsWith("/"))
    return { text: "send refused — / still runs commands", fg: "amberHi" };
  if (input.composerValue.length > 0)
    return { text: "⏎ send disabled — draft kept", fg: "amberHi" };
  return null;
}
