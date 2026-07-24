import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";
import { uuidv7 } from "infrastructure/uuid";
import type { ChatRecord as ChatRecordDto } from "ui/mirror";

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
    expect(props.agentLabel).toBe("claude");
    expect(props.lines).toEqual([{ spans: [{ text: "plain user text" }] }]);
  });

  test("an agent record maps to role 'agent' and keeps markdown-lite bold spans", () => {
    const record = agentRecord({ text: "created **page main**" });
    const props = recordToChatRecordProps(record, "claude");
    expect(props.role).toBe("agent");
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
    handle.mount(<ChatScrollback id="scrollback" records={records} agentLabel="claude" />);
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
    handle.mount(<ChatScrollback id="scrollback" records={[]} agentLabel="claude" />);
    await handle.render();
    const rows = handle.capture().rows;
    expect(rows.flat().every((run) => run.text.trim() === "")).toBe(true);
  });
});
