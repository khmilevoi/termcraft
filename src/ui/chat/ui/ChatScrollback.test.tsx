import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";
import { uuidv7 } from "infrastructure/uuid";
import type { ChatRecord as ChatRecordDto } from "ui/mirror";
import { SHELL_PALETTE } from "ui/theme";

import {
  CHAT_START_TEXT,
  ChatScrollback,
  type ChatScrollbackProps,
  OLDER_LOADING_TEXT,
  recordToChatRecordProps,
} from "./ChatScrollback";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
});

const findRowIndex = (rows: StyledRun[][], needle: string) =>
  rows.findIndex((row) => row.some((run) => run.text.includes(needle)));

const allText = (rows: StyledRun[][]) => rows.flat().map((r) => r.text).join("");

type UserRecordDto = Extract<ChatRecordDto, { kind: "user" }>;
type AgentRecordDto = Extract<ChatRecordDto, { kind: "agent" }>;

const userRecord = (overrides: Partial<UserRecordDto> = {}): ChatRecordDto => ({
  kind: "user",
  recordId: uuidv7(),
  turnId: uuidv7(),
  text: "build a system monitor with cpu / mem gauges",
  selection: null,
  pins: [],
  ts: "2026-07-22T00:00:00.000Z",
  ...overrides,
});

const agentRecord = (overrides: Partial<AgentRecordDto> = {}): ChatRecordDto => ({
  kind: "agent",
  recordId: uuidv7(),
  turnId: uuidv7(),
  text: "created **page main**",
  changedPages: ["main"],
  warnings: [],
  ts: "2026-07-22T00:00:01.000Z",
  ...overrides,
});

describe("recordToChatRecordProps (WP-10 Task 8 — the M11 handoff mapping)", () => {
  test("a user record maps to role 'you', dim, and its text flattened through markdown-lite", () => {
    const record = userRecord({ text: "plain user text" });
    const props = recordToChatRecordProps(record, "claude");
    expect(props.role).toBe("you");
    expect(props.dim).toBe(true);
    expect(props.lines).toEqual([{ spans: [{ text: "plain user text" }] }]);
  });

  test("a user record omits agentLabel entirely — it is unused for role 'you' (review finding Minor)", () => {
    const record = userRecord();
    const props = recordToChatRecordProps(record, "claude");
    expect(props.agentLabel).toBeUndefined();
    expect(Object.hasOwn(props, "agentLabel")).toBe(false);
  });

  test("an agent record maps to role 'agent', keeps markdown-lite bold spans, and carries agentLabel", () => {
    const record = agentRecord({ text: "created **page main**" });
    const props = recordToChatRecordProps(record, "claude");
    expect(props.role).toBe("agent");
    expect(props.agentLabel).toBe("claude");
    expect(props.lines).toEqual([
      { spans: [{ text: "created " }, { text: "page main", bold: true }] },
    ]);
  });

  test("system:error and system:cancelled records render their own text as an agent-role record", () => {
    const errorRecord: ChatRecordDto = {
      kind: "system:error",
      recordId: uuidv7(),
      turnId: uuidv7(),
      actionId: null,
      outcome: "error",
      reason: null,
      text: "✗ turn failed",
      ts: "2026-07-22T00:00:02.000Z",
    };
    const cancelledRecord: ChatRecordDto = {
      kind: "system:cancelled",
      recordId: uuidv7(),
      turnId: uuidv7(),
      actionId: null,
      text: "✗ cancelled",
      ts: "2026-07-22T00:00:03.000Z",
    };
    expect(recordToChatRecordProps(errorRecord, "claude").role).toBe("agent");
    expect(recordToChatRecordProps(errorRecord, "claude").lines).toEqual([
      { spans: [{ text: "✗ turn failed" }] },
    ]);
    expect(recordToChatRecordProps(cancelledRecord, "claude").role).toBe("agent");
    expect(recordToChatRecordProps(cancelledRecord, "claude").lines).toEqual([
      { spans: [{ text: "✗ cancelled" }] },
    ]);
  });

  test("system:restore renders the design's 7-char short hash, not the full sourceCommit (review finding Minor)", () => {
    const restoreRecord: ChatRecordDto = {
      kind: "system:restore",
      recordId: uuidv7(),
      restoreActionId: uuidv7(),
      pageSlug: "main",
      sourceCommit: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      ts: "2026-07-22T00:00:04.000Z",
    };
    const props = recordToChatRecordProps(restoreRecord, "claude");
    expect(props.role).toBe("agent");
    expect(props.lines).toEqual([{ spans: [{ text: "⟲ restored main from a1b2c3d" }] }]);
  });

  test("two records with the same recordId map to the same id — the M11 handoff needs a stable, derived id", () => {
    const recordId = uuidv7();
    const a = recordToChatRecordProps(userRecord({ recordId }), "claude");
    const b = recordToChatRecordProps(userRecord({ recordId }), "claude");
    expect(a.id).toBe(b.id);
  });
});

describe("ChatScrollback (design §3.2 — persisted records above the ephemeral block)", () => {
  test("renders a user record then an agent record, in order, each as a ChatRecord", async () => {
    const records = [
      userRecord({ text: "build a system monitor" }),
      agentRecord({ text: "created **page main**" }),
    ];
    const handle = await createHeadlessRenderer({ w: 60, h: 10 });
    open = handle;
    handle.mount(
      <ChatScrollback
        id="scrollback"
        records={records}
        agentLabel="claude"
        width={58}
        unloadedCount={0}
        atStart
        olderPage={{ kind: "idle" }}
      />,
    );
    await handle.render();
    const rows = handle.capture().rows;

    const youRow = findRowIndex(rows, "❯ you");
    const agentRow = findRowIndex(rows, "● claude");
    const userTextRow = findRowIndex(rows, "build a system monitor");
    const boldRow = findRowIndex(rows, "page main");
    expect(youRow).toBeGreaterThanOrEqual(0);
    expect(agentRow).toBeGreaterThan(youRow);
    expect(userTextRow).toBeGreaterThan(youRow);
    expect(userTextRow).toBeLessThan(agentRow);
    expect(boldRow).toBeGreaterThan(agentRow);

    const boldRun = rows[boldRow]?.find((run) => run.text.includes("page main"));
    expect((boldRun?.attrs ?? 0) & 1).toBe(1);
  });

  test("renders nothing for an empty tail with nothing to say", async () => {
    const handle = await createHeadlessRenderer({ w: 60, h: 10 });
    open = handle;
    handle.mount(
      <ChatScrollback
        id="scrollback"
        records={[]}
        agentLabel="claude"
        width={58}
        unloadedCount={0}
        atStart
        olderPage={{ kind: "idle" }}
      />,
    );
    await handle.render();
    const rows = handle.capture().rows;
    expect(rows.flat().every((run) => run.text.trim() === "")).toBe(true);
  });
});

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

  // Design iteration 10, answer 4 (design/termcraft-engine.js:1505-1506): the failed state is
  // TWO separate rows, not one string folded together — the bounded message (red, bold) then
  // the fixed "PgUp retries" hint (faint, not bold) on the row directly beneath it. The test
  // above only checks the message text is present; this locks the exact two-row shape and
  // styling so a regression that merges them back into one line, or swaps a color/weight,
  // fails loudly instead of silently passing the looser `toContain` check.
  test("a failed load renders the message bold-red and 'PgUp retries' faint on its own row beneath it", async () => {
    const { rows } = await frameOf({
      unloadedCount: 249,
      atStart: false,
      olderPage: { kind: "failed", safeMessage: "page unreadable" },
    });
    const messageRow = findRowIndex(rows, "page unreadable");
    const retryRow = findRowIndex(rows, "PgUp retries");
    expect(messageRow).toBeGreaterThanOrEqual(0);
    expect(retryRow).toBe(messageRow + 1);

    const messageRun = rows[messageRow]?.find((run) => run.text.includes("page unreadable"));
    expect(messageRun && extractRgb(messageRun.fg)).toBe<string>(SHELL_PALETTE.red);
    expect((messageRun?.attrs ?? 0) & 1).toBe(1);

    const retryRun = rows[retryRow]?.find((run) => run.text.includes("PgUp retries"));
    expect(retryRun && extractRgb(retryRun.fg)).toBe<string>(SHELL_PALETTE.faint);
    expect((retryRun?.attrs ?? 0) & 1).toBe(0);
  });

  // Design iteration 10, answer 1 (design/termcraft-engine.js:1502-1503): the "more" state pins
  // a second, un-bold `▲` mark at the row's right edge alongside the bold label — a second
  // visual cue the plan's dispatch explicitly asked to reproduce rather than silently drop.
  test("the 'more' state pins a second, un-bold ▲ mark at the row's right edge", async () => {
    const { rows } = await frameOf({ unloadedCount: 8, atStart: false });
    const labelRow = findRowIndex(rows, "8 earlier messages");
    expect(labelRow).toBeGreaterThanOrEqual(0);

    const markRun = rows[labelRow]?.find((run) => run.text.trim() === "▲");
    expect(markRun).toBeDefined();
    expect(markRun && extractRgb(markRun.fg)).toBe<string>(SHELL_PALETTE.amberDim);
    expect((markRun?.attrs ?? 0) & 1).toBe(0);
  });

  // Design iteration 10, answer 5 (design/termcraft-engine.js:1507): the chat-start marker is
  // faint, never bold, and renders alongside no indicator (§11 answer 1's "more" state and the
  // "start" state are mutually exclusive in practice — reaching the true start means nothing is
  // left unloaded above).
  test("the start marker renders the design's exact literal, faint, and not bold", async () => {
    const { rows } = await frameOf({});
    const startRow = findRowIndex(rows, CHAT_START_TEXT);
    expect(startRow).toBeGreaterThanOrEqual(0);

    const startRun = rows[startRow]?.find((run) => run.text.includes(CHAT_START_TEXT));
    expect(startRun && extractRgb(startRun.fg)).toBe<string>(SHELL_PALETTE.faint);
    expect((startRun?.attrs ?? 0) & 1).toBe(0);
  });
});
