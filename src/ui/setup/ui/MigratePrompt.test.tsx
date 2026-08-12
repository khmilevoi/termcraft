import { afterEach, describe, expect, test } from "bun:test";

import type { StyledRun } from "host/protocol";
import { extractRgb } from "host/render/model/color";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";
import { SHELL_PALETTE } from "ui/theme";

import { MigratePrompt, migrateBullets } from "./MigratePrompt";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
});

const findRun = (frame: { rows: StyledRun[][] }, needle: string) =>
  frame.rows.flat().find((run) => run.text.includes(needle));

const VIEW = {
  fromVersion: 1,
  toVersion: 3,
  pageCount: 2,
  pinLogCount: 0,
  seedsDesignSystem: true,
  backupsDir: "C:\\Users\\dev\\AppData\\Local\\termcraft\\backups\\019fa002",
};

async function draw(props: { working?: boolean } = {}) {
  const handle = await createHeadlessRenderer({ w: 80, h: 24 });
  open = handle;
  handle.mount(
    <MigratePrompt id="mig" width={80} height={24} view={VIEW} working={props.working ?? false} />,
  );
  await handle.render();
  return handle.capture();
}

describe("migrateBullets (design §12.1's real plan, in the mock's three lines)", () => {
  test("names the pages, the synthesized manifest, the rewritten project.toml and the seeded design system", () => {
    expect(migrateBullets(VIEW)).toEqual([
      "2 pages → design/pages/<slug>.tsx",
      "design/pages.json ← the order in project.toml",
      "project.toml → format_version 3",
      "design/system/ ← the default design system",
    ]);
  });

  test("folds the pin logs into the third line when there are any", () => {
    expect(migrateBullets({ ...VIEW, pinLogCount: 3 })[2]).toBe(
      "3 pin logs → pins/<slug>.jsonl · project.toml → format_version 3",
    );
  });

  test("uses the singular for one page and one pin log", () => {
    const bullets = migrateBullets({ ...VIEW, pageCount: 1, pinLogCount: 1 });
    expect(bullets[0]).toBe("1 page → design/pages/<slug>.tsx");
    expect(bullets[2]).toBe("1 pin log → pins/<slug>.jsonl · project.toml → format_version 3");
  });

  test("the version-2 origin draws sources-untouched bullets and no moves", () => {
    const v2View = { ...VIEW, fromVersion: 2, pageCount: 4, pinLogCount: 0 };
    expect(migrateBullets(v2View)).toEqual([
      "4 pages — sources untouched",
      "design/system/ ← the default design system",
      "project.toml → format_version 3",
    ]);
  });

  test("the version-2 origin says 'already present' when seedsDesignSystem is false", () => {
    const v2View = { ...VIEW, fromVersion: 2, seedsDesignSystem: false };
    expect(migrateBullets(v2View)[1]).toBe("design/system/ — already present");
  });
});

describe("MigratePrompt (design/16-wizard-migration.dc.html)", () => {
  test("titles the box 'migrate project' in amberHi", async () => {
    const run = findRun(await draw(), "migrate project");
    expect(run).toBeDefined();
    expect(run && extractRgb(run.fg)).toBe<string>(SHELL_PALETTE.amberHi);
  });

  test("draws the warning line verbatim, in amberHi bold", async () => {
    const run = findRun(await draw(), "⚠ opened a project from an older termcraft");
    expect(run).toBeDefined();
    expect(run && extractRgb(run.fg)).toBe<string>(SHELL_PALETTE.amberHi);
    expect((run?.attrs ?? 0) & 1).toBe(1);
  });

  test("draws the 'will migrate to the current format:' lead-in, dim", async () => {
    const run = findRun(await draw(), "will migrate to the current format:");
    expect(run && extractRgb(run.fg)).toBe<string>(SHELL_PALETTE.dim);
  });

  test("draws the git-history note verbatim, in faint", async () => {
    const run = findRun(
      await draw(),
      "git history is left untouched — only current sources migrate",
    );
    expect(run).toBeDefined();
    expect(run && extractRgb(run.fg)).toBe<string>(SHELL_PALETTE.faint);
  });

  test("shows the REAL backup directory, not the mock's .termcraft path", async () => {
    const frame = await draw();
    expect(findRun(frame, "backups")).toBeDefined();
    expect(findRun(frame, ".termcraft/backup-")).toBeUndefined();
  });

  test("offers both keys when idle", async () => {
    const frame = await draw();
    const migrate = findRun(frame, "⏎ migrate");
    expect(migrate && extractRgb(migrate.fg)).toBe<string>(SHELL_PALETTE.amber);
    expect((migrate?.attrs ?? 0) & 1).toBe(1);
    expect(findRun(frame, "esc later")).toBeDefined();
  });

  test("replaces the key row with the working indicator while migrating", async () => {
    const frame = await draw({ working: true });
    expect(findRun(frame, "migrating")).toBeDefined();
    expect(findRun(frame, "⏎ migrate")).toBeUndefined();
    expect(findRun(frame, "esc later")).toBeUndefined();
  });
});
