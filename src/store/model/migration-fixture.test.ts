import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
  // migration produces — only that its output opens as format 2 (below) and that the backup can
  // reconstruct the input. Re-establishing that coverage means committing a pristine
  // `test-fixtures/`-side expectation of the migrated tree; it deliberately does not live in
  // `examples/`.

  test("the migrated fixture opens as an ordinary format-2 project", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tc-fixture-open-"));
    const userStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tc-fixture-open-state-"));
    scratchRoots.push(root, userStateRoot);
    fs.cpSync(FIXTURE, path.join(root, ".termcraft"), { recursive: true });
    fs.rmSync(path.join(root, ".termcraft", "README.md"));

    const store = createStore(nodeStoreDeps({ userStateRoot }));
    const migrated = await store.migrateProject(root);
    if (migrated instanceof Error) throw migrated;

    const opened = await store.openProject(root);
    if (opened instanceof Error) throw opened;
    const manifest = await opened.manifest.read();
    if (manifest instanceof Error) throw manifest;
    expect(manifest.formatVersion).toBe(2);
    expect(manifest.projectId).toBe("019fa002-5f5b-7000-92e3-9931eebd6c52");
    expect(manifest.name).toBe("clock");
    await opened.close();
  });

  test("the backup can reconstruct the original project", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tc-fixture-backup-"));
    const userStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tc-fixture-backup-state-"));
    scratchRoots.push(root, userStateRoot);
    fs.cpSync(FIXTURE, path.join(root, ".termcraft"), { recursive: true });
    fs.rmSync(path.join(root, ".termcraft", "README.md"));
    const before = readTree(path.join(root, ".termcraft"));

    const store = createStore(nodeStoreDeps({ userStateRoot }));
    const outcome = await store.migrateProject(root);
    if (outcome instanceof Error) throw outcome;

    const backed = readTree(outcome.backupDir);
    backed.delete("backup-manifest.json");
    backed.delete("VERIFIED");
    expect([...backed.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [relPath, bytes] of before) expect(backed.get(relPath)).toEqual(bytes);
  });
});
