# WP-9 — Complete the UI (JIT plan)

> **For agentic workers:** Execute this plan with
> **superpowers:subagent-driven-development** — one task per gap, in the order
> below, each as its own TDD cycle and commit. Do not batch tasks. Every task's
> **first step is to read its named `design/*.dc.html` screen** (and the engine
> draw method it calls) so the glyphs, colors, and copy are taken from the design,
> never invented. Tasks 1–7 are runnable now; **Task 8 (M11) is BLOCKED** until
> WP-10 lands its chat-record transport — schedule it last.

**Goal:** Close the eight WP-9 UI gaps (M12, M13, M14, M15, M22, m4, m5 now; M11
blocked) so the chat panel, composer, export popup, Home health, chat-list popup,
and tab strip match design §3.1/§3.2/§3.7 and the agent identity is data-driven.

**Architecture:** The `ui` module is two Reatom graphs — the Kernel-fed read-model
(`ui/mirror`, one atom per event slice) and UI-local presentation atoms
(`ui/app` `UiLocalState`) — rendered by `reatomComponent` trees over OpenTUI. `ui`
sees only `core/protocol` closed DTOs plus `PreviewSession`; it imports no Kernel
atoms and no `core/capabilities` internals. Every visual value is sourced from
`design/termcraft-engine.js` (`pal`) and the `design/*.dc.html` screens; component
tests drive a headless renderer (`host/render`) and assert captured styled runs.

**Tech Stack:** TypeScript 7.0.2 on Bun ≥1.3.14, `@opentui/core`+`@opentui/react`
0.4.5, `@reatom/core` ^1001.1.0 + `@reatom/react` ^1001.0.0, `errore` ^0.14.1,
`zod` ^4.4.3, `react` ^19.2.7 (used only for its `act` re-render boundary in tests).

## Global Constraints

Binding for every task; inherited verbatim from
`.superpowers/sdd/closeout-global-constraints.md` and WP-9's own constraints.

- `bun test` and `bun x tsc --noEmit` are green at every task boundary. Baseline:
  2582 tests pass, 0 fail; `tsc --noEmit` exits 0. Before closing, `bun run lint`
  and `bun run fmt:check` are also green and `git diff --check` is clean.
- **errore is mandatory**: namespace import (`import * as errore from "errore"`),
  errors as values (`Error | T`), `createTaggedError` for domain errors,
  `.catch()` / `errore.try` only at boundaries with uncontrolled code, flat
  control flow, one-line `instanceof Error` early returns, always pass `cause`.
- **Reatom v1001 rules**: named atoms/computeds/actions; `wrap(...)` at every async
  boundary; `withComputed`/`withAsync`/`withAsyncData` over manual flags or React
  effects; no identity setter actions; group one event's writes in a single named
  mirror function (RTM-S04), never scatter `atom.set` across components.
- **Design is the source of truth**: colors/glyphs/layout come from
  `design/termcraft-engine.js` (`pal` / `lightPal()`) and `design/*.dc.html`. Never
  invent a value; document any unavoidable divergence in a code comment.
- **No type-laundering casts**: every mirror value type is derived from
  `core/protocol`'s closed DTOs (mostly by indexed access into
  `EventPayloadByKindV1`) so a contract change surfaces as a compile error, not
  silent drift. Never `as`-cast across the closed unions to bypass them; no `any`.
- **Module DAG**: `ui` sees only core boundary types + `PreviewSession`; never
  `core/capabilities` internals; cross-module imports use the `tsconfig` path
  aliases (`ui/*`, `core/*`, …), never a relative path climbing out of the module.
- **All code, comments, commit messages and docs in English.**
- Commits are frequent and per task, `feat(ui):` / `fix(ui):` / `test(ui):`
  prefixed, each ending with the Claude co-author trailer:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. All git goes through the
  `rtk` prefix (`rtk git add`, `rtk git commit`).
- **Snapshot/render tests wrap Reatom writes in `act()` (Spike D):** any atom write
  performed *after* a component is mounted must run inside `renderer.act(() => …)`
  (the react renderer's `act`, per `ui/testing`'s `react-renderer`), or the frame
  never re-renders and the assertion silently passes against stale output. Writes
  performed *before* `handle.mount(...)` need no `act`.
- **Out of scope (do not build):** `/model` picker, agent/model/effort selection,
  light theme, Tweaks (`F3` inert), interactive input (`F4` inert), chat
  rename/deletion/AI titles. Codex is not the shipped backend — MVP ships Claude
  only (see M22).

## Dependencies and landed state

- **M22 snapshot field — ALREADY LANDED (verify, then consume).**
  `AgentIdentityV1` and `kernel.snapshot`'s `agentIdentity` field exist today in
  `src/core/protocol/model/event-payload.ts`:

  ```ts
  // event-payload.ts:571
  export type AgentIdentityV1 = Readonly<{ backendId: string; modelLabel: string }> | null;
  // event-payload.ts:594-605 — KernelSnapshotPayloadV1
  readonly agentIdentity: AgentIdentityV1;
  ```

  The **type** is closed and re-exported through `core/protocol`; the **kernel does
  not emit a non-null value yet** (WP-1 wired the field into the DTO under M21 but
  the production kernel/AgentRegistry binding that fills it is a later package). So
  Task 7 (M22) can bind the UI to `agentIdentity` and rely on `tsc`, but at runtime
  the value is `null` until the kernel emits it — the UI must handle `null` without
  inventing a fallback identity.

- **M11 record DTO — BLOCKED on WP-10.** Task 8 renders the agent's *persisted*
  final message as a chat record. That record does not cross the UI↔Kernel seam
  today: `EVENT_KINDS_V1` carries no message/record kind and `ui/mirror` has no
  record type. WP-10 ("Give chat history a transport") introduces exactly that —
  its first task settles the DTO-vs-event-kind choice against the
  kernel-command-contract's closed-union rules. Task 8 consumes that decision's
  output (named precisely in the task), so it cannot start until WP-10 lands.

---

## Task 1 — m5: render tab-strip overflow indicators

The `‹ ›` scroll indicators are computed (`tabsOverflow` in
`src/ui/workspace/model/tabs.ts:45`) and unit-tested, but `renderTabs`
(`Workspace.tsx:75`) never paints them.

**Design screen (read first):** `design/18-tab-management.dc.html` → engine
`drawTabs` / the `o.scroll` branch in `design/termcraft-engine.js`. The indicators
are the faint `‹`/`›` glyphs flanking the strip when the summed tab widths exceed
the strip width; active tab stays `▸ name` amber-bold, inactive `dim`, ghost `faint`.

**Files:**
- Modify: `src/ui/workspace/ui/Workspace.tsx` — `renderTabs(tabs)` gains the strip
  width and paints leading/trailing `‹`/`›` when `tabsOverflow(tabs, width)` is true.
- Test: `src/ui/workspace/ui/Workspace.test.tsx` — add an overflow case.

**Interfaces:**
- Consumes: `deriveTabs(descriptors, activePageSlug, ghostSlug): readonly TabEntry[]`,
  `tabsOverflow(tabs: readonly TabEntry[], width: number): boolean` (both from
  `../model/tabs`). `SHELL_PALETTE.faint` for the indicators (design `o.scroll` uses
  the faint band).
- Produces: no new exports — the change is render-only.

**Steps:**
- [ ] Read `design/18-tab-management.dc.html` and the `drawTabs` `o.scroll` branch;
      confirm the indicator glyphs (`‹` / `›`) and the faint color.
- [ ] Write a failing test: mount `Workspace` at a narrow width with enough ready
      page descriptors that `tabsOverflow` is true; assert the captured tab row
      contains `‹` and `›` at `SHELL_PALETTE.faint`. Apply the snapshot before mount
      (no `act` needed).
- [ ] Run `bun test src/ui/workspace/ui/Workspace.test.tsx` — expect FAIL (no `‹`/`›`).
- [ ] Implement: thread the strip width into `renderTabs` and wrap the mapped tabs
      with the indicators:

      ```tsx
      function renderTabs(tabs: readonly TabEntry[], width: number) {
        const overflow = tabsOverflow(tabs, width);
        return (
          <box id="ws-tabs" flexDirection="row">
            {overflow && (
              <text id="ws-tabs-scroll-left" fg={SHELL_PALETTE.faint}>{"‹ "}</text>
            )}
            {tabs.map((tab) => (
              /* unchanged active/dim/ghost painting */
            ))}
            {overflow && (
              <text id="ws-tabs-scroll-right" fg={SHELL_PALETTE.faint}>{" ›"}</text>
            )}
          </box>
        );
      }
      ```
      Call site: `renderTabs(tabs, w - chatW)` (the preview column width, matching
      the width the tab strip actually occupies).
- [ ] Run `bun test src/ui/workspace` + `bun x tsc --noEmit` — expect PASS / exit 0.
- [ ] Commit `feat(ui): render the tab-strip overflow indicators`.

---

## Task 2 — m4: sort chat-list popup rows newest-first

The `/chats` rows are built in `App.tsx renderOverlay` (`App.tsx:32`) by mapping
`chats.summaries.values()` in insertion order. Design `wsChats` lists newest-first.

**Design screen (read first):** `design/24-chats.dc.html` → engine `wsChats`. Rows
descend by recency (the active/most-recent chat at the top), each row `● / ○` dot +
label + `WHEN` column; the exact glyphs/colors already live in `ChatListPopup.tsx`.

**Files:**
- Modify: `src/ui/app/ui/App.tsx` — sort the rows by `createdAt` descending before
  mapping to `ChatListRow`. Keep the ordering in one place so the popup selection
  index (`local.chatSelection`) and `chat-move`/`chat-switch` intents agree.
- Test: `src/ui/popups/ui/ChatListPopup.test.tsx` **or** a new `App.test.tsx` case —
  assert the first rendered row is the newest summary.

**Interfaces:**
- Consumes: `ChatSummary = EventPayloadByKindV1["chat.changed"]["added"][number]`
  (carries `chatId`, `createdAt`); `ChatListRow` (`{ chatId, label, when, active }`).
- Produces: no new exports.

**Decision to record in the commit body:** `intent.ts`'s `chat-move`/`chat-switch`
read `deps.mirror.chats().summaries.values()` in **insertion order** (`intent.ts:107`).
Sorting only in `App.tsx` would desync the rendered row order from the index those
intents resolve. Sort once in a shared helper the overlay and both intents call, or
keep the sorted array the single source the selection indexes into. The failing test
must cover the index/row agreement, not only the visual order.

**Steps:**
- [ ] Read `design/24-chats.dc.html` / `wsChats`; confirm newest-first ordering and
      that `createdAt` is the recency key on `ChatSummary`.
- [ ] Write a failing test: seed three `chat.changed` summaries with ascending
      `createdAt`, open the chat-list overlay, assert the top row is the newest and
      that `↑/↓` selection + `⏎` switch target the same newest chat.
- [ ] Run `bun test` for the touched files — expect FAIL (insertion order).
- [ ] Implement a `sortChatSummariesNewestFirst(summaries)` helper (pure, in a
      shared spot both `App.tsx` and `intent.ts` import — e.g. a small model file
      under `ui/mirror` or `ui/popups` model) and route the overlay rows and the
      `chat-move`/`chat-switch` index through it.
- [ ] Run `bun test src/ui/app src/ui/popups` + `bun x tsc --noEmit` — PASS / exit 0.
- [ ] Commit `fix(ui): sort chat-list rows newest-first`.

---

## Task 3 — M12: list pins in the chat panel

Pins are computed in `Workspace.tsx:217` but only handed to `PreviewOverlays` as
badges; they are never listed in the chat panel. Add a `PinList` to the chat column.

**Design screen (read first):** `design/08-pin-comments.dc.html` (`ws-pins-120` /
`ws-pins-80`) → engine `wsPins` (`design/termcraft-engine.js:503`) and its
`chatSeq` pin rows (`termcraft-engine.js:433-437`). Marker copy is **normative in
the design spec §3.2** (`docs/superpowers/specs/2026-07-13-termcraft-design.md:196-197`):
a pin whose anchor does not resolve stays in the chat pin list marked
`"not visible in the current render (hidden or removed)"`.

Design-sourced row treatment (from `chatSeq`):
- Section header: `PINS · main` — `SHELL_PALETTE.faint`, bold.
- Open pin (anchor resolves): numbered badge (inverse `fg=bg`, `bg=amber`, bold,
  the same `index+1` numbering `PreviewOverlays` paints), text `SHELL_PALETTE.dim`.
- Resolved pin (`status === "resolved"`): `✓` glyph `SHELL_PALETTE.green`, text
  `SHELL_PALETTE.faint`.
- Orphan pin (anchor unresolved): `⚠` glyph `SHELL_PALETTE.amberDim`, text
  `SHELL_PALETTE.faint`, plus the §3.2 marker copy.

**Files:**
- Create: `src/ui/chat/ui/PinList.tsx` — the component.
- Create: `src/ui/chat/ui/PinList.test.tsx` — the test.
- Modify: `src/ui/chat/index.ts` — export `PinList` and `PinListRow`.
- Modify: `src/ui/workspace/ui/Workspace.tsx` — render `<PinList>` in the chat
  stream (`ws-chat-stream`) above the composer, fed by the already-computed `pins`.

**Interfaces:**
- Consumes: `PinDtoV1` (`core/protocol`) —
  `{ pinId, pageSlug, elementId, fx, fy, text, status: "open" | "resolved", … }`.
- Produces: `PinList(props: PinListProps)` where
  `PinListProps = { id: string; pageSlug: string; pins: readonly PinListRow[] }`
  and `PinListRow = { pin: PinDtoV1; index: number; visible: boolean }` (`visible`
  = whether the pin's anchor resolves in the current render).

**Data-source note / divergence (flag, do not invent):** the mirror carries
`PinDtoV1` but **no per-pin anchor-resolution signal** — `pins.changed` reports
persisted pins; anchor resolution is a host-render concern (`rectOf`, §4.2) and
`PreviewOverlays` today places every open pin by fraction (never marks orphans). So
`visible` has no kernel source yet. Implement the full three-state row/marker
structure and have `Workspace` pass `visible: true` for every open pin in this MVP
pass (matching the always-drawn badges), with a code comment stating that the
`"not visible in the current render"` marker is design-complete but dormant until a
render-resolved element-id set reaches the mirror. This keeps the design copy exact
and the gap explicit rather than fabricating a resolution signal.

**Steps:**
- [ ] Read `design/08-pin-comments.dc.html`, `wsPins`, and `chatSeq:433-437`; read
      spec §3.2 lines 194-199 for the marker copy verbatim.
- [ ] Write a failing test: mount `PinList` with three pins — one open (numbered),
      one `status:"resolved"`, one open+`visible:false` — and assert the numbered
      badge (`index+1`, inverse amber), the `✓` green resolved row, and the `⚠`
      amberDim orphan row carrying `not visible in the current render (hidden or
      removed)`. Colors via `extractRgb`, as `ChatListPopup.test.tsx` does.
- [ ] Run `bun test src/ui/chat/ui/PinList.test.tsx` — expect FAIL (module missing).
- [ ] Implement `PinList.tsx`:

      ```tsx
      import type { PinDtoV1 } from "core/protocol";
      import { SHELL_PALETTE, shellAttrs } from "ui/theme";

      const BOLD = shellAttrs({ bold: true });
      // Design spec §3.2 (2026-07-13-termcraft-design.md:196-197): the exact marker a
      // pin gets in the chat pin list when its anchor does not resolve in the current
      // render. Verbatim — no version claim is made (a hidden element can reappear).
      const NOT_VISIBLE = "not visible in the current render (hidden or removed)";

      export interface PinListRow {
        readonly pin: PinDtoV1;
        readonly index: number; // matches the preview badge number (index+1)
        readonly visible: boolean; // anchor resolves in the current render
      }
      export interface PinListProps {
        readonly id: string;
        readonly pageSlug: string;
        readonly pins: readonly PinListRow[];
      }

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
                // keyed intrinsic wrapper — function components carry no `key` here.
                <box key={row.pin.pinId} id={rowId} flexDirection="row">
                  {resolved ? (
                    <text id={`${rowId}-mark`} fg={SHELL_PALETTE.green} attributes={BOLD}>{"✓ "}</text>
                  ) : orphan ? (
                    <text id={`${rowId}-mark`} fg={SHELL_PALETTE.amberDim} attributes={BOLD}>{"⚠ "}</text>
                  ) : (
                    <text id={`${rowId}-mark`} fg={SHELL_PALETTE.bg} bg={SHELL_PALETTE.amber} attributes={BOLD}>
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
      ```
- [ ] Run the test — expect PASS.
- [ ] Wire into `Workspace.tsx` chat stream (below `ws-chat-agent`, above the
      terminal record / composer), passing the open+resolved pins with
      `visible: true` and a comment naming the dormant-orphan divergence:

      ```tsx
      <PinList
        id="ws-pins"
        pageSlug={project.activePageSlug ?? ""}
        pins={pins.map((pin, index) => ({ pin, index, visible: true }))}
      />
      ```
- [ ] Run `bun test src/ui/chat src/ui/workspace` + `bun x tsc --noEmit` — green.
- [ ] Commit `feat(ui): list pins in the chat panel`.

---

## Task 4 — M13: derive the composer attach chip from selection and pins

`Workspace.tsx:310` only ever passes the read-only attach line; a live selection or
open pins never produce the design's selection chip / pins-attached line.

**Design screen (read first):** `design/07-selection-hover.dc.html` (`ws-select-120`
→ engine `wsSelect`, `termcraft-engine.js:479`) for the selection chip, and
`design/08-pin-comments.dc.html` (`wsPins`) for the pins-attached line. From
`chatSeq` (`termcraft-engine.js:443-448`):
- Selection present → **chip** `chipTag` (glyph `▣`, `SHELL_PALETTE.amber`; text
  `SHELL_PALETTE.selFg` bold on `SHELL_PALETTE.sel`), copy `wsSelect` = the element
  name, e.g. `gauge "CPU"`.
- Open pins present (no selection) → **attach line** `2 open pins attached · sent
  next`, `SHELL_PALETTE.amberHi` bold.
- Read-only → the existing `read-only — Send disabled` line, `SHELL_PALETTE.red`.

`Composer` already accepts `attach?: { text; fg: ShellToken } | null`
(`Composer.tsx:13`). MVP maps the design's dedicated `chip` band onto the same
`attach` prop (Composer renders one meta line above the input) — document that the
chip-vs-attach visual split from `chatSeq` collapses to one line here.

**Files:**
- Modify: `src/ui/workspace/ui/Workspace.tsx` — replace the `attach={props.readOnly
  ? … : null}` literal with a derived value from `mirror.selection()` and
  `mirror.pinsByPage()`.
- Create: `src/ui/workspace/model/attach.ts` + `attach.test.ts` — the pure
  derivation (keeps the priority logic testable without a renderer, mirroring how
  `tabs.ts` splits derivation from painting).
- Modify: `src/ui/workspace/index.ts` — export the derivation.
- Test: extend `Workspace.test.tsx` for the rendered outcomes.

**Interfaces:**
- Consumes: `SelectionMirror = SelectionChangedPayloadV1 = SelectionDtoV1 | null`
  (`{ pageSlug, elementId, sourceHash } | null`); the active page's
  `readonly PinDtoV1[]` (open pins); `readOnly: boolean`; `ShellToken`.
- Produces: `deriveComposerAttach(input): { text: string; fg: ShellToken } | null`
  with priority read-only → selection → open-pins → null.

**Steps:**
- [ ] Read `wsSelect`, `wsPins`, and `chatSeq:443-448`; confirm the chip glyph/colors
      and the exact `N open pins attached · sent next` copy.
- [ ] Write failing tests for `deriveComposerAttach`: (a) read-only wins → red line;
      (b) selection present → `▣ <elementId>` chip text at `selFg`/amber; (c) no
      selection but 2 open pins → `2 open pins attached · sent next` at amberHi;
      (d) nothing → `null`.
- [ ] Run `bun test src/ui/workspace/model/attach.test.ts` — expect FAIL.
- [ ] Implement the pure derivation:

      ```ts
      import type { PinDtoV1, SelectionChangedPayloadV1 } from "core/protocol";
      import type { ShellToken } from "ui/theme";

      export interface ComposerAttachInput {
        readonly readOnly: boolean;
        readonly selection: SelectionChangedPayloadV1;
        readonly openPins: readonly PinDtoV1[];
      }
      export function deriveComposerAttach(
        input: ComposerAttachInput,
      ): { readonly text: string; readonly fg: ShellToken } | null {
        if (input.readOnly) return { text: "read-only — Send disabled", fg: "red" };
        if (input.selection !== null)
          // design wsSelect chip → Composer's single meta line (chip band collapses to attach).
          return { text: `▣ ${input.selection.elementId}`, fg: "selFg" };
        const open = input.openPins.filter((pin) => pin.status === "open");
        if (open.length > 0)
          return { text: `${open.length} open pins attached · sent next`, fg: "amberHi" };
        return null;
      }
      ```
- [ ] Run the test — expect PASS.
- [ ] Wire into `Workspace.tsx`:
      `attach={deriveComposerAttach({ readOnly: props.readOnly, selection: mirror.selection(), openPins: pins })}`.
- [ ] Add a `Workspace.test.tsx` case: apply a `selection.changed` snapshot, mount,
      assert the composer meta line shows `▣ <elementId>`. Apply before mount (no
      `act`); if toggled after mount, wrap in `renderer.act`.
- [ ] Run `bun test src/ui/workspace` + `bun x tsc --noEmit` — green.
- [ ] Commit `feat(ui): derive the composer attach chip from selection and pins`.

---

## Task 5 — M14: make the export popup dismissible and surface failures

The export popup is driven only by `exportState.phase === "done"` in `App.tsx:45`;
it is not on the overlay/Esc stack (so `⏎ ok` / Esc cannot dismiss it), and
`exportState.phase === "failed"` is never rendered.

**Design screen (read first):** `design/13-export-feedback.dc.html` (`ws-export-120`
→ engine `wsExport`). The success popup is the quiet `✓ exported …` confirmation
with the `⏎ ok` dismiss line (already in `ExportPopup.tsx`). The design shows no
dedicated failure screen — see the divergence note below for the faithful mapping.

**Files:**
- Modify: `src/ui/app/ui/App.tsx` — render the export popup for both `done` and
  `failed`; route its dismissal through the overlay machinery.
- Modify: `src/ui/app/model/keymap.ts` — resolve `⏎`/Esc to dismissal while the
  export popup is showing.
- Modify: `src/ui/app/model/intent.ts` — an intent that clears the shown export
  result (dispatch the kernel `export.ack`/acknowledge if the contract exposes one;
  otherwise a UI-local "export popup dismissed" flag that suppresses the popup until
  the next `export.started`).
- Modify: `src/ui/popups/ui/ExportPopup.tsx` — add a failure variant (or a sibling
  render path) naming page, size, and error.
- Test: `src/ui/popups/ui/ExportPopup.test.tsx`, `src/ui/app/model/keymap.test.ts`,
  `src/ui/app/ui/App.test.tsx`.

**Interfaces:**
- Consumes: `ExportMirror` (`ui/mirror`) — `{ phase: "done"; destination; … }` and
  `{ phase: "failed"; operationId; failure: FailureDtoV1 | null }`. `FailureDtoV1`
  carries the bounded `safeMessage`; the page slug/size come from the last
  `export.progress` (`ExportMirror.running` before it collapsed) — if the mirror
  drops them on the terminal transition, extend the `failed` variant to retain
  `pageSlug`/`size` the way M11 retains `finalText` (mirror change, keep DTO-derived).
- Produces: an `export`-dismiss `KeyIntent` variant and its `applyIntent` branch.

**Decision to settle first (record in the plan/commit):** whether a dismissed
export result is UI-local (a `local.exportDismissed` atom keyed by `operationId`) or
kernel-acknowledged. Check `core/protocol`'s command kinds for an export-ack; if
none exists (export is a fire-and-forget terminal event), use the UI-local flag —
the popup shows once per `operationId` and Esc/`⏎` hides it. Do **not** invent a
kernel command.

**Divergence to document (design has no failure screen):** design §3.7 only draws
the success popup. A failed export has no design mock, so implement the closest
faithful mapping — the same popup frame with the red band vocabulary already
established for errors (`ErrorPanel`/`SHELL_PALETTE.red`), headline
`✗ export failed <pageSlug>`, the `size` and `failure.safeMessage` beneath, and the
same `⏎ ok` dismiss. Add a code comment marking this as a design-gap mapping.

**Steps:**
- [ ] Read `design/13-export-feedback.dc.html` / `wsExport`; confirm the success copy
      and the `⏎ ok` line; confirm no failure mock exists (record the gap).
- [ ] Write a failing keymap test: with the export popup showing, `⏎` and Esc both
      resolve to the export-dismiss intent.
- [ ] Write a failing `ExportPopup` failure test: renders `✗ export failed`, the page
      slug, the size, and `failure.safeMessage` in the red band.
- [ ] Write a failing `App.test.tsx` case: emit `export.failed`, assert the failure
      popup renders; press `⏎`, assert it is gone and the workspace shows.
- [ ] Run `bun test src/ui/app src/ui/popups` — expect FAIL on the new cases only.
- [ ] Implement: keymap branch, intent branch (UI-local dismiss flag or ack), the
      `ExportPopup` failure variant, and `App.renderOverlay` handling both phases
      gated by the dismiss flag.
- [ ] Run `bun test src/ui/app src/ui/popups` + `bun x tsc --noEmit` — green.
- [ ] Commit (may split): `feat(ui): surface export failures in the popup` and
      `fix(ui): let Enter/Esc dismiss the export popup`.

---

## Task 6 — M15: handle the Home agent-health re-check

Home's error panel says `then reopen, or press r to re-check` (`Home.tsx:149`) but
`r` is not handled — no keymap intent, no test — and `HOME_HEALTH` is hardcoded
`present: true` in `App.tsx:20`.

**Design screen (read first):** `design/01-home.dc.html` (`home()` idle health line
`● codex 0.34 · agent ready`) and `design/12-errors-edge-states.dc.html` (`err-agent`
→ engine `homeErr`, `termcraft-engine.js:572`) for the missing-agent panel and the
`r` re-check affordance.

**Files:**
- Modify: `src/ui/app/model/keymap.ts` — on `screen === "home"`, resolve `r` to a
  new `home-recheck` intent (guard so it only fires on the error variant / when a
  health source says the agent is missing; a printable `r` still types into the Home
  prompt on the idle screen — the error screen has no prompt input).
- Modify: `src/ui/app/model/intent.ts` — a `home-recheck` branch that triggers the
  health re-probe.
- Modify: `src/ui/home/` + `src/ui/app/ui/App.tsx` — stop hardcoding `HOME_HEALTH`;
  read the health from a source atom.
- Modify: `src/ui/home/types.ts` if the health type needs a re-check/loading marker.
- Test: `src/ui/app/model/keymap.test.ts`, `intent.test.ts`, `src/ui/home/ui/Home.test.tsx`.

**Interfaces:**
- Consumes: `HomeAgentHealth` (`ui/home` — `{ present, version?, detail, agent? }`).
- Produces: a `home-recheck` `KeyIntent` variant + `applyIntent` branch; a health
  source (atom/computed) the App reads instead of the `HOME_HEALTH` literal.

**Hard limitation to flag (name it in the plan, do not fake a command):** there is
**no Kernel command that reports agent health** in the MVP contract (the current
`App.tsx:17-19` comment states this explicitly). Home is shown *before* any project
opens, so there is no `kernel.snapshot` to read either. Therefore `home-recheck`
cannot dispatch a kernel command. The faithful MVP scope is: introduce a UI-side
health probe (an injected dependency on `UiDeps`/`UiEnv` — e.g. an
`agentHealth: () => Promise<HomeAgentHealth>` supplied by the composition root that
checks the agent CLI on PATH), drive `HOME_HEALTH` from an atom seeded by it, and
have `home-recheck` re-run the probe through a named `wrap`-ed action. If wiring a
real probe is out of this pass's reach, the minimum is: replace the hardcoded
literal with a health atom, make `r` re-read that atom (a no-op re-render today),
and add the keymap intent + test — leaving the probe as the named injection point.
State which of the two you implement in the commit body.

**Steps:**
- [ ] Read `design/01-home.dc.html` and `design/12-errors-edge-states.dc.html` /
      `homeErr`; confirm the health line and the `r` re-check copy.
- [ ] Write a failing keymap test: `screen: "home"`, error variant, key `r` →
      `{ kind: "home-recheck" }`; and on the idle screen, `r` still yields
      `home-input` (prompt typing) — the two must not collide.
- [ ] Write a failing `intent.test.ts` case: `home-recheck` re-runs the health probe
      / re-reads the health atom (assert against a fake probe on `UiDeps`).
- [ ] Run `bun test src/ui/app` — expect FAIL on the new cases.
- [ ] Implement the keymap branch, the intent branch, the health atom + injection
      point, and the `App` read replacing `HOME_HEALTH`.
- [ ] Add a `Home.test.tsx` case: `present: false` renders the missing panel with the
      `r` re-check line; a re-check that flips `present: true` renders the idle health
      line (wrap the post-mount flip in `renderer.act`).
- [ ] Run `bun test src/ui/app src/ui/home` + `bun x tsc --noEmit` — green.
- [ ] Commit `feat(ui): handle the Home agent-health re-check key`.

---

## Task 7 — M22: drive the agent identity from the kernel snapshot

The UI hardcodes the agent identity — **55 occurrences across 12 `ui` files**
(re-counted via `codex|gpt5.5|gpt5`). MVP ships Claude only and the kernel snapshot
now carries `agentIdentity: AgentIdentityV1`; the design frames' literal
`codex`/`gpt5.5` strings are **sample data, not layout** (user decision 2026-07-23).
Replace every rendered identity literal with the snapshot data; keep every glyph,
placement, and color design-sourced; add the divergence comment at each replaced
literal.

**The 12 files and their counts (55 total):**

| File | count | kind |
|---|---|---|
| `src/ui/workspace/ui/Workspace.tsx` | 5 | rendered literals (lines 273, 279, 284, 299, 304) |
| `src/ui/app/ui/App.tsx` | 2 | `HOME_COMBO` / `HOME_HEALTH` constants (16, 22) |
| `src/ui/home/ui/Home.tsx` | 3 | `|| "codex"` fallbacks (22, 109) + install hint (145) |
| `src/ui/home/types.ts` | 3 | doc-comment examples (7, 12, 14) |
| `src/ui/chat/ui/Composer.tsx` | 1 | prop doc-comment example (7) |
| `src/ui/chat/ui/ChatRecord.tsx` | 3 | `role` union literal (12), comment (41), header (47) |
| `src/ui/chat/ui/AgentStatusBlock.tsx` | 1 | prop doc-comment example (18) |
| `src/ui/chat/ui/Composer.test.tsx` | 11 | test fixtures |
| `src/ui/home/ui/Home.test.tsx` | 7 | test fixtures |
| `src/ui/chat/ui/AgentStatusBlock.test.tsx` | 9 | test fixtures |
| `src/ui/chat/ui/ChatRecord.test.tsx` | 7 | test fixtures |
| `src/ui/app/ui/App.test.tsx` | 3 | test fixtures |

**Design screens (read first):** `design/02-workspace-idle.dc.html` and
`design/03-workspace-generating.dc.html` (composer chip `codex · gpt5.5 · high`,
`● codex` presence, `chat · codex` title — engine `chatSeq`/`composerMeta`); and
`design/01-home.dc.html` (`home()` combo `agent ‹codex› model ‹gpt-5.5› effort
‹high›` and the `● codex … agent ready` health line). Confirm the glyphs (`●`, `·`,
`‹ ›`, `❯`) and the amber/green bands are unchanged — only the identity *text* moves.

**Files:**
- Modify: `src/ui/mirror/types.ts` — re-export `AgentIdentityV1` as the mirror's
  `AgentIdentity` slice type (derived from `EventPayloadByKindV1["kernel.snapshot"]
  ["agentIdentity"]`, keeping the no-cast rule).
- Modify: `src/ui/mirror/model/mirror.ts` + `src/ui/mirror/model/seed.ts` — add a
  named `agentIdentity: Atom<AgentIdentity>` seeded in the `kernel.snapshot` case
  from `payload.agentIdentity` (reset to `null` on a fresh snapshot like the other
  transient slices).
- Modify: `src/ui/mirror/index.ts` — export the `AgentIdentity` type.
- Modify: `src/ui/chat/ui/Composer.tsx` — `modelChip` already a prop; only the
  doc-comment example changes (the literal moves to the Workspace binding).
- Modify: `src/ui/chat/ui/ChatRecord.tsx` — change `role: "you" | "codex"` to
  `role: "you" | "agent"` and take an `agentLabel: string` prop for the `●` header
  (glyph/green unchanged), so `● codex` becomes `● <agentLabel>`.
- Modify: `src/ui/chat/ui/AgentStatusBlock.tsx` — `agentName` is already a prop; only
  the doc-comment example changes.
- Modify: `src/ui/workspace/ui/Workspace.tsx` — read `mirror.agentIdentity()` and
  feed the chip / presence / title / record header / status block.
- Modify: `src/ui/app/ui/App.tsx` + `src/ui/home/*` — Home identity (see the
  pre-project limitation below).
- Modify all 5 test files to match the data-driven shape.

**`AgentIdentityV1` shape and where the UI reads it:**

```ts
// core/protocol (event-payload.ts:571) — the exact shape:
type AgentIdentityV1 = Readonly<{ backendId: string; modelLabel: string }> | null;
// UI reads it from the mirror, seeded from kernel.snapshot.agentIdentity:
const identity = mirror.agentIdentity(); // AgentIdentity = AgentIdentityV1
```

**Workspace binding sketch (with the mandated divergence comment):**

```tsx
const identity = mirror.agentIdentity();
// DIVERGENCE (design sample data, not layout): the frames' literal
// `codex · gpt5.5 · high` composer chip and `● codex` presence are SAMPLE strings
// (user decision 2026-07-23). MVP ships Claude only; the chip renders what the
// kernel snapshot's agentIdentity carries. AgentIdentityV1 has no effort field, so
// the design's `· high` segment is dropped (effort/model picker is out of MVP scope).
// null (no backend selected / kernel not yet emitting identity) → neutral empty text,
// never an invented fallback.
const agentLabel = identity?.backendId ?? "";
const modelChip = identity === null ? "" : `${identity.backendId} · ${identity.modelLabel}`;
// …
title={composerFocused ? `❯ chat · ${agentLabel}` : `chat · ${agentLabel}`}
// ● presence line:
{`● ${agentLabel}`}
// AgentStatusBlock: agentName={agentLabel}
// ChatRecord: role="agent" agentLabel={agentLabel}
// Composer: modelChip={modelChip}
```

**Pre-project Home limitation (flag; do not read a non-existent snapshot):** Home is
shown *before* `.termcraft/` exists, so **no `kernel.snapshot` (and therefore no
`agentIdentity`) is available on Home**. `App.tsx`'s `HOME_COMBO`/`HOME_HEALTH` and
`Home.tsx`'s `|| "codex"` fallbacks cannot be sourced from the kernel snapshot.
Route Home's identity text through **M15's agent-health source** (Task 6) instead —
the same probe that reports `present`/`version` reports the backend/model label — so
Home's identity is data-driven from the CLI probe, not the (absent) snapshot. The
`npm i -g @openai/codex` install hint (`Home.tsx:145`) is agent-specific recovery
copy; drive it from that same source. Where a snapshot binding is impossible, keep a
single documented identity value from the probe with the divergence comment, never a
scattered `"codex"` literal. This couples Task 7 to Task 6 for the Home surface —
schedule Task 7 after Task 6.

**Steps:**
- [ ] Read `design/02-workspace-idle.dc.html`, `design/03-workspace-generating.dc.html`,
      `design/01-home.dc.html`, and the `chatSeq`/`composerMeta`/`home()` engine
      methods; confirm the glyphs/colors are identity-independent.
- [ ] Write failing mirror tests: a `kernel.snapshot` with
      `agentIdentity: { backendId: "claude", modelLabel: "sonnet-4.5" }` seeds
      `mirror.agentIdentity()`; a snapshot with `agentIdentity: null` yields `null`.
- [ ] Run `bun test src/ui/mirror` — expect FAIL (no slice).
- [ ] Implement the mirror slice (`types.ts`, `seed.ts`, `mirror.ts`, `index.ts`).
- [ ] Write failing component tests: `Workspace` with a snapshot identity renders
      `● claude`, `chat · claude`, `claude · sonnet-4.5` chip, and `role="agent"`
      header `● claude`; a `null` identity renders the neutral empty chip (no
      `codex`). Update `ChatRecord`/`AgentStatusBlock`/`Composer` tests to the
      data-driven props. Wrap post-mount identity changes in `renderer.act`.
- [ ] Run the component tests — expect FAIL.
- [ ] Implement the component changes (chip/presence/title/record/status), the
      divergence comment at each replaced literal, and the Home routing through
      Task 6's health source.
- [ ] Update all 5 test files; assert **no** `codex`/`gpt5.5` literal remains in
      non-comment render output (`grep -n "codex\|gpt5" src/ui` shows only doc
      comments / intentional design-sample references).
- [ ] Run `bun test src/ui` + `bun x tsc --noEmit` + `bun run lint` — green.
- [ ] Commit (split by module): `feat(ui): carry the agent identity through the
      mirror`, then `feat(ui): render the workspace agent identity from the snapshot`,
      then `feat(ui): drive the Home agent identity from the health probe`.

---

## Task 8 — M11: render the persisted final agent message *(BLOCKED — WP-10)*

> **BLOCKED until WP-10 lands its chat-record transport.** Do not start until the
> WP-10 record DTO exists. Named dependency below.

The mirror captures `finalText` while a turn runs (`mirror.ts:97-98`) then **drops
it at the terminal transition** (`mirror.ts:191-204` builds the `terminal`
`TurnMirror` with no `finalText`/`errorText`), and `flattenMarkdownLite`
(`chat/model/markdown-lite.ts:100`) — already implemented and exported — has **no
production caller**. `Workspace.tsx:298-300` renders only `terminalRecordLines`
(the `✓ updated <slug>` / `✗ <outcome>` summary), never the agent's prose.

**Precise interface dependency (from WP-10):** the persisted final message must
reach the UI as a **chat record**, which does not exist on the seam today —
`EVENT_KINDS_V1` has no message/record kind and `ui/mirror` has no record type
(closeout gap M10). WP-10's **first task settles the DTO-vs-event-kind choice**
against the kernel-command-contract's closed-union rules and records it before any
code task. Task 8 consumes **whichever WP-10 produces**:
- either a new record kind in `EVENT_KINDS_V1` carrying a persisted chat record, or
- an extended chat-load result DTO carrying the record page (+ derived chat display
  name),

surfaced as WP-10's new **`ui/mirror` record slice type** (the persisted records
WP-10 says the mirror will "hold and render in markdown-lite, above the ephemeral
block"). Task 8 renders those records via `flattenMarkdownLite`; it must not invent
a parallel `finalText` path that would duplicate and drift from WP-10's record.

**Design screen (read first):** `design/03-workspace-generating.dc.html` and
`design/14-first-generation.dc.html` (the `● codex` agent record collapsing to a
persisted markdown-lite record) + spec §3.2 markdown-lite rules.

**Files (final shape, confirm against WP-10's landed DTO):**
- Modify: `src/ui/mirror/types.ts` + `src/ui/mirror/model/mirror.ts` — carry
  `finalText`/`errorText` into the `terminal` `TurnMirror` variant (they are already
  on the `running` variant; stop dropping them at the terminal case), OR read them
  from WP-10's record slice — whichever WP-10's shape makes canonical. Keep both
  DTO-derived.
- Modify: `src/ui/workspace/ui/Workspace.tsx` — render the persisted final message
  through `flattenMarkdownLite(finalText)` as a dim `ChatRecord` (role `agent`, per
  Task 7), above/around the existing `terminalRecordLines` summary.
- Test: `src/ui/mirror/model/mirror.test.ts` (terminal retains `finalText`),
  `src/ui/workspace/ui/Workspace.test.tsx` (final message rendered markdown-lite).

**Interfaces:**
- Consumes: WP-10's `ui/mirror` persisted-record slice — its exact name is fixed by
  WP-10's first task as one of the two forms listed above (record event-kind, or
  extended chat-load DTO); bind to that name once WP-10 lands, not before.
  `flattenMarkdownLite(source: string): readonly MarkdownLine[]`;
  `ChatRecord` (role `agent` after Task 7).
- Produces: no new exports.

**Steps (run only after WP-10 lands):**
- [ ] Confirm WP-10's landed record shape and its `ui/mirror` slice name; write the
      task's Files/Interfaces against it (replace the "OR" above with the concrete
      choice).
- [ ] Write a failing mirror test: after `turn.completed` (or WP-10's record event),
      the persisted final message is retained, not dropped.
- [ ] Run `bun test src/ui/mirror` — expect FAIL.
- [ ] Implement the retention (terminal variant or WP-10 record read).
- [ ] Write a failing `Workspace.test.tsx` case: a completed turn with a bold/inline
      markdown final message renders it via `flattenMarkdownLite` as a dim agent
      record (assert a bold span + the `●` header).
- [ ] Run `bun test src/ui/workspace` — expect FAIL.
- [ ] Implement the Workspace render calling `flattenMarkdownLite`.
- [ ] Run `bun test src/ui` + `bun x tsc --noEmit` — green.
- [ ] Commit `feat(ui): render the persisted final agent message`.

---

## Self-review

**Every WP-9 gap has a task:** m5 → Task 1; m4 → Task 2; M12 → Task 3; M13 → Task 4;
M14 → Task 5; M15 → Task 6; M22 → Task 7; M11 → Task 8 (BLOCKED). All eight WP-9
gaps (M11, M12, M13, M14, M15, M22, m4, m5) are covered.

**Every task names its design screen (and reads it first):**
Task 1 `18-tab-management`; Task 2 `24-chats`; Task 3 `08-pin-comments` + spec §3.2;
Task 4 `07-selection-hover` + `08-pin-comments`; Task 5 `13-export-feedback`;
Task 6 `01-home` + `12-errors-edge-states`; Task 7 `02-workspace-idle` +
`03-workspace-generating` + `01-home`; Task 8 `03-workspace-generating` +
`14-first-generation` + spec §3.2.

**Type names are consistent across tasks:** `AgentIdentityV1`
(`{ backendId; modelLabel } | null`) is the one identity type — introduced by
Task 7's mirror slice (`AgentIdentity`) and consumed by the Task 7 components; Task 6
routes Home identity through its health source (not the snapshot) and Task 7 depends
on it. `PinDtoV1` (`status: "open" | "resolved"`) is used identically in Task 3
(`PinList`) and Task 4 (`deriveComposerAttach`). `SelectionChangedPayloadV1`
(`SelectionDtoV1 | null`) is the selection type in Task 4. `ExportMirror`'s
`done`/`failed` phases are the Task 5 inputs. `MarkdownLine` /
`flattenMarkdownLite` are shared by Task 3's row copy source and Task 8's render.
`ChatRecord`'s `role` becomes `"you" | "agent"` in Task 7 and is reused by Task 8.

**Ordering rationale:** independent, self-contained tasks first (m5, m4), then the
mirror-data-only tasks (M12, M13), then the intent/keymap tasks (M14, M15), then M22
(largest surface; its snapshot field has landed but its Home half depends on M15's
health source), then M11 last (BLOCKED on WP-10).

**Found already-done / impossible (with evidence):**
- **M22 snapshot field is already landed** — `AgentIdentityV1` (event-payload.ts:571)
  and `kernel.snapshot.agentIdentity` (event-payload.ts:603) exist and are re-exported
  through `core/protocol`. The **type** is done; the **kernel does not emit a non-null
  value yet** (WP-1/M21 wired the DTO; the AgentRegistry→snapshot binding is a later
  package), so at runtime the UI must handle `null` — the type-level work is
  unblocked, the runtime value is not.
- **`flattenMarkdownLite` is already implemented and exported** (markdown-lite.ts:100)
  with no production caller — M11 only needs a caller, not a parser. The mirror
  already captures `finalText`/`errorText` on the `running` turn variant
  (mirror.ts:97-102) and only *drops* them at the terminal transition — the fix is
  retention + render, not new capture.
- **The `⚠` orphan / "not visible" pin marker has no kernel data source** — the
  mirror carries `PinDtoV1` but no anchor-resolution signal, and `PreviewOverlays`
  draws every open pin by fraction. The design copy (§3.2) is implemented in Task 3
  but the marker stays dormant (`visible: true` for all open pins) until a
  render-resolved element-id set reaches the mirror. Flagged as a documented gap, not
  fabricated.
- **M15 has no Kernel health command** (App.tsx:17-19 states it) and Home precedes any
  `kernel.snapshot`; the re-check cannot dispatch a kernel command. Task 6 introduces
  a UI-side health-probe injection point instead — named, not faked.
- **M14 has no design failure screen** — §3.7 draws only the success popup; the failed
  variant is a documented closest-faithful mapping onto the established red error band.

**Concerns:**
1. Task 7's Home surface and Task 6's health source are coupled (Home has no snapshot
   pre-project); if Task 6 ships only the minimal health atom, Task 7's Home identity
   stays a single documented probe-fed constant, not snapshot data. Sequence 6 → 7.
2. The `AgentIdentityV1` chip drops the design's `· high` effort segment (no data
   field; effort/model picker out of scope) — a mandated divergence, comment required.
3. Task 3's `visible`/orphan signal and Task 5's failure `pageSlug`/`size` retention
   both need small mirror additions that must stay DTO-derived (no `as` laundering).
4. `ChatRecord.role` widening (`"codex"` → `"agent"`) touches Task 7 and Task 8; land
   it in Task 7 so Task 8 inherits it.
