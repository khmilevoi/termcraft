import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";
import { SHELL_PALETTE } from "ui/theme";

import { renderedRowCount } from "../model/text-rows";
import { ChatRecord } from "./ChatRecord";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
});

const findRun = (frame: { rows: StyledRun[][] }, needle: string) =>
  frame.rows.flat().find((run) => run.text.includes(needle));

describe("ChatRecord component (design §3.2 markdown-lite chat record)", () => {
  test("a 'you' record header renders '❯ you' in amber bold", async () => {
    const handle = await createHeadlessRenderer({ w: 30, h: 2 });
    open = handle;
    handle.mount(<ChatRecord id="rec" role="you" agentLabel="" lines={[]} />);
    await handle.render();
    const frame = handle.capture();
    const header = findRun(frame, "❯ you");
    expect(header).toBeDefined();
    expect(header && extractRgb(header.fg)).toBe<string>(SHELL_PALETTE.amber);
    expect((header?.attrs ?? 0) & 1).toBe(1);
  });

  test("an 'agent' record header renders '● <agentLabel>' in green bold, driven by data", async () => {
    const handle = await createHeadlessRenderer({ w: 30, h: 2 });
    open = handle;
    handle.mount(<ChatRecord id="rec" role="agent" agentLabel="claude" lines={[]} />);
    await handle.render();
    const frame = handle.capture();
    const header = findRun(frame, "● claude");
    expect(header).toBeDefined();
    expect(header && extractRgb(header.fg)).toBe<string>(SHELL_PALETTE.green);
    expect((header?.attrs ?? 0) & 1).toBe(1);
  });

  test("a different agentLabel renders that exact name — nothing hardcoded", async () => {
    const handle = await createHeadlessRenderer({ w: 30, h: 2 });
    open = handle;
    handle.mount(<ChatRecord id="rec" role="agent" agentLabel="sonnet" lines={[]} />);
    await handle.render();
    const frame = handle.capture();
    expect(findRun(frame, "● sonnet")).toBeDefined();
    expect(findRun(frame, "● claude")).toBeUndefined();
  });

  test("an empty agentLabel renders the neutral '●' header, never an invented fallback", async () => {
    const handle = await createHeadlessRenderer({ w: 30, h: 2 });
    open = handle;
    handle.mount(<ChatRecord id="rec" role="agent" agentLabel="" lines={[]} />);
    await handle.render();
    const frame = handle.capture();
    const header = findRun(frame, "●");
    expect(header).toBeDefined();
    expect(header?.text).toBe("● ");
  });

  test("a bold span carries the bold attribute", async () => {
    const handle = await createHeadlessRenderer({ w: 30, h: 3 });
    open = handle;
    handle.mount(
      <ChatRecord
        id="rec"
        role="agent"
        agentLabel="claude"
        lines={[{ spans: [{ text: "created page main", bold: true }] }]}
      />,
    );
    await handle.render();
    const frame = handle.capture();
    const run = findRun(frame, "created page main");
    expect(run).toBeDefined();
    expect((run?.attrs ?? 0) & 1).toBe(1);
  });

  test("a code span renders in the amberHi inline-code accent, not bold", async () => {
    const handle = await createHeadlessRenderer({ w: 30, h: 3 });
    open = handle;
    handle.mount(
      <ChatRecord
        id="rec"
        role="agent"
        agentLabel="claude"
        lines={[{ spans: [{ text: "main/page.tsx", code: true, bold: true }] }]}
      />,
    );
    await handle.render();
    const frame = handle.capture();
    const run = findRun(frame, "main/page.tsx");
    expect(run).toBeDefined();
    expect(run && extractRgb(run.fg)).toBe<string>(SHELL_PALETTE.amberHi);
    expect((run?.attrs ?? 0) & 1).toBe(0);
  });

  test("a long line with an inline code span wraps as ONE text flow, not side-by-side columns", async () => {
    const handle = await createHeadlessRenderer({ w: 20, h: 6 });
    open = handle;
    handle.mount(
      <ChatRecord
        id="rec"
        role="agent"
        agentLabel="claude"
        lines={[{ spans: [{ text: "alpha beta gamma delta " }, { text: "code", code: true }] }]}
      />,
    );
    await handle.render();
    const frame = handle.capture();
    const rows = frame.rows
      .map((row) => row.map((run) => run.text).join(""))
      .filter((text) => text.trim() !== "");
    const body = rows.slice(1); // row 0 is the `● claude` header

    // The column-layout signature: each span becomes its own independently-wrapping flex
    // item, so the code span lands on the SAME row as the paragraph's first words.
    const codeRow = body.find((text) => text.includes("code"));
    expect(codeRow).toBeDefined();
    expect(codeRow).not.toContain("alpha");

    // And the line reads back in source order across the wrap.
    expect(body.join(" ").replace(/\s+/g, " ").trim()).toBe("alpha beta gamma delta code");
  });

  // The row budget (`ui/workspace/model/agent-block-budget.ts`) sizes the chat panel from
  // `renderedRowCount` alone — it cannot mount a renderer. These cases pin that model against
  // what the real renderer does, so an OpenTUI wrap change fails HERE instead of silently
  // under-budgeting the scrollback into overflowing the panel again.
  describe("renderedRowCount matches the renderer it models", () => {
    const CASES: readonly { readonly text: string; readonly width: number }[] = [
      { text: "alpha beta gamma delta epsilon zeta", width: 10 },
      { text: "alpha beta gamma delta epsilon zeta", width: 12 },
      { text: "alpha beta gamma delta epsilon zeta", width: 20 },
      { text: "Готово — исправлено по замечаниям Gate соберём", width: 14 },
      { text: "supercalifragilistic word", width: 8 },
      { text: "one", width: 10 },
      { text: "", width: 10 },
    ];

    for (const { text, width } of CASES) {
      test(`w=${width}: ${JSON.stringify(text.slice(0, 24))}`, async () => {
        const handle = await createHeadlessRenderer({ w: width, h: 40 });
        open = handle;
        handle.mount(
          <ChatRecord id="rec" role="agent" agentLabel="X" lines={[{ spans: [{ text }] }]} />,
        );
        await handle.render();
        // Row 0 is the `● X` header; the body is every row below it that the record painted.
        const painted = handle.capture().rows.map((row) =>
          row
            .map((run) => run.text)
            .join("")
            .trimEnd(),
        );
        const bodyRows = painted.slice(1, painted.findLastIndex((row) => row !== "") + 1);
        expect(Math.max(1, bodyRows.length)).toBe(renderedRowCount(text, width));
      });
    }
  });

  test("dim=true renders plain line text in the dim hue, not the default foreground", async () => {
    const handle = await createHeadlessRenderer({ w: 30, h: 3 });
    open = handle;
    handle.mount(
      <ChatRecord
        id="rec"
        role="agent"
        agentLabel="claude"
        dim
        lines={[{ spans: [{ text: "resources + processes" }] }]}
      />,
    );
    await handle.render();
    const frame = handle.capture();
    const run = findRun(frame, "resources + processes");
    expect(run).toBeDefined();
    expect(run && extractRgb(run.fg)).toBe<string>(SHELL_PALETTE.dim);
  });

  test("without dim, plain line text renders in the default foreground", async () => {
    const handle = await createHeadlessRenderer({ w: 30, h: 3 });
    open = handle;
    handle.mount(
      <ChatRecord
        id="rec"
        role="agent"
        agentLabel="claude"
        lines={[{ spans: [{ text: "resources + processes" }] }]}
      />,
    );
    await handle.render();
    const frame = handle.capture();
    const run = findRun(frame, "resources + processes");
    expect(run).toBeDefined();
    expect(run && extractRgb(run.fg)).toBe<string>(SHELL_PALETTE.fg);
  });
});
