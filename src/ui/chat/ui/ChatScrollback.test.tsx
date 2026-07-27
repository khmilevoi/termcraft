import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";
import { uuidv7 } from "infrastructure/uuid";
import type { ChatRecord as ChatRecordDto } from "ui/mirror";
import { SHELL_PALETTE } from "ui/theme";

import { ChatScrollback, recordToChatRecordProps } from "./ChatScrollback";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
});

const findRowIndex = (rows: StyledRun[][], needle: string) =>
  rows.findIndex((row) => row.some((run) => run.text.includes(needle)));

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
        maxRows={10}
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

  test("renders nothing for an empty tail", async () => {
    const handle = await createHeadlessRenderer({ w: 60, h: 10 });
    open = handle;
    handle.mount(
      <ChatScrollback id="scrollback" records={[]} agentLabel="claude" width={58} maxRows={10} />,
    );
    await handle.render();
    const rows = handle.capture().rows;
    expect(rows.flat().every((run) => run.text.trim() === "")).toBe(true);
  });
});

describe("ChatScrollback row budget (design chatSeq o.scrollback, termcraft-engine.js:569)", () => {
  const three = () => [
    userRecord({ text: "oldest" }),
    agentRecord({ text: "middle" }),
    userRecord({ text: "newest" }),
  ];

  test("renders every record and no indicator when the tail fits", async () => {
    const handle = await createHeadlessRenderer({ w: 60, h: 12 });
    open = handle;
    handle.mount(
      <ChatScrollback
        id="scrollback"
        records={three()}
        agentLabel="claude"
        width={58}
        maxRows={12}
      />,
    );
    await handle.render();
    const rows = handle.capture().rows;
    expect(findRowIndex(rows, "oldest")).toBeGreaterThanOrEqual(0);
    expect(findRowIndex(rows, "newest")).toBeGreaterThanOrEqual(0);
    expect(findRowIndex(rows, "earlier message")).toBe(-1);
  });

  test("drops the OLDEST records and keeps the newest when the tail does not fit", async () => {
    const handle = await createHeadlessRenderer({ w: 60, h: 12 });
    open = handle;
    // Each record costs 2 rows (header + one body line); 4 rows holds the indicator block (2)
    // plus exactly one record.
    handle.mount(
      <ChatScrollback
        id="scrollback"
        records={three()}
        agentLabel="claude"
        width={58}
        maxRows={4}
      />,
    );
    await handle.render();
    const rows = handle.capture().rows;
    expect(findRowIndex(rows, "newest")).toBeGreaterThanOrEqual(0);
    expect(findRowIndex(rows, "oldest")).toBe(-1);
    expect(findRowIndex(rows, "middle")).toBe(-1);
  });

  test("names how many records it dropped, in the design's own amberDim bold indicator", async () => {
    const handle = await createHeadlessRenderer({ w: 60, h: 12 });
    open = handle;
    handle.mount(
      <ChatScrollback
        id="scrollback"
        records={three()}
        agentLabel="claude"
        width={58}
        maxRows={4}
      />,
    );
    await handle.render();
    const rows = handle.capture().rows;
    const indicatorRow = findRowIndex(rows, "2 earlier messages");
    expect(indicatorRow).toBeGreaterThanOrEqual(0);
    const run = rows[indicatorRow]?.find((entry) => entry.text.includes("earlier messages"));
    expect(run && extractRgb(run.fg)).toBe<string>(SHELL_PALETTE.amberDim);
    expect((run?.attrs ?? 0) & 1).toBe(1);
  });

  test("never spends more rows than its budget", async () => {
    const handle = await createHeadlessRenderer({ w: 60, h: 20 });
    open = handle;
    handle.mount(
      <ChatScrollback
        id="scrollback"
        records={three()}
        agentLabel="claude"
        width={58}
        maxRows={4}
      />,
    );
    await handle.render();
    const rows = handle.capture().rows.map((row) =>
      row
        .map((run) => run.text)
        .join("")
        .trimEnd(),
    );
    expect(rows.findLastIndex((row) => row !== "") + 1).toBeLessThanOrEqual(4);
  });
});
