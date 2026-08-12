import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { BACKUP_VERIFIED_FILENAME } from "store/migration";
import { TRANSACTIONS_LOCAL_DIR } from "store/transaction";

import { createDesignSystemSeedFiles } from "./design-system-seed";
import { createStore, nodeStoreDeps } from "./factory";

const FIXTURE = path.join(import.meta.dir, "..", "..", "..", "test-fixtures", "format-v1-project");

const scratchRoots: string[] = [];
afterEach(() => {
  while (scratchRoots.length > 0) {
    const root = scratchRoots.pop();
    if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
  }
});

/** Every file under `dir`, as `relPath -> bytes`, with the noise both trees carry excluded. */
function readTree(dir: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const walk = (current: string, prefix: string) => {
    for (const entry of fs
      .readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      // `lock` is the lease file, `export/` holds generation artifacts a migration never touches,
      // and `transactions.local/` is the journal the migration itself just wrote. None is part of
      // the migrated PORTABLE state this test compares.
      if (rel === "lock" || rel.startsWith("export/") || rel.startsWith("transactions.local/"))
        continue;
      if (entry.isDirectory()) walk(path.join(current, entry.name), rel);
      else files.set(rel, fs.readFileSync(path.join(current, entry.name)));
    }
  };
  walk(dir, "");
  return files;
}

/** A fresh project root + user-state root pair, with `scratchRoots` cleanup registered. */
function freshRoots(prefix: string): { readonly root: string; readonly userStateRoot: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const userStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-state-`));
  scratchRoots.push(root, userStateRoot);
  return { root, userStateRoot };
}

/**
 * A hand-built format-2 `.termcraft`: the multi-file design tree already in place (§9's whole
 * premise for this origin — the 2 -> 3 step relocates nothing), with `design/system/` absent so
 * the migration has something to seed.
 */
function seedFormatTwoProject(root: string, slugs: readonly string[] = ["dashboard"]): void {
  const termcraftDir = path.join(root, ".termcraft");
  fs.mkdirSync(path.join(termcraftDir, "design", "pages"), { recursive: true });
  fs.writeFileSync(
    path.join(termcraftDir, "project.toml"),
    [
      "format_version = 2",
      'project_id = "019fa002-5f5b-7000-92e3-9931eebd6c53"',
      'name = "seeded-v2"',
      'created_at = "2026-07-26T19:58:57.883Z"',
      'target_stack = "js-opentui"',
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(termcraftDir, "design", "pages.json"),
    JSON.stringify({
      schemaVersion: 1,
      pages: slugs.map((slug) => ({ slug, entry: `pages/${slug}.tsx` })),
    }),
  );
  for (const slug of slugs) {
    fs.writeFileSync(
      path.join(termcraftDir, "design", "pages", `${slug}.tsx`),
      `export const meta = { title: "${slug}" };\n`,
    );
  }
}

describe("the real migration against the preserved version-1 clock project (design §12.3)", () => {
  // REMOVED 2026-08-09: "produces exactly the hand-built examples/clock/.termcraft portable tree".
  //
  // It compared the migration's output byte-for-byte against `examples/clock/.termcraft` as an
  // ORACLE, which asked that directory to be two incompatible things at once: a live playground
  // the app is run against, and a frozen expectation. Running the app against the example — which
  // is what an example is FOR — broke the test, and mostly invisibly: of the 18 entries that
  // diverged when it last failed, only 5 were tracked design files; the other 13 were `chats/`,
  // `cache/**` and `workspace.local.toml`, all GITIGNORED, so `git status` showed nothing and
  // reverting the visible changes would not have made it pass.
  //
  // Examples are living artifacts and will keep changing, so no test is based on them any more.
  // The two tests below use only `test-fixtures/format-v1-project`, a committed fixture that
  // nothing but this file reads.
  //
  // WHAT WENT WITH IT, stated rather than left to be discovered: nothing now pins WHAT the
  // migration produces — only that its output opens as the current format (below) and that the
  // backup can reconstruct the input. Re-establishing that coverage means committing a pristine
  // `test-fixtures/`-side expectation of the migrated tree; it deliberately does not live in
  // `examples/`.

  test("the migrated fixture opens as an ordinary current-format project", async () => {
    const { root, userStateRoot } = freshRoots("tc-fixture-open");
    fs.cpSync(FIXTURE, path.join(root, ".termcraft"), { recursive: true });
    fs.rmSync(path.join(root, ".termcraft", "README.md"));

    const store = createStore(nodeStoreDeps({ userStateRoot }));
    const migrated = await store.migrateProject(root, { kitApiVersion: 1 });
    if (migrated instanceof Error) throw migrated;

    const opened = await store.openProject(root);
    if (opened instanceof Error) throw opened;
    const manifest = await opened.manifest.read();
    if (manifest instanceof Error) throw manifest;
    expect(manifest.formatVersion).toBe(3);
    expect(manifest.projectId).toBe("019fa002-5f5b-7000-92e3-9931eebd6c52");
    expect(manifest.name).toBe("clock");
    await opened.close();
  });

  test("the backup can reconstruct the original project", async () => {
    const { root, userStateRoot } = freshRoots("tc-fixture-backup");
    fs.cpSync(FIXTURE, path.join(root, ".termcraft"), { recursive: true });
    fs.rmSync(path.join(root, ".termcraft", "README.md"));
    const before = readTree(path.join(root, ".termcraft"));

    const store = createStore(nodeStoreDeps({ userStateRoot }));
    const outcome = await store.migrateProject(root, { kitApiVersion: 1 });
    if (outcome instanceof Error) throw outcome;

    const backed = readTree(outcome.backupDir);
    backed.delete("backup-manifest.json");
    backed.delete("VERIFIED");
    expect([...backed.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [relPath, bytes] of before) expect(backed.get(relPath)).toEqual(bytes);
  });
});

describe("the §11 end-to-end migration cases, through the real createStore", () => {
  test("a format-2 project migrates to 3 and gains a working design system", async () => {
    const { root, userStateRoot } = freshRoots("tc-fixture-v2");
    fs.mkdirSync(path.join(root, ".termcraft"), { recursive: true });
    seedFormatTwoProject(root);

    const store = createStore(nodeStoreDeps({ userStateRoot }));
    const outcome = await store.migrateProject(root, { kitApiVersion: 1 });
    if (outcome instanceof Error) throw outcome;

    expect(
      fs.existsSync(path.join(root, ".termcraft", "design", "system", "design-system.json")),
    ).toBe(true);
    expect(fs.existsSync(path.join(root, ".termcraft", "design", "system", "tokens.ts"))).toBe(
      true,
    );
    // NO page source touched — the whole point of the 2 -> 3 step (§9).
    expect(fs.existsSync(path.join(root, ".termcraft", "design", "pages", "dashboard.tsx"))).toBe(
      true,
    );

    const opened = await store.openProject(root);
    if (opened instanceof Error) throw opened;
    const manifest = await opened.manifest.read();
    if (manifest instanceof Error) throw manifest;
    expect(manifest.formatVersion).toBe(3);
    await opened.close();
  });

  test("a format-1 project migrates STRAIGHT to 3 in one transaction", async () => {
    const { root, userStateRoot } = freshRoots("tc-fixture-straight");
    fs.cpSync(FIXTURE, path.join(root, ".termcraft"), { recursive: true });
    fs.rmSync(path.join(root, ".termcraft", "README.md"));

    const store = createStore(nodeStoreDeps({ userStateRoot }));
    const outcome = await store.migrateProject(root, { kitApiVersion: 1 });
    if (outcome instanceof Error) throw outcome;

    // Exactly one transaction directory landed under `transactions.local/` — `project.toml` is
    // written exactly once, never as two chained transactions (ruling 1).
    const transactionsDir = path.join(root, ".termcraft", TRANSACTIONS_LOCAL_DIR);
    const transactionEntries = fs
      .readdirSync(transactionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory());
    expect(transactionEntries).toHaveLength(1);

    const manifestText = fs.readFileSync(path.join(root, ".termcraft", "project.toml"), "utf8");
    expect(manifestText).toContain("format_version = 3");
    expect(fs.existsSync(path.join(root, ".termcraft", "design", "pages", "dashboard.tsx"))).toBe(
      true,
    );
    expect(
      fs.existsSync(path.join(root, ".termcraft", "design", "system", "design-system.json")),
    ).toBe(true);
  });

  test("the migrated seed is byte-identical to the shipped dark-default seed", async () => {
    const { root, userStateRoot } = freshRoots("tc-fixture-byte-identical");
    fs.cpSync(FIXTURE, path.join(root, ".termcraft"), { recursive: true });
    fs.rmSync(path.join(root, ".termcraft", "README.md"));

    const store = createStore(nodeStoreDeps({ userStateRoot }));
    const outcome = await store.migrateProject(root, { kitApiVersion: 1 });
    if (outcome instanceof Error) throw outcome;

    const manifestPath = path.join(root, ".termcraft", "design", "system", "design-system.json");
    expect(fs.readFileSync(manifestPath, "utf8")).toBe(
      new TextDecoder().decode(createDesignSystemSeedFiles({ kitApiVersion: 1 })[0]!.bytes),
    );
  });

  test("a verified backup exists before the first target byte is rewritten", async () => {
    const { root, userStateRoot } = freshRoots("tc-fixture-verified-backup");
    fs.cpSync(FIXTURE, path.join(root, ".termcraft"), { recursive: true });
    fs.rmSync(path.join(root, ".termcraft", "README.md"));

    const store = createStore(nodeStoreDeps({ userStateRoot }));
    const outcome = await store.migrateProject(root, { kitApiVersion: 1 });
    if (outcome instanceof Error) throw outcome;

    expect(outcome.backupDir.startsWith(userStateRoot)).toBe(true);
    expect(fs.existsSync(path.join(outcome.backupDir, BACKUP_VERIFIED_FILENAME))).toBe(true);
  });

  test("migrating twice is refused, not repeated — the second open decodes cleanly", async () => {
    const { root, userStateRoot } = freshRoots("tc-fixture-twice");
    fs.cpSync(FIXTURE, path.join(root, ".termcraft"), { recursive: true });
    fs.rmSync(path.join(root, ".termcraft", "README.md"));

    const store = createStore(nodeStoreDeps({ userStateRoot }));
    const first = await store.migrateProject(root, { kitApiVersion: 1 });
    if (first instanceof Error) throw first;

    const second = await store.migrateProject(root, { kitApiVersion: 1 });
    expect(second).toBeInstanceOf(Error);

    const opened = await store.openProject(root);
    if (opened instanceof Error) throw opened;
    const manifest = await opened.manifest.read();
    if (manifest instanceof Error) throw manifest;
    expect(manifest.formatVersion).toBe(3);
    await opened.close();
  });
});
