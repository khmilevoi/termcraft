import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { BACKUP_VERIFIED_FILENAME } from "store/migration";

import { createStore, nodeStoreDeps } from "./factory";

const scratchRoots: string[] = [];
afterEach(() => {
  while (scratchRoots.length > 0) {
    const root = scratchRoots.pop();
    if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
  }
});

/** A project root holding a real version-1 `.termcraft`, plus its own user-state root. */
function seedV1Project(slugs: readonly string[] = ["dashboard", "calendar"]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tc-migrate-"));
  const userStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tc-migrate-state-"));
  scratchRoots.push(root, userStateRoot);
  const termcraftDir = path.join(root, ".termcraft");
  fs.mkdirSync(termcraftDir);
  fs.writeFileSync(
    path.join(termcraftDir, "project.toml"),
    [
      "format_version = 1",
      'project_id = "019fa002-5f5b-7000-92e3-9931eebd6c52"',
      'name = "clock"',
      'created_at = "2026-07-26T19:58:57.883Z"',
      'target_stack = "js-opentui"',
      `pages = [${slugs.map((slug) => `"${slug}"`).join(", ")}]`,
      "",
    ].join("\n"),
  );
  for (const slug of slugs) {
    fs.mkdirSync(path.join(termcraftDir, "pages", slug), { recursive: true });
    fs.writeFileSync(
      path.join(termcraftDir, "pages", slug, "page.tsx"),
      `export const meta = { title: "${slug}" };\n`,
    );
  }
  return {
    root,
    userStateRoot,
    termcraftDir,
    store: createStore(nodeStoreDeps({ userStateRoot })),
  };
}

describe("Store.planMigration (design-tree §12.1's offer)", () => {
  test("describes the change without writing anything", async () => {
    const seeded = seedV1Project();
    const before = fs.readdirSync(seeded.termcraftDir).sort();
    const plan = await seeded.store.planMigration(seeded.root);
    if (plan instanceof Error) throw plan;
    expect(plan.pageCount).toBe(2);
    expect(plan.pinLogCount).toBe(0);
    expect(plan.fromVersion).toBe(1);
    expect(plan.toVersion).toBe(2);
    expect(fs.readdirSync(seeded.termcraftDir).sort()).toEqual(before);
  });

  test("refuses a project that is already format 2", async () => {
    const seeded = seedV1Project([]);
    fs.writeFileSync(
      path.join(seeded.termcraftDir, "project.toml"),
      fs
        .readFileSync(path.join(seeded.termcraftDir, "project.toml"), "utf8")
        .replace("format_version = 1", "format_version = 2")
        .replace("pages = []\n", ""),
    );
    expect(await seeded.store.planMigration(seeded.root)).toBeInstanceOf(Error);
  });
});

describe("Store.migrateProject (design-tree §12.2 track 1)", () => {
  test("leaves a project openable on format 2", async () => {
    const seeded = seedV1Project();
    const outcome = await seeded.store.migrateProject(seeded.root);
    if (outcome instanceof Error) throw outcome;

    const opened = await seeded.store.openProject(seeded.root);
    if (opened instanceof Error) throw opened;
    await opened.close();
  });

  test("moves every page into the design tree and retires the old directory", async () => {
    const seeded = seedV1Project();
    const outcome = await seeded.store.migrateProject(seeded.root);
    if (outcome instanceof Error) throw outcome;

    expect(fs.existsSync(path.join(seeded.termcraftDir, "design", "pages", "dashboard.tsx"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(seeded.termcraftDir, "design", "pages.json"))).toBe(true);
    expect(fs.existsSync(path.join(seeded.termcraftDir, "pages", "dashboard", "page.tsx"))).toBe(
      false,
    );
  });

  test("writes a VERIFIED backup outside .termcraft before rewriting anything", async () => {
    const seeded = seedV1Project();
    const outcome = await seeded.store.migrateProject(seeded.root);
    if (outcome instanceof Error) throw outcome;

    expect(outcome.backupDir.startsWith(seeded.userStateRoot)).toBe(true);
    expect(outcome.backupDir.includes(".termcraft")).toBe(false);
    expect(fs.existsSync(path.join(outcome.backupDir, BACKUP_VERIFIED_FILENAME))).toBe(true);
    // The backup holds the OLD paths verbatim, so a restore is a plain copy back.
    expect(fs.existsSync(path.join(outcome.backupDir, "pages", "dashboard", "page.tsx"))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(outcome.backupDir, "project.toml"))).toBe(true);
  });

  test("preserves each page's bytes exactly", async () => {
    const seeded = seedV1Project(["dashboard"]);
    const before = fs.readFileSync(
      path.join(seeded.termcraftDir, "pages", "dashboard", "page.tsx"),
    );
    const outcome = await seeded.store.migrateProject(seeded.root);
    if (outcome instanceof Error) throw outcome;
    const after = fs.readFileSync(
      path.join(seeded.termcraftDir, "design", "pages", "dashboard.tsx"),
    );
    expect(after).toEqual(before);
  });

  test("a second migrateProject on an already-migrated project refuses", async () => {
    const seeded = seedV1Project(["dashboard"]);
    const first = await seeded.store.migrateProject(seeded.root);
    if (first instanceof Error) throw first;
    expect(await seeded.store.migrateProject(seeded.root)).toBeInstanceOf(Error);
  });

  test("migrates a pin log to pins/<slug>.jsonl", async () => {
    const seeded = seedV1Project(["dashboard"]);
    fs.writeFileSync(
      path.join(seeded.termcraftDir, "pages", "dashboard", "comments.jsonl"),
      '{"kind":"header"}\n',
    );
    const outcome = await seeded.store.migrateProject(seeded.root);
    if (outcome instanceof Error) throw outcome;
    expect(fs.readFileSync(path.join(seeded.termcraftDir, "pins", "dashboard.jsonl"), "utf8")).toBe(
      '{"kind":"header"}\n',
    );
  });
});
