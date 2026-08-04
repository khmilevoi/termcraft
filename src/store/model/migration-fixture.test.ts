import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createStore, nodeStoreDeps } from "./factory";

const FIXTURE = path.join(import.meta.dir, "..", "..", "..", "test-fixtures", "format-v1-project");
const ORACLE = path.join(import.meta.dir, "..", "..", "..", "examples", "clock", ".termcraft");

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
  test("produces exactly the hand-built examples/clock/.termcraft portable tree", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tc-fixture-"));
    const userStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tc-fixture-state-"));
    scratchRoots.push(root, userStateRoot);
    // The fixture holds the CONTENTS of a `.termcraft`, not a project root — see its README.
    fs.cpSync(FIXTURE, path.join(root, ".termcraft"), { recursive: true });
    fs.rmSync(path.join(root, ".termcraft", "README.md"));

    const store = createStore(nodeStoreDeps({ userStateRoot }));
    const outcome = await store.migrateProject(root);
    if (outcome instanceof Error) throw outcome;

    const produced = readTree(path.join(root, ".termcraft"));
    const oracle = readTree(ORACLE);
    // `.gitignore` is written by `createProject`, not by a migration: the fixture predates it and
    // the example has one. Compared for absence rather than content, so the difference is stated
    // rather than hidden inside a diff.
    expect(produced.has(".gitignore")).toBe(false);
    oracle.delete(".gitignore");

    expect([...produced.keys()].sort()).toEqual([...oracle.keys()].sort());
    for (const [relPath, bytes] of oracle) expect(produced.get(relPath)).toEqual(bytes);
  });

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
