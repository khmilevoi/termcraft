/**
 * Pure model helpers for the `/chats` popup (design `wsChats`,
 * `design/termcraft-engine.js:1010-1069`, and `design/24-chats.dc.html`). Kept out of
 * `ChatListPopup.tsx` so the component stays a thin renderer (§ code style) and so the
 * windowing/formatting math gets its own unit tests independent of the render tree.
 */

/**
 * The chats popup's fixed row capacity — design `wsChats`: `const cap=6`
 * (`design/termcraft-engine.js:1042`).
 */
export const CHAT_LIST_VIEWPORT_CAP = 6;

/** The slice of the full chat list the popup should render, plus the off-screen counts. */
export interface ChatListViewport {
  /** Index into the full list where the visible slice starts. */
  readonly start: number;
  /** Number of rows actually visible (== `total` when the list fits inside the cap). */
  readonly visibleCount: number;
  /** Count of rows above the visible slice — design's `▲ N earlier` row shows when > 0. */
  readonly before: number;
  /** Count of rows below the visible slice — design's `▼ N more` row shows when > 0. */
  readonly after: number;
}

/**
 * Derives the popup's scroll window purely from the full row count and the current selection —
 * `deps.local.chatSelection` (`ui/app/model/deps.ts`), which `chat-move`'s `wrapIndex`
 * (`ui/app/model/intent.ts:196`) can point anywhere across the FULL list, not just the visible
 * cap. The window keeps the selection centered within the cap whenever room allows, and clamps
 * to the list's start/end so it never scrolls past either edge — the design's own two static
 * mockups (`design/24-chats.dc.html`'s `ws-chats-120`/`ws-chats-overflow-120`) fix cap=6 and a
 * slice but never specify a follow formula (their `start`/`selAbs` are hardcoded demo state, not
 * a documented algorithm), so centered-clamp is the closest faithful "the selected row must
 * always be inside the window" behavior rather than an invented one.
 */
export function computeChatListViewport(params: {
  readonly total: number;
  readonly selectedIndex: number;
  readonly cap?: number;
}): ChatListViewport {
  const cap = Math.max(1, params.cap ?? CHAT_LIST_VIEWPORT_CAP);
  const total = Math.max(0, params.total);
  if (total === 0) return { start: 0, visibleCount: 0, before: 0, after: 0 };

  const visibleCount = Math.min(cap, total);
  const maxStart = total - visibleCount;
  const centered = params.selectedIndex - Math.floor((visibleCount - 1) / 2);
  const start = Math.min(Math.max(centered, 0), maxStart);

  return { start, visibleCount, before: start, after: total - (start + visibleCount) };
}

/**
 * The chats-popup label for a chat with no first user record yet (`ChatSummaryV1.displayName
 * === null`). Sourced from `wsChatFresh`'s OWN placeholder text —
 * `const ph1='new chat — fresh context'` (`design/termcraft-engine.js:1078`) — the design's
 * actual wording for an empty chat. The previous `chatId.slice(0, 8)` hex fragment cited "the
 * design's `chatId.slice(0, 8)` fallback"; that citation was false — `wsChats`'s fourteen sample
 * rows (`design/termcraft-engine.js:1026-1039`) are all descriptive names, and neither that
 * method nor `design/24-chats.dc.html` contains a hex-fallback row anywhere.
 */
export const FRESH_CHAT_LABEL = "new chat — fresh context";

/**
 * Formats a chat's `createdAt` (RFC-3339 UTC, `ChatSummaryV1.createdAt`) into the relative-time
 * vocabulary `wsChats`'s fourteen sample rows use verbatim
 * (`design/termcraft-engine.js:1026-1039`): `now`, `Nm ago`, `Nh ago`, `yesterday`, `Nd ago`,
 * `Nw ago`. Boundaries below reproduce every sample bucket exactly (now <1m, Nm ago 1-59m, Nh ago
 * 1-23h, yesterday 24-47h, Nd ago 2-6d, Nw ago >=7d — the design's oldest sample is `4w ago`;
 * weeks beyond that keep the same `Nw ago` pattern since the design specifies no upper cutoff,
 * the closest faithful extension rather than an invented format).
 *
 * `nowMs` is an explicit parameter, not `Date.now()`, so callers can inject a deterministic
 * clock (this repo has no shared clock port to thread through — see `ui/app/ui/App.tsx`'s own
 * `clock` prop).
 */
export function formatChatWhen(createdAt: string, nowMs: number): string {
  const createdMs = Date.parse(createdAt);
  if (Number.isNaN(createdMs)) {
    // Never fabricate a relative time for a timestamp that isn't one. CORRECTED (review): this
    // used to return `"now"`, which is itself an assertion of freshness the runtime has no
    // basis for — the same class of invented user-visible fact this module's own
    // {@link FRESH_CHAT_LABEL} exists to undo. An em-dash says "unknown" and says nothing else.
    // Defensive only: `ChatSummaryV1.createdAt` is validated by `rfc3339UtcSchema` on the wire.
    console.warn(`formatChatWhen: "${createdAt}" is not a valid ISO-8601 timestamp`);
    return "—";
  }

  const diffMs = Math.max(0, nowMs - createdMs);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(diffMs / 3_600_000);
  if (hours < 24) return `${hours}h ago`;
  if (hours < 48) return "yesterday";

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;

  const weeks = Math.floor(days / 7);
  return `${weeks}w ago`;
}
