import { afterEach, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";

import type { ScrollBoxRenderable } from "@opentui/core";

import type { StyledRun } from "host/protocol";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";

/** Same `@types/react`-free workaround as `Workspace.tsx`'s own `useRef` import — see that
 *  file's doc comment for why a plain `import { useState } from "react"` is a TS7016 error. */
type UseState = <T>(initial: T) => readonly [T, (value: T) => void];
const { useState } = createRequire(import.meta.url)("react") as { readonly useState: UseState };

/**
 * The `<scrollbox>` contract this feature stands on (chat-scroll spec §9). Nothing in `src/`
 * used the widget before this feature, so these five facts were unproven; they are asserted
 * here rather than assumed at the call site in `Workspace.tsx`.
 *
 * Tests 3 and 5 update `rows` through `StatefulProbe`'s own `useState`, never by calling
 * `mount()` a second time. `Workspace.tsx` never remounts its tree when `chat.records`/
 * `chat.records.older` arrive — a Reatom-subscribed hook re-renders the SAME mounted tree, and
 * that is the path these two tests must reproduce. A draft of this file called `mount()` again
 * to simulate "a new page arrived"; that goes through `@opentui/react`'s root-replace path,
 * which a diagnostic (5/5 deterministic reproductions) showed leaves `ScrollBoxRenderable`'s
 * `scrollHeight`/`content.height` stale after the second `mount()`, while the underlying Yoga
 * layout and the actual paint are both already correct. Testing through `mount()` twice
 * produced two false readings from that staleness: a spurious "sticky-bottom disengage fails on
 * a new tail row" result, and an uninterpretable "content frozen" result for the prepend
 * question. Driving the SAME mounted tree through `useState`, matching the real call site,
 * reproduces neither symptom — see `docs/spikes/2026-08-03-scrollbox-findings.md`.
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
    <box
      id="probe-frame"
      width={24}
      height={VIEWPORT_ROWS}
      flexDirection="column"
      overflow="hidden"
    >
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

/**
 * Same widget as `Probe`, but `rows` lives in local state so a later update flows through a
 * normal React re-render of the SAME mounted tree — see the module doc comment for why this
 * matters for tests 3 and 5.
 */
function StatefulProbe(props: {
  readonly initialRows: readonly string[];
  readonly onBox: (box: ScrollBoxRenderable | null) => void;
  readonly onSetRows: (setRows: (rows: readonly string[]) => void) => void;
}) {
  const [rows, setRows] = useState<readonly string[]>(props.initialRows);
  props.onSetRows(setRows);
  return <Probe rows={rows} onBox={props.onBox} />;
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

/** Like `mountProbe`, but also hands back the setter for a later same-tree update. */
async function mountStatefulProbe(rows: readonly string[]) {
  const handle = await createHeadlessRenderer({ w: 40, h: 12 });
  open = handle;
  let box: ScrollBoxRenderable | null = null;
  let setRows: ((rows: readonly string[]) => void) | null = null;
  handle.mount(
    <StatefulProbe
      initialRows={rows}
      onBox={(next) => (box = next)}
      onSetRows={(setter) => (setRows = setter)}
    />,
  );
  await handle.render();
  if (box === null) throw new Error("the scrollbox ref never resolved");
  if (setRows === null) throw new Error("setRows never captured");
  return {
    handle,
    box: box as ScrollBoxRenderable,
    setRows: setRows as (rows: readonly string[]) => void,
  };
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
    const { handle, box, setRows } = await mountStatefulProbe(labels(0, 40));
    expect(allText(handle.capture().rows)).toContain("row-39");

    box.scrollTo(0);
    await handle.render();
    expect(allText(handle.capture().rows)).toContain("row-0");

    // A same-tree update, not a second mount() — see the module doc comment.
    setRows(labels(0, 41));
    await handle.render();
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
    const { handle, box, setRows } = await mountStatefulProbe(labels(10, 30));
    box.scrollTo(0);
    await handle.render();
    const before = box.scrollTop;
    const heightBefore = box.scrollHeight;

    setRows(labels(0, 40));
    await handle.render();
    await handle.render();

    // Not a pass/fail assertion — the value this records is what Task 12 branches on.
    // `holds` means the widget compensated for the rows inserted above the viewport.
    const grew = box.scrollHeight - heightBefore;
    const holds = box.scrollTop === before + grew;
    console.log(
      `[probe] prepend: scrollTop ${before} -> ${box.scrollTop}, grew ${grew}, holds=${holds}`,
    );
    expect(typeof holds).toBe("boolean");
  });
});
