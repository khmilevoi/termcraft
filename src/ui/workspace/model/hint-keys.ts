import { HOTKEYS } from "ui/actions";
import type { HotkeyAction } from "ui/actions";
import type { TurnMirror } from "ui/mirror";
import type { StatusBarHintKey } from "ui/status-bar";

import type { PreviewHalt } from "../types";
import type { FocusTarget } from "./focus";

function hotkeyGlyph(key: string): string {
  if (key === "ctrl+e") return "^E";
  if (key.startsWith("ctrl+")) return `Ctrl+${key.slice(5).toUpperCase()}`;
  // CORRECTED (review finding I5): a bare `.toUpperCase()` read `pageup`/`pagedown` as
  // `PAGEUP`/`PAGEDOWN` — two spellings of the same key on one screen, since
  // `ChatScrollback`'s own retry row already writes the design's literal `PgUp`
  // (`design/termcraft-engine.js:1505-1506`).
  if (key === "pageup") return "PgUp";
  if (key === "pagedown") return "PgDn";
  return key.toUpperCase();
}

/**
 * One hint entry, with the two reasons a key renders in the design's own `dis` state.
 *
 * ZONE (focus-scoped-hotkeys §8): a `chat`-scoped key while the zone is `preview` — and vice
 * versa — is visible but greyed, the same state this row already gives an inert key and a refused
 * `⏎ send`. The row's CONTENT is unchanged either way: the design's key row is a transcription of
 * `wsStatus`'s own rows, so which keys appear must not depend on where focus is. Only their state
 * does. This is deliberately NOT the rejected "hint row that changes with focus".
 */
function hotkeyHint(
  action: HotkeyAction,
  zone: FocusTarget,
  label = action.label,
): StatusBarHintKey {
  const foreignZone = action.scope !== "global" && action.scope !== zone;
  return action.inert === true || foreignZone
    ? [hotkeyGlyph(action.key), label, "dis"]
    : [hotkeyGlyph(action.key), label];
}

function fullscreenHint(label: string, zone: FocusTarget): readonly StatusBarHintKey[] {
  return HOTKEYS.filter((action) => action.id === "preview.fullscreen").map((action) =>
    hotkeyHint(action, zone, label),
  );
}

/**
 * The right-aligned hint keys for the current state (design `hintKeys` defaults). CORRECTED
 * (finding §2.5, phase-8 Task 16): the running branch used to append the F2 "full" hint after
 * "esc cancel" — the plainer `workspace(w,h,'gen')` screen's own key row
 * (`design/termcraft-engine.js:215`) does show F2, but the dedicated, more detailed generating
 * screens this task is about do not: `wsGenTyping` (`:275-276`) and `wsSlashTurn` (`:1005-1006`)
 * both draw the SAME exact pair, `keys:[['⏎','send','dis'],['esc','cancel']]` — a faint,
 * explicitly-disabled `⏎ send` alongside the live `esc cancel`, no F2 at all.
 */
export function hintKeys(
  turn: TurnMirror,
  fullscreen: boolean,
  previewHalt: PreviewHalt,
  // `following`/`atStart`/`olderPageFailed` (review finding I5): the chat-scroll key entries
  // this row derives from `HOTKEYS` all vary with the chat viewport's own state, not merely
  // with the four facts this function already took.
  chat: Readonly<{ following: boolean; atStart: boolean; olderPageFailed: boolean }>,
  zone: FocusTarget,
): readonly StatusBarHintKey[] {
  if (fullscreen) return fullscreenHint("windowed", zone);
  // design/termcraft-engine.js:1005-1006 (`wsSlashTurn`) / :275-276 (`wsGenTyping`).
  if (turn.phase === "running") {
    // CORRECTED (review finding I5): `wsScrollLive` (`design/termcraft-engine.js:1605`) is a
    // THIRD running-turn key row the citation above doesn't cover — scrolled away from a live
    // block that keeps growing off-screen below. Its row drops the disabled-send hint for the
    // scroll/follow trio instead: there is nothing to send toward (the turn already owns the
    // composer), but there IS somewhere to scroll back to.
    if (!chat.following) {
      return [
        ...HOTKEYS.filter(
          (action) => action.id === "chat.scroll-up" || action.id === "chat.scroll-down",
        ).map((action) => hotkeyHint(action, zone)),
        ...HOTKEYS.filter((action) => action.id === "chat.follow-latest").map((action) =>
          hotkeyHint(action, zone),
        ),
        ["esc", "cancel"],
      ];
    }
    return [
      ["⏎", "send", "dis"],
      ["esc", "cancel"],
    ];
  }
  // `preview.retry` and `preview.repair` are advertised ONLY where they actually act. Showing
  // them unconditionally would put a live-looking `F5 retry`/`F6 repair` in the status bar for
  // the entire session, for actions that do nothing in every other phase — the same "advertised
  // but inert" trap this file's own `dis` state and the `q`/`/exit` divergence exist to avoid.
  //
  // `F6` additionally requires the PAGE to be at fault: `wsHostUnavailable`'s own key row is
  // `F5 · F2 · F3` with no repair key at all, because no page edit could start a host.
  //
  // `chat.scroll-up`/`chat.follow-latest` are ALSO conditional (review finding I5): PgUp drops
  // at the true start of chat — `wsScrollStart`'s own key row is `PgDn`-only, there is nothing
  // above to page to — and `^D follow` draws only while `!following`, matching every mockup
  // that shows it (`wsScrollMid`/`wsScrollLive`; `wsScrollLoaded`/`wsScrollLoading`/
  // `wsScrollFailed`/`wsScrollStart` all omit it).
  return HOTKEYS.filter((action) => {
    // A key bound without being drawn (the page-step extension, `HotkeyAction.hint`) never
    // enters the row: this row is a transcription of the design's own key rows.
    if (action.hint === false) return false;
    if (action.id === "preview.retry") return previewHalt !== null;
    if (action.id === "preview.repair") return previewHalt?.designAtFault === true;
    if (action.id === "chat.scroll-up") return !chat.atStart;
    if (action.id === "chat.follow-latest") return !chat.following;
    return true;
  }).map((action): StatusBarHintKey => {
    if (action.id === "preview.retry" && previewHalt?.retryAvailable === false)
      // Both no-retry variants mark F5 `dis` in the key row.
      return [hotkeyGlyph(action.key), action.label, "dis"];
    // design/termcraft-engine.js:1505-1506 / `ChatScrollback`'s own "PgUp retries" row copy:
    // the SAME gesture that requested the failed page retries it. CORRECTED (final-review
    // Finding 3, focus-scoped-hotkeys, 2026-08-10): this branch used to return its custom
    // label directly, bypassing `hotkeyHint` and the zone-mismatch `dis` state it applies —
    // so "PgUp retries" stayed live even in the preview zone, where `chat.scroll-up` (`chat`
    // scope) does not actually act. Keep the custom label, but compute the state the exact same
    // way `hotkeyHint` does.
    if (action.id === "chat.scroll-up" && chat.olderPageFailed) {
      const foreignZone = action.scope !== "global" && action.scope !== zone;
      return foreignZone
        ? [hotkeyGlyph(action.key), "retries", "dis"]
        : [hotkeyGlyph(action.key), "retries"];
    }
    return hotkeyHint(action, zone);
  });
}
