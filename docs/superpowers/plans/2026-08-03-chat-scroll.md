# Scrollable chat stream with history paging — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the chat message stream scroll by wheel and keyboard, and page backwards from disk until the chat's first record, so the entire history is reachable.

**Architecture:** An OpenTUI `<scrollbox>` becomes the container of the message stream inside `ws-chat-stream`, replacing the row-budget windowing that `ChatScrollback` does today. A new `chat.load-older` command and a new `chat.records.older` event carry backward pages over the wire; the UI mirror accumulates them by merging on `recordId` instead of bulk-replacing. The `▲ N earlier messages` row becomes real scroll content whose `N` counts records not yet loaded (total minus loaded), which is why the UI never has to read scroll metrics to keep a label truthful.

**Tech Stack:** Bun + TypeScript 7, React 19 via `@opentui/react` 0.4.5, Reatom v1001 (`@reatom/core`), Zod v4, `errore`, `bun test`.

**Source spec:** `docs/superpowers/specs/2026-08-02-chat-scroll-design.md`. Every `§n` below refers to it unless another document is named.

## Global Constraints

- **Design is the source of truth — never invent it** (`CLAUDE.md`). Colors come from `SHELL_PALETTE` (`src/ui/theme`), which mirrors `design/termcraft-engine.js`'s `pal`. No glyph, literal string, hue or layout may be chosen in this plan's code; every one is either already in the codebase or comes from design iteration 10 (Task 1).
- **Module shape**: each module is `module/{ui,model,types.ts,index.ts}`; code never sits loose at a module root.
- **Imports**: cross-module imports use the top-level aliases (`ui/chat`, `core/protocol`, `store/jsonl`, …), never a relative path that climbs out of the current module. Relative imports stay inside one module.
- **errore**: errors are values. `.catch()` only at boundaries with code we do not control; every non-propagated error is logged (rule 21); `if (x instanceof Error) return x` on one line.
- **Reatom v1001**: every atom/computed/action is named. Every port call inside a Kernel handler is `await wrap(...)` (RTM-A04). Every React event handler that touches Reatom goes through `useWrap` (RTM-C02). Prefer `atom.set(...)` over identity setter actions (RTM-S01).
- **Protocol unions are closed.** `CommandKindV1` and `EventKindV1` are closed registries with asserted member counts; adding a member means schema + guard + capability mapping + handler + contract tests, all in the same task.
- **Commands are prefixed with `rtk`** (`CLAUDE.md`): `rtk git …`, `rtk bun test …`.
- **`rtk git commit` swallows heredoc stdin.** For a multi-line commit message write it to the scratchpad and pass `-F <path>`. Single-line `-m "…"` works as-is; every commit in this plan is single-line.
- **OpenTUI render tests flake under load.** Never run `src/ui` and `src/entrypoint` in one `bun test` invocation; run them as separate commands.
- **A crashed `bun test` run prints no `(fail)` lines and reads as clean.** Re-run before calling anything a regression.
- **Architecture docs**: if a change alters structure covered by `docs/architecture/`, update the affected docs before finishing (Task 13 collects this).
- **Reatom audit**: run `/reatom-audit` after any task that touched atoms, computeds, actions, async flows or `reatomComponent`, before reporting that task done.

## File Structure

**Created**

| File | Responsibility |
| --- | --- |
| `design-prompts/claude-design-prompt-10.md` | The Claude Design brief, iteration 10. Untracked, local-only directory in the main checkout. |
| `src/ui/workspace/ui/scrollbox-probe.test.tsx` | The permanent contract test for the five `<scrollbox>` behaviours this feature stands on (§9). |
| `docs/spikes/2026-08-03-scrollbox-findings.md` | What the probe found, including the one decision Task 12 branches on. |

**Modified** — one line each, in dependency order:

| File | Change |
| --- | --- |
| `src/store/jsonl/types.ts` | `LoadResult` gains `totalRecordCount`. |
| `src/store/jsonl/model/chat-index.ts` | Both loaders report the total, summed from the page directory. |
| `src/core/ports/chat-store.ts` | `ChatLoadResultV1` gains `totalRecordCount`. |
| `src/store/adapters/chat-store.ts` | Threads it through both loaders. |
| `src/core/ports/fakes/chat-store.ts` | The in-memory fake reports it. |
| `src/core/protocol/model/shared-dto.ts` | New home of `ChatPageCursorDtoV1` (command *and* event now use it). |
| `src/core/protocol/model/event-payload.ts` | `chat.records` gains the total; new `chat.records.older` payload. |
| `src/core/protocol/model/event-kind.ts` | `chat.records.older`; count 44 → 45. |
| `src/core/protocol/model/command-kind.ts` | `chat.load-older`; count 43 → 44. |
| `src/core/protocol/model/command-payload.ts` | `chat.load-older` payload. |
| `src/core/protocol/model/capability-target.ts` | `chat.load-older` target `{ chatId }`. |
| `src/core/protocol/index.ts` | Exports for the moved/added DTOs. |
| `src/core/capabilities/model/target.ts` | Target extractor for the new kind. |
| `src/core/capabilities/model/turn-lock.ts` | Documents `chat.load-older` as deliberately unlocked. |
| `src/core/chats/model/records.ts` | Payload builders carry the total; new older-page builders. |
| `src/core/kernel/model/handlers/chat.ts` | The `chat.load-older` handler. |
| `src/core/kernel/model/handlers/index.ts` | Registry exhaustiveness for the new kind. |
| `src/ui/mirror/types.ts` | `ChatHistoryMirror`; `records` slice becomes `history`. |
| `src/ui/mirror/model/mirror.ts` | Merge-by-id, prepend, cursor + total, new event fold. |
| `src/ui/chat/ui/ChatScrollback.tsx` | Windowing removed; the indicator row becomes content. |
| `src/ui/chat/index.ts` | Exports `ChatOlderPageState`. |
| `src/ui/workspace/types.ts` | `ChatViewport` port; two new local atoms. |
| `src/ui/workspace/index.ts` | Exports `ChatViewport`. |
| `src/ui/workspace/model/agent-block-budget.ts` | `scrollbackMaxRows` removed; `agentStatusMaxRows` simplified. |
| `src/ui/workspace/ui/Workspace.tsx` | The scrollbox, the viewport adapter, the paging trigger. |
| `src/ui/actions/types.ts` | Two new local effects. |
| `src/ui/actions/model/registry.ts` | `chat.scroll-up` / `chat.scroll-down`. |
| `src/ui/app/model/deps.ts` | `chatViewport` and `olderPage` local atoms. |
| `src/ui/app/model/intent.ts` | The two scroll effects drive the viewport port. |
| `docs/architecture/flows/chats.md`, `docs/architecture/modules.md` | Structure updates (Task 13). |

## Interfaces fixed by this plan

Every task below uses exactly these names. Do not rename them mid-plan.

```ts
// store/jsonl/types.ts
interface LoadResult { records; prevCursor; totalRecordCount: number }

// core/ports/chat-store.ts
interface ChatLoadResultV1 { records; prevCursor; totalRecordCount: number }

// core/protocol/model/shared-dto.ts
interface ChatPageCursorDtoV1 { generation: number; beforeOffset: number }

// core/protocol/model/event-payload.ts
interface ChatRecordsPayloadV1 { chatId; records; prevCursor; totalRecordCount: number }
interface ChatRecordsOlderPayloadV1 {
  chatId; records; prevCursor; totalRecordCount: number; failure: FailureDtoV1 | null
}

// core/protocol/model/command-payload.ts
"chat.load-older": { chatId: UUIDv7; cursor: ChatPageCursorDtoV1 }

// ui/mirror/types.ts
interface ChatHistoryMirror {
  records: readonly ChatRecord[]
  prevCursor: ChatPageCursorDtoV1 | null
  totalRecordCount: number
}
// and one sibling atom on Mirror:
lastOlderPageFailure: Atom<FailureDtoV1 | null>

// ui/chat/ui/ChatScrollback.tsx
type ChatOlderPageState =
  | { kind: "idle" } | { kind: "loading" } | { kind: "failed"; safeMessage: string }

// ui/workspace/types.ts
interface ChatViewport {
  scrollByPage(direction: -1 | 1): void
  scrollToBottom(): void
  atBottom(): boolean
  anchorFromBottom(): number
  restoreAnchor(distanceFromBottom: number): void
}
```

---

### Task 1: Design brief — Claude Design iteration 10

**Files:**
- Create: `C:/Users/Khmil/RustProjects/termcraft/design-prompts/claude-design-prompt-10.md` (main checkout, untracked directory — NOT the worktree)
- Modify: `docs/superpowers/specs/2026-08-02-chat-scroll-design.md` (append §11)
- Modify (by the design tool, not by hand): `design/*.dc.html`, `design/termcraft-engine.js`

**Interfaces:**
- Consumes: nothing.
- Produces: spec §11 "Design iteration 10 answers" — seven numbered answers, one per §4.2 question, each citing the `design/` file and line that now carries it. Tasks 10 and 12 read §11 and nothing else for their literal strings, glyphs and colors.

This task is a **hard gate**. Tasks 2–9, 11 and 13 do not depend on it and may proceed in parallel; Tasks 10 and 12 must not start until §11 exists.

- [ ] **Step 1: Read the established form**

Read `C:/Users/Khmil/RustProjects/termcraft/design-prompts/claude-design-prompt-9.md` end to end. Iteration 10 follows its section order exactly:

```
# Claude Design prompt — termcraft UI, iteration 10 (<one-line subject>)
## The product change
## Why the current design cannot be reused
## The facts the screen may draw
## Constraints that apply
## What to define
## Not design work in this round
## Do not change
## Deliverables
```

- [ ] **Step 2: Read every design source the brief will cite, verbatim**

```bash
rtk grep -n "scrollback" design/termcraft-engine.js
```
Read `design/termcraft-engine.js:560-580` (the `▲ N earlier messages` indicator, `y += 2`), `design/03-workspace-generating.dc.html` (the 12-row cap prose), and `design/Termcraft UI.dc.html` §3.8 (the two hotkey tiers — confirm no chat key is named). Iteration 9 states "Every line number cited below was read verbatim before writing this"; iteration 10 makes the same claim, so it must be true.

- [ ] **Step 3: Write the brief**

Content is fixed by §4 of the spec — transcribe it, do not re-derive it:

- *The product change*: the message stream becomes scrollable and pages backwards to the chat's first record (§2's three goals).
- *Why the current design cannot be reused*: the four gaps §4 names — the indicator is a static mockup that leads nowhere (`design/termcraft-engine.js:569`); no scrollbar is drawn anywhere in the shell while `<scrollbox>` draws one by default; §3.8 names no chat key; and "loading an older page", "that load failed" and "this is the start of the chat" are states the design could not have covered because paging did not exist.
- *The facts the screen may draw*: exactly §4.1's six bullets — older records exist (`prevCursor !== null`), **how many** older records exist (an exact number, not "more"), whether a page is loading, whether it failed (a short technical message, no absolute paths), whether the chat's start is reached, and whether the view is at the bottom. Plus §4.1's key constraint: not bare letters (the composer swallows printable characters), `PgUp`/`PgDn` and C0 chords such as `ctrl+u`/`ctrl+d` are available, `ctrl+`-arrows are not.
- The brief **must not** offer the count of records scrolled above the viewport edge. §4.1's last paragraph: that number is deliberately never computed, so offering it would let the design ask for a label the implementation then has to refuse.
- *What to define*: §4.2's seven numbered questions, verbatim.
- *Not design work in this round*: §4.3 — the paging protocol, the page size, sticky-to-bottom behavior, position retention, and every other decision the spec makes.
- *Do not change*: §12's error frames, the palette, the spacing system, `MAX_TIMELINE_ROWS`'s 12-row cap (`design/03-workspace-generating.dc.html` states it outright and §5.3 keeps it).

- [ ] **Step 4: Hand the brief to Claude Design and land its answer**

The design iteration is produced by the design tool, not written here. Run the brief, review the result, and land whatever it changes under `design/`.

- [ ] **Step 5: Record the answers in the spec as §11**

Append to `docs/superpowers/specs/2026-08-02-chat-scroll-design.md`:

```markdown
## 11. Design iteration 10 answers

Recorded so the implementation reads one place, not the design tree, for its literals.
Each answer cites the `design/` file and line that now carries it.

1. **Older-messages indicator** — <what design decided>, `design/<file>:<line>`.
2. **Newer-messages indicator** — <decided / none>, `design/<file>:<line>`.
3. **Scrollbar** — <drawn / suppressed>, `design/<file>:<line>`.
4. **Older-page loading state, and its failure state** — `design/<file>:<line>`.
5. **Start-of-chat marker** — <decided / none>, `design/<file>:<line>`.
6. **Indicator behavior while a turn is running** — `design/<file>:<line>`.
7. **Status-bar key row** — <the scroll keys appear / do not appear>, `design/<file>:<line>`.
```

- [ ] **Step 6: Commit**

```bash
rtk git add design docs/superpowers/specs/2026-08-02-chat-scroll-design.md
rtk git commit -m "design: iteration 10 answers the scrollable chat stream's visual gaps"
```

`design-prompts/` is untracked and is deliberately not committed.

---

### Task 2: `<scrollbox>` validation probe

**Files:**
- Create: `src/ui/workspace/ui/scrollbox-probe.test.tsx`
- Create: `docs/spikes/2026-08-03-scrollbox-findings.md`

**Interfaces:**
- Consumes: `createHeadlessRenderer` from `host/render/model/renderer`, `RenderHandle` from `host/render/types`.
- Produces: a recorded verdict on **prepend position retention** — "the widget holds position" or "it does not". Task 12 branches on exactly this sentence.

§9: nothing in `src/` uses `<scrollbox>` today, and the whole design stands on it. This probe runs before any of it is built. It stays in the repository afterwards as the contract test for the widget behaviours the feature depends on.

- [ ] **Step 1: Write the probe test file**

```tsx
import type { ScrollBoxRenderable } from "@opentui/core";
import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";

/**
 * The `<scrollbox>` contract this feature stands on (chat-scroll spec §9). Nothing in `src/`
 * used the widget before this feature, so these five facts were unproven; they are asserted
 * here rather than assumed at the call site in `Workspace.tsx`.
 */

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
});

const allText = (rows: StyledRun[][]) =>
  rows
    .flat()
    .map((run) => run.text)
    .join("");

const VIEWPORT_ROWS = 5;

function Probe(props: {
  readonly rows: readonly string[];
  readonly onBox: (box: ScrollBoxRenderable | null) => void;
}) {
  return (
    <box id="probe-frame" width={24} height={VIEWPORT_ROWS} flexDirection="column" overflow="hidden">
      <scrollbox
        id="probe"
        ref={props.onBox}
        flexGrow={1}
        scrollY
        scrollX={false}
        stickyScroll
        stickyStart="bottom"
        scrollbarOptions={{ visible: false }}
      >
        {props.rows.map((row) => (
          <box key={row} id={`wrap-${row}`}>
            <text id={`text-${row}`}>{row}</text>
          </box>
        ))}
      </scrollbox>
    </box>
  );
}

function labels(from: number, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `row-${from + i}`);
}

async function mountProbe(rows: readonly string[]) {
  const handle = await createHeadlessRenderer({ w: 40, h: 12 });
  open = handle;
  let box: ScrollBoxRenderable | null = null;
  handle.mount(<Probe rows={rows} onBox={(next) => (box = next)} />);
  await handle.render();
  if (box === null) throw new Error("the scrollbox ref never resolved");
  return { handle, box: box as ScrollBoxRenderable };
}

describe("scrollbox probe (spec §9)", () => {
  test("1. renders through createHeadlessRenderer and its content reaches capture()", async () => {
    const { handle } = await mountProbe(labels(0, 3));
    expect(allText(handle.capture().rows)).toContain("row-2");
  });

  test("2. content taller than the viewport is clipped, not overdrawn", async () => {
    const { handle } = await mountProbe(labels(0, 40));
    const text = allText(handle.capture().rows);
    expect(text).toContain("row-39");
    expect(text).not.toContain("row-0 ");
  });

  test("3. stickyStart bottom holds the newest content and disengages on manual scroll", async () => {
    const { handle, box } = await mountProbe(labels(0, 40));
    expect(allText(handle.capture().rows)).toContain("row-39");

    box.scrollTo(0);
    await handle.render();
    expect(allText(handle.capture().rows)).toContain("row-0");

    handle.mount(<Probe rows={labels(0, 41)} onBox={() => {}} />);
    await handle.render();
    expect(allText(handle.capture().rows)).not.toContain("row-40");
  });

  test("4. the scrollbar is suppressed without artifacts", async () => {
    const { handle, box } = await mountProbe(labels(0, 40));
    expect(box.verticalScrollBar.visible).toBe(false);
    const text = allText(handle.capture().rows);
    expect(text).not.toContain("█");
    expect(text).not.toContain("▲");
    expect(text).not.toContain("▼");
  });

  test("5. RECORDS whether a prepend holds the scroll position", async () => {
    const { handle, box } = await mountProbe(labels(10, 30));
    box.scrollTo(0);
    await handle.render();
    const before = box.scrollTop;
    const heightBefore = box.scrollHeight;

    handle.mount(<Probe rows={labels(0, 40)} onBox={() => {}} />);
    await handle.render();

    // Not a pass/fail assertion — the value this records is what Task 12 branches on.
    // `holds` means the widget compensated for the rows inserted above the viewport.
    const grew = box.scrollHeight - heightBefore;
    const holds = box.scrollTop === before + grew;
    console.log(`[probe] prepend: scrollTop ${before} -> ${box.scrollTop}, grew ${grew}, holds=${holds}`);
    expect(typeof holds).toBe("boolean");
  });
});
```

- [ ] **Step 2: Run the probe**

```bash
rtk bun test src/ui/workspace/ui/scrollbox-probe.test.tsx
```

Expected: tests 1–4 PASS. If any of 1–4 fails, **stop and report** — §9's fallback (a self-implemented row-window over a flattened stream) is a substantial rendering refactor and is a decision for the maintainer, not this plan. Test 5 always passes; read its `[probe]` log line.

- [ ] **Step 3: Record the findings**

Create `docs/spikes/2026-08-03-scrollbox-findings.md`:

```markdown
# `<scrollbox>` probe — findings

Date: 2026-08-03
Probe: `src/ui/workspace/ui/scrollbox-probe.test.tsx`
Question set: `docs/superpowers/specs/2026-08-02-chat-scroll-design.md` §9

1. Renders through `createHeadlessRenderer`, content reaches `capture()`: <yes/no>
2. Content taller than the viewport is clipped, not overdrawn: <yes/no>
3. `stickyStart: "bottom"` holds the newest content and disengages on manual scroll: <yes/no>
4. The scrollbar can be suppressed without artifacts: <yes/no>
5. **A prepend above the current position: the widget <holds / does not hold> position.**

Answer 5 is what `Workspace.tsx`'s paging trigger branches on — see the plan's Task 12.
```

- [ ] **Step 4: Commit**

```bash
rtk git add src/ui/workspace/ui/scrollbox-probe.test.tsx docs/spikes/2026-08-03-scrollbox-findings.md
rtk git commit -m "test(ui): prove the scrollbox contract the chat stream will stand on"
```

---

### Task 3: `store/jsonl` reports the chat's total record count

**Files:**
- Modify: `src/store/jsonl/types.ts:209-213`
- Modify: `src/store/jsonl/model/chat-index.ts` (`loadChatIndexTail`, `loadChatIndexBefore`)
- Test: `src/store/jsonl/model/chat-index.test.ts`

**Interfaces:**
- Consumes: `ChatIndexState.pages` (`readonly ChatIndexPageDirectoryEntry[]`, each with `entryCount`).
- Produces: `LoadResult.totalRecordCount: number` on both loaders.

§6.3: the chat index's entry count *is* the chat's total record count. The index builds exactly one entry per record (`chat-index.ts`'s `flushEntries`), and every entry lands in a directory page carrying its own `entryCount` — so the total is a sum over `state.pages`, with no extra read and no new scan.

- [ ] **Step 1: Write the failing test**

Append to `src/store/jsonl/model/chat-index.test.ts`, inside a new `describe`:

```ts
describe("total record count", () => {
  test("loadTail reports the chat's whole record count, not the page's", async () => {
    const { bytes } = chatOf(250);
    const pages = makePageStore();
    const state = unwrap(await buildFor(bytes, pages));

    const tail = unwrap(await loadChatIndexTail(state, { pages }, makeSource(bytes), { limit: 10 }));
    expect(tail.records).toHaveLength(10);
    expect(tail.totalRecordCount).toBe(250);
  });

  test("loadBefore reports the same total as loadTail", async () => {
    const { bytes } = chatOf(250);
    const pages = makePageStore();
    const state = unwrap(await buildFor(bytes, pages));
    const source = makeSource(bytes);

    const tail = unwrap(await loadChatIndexTail(state, { pages }, source, { limit: 10 }));
    const older = unwrap(
      await loadChatIndexBefore(state, { pages }, source, requireCursor(tail.prevCursor), {
        limit: 10,
      }),
    );
    expect(older.records).toHaveLength(10);
    expect(older.totalRecordCount).toBe(250);
  });

  test("a header-only chat reports zero", async () => {
    const pages = makePageStore();
    const state = unwrap(await buildFor(chatHeaderBytes(), pages));
    const loaded = unwrap(
      await loadChatIndexTail(state, { pages }, makeSource(chatHeaderBytes())),
    );
    expect(loaded.totalRecordCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
rtk bun test src/store/jsonl/model/chat-index.test.ts
```
Expected: FAIL — `totalRecordCount` is `undefined` (three failures).

- [ ] **Step 3: Add the field to `LoadResult`**

In `src/store/jsonl/types.ts`, replace the `LoadResult` interface:

```ts
/** `loadTail`/`loadBefore`'s result: decoded records in display order + the cursor for the older page. */
export interface LoadResult {
  readonly records: readonly ChatRecord[];
  readonly prevCursor: PageCursor | null;
  /**
   * The chat's TOTAL record count — every record on disk, not just this page's. Summed from
   * the index's own page directory (`ChatIndexPageDirectoryEntry.entryCount`), which
   * `flushEntries` builds one entry per record, so this costs no extra read and no second
   * scan. The UI's `▲ N earlier messages` row subtracts what it has loaded from this
   * (chat-scroll spec §6.3), which is what lets that label stay truthful without ever
   * reading a scroll metric.
   */
  readonly totalRecordCount: number;
}
```

- [ ] **Step 4: Compute and return it**

In `src/store/jsonl/model/chat-index.ts`, add beside `toPrevCursor`:

```ts
/** Every record the index holds — see `LoadResult.totalRecordCount` for why the directory is enough. */
function totalRecordCount(state: ChatIndexState): number {
  return state.pages.reduce((sum, page) => sum + page.entryCount, 0);
}
```

Then in **both** `loadChatIndexTail` and `loadChatIndexBefore`, replace the final return with:

```ts
  return {
    records,
    prevCursor: toPrevCursor(state, picked),
    totalRecordCount: totalRecordCount(state),
  };
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
rtk bun test src/store/jsonl
```
Expected: PASS, whole `store/jsonl` suite green.

- [ ] **Step 6: Commit**

```bash
rtk git add src/store/jsonl
rtk git commit -m "feat(store): report a chat's total record count from every load"
```

---

### Task 4: The port, adapter and fake thread the total through

**Files:**
- Modify: `src/core/ports/chat-store.ts:45-48`
- Modify: `src/store/adapters/chat-store.ts` (`toHandleV1`)
- Modify: `src/core/ports/fakes/chat-store.ts` (`sliceResult`)
- Test: `src/core/ports/fakes/chat-store.test.ts`, `src/store/adapters/chat-store.test.ts` (whichever exist; create the assertions inside the existing files)

**Interfaces:**
- Consumes: `LoadResult.totalRecordCount` (Task 3).
- Produces: `ChatLoadResultV1.totalRecordCount: number` — every `ChatHandleV1.loadTail`/`loadBefore` result carries it, real adapter and fake alike.

This change is purely additive at every consumer, so nothing downstream breaks yet.

- [ ] **Step 1: Write the failing test**

Append to `src/core/ports/fakes/chat-store.test.ts`:

```ts
test("the fake reports the chat's whole record count on both loaders", async () => {
  const store = createFakeChatStore({ clock: fixedClock() });
  const header = await store.create();
  if ("code" in header) throw new Error("create failed");
  store.seedRecords(header.chatId, [record(1), record(2), record(3), record(4)]);

  const handle = await store.open(header.chatId);
  if ("code" in handle) throw new Error("open failed");

  const tail = await handle.loadTail(2);
  if ("code" in tail) throw new Error("loadTail failed");
  expect(tail.records).toHaveLength(2);
  expect(tail.totalRecordCount).toBe(4);

  if (tail.prevCursor === null) throw new Error("expected a prevCursor");
  const older = await handle.loadBefore(tail.prevCursor, 2);
  if ("code" in older) throw new Error("loadBefore failed");
  expect(older.totalRecordCount).toBe(4);
});
```

Reuse whatever `createFakeChatStore`/`fixedClock`/`record` helpers that file already defines; if their names differ, match the file, do not rename them.

- [ ] **Step 2: Run it to verify it fails**

```bash
rtk bun test src/core/ports
```
Expected: FAIL — `totalRecordCount` is `undefined`.

- [ ] **Step 3: Widen the port**

In `src/core/ports/chat-store.ts`:

```ts
export interface ChatLoadResultV1 {
  readonly records: readonly ChatRecord[];
  readonly prevCursor: ChatPageCursorV1 | null;
  /**
   * The chat's TOTAL record count, mirroring `store/jsonl`'s `LoadResult.totalRecordCount`
   * (redrawn here per code-structure Decision C1, like every other member of this port).
   * Not derivable from `records` — that is one bounded page — and not derivable from
   * `prevCursor` either, which says only *whether* more exist, never how many.
   */
  readonly totalRecordCount: number;
}
```

- [ ] **Step 4: Thread it through the real adapter**

In `src/store/adapters/chat-store.ts`'s `toHandleV1`, both loaders return the same three fields:

```ts
      return {
        records: result.records,
        prevCursor: result.prevCursor === null ? null : toCursorV1(result.prevCursor),
        totalRecordCount: result.totalRecordCount,
      };
```

- [ ] **Step 5: Thread it through the fake**

In `src/core/ports/fakes/chat-store.ts`, `sliceResult` gains the whole array's length — the fake's records array IS the whole chat, so its length is the honest total:

```ts
  function sliceResult(
    records: readonly ChatRecord[],
    endExclusive: number,
    limit: number | undefined,
  ): ChatLoadResultV1 {
    const start = limit === undefined ? 0 : Math.max(0, endExclusive - limit);
    const slice = records.slice(start, endExclusive);
    const prevCursor: ChatPageCursorV1 | null =
      start > 0 ? { generation: 0, beforeOffset: start } : null;
    // The fake holds the WHOLE chat in memory, so the array's own length is the honest total
    // — the same fact `store/jsonl` sums out of its page directory.
    return { records: slice, prevCursor, totalRecordCount: records.length };
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
rtk bun test src/core/ports src/store
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
rtk git add src/core/ports src/store
rtk git commit -m "feat(ports): carry a chat's total record count across the chat-store port"
```

---

### Task 5: The wire carries the total, and gains `chat.records.older`

**Files:**
- Modify: `src/core/protocol/model/shared-dto.ts`
- Modify: `src/core/protocol/model/event-payload.ts:1686-1723`, plus the `EventPayloadByKindV1` map and the schema map
- Modify: `src/core/protocol/model/event-kind.ts`
- Modify: `src/core/protocol/index.ts`
- Modify: `src/core/chats/model/records.ts`
- Modify: `src/core/kernel/model/handlers/chat.ts` (the `chat.create` literal payload)
- Test: `src/core/protocol/model/closure.test.ts`, `src/core/protocol/model/event-payload.test.ts`, `src/core/chats/model/records.test.ts`

**Interfaces:**
- Consumes: `ChatLoadResultV1.totalRecordCount` (Task 4).
- Produces:
  - `ChatPageCursorDtoV1` / `chatPageCursorDtoV1Schema` now live in `shared-dto.ts`.
  - `ChatRecordsPayloadV1` gains `totalRecordCount: number`.
  - New event kind `"chat.records.older"`, `EVENT_KIND_COUNT = 45`, payload `ChatRecordsOlderPayloadV1`.
  - `core/chats` exports `buildChatRecordsOlderPayload(chatId, loadResult)` and `chatRecordsOlderFailurePayload(chatId, failure)`.

No new *command* kind here — that is Task 6. Splitting them keeps this task compiling on its own: a new event kind has no exhaustiveness obligation, a new command kind does.

- [ ] **Step 1: Write the failing tests**

In `src/core/protocol/model/closure.test.ts`, update the transcribed spec array and the counts:

```ts
// in EVENT_KINDS_PER_SPEC, immediately after "chat.records":
  "chat.records.older",
```
```ts
    expect(EVENT_KINDS_PER_SPEC.length).toBe(45);
    expect(EVENT_KIND_COUNT).toBe(45);
```

Append to `src/core/protocol/model/event-payload.test.ts`:

```ts
describe("chat paging payloads (chat-scroll spec §6.2/§6.3)", () => {
  const CURSOR = { generation: 3, beforeOffset: 4096 };

  test("chat.records carries the chat's total record count", () => {
    const parsed = eventPayloadV1SchemaByKind["chat.records"].safeParse({
      chatId: TEST_UUID,
      records: [],
      prevCursor: CURSOR,
      totalRecordCount: 250,
    });
    expect(parsed.success).toBe(true);
  });

  test("chat.records rejects a payload without the total", () => {
    const parsed = eventPayloadV1SchemaByKind["chat.records"].safeParse({
      chatId: TEST_UUID,
      records: [],
      prevCursor: null,
    });
    expect(parsed.success).toBe(false);
  });

  test("chat.records.older round-trips a successful page", () => {
    const payload = {
      chatId: TEST_UUID,
      records: [],
      prevCursor: CURSOR,
      totalRecordCount: 250,
      failure: null,
    };
    const parsed = eventPayloadV1SchemaByKind["chat.records.older"].safeParse(payload);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual(payload);
  });

  test("chat.records.older round-trips a failed page", () => {
    const parsed = eventPayloadV1SchemaByKind["chat.records.older"].safeParse({
      chatId: TEST_UUID,
      records: [],
      prevCursor: null,
      totalRecordCount: 0,
      failure: { code: "IO_ERROR", safeMessage: "chat page could not be read" },
    });
    expect(parsed.success).toBe(true);
  });
});
```

Match `TEST_UUID` and the `FailureDtoV1` literal shape to whatever that test file already uses — read its existing cases first and reuse their helpers rather than introducing new ones.

- [ ] **Step 2: Run them to verify they fail**

```bash
rtk bun test src/core/protocol
```
Expected: FAIL — `chat.records.older` is not a key of the schema map; the count assertions fail at 44.

- [ ] **Step 3: Move the cursor DTO into `shared-dto.ts`**

Cut `ChatPageCursorDtoV1` and `chatPageCursorDtoV1Schema` out of `event-payload.ts:1686-1701` and paste them into `src/core/protocol/model/shared-dto.ts`, with its home restated:

```ts
const nonNegativeIntSchema = z.number().int().nonnegative();

/**
 * A chat's backward-pagination cursor, mirroring `ChatReader`'s own `ChatPageCursorV1`
 * (`core/ports/chat-store.ts`: a generation plus a byte offset) — redrawn here per
 * code-structure Decision C1.
 *
 * It lives in `shared-dto.ts` rather than beside `chat.records` because BOTH directions of
 * the wire now use it: `chat.records`/`chat.records.older` hand one out, and
 * `chat.load-older` hands the same value straight back (chat-scroll spec §6.1 — "the client
 * returns the cursor it was given; it never constructs one"). A command payload importing
 * the event registry to reach it would invert this module's own layering.
 */
export interface ChatPageCursorDtoV1 {
  readonly generation: number;
  readonly beforeOffset: number;
}

export const chatPageCursorDtoV1Schema = z.strictObject({
  generation: nonNegativeIntSchema,
  beforeOffset: nonNegativeIntSchema,
});
```

In `event-payload.ts`, add `type ChatPageCursorDtoV1` and `chatPageCursorDtoV1Schema` to the existing `./shared-dto` import block.

- [ ] **Step 4: Widen `chat.records` and add `chat.records.older`**

In `event-payload.ts`, where `ChatRecordsPayloadV1` was:

```ts
export interface ChatRecordsPayloadV1 {
  readonly chatId: UUIDv7;
  readonly records: readonly ChatRecordDtoV1[];
  readonly prevCursor: ChatPageCursorDtoV1 | null;
  /**
   * The chat's TOTAL record count (chat-scroll spec §6.3), from `ChatLoadResultV1.
   * totalRecordCount`. The UI's top-of-stream indicator counts records it has NOT loaded —
   * this minus the number it holds — so the label never needs a scroll metric to stay true.
   */
  readonly totalRecordCount: number;
}

export const chatRecordsPayloadV1Schema = z.strictObject({
  chatId: uuidv7Schema,
  records: z.array(chatRecordDtoV1Schema).readonly(),
  prevCursor: chatPageCursorDtoV1Schema.nullable(),
  totalRecordCount: nonNegativeIntSchema,
});

/**
 * `chat.records.older`'s payload (chat-scroll spec §6.2): one page of records OLDER than the
 * cursor the client sent, or the reason that page could not be read.
 *
 * The failure rides this event rather than a separate kind for two reasons the spec states:
 * one nullable field is cheaper than another member of a closed registry, and it retires the
 * UI's loading latch by the same path a success does. `diagnostics.changed` is deliberately
 * not the channel — it carries page and Gate diagnostics, not the outcome of a UI-issued
 * operation.
 *
 * WHEN `failure` IS NON-NULL the other three fields carry no information: `records` is empty,
 * `prevCursor` is `null` and `totalRecordCount` is `0`. The mirror must branch on `failure`
 * FIRST and leave its own cursor and window untouched — spec §7: "`prevCursor` is left as it
 * was so the load can be retried. No records are lost."
 */
export interface ChatRecordsOlderPayloadV1 {
  readonly chatId: UUIDv7;
  readonly records: readonly ChatRecordDtoV1[];
  readonly prevCursor: ChatPageCursorDtoV1 | null;
  readonly totalRecordCount: number;
  readonly failure: FailureDtoV1 | null;
}

export const chatRecordsOlderPayloadV1Schema = z.strictObject({
  chatId: uuidv7Schema,
  records: z.array(chatRecordDtoV1Schema).readonly(),
  prevCursor: chatPageCursorDtoV1Schema.nullable(),
  totalRecordCount: nonNegativeIntSchema,
  failure: failureDtoV1Schema.nullable(),
});
```

Add to the `EventPayloadByKindV1` interface, directly after `"chat.records"`:

```ts
  "chat.records.older": ChatRecordsOlderPayloadV1;
```

and to `eventPayloadV1SchemaByKind`, in the same position:

```ts
  "chat.records.older": chatRecordsOlderPayloadV1Schema,
```

- [ ] **Step 5: Register the event kind**

In `src/core/protocol/model/event-kind.ts`, insert `"chat.records.older",` directly after `"chat.records",`, and:

```ts
/**
 * The exact member count §9 fixes. 44 -> 45 (chat-scroll spec §6.2): `chat.records.older`
 * carries one backward page of a chat's history, or the reason it could not be read. It is a
 * separate kind from `chat.records` because the mirror treats the two differently — a tail
 * page merges at the tail, an older page prepends (spec §6.5) — and one kind carrying both
 * would need a direction discriminant on the payload to say which.
 */
export const EVENT_KIND_COUNT = 45;
```

- [ ] **Step 6: Export the new/moved DTOs**

In `src/core/protocol/index.ts`, add `ChatPageCursorDtoV1` to the `shared-dto` type export block and `chatPageCursorDtoV1Schema` to its value export block.

- [ ] **Step 7: Build the payloads in `core/chats`**

In `src/core/chats/model/records.ts`, update `buildChatRecordsPayload` and add the two older-page builders:

```ts
export function buildChatRecordsPayload(
  chatId: UUIDv7,
  loadResult: ChatLoadResultV1,
): ChatRecordsPayloadV1 {
  return {
    chatId,
    records: loadResult.records.map(chatRecordToDtoV1),
    prevCursor: loadResult.prevCursor,
    totalRecordCount: loadResult.totalRecordCount,
  };
}

/** `chat.records.older`'s successful payload — the same mapping, plus the null failure slot. */
export function buildChatRecordsOlderPayload(
  chatId: UUIDv7,
  loadResult: ChatLoadResultV1,
): ChatRecordsOlderPayloadV1 {
  return {
    chatId,
    records: loadResult.records.map(chatRecordToDtoV1),
    prevCursor: loadResult.prevCursor,
    totalRecordCount: loadResult.totalRecordCount,
    failure: null,
  };
}

/**
 * `chat.records.older`'s failure payload. Every non-`failure` field is deliberately empty:
 * a failed read learned nothing, and the mirror leaves its own cursor and window alone
 * (spec §7) rather than adopting placeholder values from an event that knows nothing.
 */
export function chatRecordsOlderFailurePayload(
  chatId: UUIDv7,
  failure: FailureDtoV1,
): ChatRecordsOlderPayloadV1 {
  return { chatId, records: [], prevCursor: null, totalRecordCount: 0, failure };
}
```

- [ ] **Step 8: Fix the one hand-built payload**

In `src/core/kernel/model/handlers/chat.ts`, `handleChatCreate`'s literal event:

```ts
      // A chat this fresh has nothing on disk, so its total is 0 — the honest count, not a
      // placeholder (chat-scroll spec §6.3).
      chatRecordsEvent({ chatId: header.chatId, records: [], prevCursor: null, totalRecordCount: 0 }),
```

- [ ] **Step 9: Run everything that touches the wire**

```bash
rtk bun test src/core
```
Expected: PASS. If `handlers/project.ts` or `handlers/turn.ts` fail to compile, they build their payload through `buildChatRecordsPayload` and need no edit — read the error before changing anything there.

- [ ] **Step 10: Commit**

```bash
rtk git add src/core
rtk git commit -m "feat(protocol): add chat.records.older and put a chat's total on the wire"
```

---

### Task 6: The `chat.load-older` command and its Kernel handler

**Files:**
- Modify: `src/core/protocol/model/command-kind.ts`
- Modify: `src/core/protocol/model/command-payload.ts`
- Modify: `src/core/protocol/model/capability-target.ts`
- Modify: `src/core/capabilities/model/target.ts`
- Modify: `src/core/capabilities/model/turn-lock.ts` (doc only)
- Modify: `src/core/kernel/model/handlers/chat.ts`
- Modify: `src/core/kernel/model/handlers/index.ts`
- Test: `src/core/protocol/model/closure.test.ts`, `src/core/protocol/model/command-payload.test.ts`, `src/core/protocol/model/capability-target.test.ts`, `src/core/kernel/model/handlers/chat.test.ts`

**Interfaces:**
- Consumes: `ChatPageCursorDtoV1` (Task 5), `buildChatRecordsOlderPayload` / `chatRecordsOlderFailurePayload` (Task 5), `ChatReader.open` + `ChatHandleV1.loadBefore`.
- Produces: command kind `"chat.load-older"` with payload `{ chatId: UUIDv7; cursor: ChatPageCursorDtoV1 }`, capability target `{ chatId: string }`, `COMMAND_KIND_COUNT = 44`, and a handler in `chatHandlers` that publishes exactly one `chat.records.older`.

The protocol change and the handler are one task because they cannot be separated: `totalHandlers satisfies TotalHandlerMap` stops compiling the moment a `CommandKindV1` member has no handler.

- [ ] **Step 1: Write the failing tests**

`closure.test.ts` — add `"chat.load-older",` to `COMMAND_KINDS_PER_SPEC` directly after `"chat.switch"`, and:

```ts
    expect(COMMAND_KINDS_PER_SPEC.length).toBe(44);
    expect(COMMAND_KIND_COUNT).toBe(44);
```

`command-payload.test.ts`:

```ts
test("chat.load-older takes the chat id and the cursor the client was given", () => {
  const schema = commandPayloadSchemaFor("chat.load-older");
  expect(schema.safeParse({ chatId: TEST_UUID, cursor: { generation: 2, beforeOffset: 8192 } }).success).toBe(true);
  expect(schema.safeParse({ chatId: TEST_UUID }).success).toBe(false);
  expect(schema.safeParse({ chatId: TEST_UUID, cursor: null }).success).toBe(false);
});
```

`src/core/kernel/model/handlers/chat.test.ts`:

```ts
describe("chat.load-older (chat-scroll spec §6.4)", () => {
  test("loads the page before the cursor and publishes it", async () => {
    const harness = createChatHandlerHarness();
    const chatId = await harness.seedChat(12);
    const cursor = { generation: 0, beforeOffset: 6 };

    await harness.dispatch("chat.load-older", { chatId, cursor });

    const call = harness.chatStore.calls.find((c) => c.method === "loadBefore");
    expect(call?.cursor).toEqual(cursor);

    const published = harness.published("chat.records.older");
    expect(published).toHaveLength(1);
    expect(published[0]?.payload.chatId).toBe(chatId);
    expect(published[0]?.payload.failure).toBeNull();
    expect(published[0]?.payload.totalRecordCount).toBe(12);
  });

  test("a loadBefore failure rides the same event and loses no cursor", async () => {
    const harness = createChatHandlerHarness();
    const chatId = await harness.seedChat(12);
    harness.chatStore.failNext("loadBefore", { code: "IO_ERROR", safeMessage: "page unreadable" });

    await harness.dispatch("chat.load-older", { chatId, cursor: { generation: 0, beforeOffset: 6 } });

    const published = harness.published("chat.records.older");
    expect(published).toHaveLength(1);
    expect(published[0]?.payload.failure?.safeMessage).toBe("page unreadable");
    expect(published[0]?.payload.records).toEqual([]);
  });

  test("an open failure fails the same way", async () => {
    const harness = createChatHandlerHarness();
    const chatId = await harness.seedChat(3);
    harness.chatStore.failNext("open", { code: "IO_ERROR", safeMessage: "chat unreadable" });

    await harness.dispatch("chat.load-older", { chatId, cursor: { generation: 0, beforeOffset: 1 } });

    expect(harness.published("chat.records.older")[0]?.payload.failure?.safeMessage).toBe(
      "chat unreadable",
    );
  });
});
```

`chat.test.ts` already builds a harness for `chat.create`/`chat.switch` — read it and reuse its own construction and helper names verbatim (`createChatHandlerHarness`, `seedChat`, `dispatch`, `published` above are placeholders for whatever that file already calls them). Do not add a second harness.

- [ ] **Step 2: Run them to verify they fail**

```bash
rtk bun test src/core/protocol src/core/kernel/model/handlers/chat.test.ts
```
Expected: FAIL — `"chat.load-older"` is not assignable to `CommandKindV1`.

- [ ] **Step 3: Register the command kind**

`command-kind.ts` — insert `"chat.load-older",` directly after `"chat.switch",`, and:

```ts
/**
 * The exact member count §8.1 fixes. 43 -> 44 (chat-scroll spec §6.1): `chat.load-older`
 * asks for the page of records before a cursor the client was previously given. It is a
 * command, not a plain read, because it crosses the same guard/capability boundary every
 * other chat operation does, and its answer travels as an event for the same reason
 * `chat.records` does — `AcceptedCommandV1` is a closed object with no payload slot.
 */
export const COMMAND_KIND_COUNT = 44;
```

- [ ] **Step 4: Add the payload**

`command-payload.ts` — beside `chatSwitchPayloadSchema`:

```ts
/**
 * `chat.load-older`: the chat, plus the cursor the client last received on `chat.records` or
 * `chat.records.older` (chat-scroll spec §6.1). The client returns the cursor it was given
 * and never constructs one — which is why this is the DTO from `shared-dto.ts` and not a
 * pair of loose numbers validated here.
 */
const chatLoadOlderPayloadSchema = z.strictObject({
  chatId: uuidv7Schema,
  cursor: chatPageCursorDtoV1Schema,
});
```

Import `chatPageCursorDtoV1Schema` from `./shared-dto` in the existing import block, and register `"chat.load-older": chatLoadOlderPayloadSchema,` in `commandPayloadSchemas` after `"chat.switch"`.

- [ ] **Step 5: Add the capability target**

`capability-target.ts` — in `CapabilityTargetByKindV1`, after `"chat.switch"`:

```ts
  "chat.load-older": { readonly chatId: string };
```
and in the schema map, in the same position:
```ts
  "chat.load-older": z.strictObject({
    chatId: uuidv7Schema,
  }),
```

`src/core/capabilities/model/target.ts`, after the `chat.switch` row:

```ts
  "chat.load-older": extractor("chat.load-older", (p) => ({ chatId: p.chatId })),
```

- [ ] **Step 6: Record the turn-lock decision**

`chat.load-older` is **not** added to `TURN_LOCKED_KINDS`. Extend that constant's doc comment with:

```
 * - `chat.load-older` — reading further back in the active chat's own history changes no
 *   Kernel or durable state and competes with nothing a turn is doing. Locking it would
 *   freeze the scrollback for the whole duration of a generation, which is exactly when a
 *   user is most likely to scroll back and re-read what they asked for.
```

Note for the implementer, not a code change: `chat.load-older` is **not** added to `PROJECT_UNTRUSTED_EXEMPT_KINDS` either. §7.1 fixes that list at three members by name; paging is therefore unavailable in `untrusted-read-only`, and Task 12's trigger checks the mirrored capability before dispatching so the UI never offers it there.

- [ ] **Step 7: Write the handler**

In `src/core/kernel/model/handlers/chat.ts`, add the imports (`buildChatRecordsOlderPayload`, `chatRecordsOlderFailurePayload` from `core/chats`) and:

```ts
type ChatRecordsOlderPayloadV1 = EventPayloadByKindV1["chat.records.older"];

function chatRecordsOlderEvent(
  payload: ChatRecordsOlderPayloadV1,
): PublishableEventV1<"chat.records.older"> {
  return { kind: "chat.records.older", payload };
}

/**
 * `chat.load-older` (chat-scroll spec §6.4): open the chat, `loadBefore(cursor)`, publish the
 * page. Sits beside `loadActiveChatTail` because it is the same two port calls with the other
 * loader.
 *
 * UNLIKE `chat.switch`'s tail load, a failure here is NOT silent. That one is a best-effort
 * side read of an operation that already succeeded; this one IS the operation, and the UI is
 * sitting on a loading latch waiting for it. So both failure paths publish
 * `chat.records.older` with a non-null `failure` — which retires that latch by the same path
 * a success does — and log it as well (errore rule 21).
 *
 * The Kernel holds no paging state (spec §6.4): the accumulated window lives in the mirror,
 * and this handler is stateless between calls. Every port call is `await wrap(...)`
 * (RTM-A04), matching the rest of this file.
 */
const handleChatLoadOlder: CommandHandler<"chat.load-older"> = (payload, context) => {
  context.launchOperation("kernel.chat.loadOlder", async () => {
    const handle = await wrap(context.deps.chatReader.open(payload.chatId));
    if ("code" in handle) {
      console.warn(
        `core/kernel: chat.load-older could not open chatId ${payload.chatId}: ${handle.safeMessage}`,
      );
      return [chatRecordsOlderEvent(chatRecordsOlderFailurePayload(payload.chatId, handle))];
    }

    const loadResult = await wrap(handle.loadBefore(payload.cursor));
    if ("code" in loadResult) {
      console.warn(
        `core/kernel: chat.load-older could not load the page before ${payload.cursor.beforeOffset} for chatId ${payload.chatId}: ${loadResult.safeMessage}`,
      );
      return [chatRecordsOlderEvent(chatRecordsOlderFailurePayload(payload.chatId, loadResult))];
    }

    return [chatRecordsOlderEvent(buildChatRecordsOlderPayload(payload.chatId, loadResult))];
  });

  return startedOutcome([]);
};
```

Register it:

```ts
export const chatHandlers: FamilyHandlerMap<"chat"> = {
  "chat.create": handleChatCreate,
  "chat.switch": handleChatSwitch,
  "chat.load-older": handleChatLoadOlder,
};
```

- [ ] **Step 8: Keep the registry's exhaustiveness check honest**

In `src/core/kernel/model/handlers/index.ts`, add `| "chat.load-older"` to `MigrationPostMvpKind`'s `Exclude` list, and update the `totalHandlers` doc's arithmetic: "43-kind" → "44-kind", "`chatHandlers` 2" → "`chatHandlers` 3", the families' subtotal 29 → 30.

- [ ] **Step 9: Run the tests to verify they pass**

```bash
rtk bun test src/core
```
Expected: PASS. `capabilities/model/projector.test.ts` and `target.test.ts` may assert per-kind coverage — if they enumerate kinds, extend them the same way rather than loosening an assertion.

- [ ] **Step 10: Reatom audit, then commit**

```bash
/reatom-audit
```
```bash
rtk git add src/core
rtk git commit -m "feat(kernel): handle chat.load-older and page a chat backwards"
```

---

### Task 7: The mirror accumulates history instead of replacing it

**Files:**
- Modify: `src/ui/mirror/types.ts`
- Modify: `src/ui/mirror/model/mirror.ts:66`, `:219`, `:318`, `:599`, `:604-606`
- Modify: `src/ui/mirror/index.ts` (export `ChatHistoryMirror`)
- Modify: `src/ui/workspace/ui/Workspace.tsx:439` (read-site only; the render change is Task 11)
- Test: `src/ui/mirror/model/mirror.test.ts`

**Interfaces:**
- Consumes: `chat.records` and `chat.records.older` payloads (Task 5).
- Produces:
  - `Mirror.history: Atom<ChatHistoryMirror>` replacing `Mirror.records`. `ChatHistoryMirror = { records, prevCursor, totalRecordCount }`.
  - `Mirror.lastOlderPageFailure: Atom<FailureDtoV1 | null>` — the outcome of the most recent `chat.records.older`, `null` on success and after every chat switch. A separate atom rather than a fourth field on `ChatHistoryMirror`, because it is the only one of the four a *failed* page changes, and folding it in would force a window write on an event that learned nothing about the window. Task 12's Workspace effect reads it to retire the UI-local loading latch.

§6.5: `chat.records` bulk-replaces today, and `handlers/turn.ts` reloads the tail after every turn — so with paging, a window expanded three pages back would collapse on every agent reply. The apply becomes a merge by `recordId`.

The three fields become **one** atom rather than three, because they are one fact set that always moves together; three atoms would be exactly the "parallel state maps" shape the Reatom rules warn about, and a merge would need three `.set` calls where one is correct.

- [ ] **Step 1: Write the failing tests**

Append to `src/ui/mirror/model/mirror.test.ts`:

```ts
describe("chat history paging (chat-scroll spec §6.5)", () => {
  const CHAT = uuidv7();
  const cursor = (beforeOffset: number) => ({ generation: 1, beforeOffset });

  function ready(mirror: Mirror): void {
    mirror.apply(event("chat.changed", { activeChatId: CHAT, added: [], updated: [], removedChatIds: [] }));
  }

  test("a tail page seeds records, cursor and total", () => {
    const mirror = createMirror();
    ready(mirror);
    mirror.apply(
      event("chat.records", {
        chatId: CHAT,
        records: [userRecord("r3"), userRecord("r4")],
        prevCursor: cursor(120),
        totalRecordCount: 40,
      }),
    );
    const history = mirror.history();
    expect(history.records.map((r) => r.recordId)).toEqual(["r3", "r4"]);
    expect(history.prevCursor).toEqual(cursor(120));
    expect(history.totalRecordCount).toBe(40);
  });

  test("an older page prepends and moves the cursor further back", () => {
    const mirror = createMirror();
    ready(mirror);
    mirror.apply(
      event("chat.records", {
        chatId: CHAT,
        records: [userRecord("r3")],
        prevCursor: cursor(120),
        totalRecordCount: 40,
      }),
    );
    mirror.apply(
      event("chat.records.older", {
        chatId: CHAT,
        records: [userRecord("r1"), userRecord("r2")],
        prevCursor: cursor(40),
        totalRecordCount: 40,
        failure: null,
      }),
    );
    const history = mirror.history();
    expect(history.records.map((r) => r.recordId)).toEqual(["r1", "r2", "r3"]);
    expect(history.prevCursor).toEqual(cursor(40));
  });

  test("a fresh tail reload does not erase the pages loaded above it", () => {
    const mirror = createMirror();
    ready(mirror);
    mirror.apply(
      event("chat.records", { chatId: CHAT, records: [userRecord("r3")], prevCursor: cursor(120), totalRecordCount: 40 }),
    );
    mirror.apply(
      event("chat.records.older", {
        chatId: CHAT,
        records: [userRecord("r1"), userRecord("r2")],
        prevCursor: cursor(40),
        totalRecordCount: 40,
        failure: null,
      }),
    );
    // The turn-completion reload: the same tail, now one record longer.
    mirror.apply(
      event("chat.records", {
        chatId: CHAT,
        records: [userRecord("r3"), userRecord("r4")],
        prevCursor: cursor(120),
        totalRecordCount: 41,
      }),
    );
    const history = mirror.history();
    expect(history.records.map((r) => r.recordId)).toEqual(["r1", "r2", "r3", "r4"]);
    expect(history.prevCursor).toEqual(cursor(40));
    expect(history.totalRecordCount).toBe(41);
  });

  test("a failed older page keeps the window and the cursor untouched", () => {
    const mirror = createMirror();
    ready(mirror);
    mirror.apply(
      event("chat.records", { chatId: CHAT, records: [userRecord("r3")], prevCursor: cursor(120), totalRecordCount: 40 }),
    );
    mirror.apply(
      event("chat.records.older", {
        chatId: CHAT,
        records: [],
        prevCursor: null,
        totalRecordCount: 0,
        failure: { code: "IO_ERROR", safeMessage: "page unreadable" },
      }),
    );
    const history = mirror.history();
    expect(history.records.map((r) => r.recordId)).toEqual(["r3"]);
    expect(history.prevCursor).toEqual(cursor(120));
    expect(history.totalRecordCount).toBe(40);
    expect(mirror.lastOlderPageFailure()?.safeMessage).toBe("page unreadable");
  });

  test("a successful older page clears the last failure", () => {
    const mirror = createMirror();
    ready(mirror);
    mirror.apply(
      event("chat.records", { chatId: CHAT, records: [userRecord("r3")], prevCursor: cursor(120), totalRecordCount: 40 }),
    );
    mirror.apply(
      event("chat.records.older", {
        chatId: CHAT,
        records: [],
        prevCursor: null,
        totalRecordCount: 0,
        failure: { code: "IO_ERROR", safeMessage: "page unreadable" },
      }),
    );
    mirror.apply(
      event("chat.records.older", {
        chatId: CHAT,
        records: [userRecord("r2")],
        prevCursor: cursor(40),
        totalRecordCount: 40,
        failure: null,
      }),
    );
    expect(mirror.lastOlderPageFailure()).toBeNull();
  });

  test("an older page for a chat the user left is dropped", () => {
    const mirror = createMirror();
    ready(mirror);
    mirror.apply(
      event("chat.records", { chatId: CHAT, records: [userRecord("r3")], prevCursor: cursor(120), totalRecordCount: 40 }),
    );
    mirror.apply(
      event("chat.records.older", {
        chatId: uuidv7(),
        records: [userRecord("x1")],
        prevCursor: cursor(40),
        totalRecordCount: 40,
        failure: null,
      }),
    );
    expect(mirror.history().records.map((r) => r.recordId)).toEqual(["r3"]);
  });

  test("switching chats clears the whole window", () => {
    const mirror = createMirror();
    ready(mirror);
    mirror.apply(
      event("chat.records", { chatId: CHAT, records: [userRecord("r3")], prevCursor: cursor(120), totalRecordCount: 40 }),
    );
    mirror.apply(
      event("chat.changed", { activeChatId: uuidv7(), added: [], updated: [], removedChatIds: [] }),
    );
    expect(mirror.history()).toEqual({ records: [], prevCursor: null, totalRecordCount: 0 });
  });
});
```

Reuse `createMirror`, `event` and `uuidv7` from that file. Its existing `userRecord` fixture (declared inside the `mirror.apply — records` describe, `mirror.test.ts:1399`) takes no argument and mints a random `recordId`; the merge tests above need deterministic ids, so lift it to module scope and give it one optional parameter:

```ts
const userRecord = (recordId: string = uuidv7()) => ({ /* …unchanged body… */, recordId });
```

Existing call sites keep working unchanged. Every existing `chat.records` payload in that describe also needs `totalRecordCount` added, and every `m.records()` read becomes `m.history().records`.

- [ ] **Step 2: Run them to verify they fail**

```bash
rtk bun test src/ui/mirror
```
Expected: FAIL — `mirror.history` is not a function.

- [ ] **Step 3: Declare the slice type**

In `src/ui/mirror/types.ts`, replace the `ChatRecord` block's neighbourhood with:

```ts
export type ChatRecord = EventPayloadByKindV1["chat.records"]["records"][number];

/**
 * The active chat's loaded window plus what the client knows about the rest of it
 * (chat-scroll spec §6.5). One slice, not three atoms: `records`, `prevCursor` and
 * `totalRecordCount` are established together by every event that touches any of them, and
 * splitting them would mean three writes where the merge produces one new value.
 *
 * `records` still holds ONLY the active chat (`mirror.ts`'s clear-on-switch is unchanged) —
 * paging widens the window backwards, it does not turn this into a per-chat cache.
 */
export interface ChatHistoryMirror {
  readonly records: readonly ChatRecord[];
  readonly prevCursor: EventPayloadByKindV1["chat.records"]["prevCursor"];
  /** Every record the chat has on disk. `records.length` subtracted from this is the `▲ N` count. */
  readonly totalRecordCount: number;
}
```

- [ ] **Step 4: Replace the atom and its folds**

In `src/ui/mirror/model/mirror.ts`:

Interface member (`:66`):
```ts
  /**
   * The ACTIVE chat's loaded history window — see {@link ChatHistoryMirror}. Grows backwards
   * through `chat.records.older` (chat-scroll spec §6.5) and forwards through `chat.records`,
   * which now MERGES by `recordId` rather than bulk-replacing: `handlers/turn.ts` reloads the
   * tail after every turn, so a replace would collapse a window paged three pages back on
   * every agent reply. Still one `atom.set` with a new array.
   */
  readonly history: Atom<ChatHistoryMirror>;
  /**
   * The outcome of the most recent `chat.records.older` — the failure, or `null` for a success
   * and after every chat switch. A Kernel fact, so it belongs here and not in UI-local state;
   * `Workspace.tsx` reads it to retire its own loading latch (chat-scroll spec §6.6).
   *
   * Separate from {@link ChatHistoryMirror} on purpose: it is the only thing a FAILED page
   * changes, and folding it in would force a window write on an event that learned nothing
   * about the window — which is exactly what spec §7 forbids ("`prevCursor` is left as it was
   * so the load can be retried. No records are lost.").
   */
  readonly lastOlderPageFailure: Atom<FailureDtoV1 | null>;
```

Construction (`:219`):
```ts
const EMPTY_HISTORY: ChatHistoryMirror = { records: [], prevCursor: null, totalRecordCount: 0 };
const history = atom<ChatHistoryMirror>(EMPTY_HISTORY, "ui.mirror.history");
const lastOlderPageFailure = atom<FailureDtoV1 | null>(null, "ui.mirror.lastOlderPageFailure");
```

Add the two merge helpers beside the other module-level helpers:

```ts
/**
 * A newer tail page folded into the window: same-id records are superseded in place by the
 * incoming copy, everything the client holds ABOVE the page is untouched, and the page lands
 * at the tail (chat-scroll spec §6.5).
 */
function mergeTail(
  held: readonly ChatRecord[],
  incoming: readonly ChatRecord[],
): readonly ChatRecord[] {
  const incomingIds = new Set(incoming.map((record) => record.recordId));
  return [...held.filter((record) => !incomingIds.has(record.recordId)), ...incoming];
}

/** An older page folded in: whatever the client does not already hold, ahead of what it does. */
function mergeOlder(
  held: readonly ChatRecord[],
  incoming: readonly ChatRecord[],
): readonly ChatRecord[] {
  const heldIds = new Set(held.map((record) => record.recordId));
  return [...incoming.filter((record) => !heldIds.has(record.recordId)), ...held];
}
```

Snapshot reset (`:318`) and chat-switch clear (`:599`) both become:
```ts
        history.set(EMPTY_HISTORY);
        lastOlderPageFailure.set(null);
```

The `chat.records` fold (`:604-606`):
```ts
      case "chat.records": {
        const p = envelope.payload;
        // Fenced to the active chat, the same pattern the turn cases use for a stale/late
        // arrival: a tail for a since-switched-away chat is a no-op.
        if (p.chatId !== chats().activeChatId) return;
        const held = history();
        const records = mergeTail(held.records, p.records);
        // KEEP the further-back cursor when the client already holds records this page does
        // not contain: those are older, so its own cursor points further back than the fresh
        // tail's does. Taking the incoming one would walk the paging back down toward the
        // tail and re-request pages the window already has.
        const kept = records.length - p.records.length;
        history.set({
          records,
          prevCursor: kept > 0 ? held.prevCursor : p.prevCursor,
          totalRecordCount: p.totalRecordCount,
        });
        return;
      }
      case "chat.records.older": {
        const p = envelope.payload;
        if (p.chatId !== chats().activeChatId) return;
        lastOlderPageFailure.set(p.failure);
        // A failed page learned nothing — the window and the cursor stay exactly as they were
        // so the load can be retried (spec §7). Its outcome still reached the mirror above,
        // which is what retires the UI's own loading latch.
        if (p.failure !== null) return;
        const held = history();
        history.set({
          records: mergeOlder(held.records, p.records),
          prevCursor: p.prevCursor,
          totalRecordCount: p.totalRecordCount,
        });
        return;
      }
```

Export `history` and `lastOlderPageFailure` in the returned object, `history` in place of `records`, and export `ChatHistoryMirror` from `src/ui/mirror/index.ts` beside the other slice types.

- [ ] **Step 5: Fix the one production read-site**

`src/ui/workspace/ui/Workspace.tsx:439`:
```ts
  const records = mirror.history().records;
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
rtk bun test src/ui/mirror
rtk bun test src/ui
```
Expected: PASS. Existing `chat.records` cases in `mirror.test.ts` and `Workspace.test.tsx` need their payloads to gain `totalRecordCount` and their reads to move from `mirror.records()` to `mirror.history().records` — update them; do not add a compatibility shim.

- [ ] **Step 7: Reatom audit, then commit**

```bash
/reatom-audit
```
```bash
rtk git add src/ui
rtk git commit -m "feat(ui): accumulate the chat history window instead of replacing it"
```

---

### Task 8: The `ChatViewport` port and the two UI-local atoms

**Files:**
- Modify: `src/ui/chat/ui/ChatScrollback.tsx` (type only), `src/ui/chat/index.ts`
- Modify: `src/ui/workspace/types.ts`, `src/ui/workspace/index.ts`
- Modify: `src/ui/app/model/deps.ts`
- Test: `src/ui/app/model/deps.test.ts` (or the existing file that asserts `createUiDeps`' shape)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `ChatOlderPageState` from `ui/chat` — `{ kind: "idle" } | { kind: "loading" } | { kind: "failed"; safeMessage: string }`.
  - `ChatViewport` from `ui/workspace` — the five-method imperative port.
  - `WorkspaceLocalState` and `UiLocalState` both gain `chatViewport: Atom<ChatViewport | null>` and `olderPage: Atom<ChatOlderPageState>`.

§5.5: scrolling is imperative and `intent.ts` is pure, so the two meet at a port. This task declares it and nothing else, so Tasks 9 (keyboard) and 12 (adapter) can land independently.

`ChatOlderPageState` lives in `ui/chat`, not `ui/workspace`, because `ChatScrollback` renders it and `ui/workspace` already imports `ui/chat` — declaring it the other way round would invert an existing dependency edge.

- [ ] **Step 1: Declare `ChatOlderPageState`**

In `src/ui/chat/ui/ChatScrollback.tsx`, above `ChatScrollbackProps`:

```ts
/**
 * Whether an older page of this chat's history is being loaded right now, and whether the last
 * attempt failed (chat-scroll spec §6.6). UI-local: the operation does not complete when the
 * dispatch promise resolves — it completes when `chat.records.older` arrives — so this is a
 * plain latch, not a `withAsync` state (spec §6.6 states the reason at length).
 *
 * `safeMessage` is the failure's own bounded message, never a path or an environment value.
 */
export type ChatOlderPageState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly safeMessage: string };
```

Export it from `src/ui/chat/index.ts`:
```ts
export type { ChatOlderPageState, ChatScrollbackProps } from "./ui/ChatScrollback";
```

- [ ] **Step 2: Declare `ChatViewport` and widen the local state**

In `src/ui/workspace/types.ts`:

```ts
/**
 * The chat stream's scroll surface, as the keyboard layer sees it (chat-scroll spec §5.5).
 *
 * Scrolling is imperative and `applyIntent` is pure, so the two meet here rather than in a
 * component: `Workspace.tsx` publishes an adapter over the live `ScrollBoxRenderable` into
 * {@link WorkspaceLocalState.chatViewport}, and `applyIntent` reads that atom and calls a
 * method — exactly as it already calls `dispatcher`. Tests substitute a fake and need no
 * renderer.
 *
 * Deliberately five methods, not a handle to the renderable: everything the keyboard layer
 * needs is expressible without exposing `scrollTop`/`scrollHeight`, and the spec's own §5.4
 * turns on the UI never reading a continuous scroll metric to keep a label truthful.
 */
export interface ChatViewport {
  /** One viewport-height step; `-1` is up (toward older), `1` is down. */
  scrollByPage(direction: -1 | 1): void;
  scrollToBottom(): void;
  atBottom(): boolean;
  /** Rows between the bottom of the content and the bottom of the viewport, right now. */
  anchorFromBottom(): number;
  /** Puts that same distance back after content changed above the viewport. */
  restoreAnchor(distanceFromBottom: number): void;
}
```

and inside `WorkspaceLocalState`:

```ts
  /**
   * The live chat scroll surface, or `null` before the first render publishes one (and
   * whenever the Workspace is unmounted). Written only by `Workspace.tsx`'s ref callback.
   */
  readonly chatViewport: Atom<ChatViewport | null>;
  /** The older-page load latch — see `ui/chat`'s {@link ChatOlderPageState}. */
  readonly olderPage: Atom<ChatOlderPageState>;
```

Import `ChatOlderPageState` from `"ui/chat"` at the top of the file, and export `ChatViewport` from `src/ui/workspace/index.ts`.

- [ ] **Step 3: Add the atoms to `UiLocalState` and `createUiDeps`**

In `src/ui/app/model/deps.ts`, add the identical two members to `UiLocalState` (same doc comments, importing `ChatViewport` from `"ui/workspace"` and `ChatOlderPageState` from `"ui/chat"`), and create them where the other local atoms are created:

```ts
    chatViewport: atom<ChatViewport | null>(null, "ui.local.chatViewport"),
    olderPage: atom<ChatOlderPageState>({ kind: "idle" }, "ui.local.olderPage"),
```

- [ ] **Step 4: Write the test**

Append to the existing `createUiDeps` shape test:

```ts
test("createUiDeps seeds the chat viewport empty and the older-page latch idle", () => {
  const deps = createUiDeps(createFakeKernel(), { w: 120, h: 36 });
  expect(deps.local.chatViewport()).toBeNull();
  expect(deps.local.olderPage()).toEqual({ kind: "idle" });
});
```

- [ ] **Step 5: Run it**

```bash
rtk bun test src/ui/app
```
Expected: PASS (the test is written after the code here because the code is a declaration, not a behavior — there is nothing to observe failing).

- [ ] **Step 6: Commit**

```bash
rtk git add src/ui
rtk git commit -m "feat(ui): declare the chat viewport port and its two local atoms"
```

---

### Task 9: `PgUp`/`PgDn` scroll the chat stream

**Files:**
- Modify: `src/ui/actions/types.ts`
- Modify: `src/ui/actions/model/registry.ts`
- Modify: `src/ui/app/model/intent.ts` (`executeAction`)
- Test: `src/ui/actions/model/registry.test.ts`, `src/ui/app/model/keymap.test.ts`, `src/ui/app/model/intent.test.ts`

**Interfaces:**
- Consumes: `ChatViewport` and `local.chatViewport` (Task 8).
- Produces: action ids `chat.scroll-up` / `chat.scroll-down`, local effects `chat-scroll-up` / `chat-scroll-down`, keys `pageup` / `pagedown` with aliases `ctrl+u` / `ctrl+d`.

§5.5. Resolution runs through the existing `keymap.ts` → `intent.ts` chain with no special case: `resolveKey` already funnels every unclaimed key through `resolveHotkey(hotkeyName(key))`, and OpenTUI names these keys `pageup`/`pagedown` (verified in `@opentui/core`'s keypress parser). The composer is unaffected: `printableChar` accepts only a single-character sequence, and both keys arrive as multi-character escape sequences.

- [ ] **Step 1: Write the failing tests**

`src/ui/app/model/keymap.test.ts`:

```ts
test("PgUp/PgDn and their ctrl aliases resolve to the chat scroll actions", () => {
  const context = workspaceContext(); // reuse this file's own context builder
  expect(resolveKey({ name: "pageup", ctrl: false, sequence: "\x1b[5~" }, context)).toEqual({
    kind: "action-execute",
    actionId: "chat.scroll-up",
  });
  expect(resolveKey({ name: "pagedown", ctrl: false, sequence: "\x1b[6~" }, context)).toEqual({
    kind: "action-execute",
    actionId: "chat.scroll-down",
  });
  expect(resolveKey({ name: "u", ctrl: true, sequence: "\x15" }, context)).toEqual({
    kind: "action-execute",
    actionId: "chat.scroll-up",
  });
  expect(resolveKey({ name: "d", ctrl: true, sequence: "\x04" }, context)).toEqual({
    kind: "action-execute",
    actionId: "chat.scroll-down",
  });
});
```

`src/ui/app/model/intent.test.ts`:

```ts
describe("chat scroll intents (chat-scroll spec §5.5)", () => {
  function fakeViewport() {
    const calls: (-1 | 1)[] = [];
    return {
      calls,
      viewport: {
        scrollByPage: (direction: -1 | 1) => calls.push(direction),
        scrollToBottom: () => {},
        atBottom: () => true,
        anchorFromBottom: () => 0,
        restoreAnchor: () => {},
      },
    };
  }

  test("PgUp scrolls the published viewport up a page", () => {
    const deps = createUiDeps(createFakeKernel(), { w: 120, h: 36 });
    const fake = fakeViewport();
    deps.local.chatViewport.set(fake.viewport);
    applyIntent({ kind: "action-execute", actionId: "chat.scroll-up" }, deps);
    expect(fake.calls).toEqual([-1]);
  });

  test("PgDn scrolls it down a page", () => {
    const deps = createUiDeps(createFakeKernel(), { w: 120, h: 36 });
    const fake = fakeViewport();
    deps.local.chatViewport.set(fake.viewport);
    applyIntent({ kind: "action-execute", actionId: "chat.scroll-down" }, deps);
    expect(fake.calls).toEqual([1]);
  });

  test("with no viewport published the key is inert, not a crash", () => {
    const deps = createUiDeps(createFakeKernel(), { w: 120, h: 36 });
    expect(() =>
      applyIntent({ kind: "action-execute", actionId: "chat.scroll-up" }, deps),
    ).not.toThrow();
  });
});
```

`src/ui/actions/model/registry.test.ts` — if it asserts a hotkey count or enumerates the hint row, extend those assertions: the two new entries carry `hint` per spec §11 answer 7, and if §11 says they do not appear, `hint: false` and the hint-row assertion is unchanged.

- [ ] **Step 2: Run them to verify they fail**

```bash
rtk bun test src/ui/app src/ui/actions
```
Expected: FAIL — `resolveKey` returns `{ kind: "none" }`; `chat.scroll-up` resolves to no entry.

- [ ] **Step 3: Widen the effect union**

`src/ui/actions/types.ts`:

```ts
      readonly effect:
        | "fullscreen"
        | "open-chats"
        | "exit"
        | "compose-repair"
        | "page-prev"
        | "page-next"
        | "chat-scroll-up"
        | "chat-scroll-down";
```

- [ ] **Step 4: Register the two actions**

In `src/ui/actions/model/registry.ts`, after the `page.next` entry:

```ts
  {
    // SCROLLING THE CHAT STREAM FROM THE KEYBOARD (chat-scroll spec §5.5). Like
    // `page.prev`/`page.next` above, this is a DESIGN EXTENSION and is recorded as one:
    // §3.8's two hotkey tiers name no chat key at all, and the design's own
    // `▲ N earlier messages` indicator (`design/termcraft-engine.js:569`) leads nowhere.
    // Design iteration 10 decides only whether these keys are DRAWN in the status-bar key
    // row (`hint` below); the binding itself is this project's.
    //
    // WHY `PgUp`/`PgDn` CANONICAL, `ctrl+u`/`ctrl+d` AS ALIASES:
    //   - it must be GLOBAL tier: the composer owns focus by default, so a bare letter would
    //     be swallowed as text — the same hazard `keymap.ts`'s `home-recheck` note records;
    //   - `PgUp`/`PgDn` arrive as multi-character CSI sequences, which `printableChar`
    //     rejects on length alone, so they can never reach the composer as input;
    //   - `ctrl+u`/`ctrl+d` are C0 control bytes (0x15 / 0x04): one byte, no encoding to get
    //     wrong, and below 0x20 so `printableChar` rejects them too;
    //   - `ctrl+`-arrows are deliberately NOT bound — they were dead on the maintainer's
    //     terminal, which is exactly why `page.prev`/`page.next` are `ctrl+b`/`ctrl+n`.
    id: "chat.scroll-up",
    execution: { kind: "local", effect: "chat-scroll-up" },
    hotkey: {
      id: "chat.scroll-up",
      key: "pageup",
      aliases: ["ctrl+u"],
      label: "scroll up",
      capability: null,
      hint: false,
    },
  },
  {
    id: "chat.scroll-down",
    execution: { kind: "local", effect: "chat-scroll-down" },
    hotkey: {
      id: "chat.scroll-down",
      key: "pagedown",
      aliases: ["ctrl+d"],
      label: "scroll down",
      capability: null,
      hint: false,
    },
  },
```

`hint: false` is the default this task lands with, because the design never drew these keys. **If spec §11 answer 7 says the scroll keys DO appear in the status-bar key row**, drop `hint: false` from both entries and add them to `Workspace.tsx`'s `hintKeys` in the position §11 names — that is the only change, and it belongs in Task 12 alongside the rest of the §11 transcription.

- [ ] **Step 5: Drive the viewport from `executeAction`**

In `src/ui/app/model/intent.ts`, inside `executeAction`, directly after the `page-prev`/`page-next` branch:

```ts
  if (execution.effect === "chat-scroll-up" || execution.effect === "chat-scroll-down") {
    // The keyboard half of chat scrolling (chat-scroll spec §5.5). `applyIntent` stays pure of
    // the renderer: it calls a port `Workspace.tsx` published, exactly as it calls `dispatcher`.
    const viewport = deps.local.chatViewport();
    if (viewport === null) {
      // Reachable for one frame at mount, and on every non-Workspace screen — the keys are
      // global tier, so they resolve there too and must be inert rather than throw.
      trace("ui.chat.scroll.refused", { effect: execution.effect, reason: "no viewport" });
      return;
    }
    viewport.scrollByPage(execution.effect === "chat-scroll-down" ? 1 : -1);
    return;
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
rtk bun test src/ui/app src/ui/actions
```
Expected: PASS.

- [ ] **Step 7: Reatom audit, then commit**

```bash
/reatom-audit
```
```bash
rtk git add src/ui
rtk git commit -m "feat(ui): bind PgUp/PgDn to the chat stream's scroll port"
```

---

### Task 10: `ChatScrollback` becomes a plain column with a real indicator row

**Gated on Task 1** — every literal string, glyph and color in this task comes from spec §11.

**Files:**
- Modify: `src/ui/chat/ui/ChatScrollback.tsx`
- Test: `src/ui/chat/ui/ChatScrollback.test.tsx`

**Interfaces:**
- Consumes: `ChatHistoryMirror` (Task 7), `ChatOlderPageState` (Task 8).
- Produces:
```ts
interface ChatScrollbackProps {
  readonly id: string;
  readonly records: readonly ChatRecordDto[];
  readonly agentLabel: string;
  readonly width: number;
  /** Records the client has NOT loaded: total minus loaded. Never negative. */
  readonly unloadedCount: number;
  /** True once the chat's first record is in the window (`prevCursor === null`). */
  readonly atStart: boolean;
  readonly olderPage: ChatOlderPageState;
  readonly onLoadOlder?: (event: MouseEvent) => void;
}
```
  `recordToChatRecordProps` is unchanged and stays exported.

§5.2: `maxRows`, `selectVisibleTail`, `recordRowCost` and `INDICATOR_ROWS` all go. §5.4: the indicator becomes the first row of the scroll content, and `N` counts unloaded records — not records scrolled out of view. That is the simplification the whole design turns on: the UI never computes how many records lie above the viewport edge, so it never reads `scrollTop`/`scrollHeight` to keep a label truthful.

- [ ] **Step 1: Write the failing tests**

`src/ui/chat/ui/ChatScrollback.test.tsx` already builds frames with `createHeadlessRenderer` plus the file-scoped `open` handle, and its `userRecord(overrides)` fixture takes a partial DTO. Keep that style. Delete every windowing case (they exercise `selectVisibleTail`, which no longer exists), add a local `const allText = (rows: StyledRun[][]) => rows.flat().map((r) => r.text).join("")` if the file has none, and add:

```tsx
describe("ChatScrollback (chat-scroll spec §5.2/§5.4)", () => {
  async function frameOf(props: Partial<ChatScrollbackProps>, h = 40) {
    const handle = await createHeadlessRenderer({ w: 60, h });
    open = handle;
    handle.mount(
      <ChatScrollback
        id="sb"
        records={[userRecord({ recordId: "r1", text: "hello" })]}
        agentLabel="claude"
        width={40}
        unloadedCount={0}
        atStart
        olderPage={{ kind: "idle" }}
        {...props}
      />,
    );
    await handle.render();
    return handle.capture();
  }

  test("renders every loaded record, with no row budget", async () => {
    const records = Array.from({ length: 60 }, (_, i) =>
      userRecord({ recordId: `r${i}`, text: `message ${i}` }),
    );
    const text = allText((await frameOf({ records }, 200)).rows);
    expect(text).toContain("message 0");
    expect(text).toContain("message 59");
  });

  test("the indicator counts UNLOADED records, not records off screen", async () => {
    const text = allText((await frameOf({ unloadedCount: 249, atStart: false })).rows);
    expect(text).toContain("249");
  });

  test("no indicator once the chat's start is loaded", async () => {
    expect(allText((await frameOf({})).rows)).not.toContain("earlier");
  });

  test("the loading state replaces the indicator's own label", async () => {
    const text = allText(
      (await frameOf({ unloadedCount: 249, atStart: false, olderPage: { kind: "loading" } })).rows,
    );
    expect(text).toContain(OLDER_LOADING_TEXT);
  });

  test("a failed load shows its own bounded message", async () => {
    const text = allText(
      (
        await frameOf({
          unloadedCount: 249,
          atStart: false,
          olderPage: { kind: "failed", safeMessage: "page unreadable" },
        })
      ).rows,
    );
    expect(text).toContain("page unreadable");
  });
});
```

`OLDER_LOADING_TEXT` is imported from the component (Step 3), so the test asserts the design's own string without restating it. The "no indicator" case's negative literal must match §11 answer 1 — if design renamed the row, assert the absence of *its* wording, not `"earlier"`.

- [ ] **Step 2: Run them to verify they fail**

```bash
rtk bun test src/ui/chat
```
Expected: FAIL — `unloadedCount` is not a prop; `maxRows` is required.

- [ ] **Step 3: Transcribe the design's literals**

Read the `design/` file spec §11 cites for answers 1, 4 and 5, and declare one exported constant per literal at the top of `ChatScrollback.tsx`, each citing its design line — the shape the file already uses for `RESTORE_SOURCE_COMMIT_DISPLAY_LENGTH`. For example, if §11 answer 1 keeps `▲ N earlier messages`:

```ts
/** Design iteration 10, answer 1 (`design/<file>:<line>`): the indicator's own label. */
function earlierMessagesText(count: number): string {
  return `▲ ${count} earlier ${count === 1 ? "message" : "messages"}`;
}
/** Design iteration 10, answer 1 (`design/<file>:<line>`): the indicator row's foreground. */
const INDICATOR_FG = SHELL_PALETTE.amberDim;
/** Design iteration 10, answer 4 (`design/<file>:<line>`). */
export const OLDER_LOADING_TEXT = "<the design's literal>";
/** Design iteration 10, answer 4 (`design/<file>:<line>`): the failure row's foreground. */
const OLDER_FAILED_FG = SHELL_PALETTE.red;
/** Design iteration 10, answer 5 (`design/<file>:<line>`); omit the constant if §11 defines none. */
export const CHAT_START_TEXT = "<the design's literal>";
/** Design iteration 10, answer 5 (`design/<file>:<line>`). */
const CHAT_START_FG = SHELL_PALETTE.faint;
```

Every value on the right-hand side above is a stand-in for what §11 names — `amberDim`, `red` and `faint` are what the *current* indicator and the existing failure surfaces use, and they are here to show the shape, not to be kept by default. **Do not choose a hue, a glyph or a string that §11 does not state.** If §11 leaves one of these cases undefined, stop and say so rather than filling it in — that is the gap-flagging rule `CLAUDE.md` states.

- [ ] **Step 4: Rewrite the component**

Delete `INDICATOR_ROWS`, `recordRowCost` and `selectVisibleTail` outright, and drop the `markdownLineRows` import if nothing else in the file uses it. The component becomes:

```tsx
/**
 * The persisted chat scrollback (design §3.2). A plain column of {@link ChatRecord}s over
 * EVERY loaded record, in arrival order — the row budget this component used to enforce is
 * gone, because the `<scrollbox>` the caller mounts it inside now clips (chat-scroll spec
 * §5.2). `Workspace.tsx` places this above the ephemeral `AgentStatusBlock`/collapsed record.
 *
 * The `▲ N earlier` row is CONTENT, not an overlay, and `N` counts records the client has not
 * loaded (§5.4) — never records scrolled above the viewport edge. That number is derivable
 * but is deliberately never computed: keeping it out means this component never reads a
 * scroll metric, and the row is simply what the user scrolls to and what triggers the next
 * page load. Adds no visual vocabulary of its own beyond the literals design iteration 10
 * defines above.
 */
export function ChatScrollback(props: ChatScrollbackProps) {
  const showIndicator = !props.atStart || props.olderPage.kind !== "idle";
  if (props.records.length === 0 && !showIndicator) return null;

  return (
    <box id={props.id} flexDirection="column">
      {showIndicator && (
        <box id={`${props.id}-earlier`} flexDirection="column" width={props.width}>
          <text
            id={`${props.id}-earlier-label`}
            fg={props.olderPage.kind === "failed" ? OLDER_FAILED_FG : INDICATOR_FG}
            attributes={shellAttrs({ bold: true })}
            onMouseDown={props.onLoadOlder}
          >
            {indicatorText(props)}
          </text>
        </box>
      )}
      {props.atStart && (
        <text id={`${props.id}-start`} fg={CHAT_START_FG}>
          {CHAT_START_TEXT}
        </text>
      )}
      {props.records.map((record) => {
        const recordProps = recordToChatRecordProps(record, props.agentLabel);
        return (
          // keyed intrinsic wrapper — function components carry no `key` in this repo's
          // no-@types/react environment (`runtime/ui/list.tsx`).
          <box key={record.recordId} id={`${recordProps.id}-wrap`}>
            <ChatRecord {...recordProps} />
          </box>
        );
      })}
    </box>
  );
}
```

with:

```ts
/** The one line the indicator row shows, chosen by the older-page latch (spec §6.6). */
function indicatorText(props: ChatScrollbackProps): string {
  if (props.olderPage.kind === "loading") return OLDER_LOADING_TEXT;
  if (props.olderPage.kind === "failed") return props.olderPage.safeMessage;
  return earlierMessagesText(props.unloadedCount);
}
```

Shape the markup to §11's answers — the block above is the structure (one row, three states, a mouse target, a start marker below it), not a licence to keep the old two-row `position="absolute"` layout if §11 draws something else. If §11 answer 2 defines a "newer messages below" indicator, it is a `boolean` prop `atBottom` on this component and one more conditional row, placed where §11 puts it; add it in this step.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
rtk bun test src/ui/chat
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
rtk git add src/ui/chat
rtk git commit -m "feat(ui): make the chat scrollback a plain column with a live earlier-messages row"
```

---

### Task 11: The `<scrollbox>` viewport replaces the row budget

**Files:**
- Modify: `src/ui/workspace/model/agent-block-budget.ts`
- Modify: `src/ui/workspace/ui/Workspace.tsx`
- Test: `src/ui/workspace/model/agent-block-budget.test.ts`, `src/ui/workspace/ui/Workspace.test.tsx`

**Interfaces:**
- Consumes: `ChatScrollback`'s new props (Task 10), `mirror.history()` (Task 7).
- Produces: `ws-chat-stream` contains a `<scrollbox id="ws-chat-scroll">`; `scrollbackMaxRows` no longer exists; `agentStatusMaxRows` takes `{ frameH, chromeRows }` only.

§5.1/§5.2/§5.3. `ws-chat-stream` keeps `overflow="hidden"` — it is the design's own clip (`Workspace.tsx:584-590`), not a defensive extra. `MAX_TIMELINE_ROWS = 11` stays: the 12-row cap is design semantics, stated outright in `design/03-workspace-generating.dc.html`, so the fold must not vary with terminal size.

§9's second risk: `agentStatusMaxRows` losing its sibling arithmetic changes an overflow guard added deliberately (a long reply overwriting the composer). Task 2's probe question 2 is what licenses this removal — **do not start this task until that probe passed.**

- [ ] **Step 1: Write the failing tests**

`src/ui/workspace/model/agent-block-budget.test.ts` — delete every `scrollbackMaxRows` case and replace the `agentStatusMaxRows` cases with:

```ts
describe("agentStatusMaxRows (chat-scroll spec §5.3)", () => {
  test("measures the panel and its own chrome, and nothing else", () => {
    expect(agentStatusMaxRows({ frameH: 30, chromeRows: 1 })).toBe(MAX_TIMELINE_ROWS);
    expect(agentStatusMaxRows({ frameH: 10, chromeRows: 1 })).toBe(7);
  });

  test("still clamps to the design's own floor and ceiling", () => {
    expect(agentStatusMaxRows({ frameH: 4, chromeRows: 1 })).toBe(3);
    expect(agentStatusMaxRows({ frameH: 200, chromeRows: 1 })).toBe(MAX_TIMELINE_ROWS);
  });
});
```

`src/ui/workspace/ui/Workspace.test.tsx`:

Introduce one setup helper in `Workspace.test.tsx`, used by this task's cases and reused verbatim by Task 12's:

```ts
const CHAT = uuidv7();

/** Puts a trusted, open project with `loaded` of `total` records on screen. */
function seedHistory(
  deps: UiDeps,
  input: { loaded: number; total: number; cursor: { generation: number; beforeOffset: number } | null },
): void {
  deps.mirror.apply(
    snapshot({ projectId: uuidv7(), activePageSlug: null, activeChatId: CHAT, trust: "trusted" }),
  );
  deps.mirror.apply(
    event("chat.changed", { activeChatId: CHAT, added: [], updated: [], removedChatIds: [] }),
  );
  deps.mirror.apply(
    event("chat.records", {
      chatId: CHAT,
      records: Array.from({ length: input.loaded }, (_, i) => chatUserRecord(`r${i}`, `message ${i}`)),
      prevCursor: input.cursor,
      totalRecordCount: input.total,
    }),
  );
}
```

`chatUserRecord(recordId, text)` is a small local DTO factory — copy the field set from `ChatScrollback.test.tsx`'s own `userRecord`; do not import a test helper across module test files.

```ts
describe("chat stream viewport (chat-scroll spec §5.1)", () => {
  test("a history longer than the panel is clipped to the viewport, not overdrawn", async () => {
    const deps = createUiDeps(createFakeKernel(), { w: 120, h: 36 });
    seedHistory(deps, { loaded: 80, total: 300, cursor: { generation: 1, beforeOffset: 400 } });
    const handle = await createHeadlessRenderer({ w: 120, h: 36 });
    open = handle;
    handle.mount(<Workspace deps={deps} />);
    await handle.render();
    const text = allText(handle.capture().rows);

    // Sticky bottom: the newest record is on screen, the oldest loaded one is not.
    expect(text).toContain("message 79");
    expect(text).not.toContain("message 0 ");
    // The composer survived — the defect the old row budget existed to prevent.
    expect(text).toContain("Ask for changes");
  });

  test("the indicator row carries the unloaded count", async () => {
    const deps = createUiDeps(createFakeKernel(), { w: 120, h: 36 });
    seedHistory(deps, { loaded: 80, total: 300, cursor: { generation: 1, beforeOffset: 400 } });
    const handle = await createHeadlessRenderer({ w: 120, h: 36 });
    open = handle;
    handle.mount(<Workspace deps={deps} />);
    await handle.render();
    // 300 on disk, 80 in the window — the row counts what is NOT loaded (spec §5.4), never
    // what is scrolled off screen.
    expect(allText(handle.capture().rows)).toContain("220");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

```bash
rtk bun test src/ui/workspace
```
Expected: FAIL — `agentStatusMaxRows` rejects the two-field argument; the indicator shows a dropped-record count, not 220.

- [ ] **Step 3: Shrink the budget module**

In `src/ui/workspace/model/agent-block-budget.ts`, delete `scrollbackMaxRows` entirely, delete `pinListRowCount` and `composerRowCount` **only if nothing else imports them** (check first — `deriveComposerAttach` or `PinList` may), and rewrite `agentStatusMaxRows`:

```ts
/**
 * The row budget `foldTurnTimeline` gets as `maxRows`.
 *
 * It used to subtract every sibling that shares `ws-chat-stream` — the panel border, the
 * `● agent` line, the persisted scrollback, the pin list, the composer — because nothing else
 * bounded the stream, and a long reply would paint straight over the composer. The
 * `<scrollbox>` now does that job by clipping (chat-scroll spec §5.2/§5.3), so this subtracts
 * only what physically cannot hold a timeline row inside the block's own frame: the panel
 * border and `AgentStatusBlock`'s own always-drawn chrome.
 *
 * `MAX_TIMELINE_ROWS` STAYS. The 12-row cap is design semantics, not crowding:
 * `design/03-workspace-generating.dc.html` states "The block is capped at 12 rows and folds
 * from the top. The spinner row is pinned." — so the fold must not vary with terminal size.
 * The `3` floor is the design's own smallest per-frame cap (`short`'s `liveCap:3`).
 */
export function agentStatusMaxRows(input: {
  readonly frameH: number;
  readonly chromeRows: number;
}): number {
  const available = input.frameH - CHAT_PANEL_BORDER_ROWS - input.chromeRows;
  return Math.max(3, Math.min(MAX_TIMELINE_ROWS, available));
}
```

- [ ] **Step 4: Mount the viewport**

In `Workspace.tsx`, delete the `scrollbackMaxRows` import and its call, delete the `liveBlockRows` computation that fed it, and shrink the `agentStatusMaxRows` call to `{ frameH, chromeRows: AGENT_BLOCK_CHROME_ROWS }`. Then wrap the stream's scrollable half:

```tsx
            <box id="ws-chat-stream" flexGrow={1} flexDirection="column" overflow="hidden">
              {agentLabel !== "" && (
                <text id="ws-chat-agent" fg={SHELL_PALETTE.green} attributes={BOLD}>
                  {`● ${agentLabel}`}
                </text>
              )}
              {/*
               * THE SCROLL VIEWPORT (chat-scroll spec §5.1). It owns everything between the
               * `● agent` presence line and the pin list: the persisted scrollback, the
               * preview notice, and whichever ephemeral block is on screen. Pinned OUTSIDE
               * it, deliberately: the `● agent` line (panel header, not a message), `PinList`
               * (attached composer context, not a message), the composer, the panel border.
               *
               * Follow-the-tail and its disengagement on manual scroll are the renderable's
               * OWN behavior (`stickyScroll` + `stickyStart`); this project implements
               * neither. The scrollbar is suppressed per design iteration 10, answer 3.
               */}
              <scrollbox
                id="ws-chat-scroll"
                ref={publishChatViewport}
                flexGrow={1}
                scrollY
                scrollX={false}
                stickyScroll
                stickyStart="bottom"
                scrollbarOptions={{ visible: false }}
              >
                <ChatScrollback
                  id="ws-scrollback"
                  records={records}
                  agentLabel={agentLabel}
                  width={chatContentWidth}
                  unloadedCount={Math.max(0, history.totalRecordCount - records.length)}
                  atStart={history.prevCursor === null}
                  olderPage={local.olderPage()}
                />
                {previewNotice !== null && (
                  <SystemNotice … unchanged … />
                )}
                {turn.phase === "running" && <AgentStatusBlock … unchanged … />}
                {turn.phase === "terminal" && <ChatRecord … unchanged … />}
              </scrollbox>
              <PinList id="ws-pins" pageSlug={activePageSlug ?? ""} pins={pinRows} />
            </box>
```

with `const history = mirror.history();` and `const records = history.records;` replacing the single read from Task 7, and `publishChatViewport` a `useWrap`-ed ref callback that for now only stores the renderable:

```tsx
  const viewportRef = useRef<ScrollBoxRenderable | null>(null);
  const publishChatViewport = useWrap((box: ScrollBoxRenderable | null) => {
    viewportRef.current = box;
  });
```

The adapter that fills `local.chatViewport` and the paging trigger land in Task 12. If `scrollbarOptions: { visible: false }` conflicts with §11 answer 3 (design DID define a scrollbar), transcribe that instead — the props are `scrollbarOptions`/`verticalScrollbarOptions` on the same element.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
rtk bun test src/ui/workspace
rtk bun test src/ui
```
Expected: PASS.

- [ ] **Step 6: Reatom audit, then commit**

```bash
/reatom-audit
```
```bash
rtk git add src/ui
rtk git commit -m "feat(ui): put the chat message stream inside a scrollbox viewport"
```

---

### Task 12: The viewport adapter and the paging trigger

**Gated on Task 2's finding 5 and on Task 1's §11.**

**Files:**
- Modify: `src/ui/workspace/ui/Workspace.tsx`
- Test: `src/ui/workspace/ui/Workspace.test.tsx`

**Interfaces:**
- Consumes: `ChatViewport` and `local.chatViewport` / `local.olderPage` (Task 8), the `chat.load-older` command (Task 6), `ChatScrollback.onLoadOlder` (Task 10).
- Produces: nothing new — this is the last wiring step.

§6.6. Three input routes reach the top edge — the wheel, `PgUp`, and a click on the indicator row — and all three funnel into one `maybeLoadOlder()`. Putting the check in that one function rather than relying on the widget to emit a scroll event is what makes every route testable without a real wheel.

- [ ] **Step 1: Write the failing tests**

```ts
describe("older-page paging (chat-scroll spec §6.6)", () => {
  test("reaching the top dispatches chat.load-older with the cursor the client was given", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    seedHistory(deps, { loaded: 20, total: 300, cursor: { generation: 1, beforeOffset: 400 } });
    const handle = await createHeadlessRenderer({ w: 120, h: 36 });
    open = handle;
    handle.mount(<Workspace deps={deps} />);
    await handle.render();

    deps.local.chatViewport()?.scrollByPage(-1);
    await handle.render();

    const sent = loadOlderCommands(kernel);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload).toEqual({ chatId: CHAT, cursor: { generation: 1, beforeOffset: 400 } });
    expect(deps.local.olderPage()).toEqual({ kind: "loading" });
  });

  test("a second request is latched out while one is in flight", async () => {
    const { deps, kernel } = await mounted({ cursor: { generation: 1, beforeOffset: 400 } });
    deps.local.chatViewport()?.scrollByPage(-1);
    deps.local.chatViewport()?.scrollByPage(-1);
    expect(loadOlderCommands(kernel)).toHaveLength(1);
  });

  test("no request once the chat's start is loaded", async () => {
    const { deps, kernel } = await mounted({ cursor: null });
    deps.local.chatViewport()?.scrollByPage(-1);
    expect(loadOlderCommands(kernel)).toHaveLength(0);
  });

  test("no request when the capability is unavailable (read-only project)", async () => {
    const { deps, kernel } = await mounted({
      cursor: { generation: 1, beforeOffset: 400 },
      loadOlderAvailable: false,
    });
    deps.local.chatViewport()?.scrollByPage(-1);
    expect(loadOlderCommands(kernel)).toHaveLength(0);
  });

  test("a refused dispatch clears the latch and records the failure", async () => {
    const { deps, handle, kernel } = await mounted({ cursor: { generation: 1, beforeOffset: 400 } });
    // `FakeKernel` has one dispatch-outcome override, `setDispatchResult` — there is no
    // per-kind rejection injector, and this test issues exactly one command.
    kernel.setDispatchResult({
      protocolVersion: 1,
      commandId: uuidv7(),
      status: "rejected",
      reason: { code: "CAPABILITY_UNAVAILABLE" },
    } as never);
    deps.local.chatViewport()?.scrollByPage(-1);
    await handle.render();
    expect(deps.local.olderPage().kind).toBe("failed");
  });

  test("the arriving page retires the latch", async () => {
    const { deps, handle } = await mounted({ cursor: { generation: 1, beforeOffset: 400 } });
    deps.local.chatViewport()?.scrollByPage(-1);
    deps.mirror.apply(
      event("chat.records.older", {
        chatId: CHAT,
        records: [chatUserRecord("r-old", "oldest")],
        prevCursor: null,
        totalRecordCount: 300,
        failure: null,
      }),
    );
    await handle.render();
    expect(deps.local.olderPage()).toEqual({ kind: "idle" });
  });

  test("a failed page shows its message and clears the latch", async () => {
    const { deps, handle } = await mounted({ cursor: { generation: 1, beforeOffset: 400 } });
    deps.local.chatViewport()?.scrollByPage(-1);
    deps.mirror.apply(
      event("chat.records.older", {
        chatId: CHAT,
        records: [],
        prevCursor: null,
        totalRecordCount: 0,
        failure: { code: "IO_ERROR", safeMessage: "page unreadable" },
      }),
    );
    await handle.render();
    expect(deps.local.olderPage()).toEqual({ kind: "failed", safeMessage: "page unreadable" });
    expect(allText(handle.capture().rows)).toContain("page unreadable");
  });
});
```

with two more helpers beside `seedHistory`. `FakeKernel.dispatched` is `readonly unknown[]` of raw command envelopes, so narrow rather than cast:

```tsx
type LoadOlderCommand = {
  readonly kind: "chat.load-older";
  readonly payload: { readonly chatId: string; readonly cursor: unknown };
};

function loadOlderCommands(kernel: FakeKernel): readonly LoadOlderCommand[] {
  return kernel.dispatched.filter(
    (raw): raw is LoadOlderCommand => (raw as { kind?: unknown }).kind === "chat.load-older",
  );
}

async function mounted(input: {
  cursor: { generation: number; beforeOffset: number } | null;
  loadOlderAvailable?: boolean;
}) {
  const kernel = createFakeKernel();
  const deps = createUiDeps(kernel, { w: 120, h: 36 });
  seedHistory(deps, { loaded: 80, total: 300, cursor: input.cursor });
  if (input.loadOlderAvailable === false) {
    deps.mirror.apply(
      event("kernel.capabilitiesChanged", {
        changed: [
          {
            command: "chat.load-older",
            state: { available: false, reasons: [{ code: "PROJECT_UNTRUSTED" }] },
          },
        ],
      }),
    );
  }
  const handle = await createHeadlessRenderer({ w: 120, h: 36 });
  open = handle;
  handle.mount(<Workspace deps={deps} />);
  await handle.render();
  return { deps, handle, kernel };
}
```

`seedHistory` and `CHAT` are the helpers Task 11 introduced in this same file — reuse them, do not write a second setup. `kernel.dispatched` stands for whatever `createFakeKernel` (`ui/testing/model/fake-kernel.ts`) already calls its recorded-command list; read that file and match its name and entry shape.

- [ ] **Step 2: Run them to verify they fail**

```bash
rtk bun test src/ui/workspace
```
Expected: FAIL — `deps.local.chatViewport()` is `null`; nothing dispatches.

- [ ] **Step 3: Publish the adapter**

In `Workspace.tsx`, replace Task 11's placeholder ref callback:

```tsx
  const viewportRef = useRef<ScrollBoxRenderable | null>(null);
  const pendingAnchor = useRef<number | null>(null);

  /**
   * Publishes the live `ScrollBoxRenderable` as a {@link ChatViewport} (chat-scroll spec
   * §5.5). `useWrap` because the callback writes a Reatom atom from React's commit phase —
   * outside any Reatom frame otherwise (RTM-C02).
   */
  const publishChatViewport = useWrap((box: ScrollBoxRenderable | null) => {
    viewportRef.current = box;
    if (box === null) {
      local.chatViewport.set(null);
      return;
    }
    local.chatViewport.set({
      scrollByPage(direction) {
        box.scrollBy({ x: 0, y: direction }, "viewport");
        maybeLoadOlder();
      },
      scrollToBottom() {
        box.scrollTo({ x: 0, y: box.scrollHeight });
      },
      atBottom() {
        return box.scrollTop + box.viewport.height >= box.scrollHeight;
      },
      anchorFromBottom() {
        return box.scrollHeight - box.scrollTop - box.viewport.height;
      },
      restoreAnchor(distanceFromBottom) {
        box.scrollTop = Math.max(0, box.scrollHeight - box.viewport.height - distanceFromBottom);
      },
    });
  });
```

- [ ] **Step 4: Write the trigger**

```tsx
  /** How close to the top edge counts as "at the top" — one row of slack, so a wheel step that
   *  lands at 1 rather than 0 still pages. */
  const TOP_TRIGGER_ROWS = 1;

  /**
   * The ONE paging trigger (chat-scroll spec §6.6), reached from all three routes: the wheel
   * (`onMouseScroll` below), the keyboard (the adapter's own `scrollByPage`), and a click on
   * the indicator row. Four guards, in the order they can refuse most cheaply.
   *
   * `withAsync` is deliberately NOT used here even though it is this project's default
   * (RTM-A02/A03), and the reason is worth stating: the operation does not complete when the
   * dispatch promise resolves — it completes when `chat.records.older` arrives. The dispatch
   * promise reports only whether the dispatcher itself refused, which is handled in the
   * established `.then(wrap(...))` form.
   */
  const maybeLoadOlder = useWrap(() => {
    const box = viewportRef.current;
    if (box === null) return;
    if (box.scrollTop > TOP_TRIGGER_ROWS) return;

    const held = mirror.history();
    if (held.prevCursor === null) return;
    if (local.olderPage().kind === "loading") return;

    const chatId = mirror.chats().activeChatId;
    if (chatId === null) return;
    // No affordance for an unavailable action: §7.1 fixes the untrusted-read-only exemption
    // list at three commands by name, so paging is genuinely unavailable there. Checking the
    // mirrored capability keeps the stream from showing a failure the user cannot act on.
    if (mirror.capabilities().get("chat.load-older")?.available !== true) return;

    pendingAnchor.current = box.scrollHeight - box.scrollTop - box.viewport.height;
    local.olderPage.set({ kind: "loading" });
    void dispatcher.dispatch("chat.load-older", { chatId, cursor: held.prevCursor }).then(
      wrap((result) => {
        if (result instanceof Error) {
          console.error("UI command dispatch failed:", result);
          local.olderPage.set({ kind: "failed", safeMessage: "the page could not be requested" });
          return;
        }
        if (result.status !== "accepted")
          local.olderPage.set({ kind: "failed", safeMessage: "the page could not be requested" });
      }),
    );
  });
```

The two `safeMessage` literals above are the dispatcher-refusal case, which §11 answer 4 covers alongside the load-failure case — use the literal §11 states there, not the placeholder above.

Wire the wheel and the click:

```tsx
              <scrollbox … onMouseScroll={maybeLoadOlder}>
                <ChatScrollback … onLoadOlder={maybeLoadOlder} />
```

- [ ] **Step 5: Retire the latch when the page arrives**

The mirror never writes UI-local atoms, so the Workspace retires its own latch from the two mirror facts a settled page moves: the window grew (success) or `lastOlderPageFailure` became non-null (failure). Both are read in one effect:

```tsx
  const recordCount = records.length;
  const olderFailure = mirror.lastOlderPageFailure();
  /**
   * Retires the older-page latch when the page settles (chat-scroll spec §6.6). Keyed on both
   * outcomes because a FAILED page changes no record count and a SUCCESSFUL one clears no
   * failure — one of the two always moves, and neither moves on its own for any other reason.
   */
  useEffect(() => {
    if (local.olderPage().kind !== "loading") return;
    local.olderPage.set(
      olderFailure === null
        ? { kind: "idle" }
        : { kind: "failed", safeMessage: olderFailure.safeMessage },
    );
  }, [recordCount, olderFailure]);
```

`mirror.lastOlderPageFailure` is declared and folded in Task 7 — this task only reads it.

- [ ] **Step 6: Position retention — branch on the probe's answer**

Read `docs/spikes/2026-08-03-scrollbox-findings.md`, answer 5.

**If the probe recorded "does not hold position"**, add to the effect above, before the `olderPage` write:

```tsx
    const anchor = pendingAnchor.current;
    const box = viewportRef.current;
    if (anchor !== null && box !== null) {
      pendingAnchor.current = null;
      box.scrollTop = Math.max(0, box.scrollHeight - box.viewport.height - anchor);
    }
```

and add the test:

```ts
  test("a prepended page keeps the reader where they were", async () => {
    // …seed, scroll to top, dispatch, apply an older page of 20 records…
    await handle.render();
    expect(allText(handle.capture().rows)).toContain("message 0");
  });
```

**If the probe recorded "holds position"**, do not add the restore. Delete `pendingAnchor` and its write in `maybeLoadOlder`, and add the same test above as an assertion that the widget's own behavior holds. `ChatViewport.anchorFromBottom`/`restoreAnchor` stay on the port either way — `applyIntent` does not use them, but they are the port's honest surface and the fake in Task 9's tests already implements them.

- [ ] **Step 7: Run the tests to verify they pass**

```bash
rtk bun test src/ui/workspace
rtk bun test src/ui
```
Expected: PASS.

- [ ] **Step 8: Reatom audit, then commit**

```bash
/reatom-audit
```
```bash
rtk git add src/ui
rtk git commit -m "feat(ui): page the chat history backwards from the top of the stream"
```

---

### Task 13: Architecture docs and the full-suite gate

**Files:**
- Modify: `docs/architecture/flows/chats.md`
- Modify: `docs/architecture/modules.md`
- Modify: `docs/superpowers/specs/2026-08-02-chat-scroll-design.md` (status line)
- Verify: everything

**Interfaces:**
- Consumes: every task above.
- Produces: docs that match the code, and a recorded verification run.

- [ ] **Step 1: Update the chats flow doc**

```bash
rtk grep -n "chat.records\|loadTail\|loadBefore" docs/architecture/flows/chats.md
```

The flow gained a leg: `chat.load-older` → `ChatReader.open` + `loadBefore` → `chat.records.older` → the mirror's prepend. Extend the doc's Mermaid diagram with it (the repo's docs use Mermaid for architecture), and update the `Source anchors` list to name `src/core/kernel/model/handlers/chat.ts`'s new handler and `src/ui/mirror/model/mirror.ts`'s two folds.

- [ ] **Step 2: Update the modules doc**

`src/ui/workspace/model/agent-block-budget.ts` lost an export; `src/ui/workspace/types.ts` gained a port. Reflect both wherever `modules.md` enumerates them.

- [ ] **Step 3: Mark the spec implemented**

```markdown
Status: implemented (2026-08-03) — see docs/superpowers/plans/2026-08-03-chat-scroll.md
```

- [ ] **Step 4: Run the whole suite, in the split the flake note requires**

```bash
rtk bun test src/core
rtk bun test src/store
rtk bun test src/host src/agent src/gate src/runtime src/infrastructure src/entities
rtk bun test src/ui
rtk bun test src/entrypoint
```

`src/ui` and `src/entrypoint` are deliberately separate invocations: combined runs flake with random failures under load. A run that crashes prints no `(fail)` lines and reads as clean — check each run actually reported a test count before believing it.

- [ ] **Step 5: Lint and format**

```bash
rtk npm run lint && rtk npm run fmt:check
```

- [ ] **Step 6: Final Reatom audit**

```bash
/reatom-audit
```

- [ ] **Step 7: Commit**

```bash
rtk git add docs
rtk git commit -m "docs(architecture): record the chat history paging leg"
```

---

## Known coverage gap

Stated rather than faked (§8): **the mouse-wheel path cannot be exercised end-to-end.** `createHeadlessRenderer` is built with `useMouse: false` (`src/host/render/model/renderer.ts:29`), so no test scrolls the real widget with a real wheel event. `maybeLoadOlder` is unit-tested through the keyboard and click routes, and the wheel route is one `onMouseScroll` prop away from those — but that prop's delivery is untested. Do not add a test that pretends otherwise.
