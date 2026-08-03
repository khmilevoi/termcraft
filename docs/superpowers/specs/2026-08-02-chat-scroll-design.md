# Scrollable chat message stream with history paging

Date: 2026-08-02
Status: implemented (2026-08-03) — see docs/superpowers/plans/2026-08-03-chat-scroll.md

## 1. The gap

The chat panel's message stream cannot be scrolled, and most of a chat's history cannot be
reached at all.

**Nothing scrolls.** `ChatScrollback` (`src/ui/chat/ui/ChatScrollback.tsx:111`) selects the
newest run of records that fits `maxRows` and summarises the rest into a single
`▲ N earlier messages` row. That row is inert: no key, no mouse gesture, and no code path
anywhere in `src/ui` changes which records are selected. Whatever the tail-fitting pass drops
is unreachable for the rest of the session.

**Most of the history is not even loaded.** The Kernel calls `handle.loadTail()` with no
arguments at all three of its call sites (`src/core/kernel/model/handlers/chat.ts:156`,
`handlers/project.ts:536`, `handlers/turn.ts:900`). The default is "the newest `limit` records
(default 100, max 200)" (`src/store/jsonl/model/chat-index.ts:595`). So the UI mirror holds at
most the newest 100 records of a chat regardless of how long it is.

**The wire is half-built for paging and unused.** `chat.records` already carries
`prevCursor` (`src/core/protocol/model/event-payload.ts:1715`), and the store port already
exposes `loadBefore` (`src/core/ports/chat-store.ts:53`) with a working fake
(`src/core/ports/fakes/chat-store.ts:162`). But the UI mirror drops `prevCursor` — it keeps
only `records` (`src/ui/mirror/model/mirror.ts:66`) — and no command exists to ask for an
older page: `command-kind.ts` declares only `chat.create` and `chat.switch` for chats. The one
consumer of `loadBefore` today is `resolveChatDisplayName`'s internal backward walk
(`src/core/chats/model/records.ts:145`).

## 2. Goals

1. The chat's message stream scrolls, by mouse wheel and by keyboard, over everything the
   client holds.
2. Reaching the top of the loaded history loads the previous page from disk, and continues
   until the chat's first record, so the entire history is reachable.
3. The stream follows the newest content while the user is at the bottom, and stops following
   the moment they scroll away from it.

### 2.1 Non-goals

- Search or jump-to-record within a chat.
- Text selection or copy-out of chat records.
- Scrolling any surface other than the chat message stream (the preview pane, the pin list,
  and every popup keep their current behavior).
- Rendering more than the active chat: the mirror still holds exactly one chat's records
  (`mirror.ts:60-66`), and switching chats still discards them.

## 3. Scope of the scrollable region

The scroll viewport owns the content of `ws-chat-stream` between the `● agent` presence line
and the pin list: `ChatScrollback`, the preview `SystemNotice`, and either `AgentStatusBlock`
(a running turn) or the collapsed terminal `ChatRecord` (a finished one).

Pinned, i.e. outside the viewport: the `● agent` line (panel header, not a message), `PinList`
(attached composer context — "2 open pins attached · sent next" — not a message), `Composer`,
the panel border, and every overlay.

## 4. The design gap and how it is closed

`CLAUDE.md` forbids inventing visual decisions. The design does not cover this case, and the
gap is not a detail:

- `▲ N earlier messages` (`design/termcraft-engine.js:569`) is a static mockup indicator drawn
  when the sequence overflows. It leads nowhere and has no scrolled state.
- No scrollbar is drawn anywhere in the shell. `@opentui/core`'s `<scrollbox>` draws one by
  default (`node_modules/@opentui/core/renderables/ScrollBar.d.ts`).
- §3.8 names no chat key in either hotkey tier.
- "Loading an older page", "that load failed", and "this is the start of the chat" are states
  the design could not have covered — paging did not exist.

**Resolution: a Claude Design brief, iteration 10**, written as the first implementation step
and following the established form of `design-prompts/claude-design-prompt-9.md` (untracked,
local-only directory in the main checkout; iterations 1–9 exist). Like iterations 6–9 it states
what happens functionally and which facts the runtime can supply, and leaves the visual answer
to the design.

### 4.1 The facts the brief may offer

- Whether older records exist on disk — known exactly (`prevCursor !== null`).
- **How many** older records exist — not on the wire today, but available: the chat index's
  entry count is the chat's total record count. §6.3 puts it on the wire, so the design may
  rely on an exact number rather than a vague "more".
- Whether an older page is being loaded right now, and whether that load failed (a short
  technical message, no absolute paths — the bound every failure surface in this project
  already respects).
- Whether the start of the chat has been reached.
- Whether the view is at the bottom of the stream — a boolean, refreshed on every scroll.
- Which keys may be bound: not bare letters (the composer is live and swallows printable
  characters — `keymap.ts`'s own `home-recheck` note, restated as "a bare letter is unusable in
  this pane" in iteration 9). `PgUp`/`PgDn` and C0 chords such as `ctrl+u`/`ctrl+d` are
  available; `ctrl+`-arrows are not — they were dead on the maintainer's terminal, which is why
  `page.prev`/`page.next` are `ctrl+b`/`ctrl+n` today (`src/ui/actions/model/registry.ts`).

The brief must **not** offer the count of records scrolled above the viewport edge. That number
is derivable but is deliberately never computed (§5.4), so offering it would let the design ask
for a label the implementation then has to refuse.

### 4.2 What the brief asks the design to define

1. The "older messages above" indicator — whether `▲ N earlier messages` keeps that role, and
   what it looks like once it is a reachable target rather than a summary.
2. Whether a "newer messages below" indicator exists, and what it is.
3. Whether a scrollbar is drawn, and if so what it looks like. If not, the native one is
   suppressed.
4. The loading state of an older page, and its failure state, as read inside the stream.
5. The start-of-chat marker, if any.
6. What the indicators do while a turn is running and the stream is growing from the bottom.
7. Whether the scroll keys appear in the status-bar key row (`page.prev`/`page.next` carry
   `hint: false` precisely because the design never drew them).

### 4.3 Explicitly not design work in this round

The paging protocol, the page size, sticky-to-bottom behavior, position retention, and every
other decision this spec makes.

## 5. UI architecture

### 5.1 The viewport

A `<scrollbox>` (`@opentui/react`'s `scrollbox` intrinsic, backed by `ScrollBoxRenderable`)
becomes the container of the message stream inside `ws-chat-stream`, configured `scrollY`,
`scrollX: false`, `stickyScroll`, `stickyStart: "bottom"`. Follow-the-tail and its
disengagement on manual scroll are the renderable's own behavior (`_hasManualScroll`,
`isAtStickyReengagePoint`); this project implements neither.

`ws-chat-stream` keeps `overflow="hidden"`. It is not a defensive extra — it is the design's own
clip (`Workspace.tsx:584-590`).

The scrollbar is suppressed unless design iteration 10 defines one.

### 5.2 What is removed

- `scrollbackMaxRows` (`src/ui/workspace/model/agent-block-budget.ts:80`) and its call site.
  The viewport clips; there is no row remainder to compute.
- `ChatScrollback`'s `maxRows` prop, `selectVisibleTail`, `recordRowCost`, `INDICATOR_ROWS`,
  and the inline `▲ N earlier messages` block. The component becomes a plain column of
  `ChatRecord`s over every loaded record.
- `recordToChatRecordProps` is unchanged. It is the one record-to-props mapping and is
  unaffected.

### 5.3 What is kept, and why

`agentStatusMaxRows` loses its sibling arithmetic (panel border, `● agent` line, pin rows,
composer rows) — that subtraction was overflow protection and the viewport now does that job.
`MAX_TIMELINE_ROWS = 11` stays: the 12-row cap is design semantics, not a consequence of
crowding. `design/03-workspace-generating.dc.html` states it outright — "The block is capped at
12 rows and folds from the top. The spinner row is pinned." — so the fold must not vary with
terminal size.

### 5.4 The `▲ N earlier messages` row becomes content, not an overlay

The indicator is rendered as the first row of the scroll content, and `N` counts records that
are **not loaded yet** (total minus loaded), not records scrolled out of view.

This is a deliberate simplification and it removes most of the risk in this design: the UI
never has to compute how many records lie above the viewport edge, and therefore never has to
read `scrollTop`/`scrollHeight` continuously to keep a label truthful. The row sits where the
design already draws it (the top of the chat sequence), it is what the user scrolls to, and
reaching it is what triggers the next page load. When the chat's start is reached, the row is
replaced by whatever §4.2.5 defines, or by nothing.

The "more below" indicator, if design defines one, depends only on a boolean — "not at the
bottom" — refreshed from the scroll handler, not on a continuous metric.

### 5.5 Keyboard

Two new entries in `UI_ACTIONS` (`src/ui/actions/model/registry.ts`): `chat.scroll-up` and
`chat.scroll-down`, canonical `PgUp`/`PgDn`, aliases `ctrl+u`/`ctrl+d`, `capability: null`,
`hint` per §4.2.7. Both are design extensions and are documented as such at the declaration,
in the form `page.prev`/`page.next` already use. Resolution runs through the existing
`keymap.ts` → `intent.ts` chain with no special case.

Scrolling is imperative and `intent.ts` is pure, so the two meet at a port. `ui/workspace`
declares a narrow `ChatViewport` interface — `scrollByPage(direction)`, `scrollToBottom()`,
`atBottom()`, `anchorFromBottom()`/`restoreAnchor(value)` — and `Workspace.tsx` publishes an
adapter over the `ScrollBoxRenderable` ref into the UI-local atom `local.chatViewport`.
`applyIntent` reads that atom and calls the method, exactly as it already calls `dispatcher`.
`intent.ts` stays testable without a renderer: tests substitute a fake viewport.

The composer's own keys are unaffected: `printableChar` (`keymap.ts:146-152`) accepts only a
single-character sequence, and `PgUp`/`PgDn` arrive as multi-character escape sequences.

## 6. History paging

### 6.1 Command

New command kind `chat.load-older` (`command-kind.ts`), payload `{ chatId, cursor }` where
`cursor` is the `ChatPageCursorDtoV1` the client last received (`command-payload.ts`),
capability target `{ chatId }` (`capability-target.ts`), modelled on `chat.switch`. The client
returns the cursor it was given; it never constructs one.

### 6.2 Event

New event kind `chat.records.older`, payload `{ chatId, records, prevCursor, failure }` where
`failure` is `FailureDtoV1 | null`. The mirror prepends `records`, updates the cursor, and
clears the loading latch.

A failure rides the same event rather than a separate kind: one nullable field is cheaper than
another event kind, and it retires the loading state by the same path success does.
`diagnostics.changed` is not the channel — it carries page and Gate diagnostics, not the
outcome of a UI-issued operation.

### 6.3 Store and port

`LoadResult` (`src/store/jsonl/types.ts:209`) gains the chat's total record count, taken from
the length of the chat index's `entries` array (`src/store/jsonl/model/chat-index.ts:283-300`,
built one entry per record). It is threaded through `ChatReader`/`ChatHandleV1`
(`src/core/ports/chat-store.ts:52`), the JSONL adapter (`src/store/adapters/chat-store.ts:39`),
the in-memory fake (`src/core/ports/fakes/chat-store.ts:154`), and onto `chat.records` and
`chat.records.older`. `N` in the top indicator is that total minus the number of loaded
records.

### 6.4 Kernel handler

`chat.load-older` is handled beside `loadActiveChatTail` (`handlers/chat.ts:145`): open the
chat, `loadBefore(cursor)`, publish `chat.records.older`. Every port call is `await wrap(...)`
(Reatom RTM-A04), as the rest of that file already is. A failure is reported in the event's
`failure` field and also logged (errore rule 21).

The Kernel holds no paging state. The accumulated window lives in the mirror.

### 6.5 The mirror merges instead of replacing

`chat.records` currently bulk-replaces (`mirror.ts:606`). With paging that would erase loaded
history on every turn completion — `handlers/turn.ts:900` reloads the tail after each turn, so
a window expanded three pages back would collapse on every agent reply.

The apply becomes a merge by `recordId`: incoming records supersede same-id records already
held and extend the list at the tail; anything loaded above is untouched. This is still one
`atom.set` with a new array, so the "bulk replace is `atom.set`" guidance is intact. The
existing clear-on-chat-switch (`mirror.ts:599`) and the stale-`chatId` fence
(`mirror.ts:604-606`) are unchanged and apply to the new event too.

The mirror gains `prevCursor` and the total count alongside `records`.

### 6.6 Trigger, retention, loading state

**Trigger.** On a scroll event: `scrollTop` at the top edge, `prevCursor !== null`, and no load
in flight → dispatch `chat.load-older`. A mouse-down on the indicator row triggers the same
dispatch; the panel already handles mouse (`Workspace.tsx` tab and preview handlers).

**Position retention.** Before dispatching, record `scrollHeight - scrollTop - viewportHeight`;
once the prepended records have rendered, restore `scrollTop` from that same distance. Whether
`<scrollbox>` preserves position across a prepend on its own is one of the questions §9's
validation step answers; if it does, this reduces to an assertion.

**Loading state.** UI-local atom `local.olderPage`: `"idle" | "loading" | { failure }`. Set to
`"loading"` before the dispatch, retired by `chat.records.older` in either outcome, and used as
the latch that prevents a second concurrent request.

`withAsync` is deliberately not used here, and the reason is worth stating because it is the
project's default (RTM-A02/A03): the operation does not complete when the dispatch promise
resolves — it completes when the event arrives. The dispatch promise only reports whether the
dispatcher itself refused, which is handled in the established `.then` form
(`intent.ts:126-130`).

## 7. Error handling

- **Page load failed** (open, `loadBefore`, or a refused dispatch): the stream shows the
  failure state design defines in §4.2.4, the latch clears, and `prevCursor` is left as it was
  so the load can be retried. No records are lost.
- **Dispatcher refusal** (capability unavailable, stale revision): identical treatment — the
  `.then` handler clears the latch and records the failure.
- **A stale page** for a chat the user has since switched away from is dropped by the existing
  `chatId` fence, and the switch has already cleared `records`.
- **Cursor and content disagree** (the chat file grew or was rewritten between pages): the
  merge is by `recordId`, so duplicates collapse rather than double up.

## 8. Testing

By layer, following the repository's existing split:

- `store/jsonl`: the total count reported by `loadTail`/`loadBefore`.
- `core/protocol`: schema round-trip for `chat.load-older` and `chat.records.older`.
- `core/kernel`: the handler's success and failure paths. The port fake already records
  `loadBefore` calls (`fakes/chat-store.ts:162`), so the cursor it was called with is
  assertable.
- `ui/mirror`: prepend, merge-by-id on a fresh tail, clear on chat switch, stale-`chatId`
  fence, cursor and count updates.
- `ui/actions` + `ui/app`: the two new hotkeys resolve to their intents, and `applyIntent`
  drives a fake `ChatViewport`.
- `ui/workspace`: rendered through `createHeadlessRenderer` — the scrollbox is present, content
  is clipped to the viewport, and the indicator row carries the right `N`.

**Known coverage gap, stated rather than faked:** the mouse-wheel path cannot be exercised
end-to-end, because `createHeadlessRenderer` is built with `useMouse: false`
(`src/host/render/model/renderer.ts`). The wheel handler is unit-tested; there is no test that
scrolls the real widget with a real wheel event.

## 9. Risks and validation

**`<scrollbox>` is unproven in this codebase.** Nothing in `src/` uses it today. It must be
validated before the rest of the work is built on it, as the first implementation task after
the design brief:

1. It renders through `createHeadlessRenderer` and its content is captured by `capture()`.
2. Content taller than the viewport is clipped, not overdrawn.
3. `stickyStart: "bottom"` holds the newest content and disengages on manual scroll.
4. The scrollbar can be suppressed without visual artifacts.
5. Prepending content above the current position — does the widget hold position, or must
   §6.6's anchor do it?

If that check fails, the fallback is a self-implemented row-window over a flattened stream with
the offset counted from the bottom. That approach was evaluated and rejected only on cost: it
requires `ChatRecord` and `AgentStatusBlock` to expose their rows as data so a partial record
can render, which is a substantial rendering refactor.

**Second risk: `agentStatusMaxRows` losing its subtraction changes an overflow guard that was
added deliberately** (its own doc records the defect it fixed — a long reply overwriting the
composer). The viewport replaces it, which is exactly why point 2 above must be verified before
the removal lands.

## 10. Files this touches

- `src/ui/chat/ui/ChatScrollback.tsx` — windowing removed, indicator row added.
- `src/ui/workspace/ui/Workspace.tsx` — the scrollbox, the viewport adapter, the paging trigger.
- `src/ui/workspace/model/agent-block-budget.ts` — `scrollbackMaxRows` removed,
  `agentStatusMaxRows` simplified.
- `src/ui/workspace/types.ts` — the `ChatViewport` port.
- `src/ui/actions/model/registry.ts`, `src/ui/app/model/keymap.ts`,
  `src/ui/app/model/intent.ts`, `src/ui/app/model/deps.ts` — the two scroll actions and the
  viewport atom.
- `src/ui/mirror/model/mirror.ts`, `src/ui/mirror/types.ts` — merge, prepend, cursor, count.
- `src/core/protocol/model/{command-kind,command-payload,capability-target,event-kind,event-payload}.ts`
  — the new command and event.
- `src/core/kernel/model/handlers/chat.ts` — the handler.
- `src/core/ports/chat-store.ts`, `src/core/ports/fakes/chat-store.ts`,
  `src/store/adapters/chat-store.ts`, `src/store/jsonl/types.ts`,
  `src/store/jsonl/model/chat-index.ts` — the total count.
- `design-prompts/claude-design-prompt-10.md` — the brief (untracked directory).
- `docs/architecture/` — updated where this changes documented structure.

## 11. Design iteration 10 answers

Recorded so the implementation reads one place, not the design tree, for its literals.
Each answer cites the `design/` file and line that now carries it.

1. **Older-messages indicator** — `▲ N earlier messages` keeps its exact wording and its role,
   but stops being a summary: it becomes the first row of the loaded content, a reachable
   target (scroll or mouse-down triggers the next page load). Drawn only while `N` (records not
   yet loaded) is nonzero — once every record is on the client but the buffer is still taller
   than the viewport, the row is not drawn at all, `design/28-chat-scroll.dc.html:43`,
   `design/termcraft-engine.js:1502` (`top.mode==='more'`).
2. **Newer-messages indicator** — none, by design. It reuses the pinned attach-row above the
   composer that §08 already draws pin-attach text into, literal text
   `▼ scrolled up · ^D follow latest`. Not a floating badge, never claims a count,
   `design/28-chat-scroll.dc.html:45`, `design/termcraft-engine.js:1525`
   (`o.following===false` branch).
3. **Scrollbar** — drawn: a 1-column scrollbar at the sequence's right edge. Track glyph `│`
   (`P.line`), thumb built from `█`/half-cell `▀`/`▄` colored `P.amberDim`, no end arrows,
   `design/28-chat-scroll.dc.html:44`, `design/termcraft-engine.js:1478-1484` (`scrollbar()`),
   called at `:1519`.
4. **Older-page loading state, and its failure state** — loading: the indicator row becomes
   `⠹ loading earlier messages…`, no count while in flight,
   `design/termcraft-engine.js:1504`. Failure: `✗ <short technical message>` (the same
   no-absolute-paths bound every failure surface here respects) plus a second line
   `PgUp retries` — no separate retry key, the same gesture that requested the page retries it,
   `design/28-chat-scroll.dc.html:46-47`, `design/termcraft-engine.js:1505-1506`.
5. **Start-of-chat marker** — `╌╌╌ start of chat ╌╌╌`, centered, faint (`P.faint`), no arrow: a
   dead end, not a target — nothing loads from reaching it, `design/28-chat-scroll.dc.html:47`,
   `design/termcraft-engine.js:1507`.
6. **Indicator behavior while a turn is running** — scrolling away and a running turn are
   independent: the live block still tails and folds exactly as §03 defines, unchanged, off the
   bottom of a viewport scrolled elsewhere. The same pinned-row banner slot is reused, just
   `P.amberHi` (insistent) with the wording `▼ turn running below · ^D follow latest` in place
   of the away-banner's `▼ scrolled up · ^D follow latest` — it can say a turn is running below,
   never how much it grew, `design/28-chat-scroll.dc.html:48`,
   `design/termcraft-engine.js:1602`.
7. **Status-bar key row** — the scroll keys DO appear: every one of the seven frames' own
   `wsStatus(...)` call lists `PgUp/PgDn` (labeled `'scroll'`, or `'scroll · retry'` in the
   failure state, `PgDn`-only at the start-of-chat state, since there is nothing above to page
   to), `design/28-chat-scroll.dc.html:46`, e.g. `design/termcraft-engine.js:1541,1557,1566,
   1576,1588,1605,1617`.
