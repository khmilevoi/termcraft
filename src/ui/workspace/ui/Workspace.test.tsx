import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";
import { uuidv7 } from "infrastructure/uuid";
import { createUiDeps } from "ui/app";
import { createFakeKernel, snapshot } from "ui/testing";
import { SHELL_PALETTE } from "ui/theme";

import { Workspace } from "./Workspace";

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
const findRun = (rows: StyledRun[][], needle: string) =>
  rows.flat().find((run) => run.text.includes(needle));

describe("Workspace read-only presentation", () => {
  test("disables composer affordances and uses only approved read-only vocabulary/colors", async () => {
    const deps = createUiDeps(createFakeKernel(), { w: 120, h: 36 });
    deps.mirror.apply(
      snapshot({
        projectId: uuidv7(),
        activePageSlug: null,
        activeChatId: uuidv7(),
        trust: "untrusted-read-only",
      }),
    );
    const handle = await createHeadlessRenderer({ w: 120, h: 36 });
    open = handle;
    handle.mount(<Workspace deps={deps} readOnly />);
    await handle.render();
    const rows = handle.capture().rows;
    const text = allText(rows);
    expect(text).toContain("READ-ONLY");
    expect(text).toContain("Send · Tweaks · pins disabled");
    expect(text).toContain("read-only — Send disabled");
    expect(text).not.toContain("█");
    const attach = findRun(rows, "read-only — Send disabled");
    expect(attach && extractRgb(attach.fg)).toBe(SHELL_PALETTE.red);
  });
});
