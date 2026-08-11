import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { validManifestObject } from "entities/design-system/model/manifest.fixture";
import { systemClock } from "infrastructure/clock";

import type { PackageFile } from "../types";
import { allowAllPackageAdmission, nodeDesignSystemFsDeps } from "./fs-deps";
import { localSystemDir } from "./layout";
import { listLocalSystems } from "./list";
import { createRecordingFsDeps, writeFixturePackage } from "./test-support";

const scratchRoots: string[] = [];
function freshScratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-ds-list-"));
  scratchRoots.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of scratchRoots) fs.rmSync(dir, { recursive: true, force: true });
});

const utf8 = (text: string) => new Uint8Array(Buffer.from(text, "utf8"));

// `readDesignSystemSummary` now decodes through `entities/design-system`'s decoder (project-
// design-systems §10.1 sync point 1), which enforces materially more than a picker used to need —
// every core token role, cross-theme parity, lowercase-hex values. `validManifestObject` is the
// one shared manifest the decoder actually accepts (see its own doc), overridden here per system.
function manifest(id: string, version: string): PackageFile {
  return {
    relPath: "design-system.json",
    bytes: utf8(
      JSON.stringify({
        ...validManifestObject(),
        id,
        name: id[0]?.toUpperCase() + id.slice(1),
        version,
        components: [{ name: "Button", module: "components/Button.tsx", export: "Button" }],
      }),
    ),
  };
}

const BUTTON: PackageFile = {
  relPath: "components/Button.tsx",
  bytes: utf8("export const Button = () => null\n"),
};

function seedLibrary(root: string, id: string, version: string): void {
  writeFixturePackage(localSystemDir(root, id as never), [manifest(id, version), BUTTON]);
}

function depsFor(root: string, inner = nodeDesignSystemFsDeps) {
  return {
    userStateRoot: root,
    fs: inner,
    admission: allowAllPackageAdmission,
    clock: systemClock,
  };
}

describe("listLocalSystems", () => {
  test("an absent library is an empty list, not a failure", async () => {
    expect(await listLocalSystems(depsFor(freshScratch()))).toEqual([]);
  });

  test("summarizes every system in the library, sorted by id", async () => {
    const root = freshScratch();
    seedLibrary(root, "midnight", "1.2.0");
    seedLibrary(root, "aurora", "2.0.0");

    const listed = await listLocalSystems(depsFor(root));
    if (listed instanceof Error) throw listed;
    expect(listed.map((summary) => summary.id)).toEqual(["aurora", "midnight"]);
    expect(listed[0]?.version).toBe("2.0.0");
    expect(listed[1]?.defaultThemeTokens).toContainEqual({ name: "accent", value: "#4cc9f0" });
    expect(listed[1]?.componentNames).toEqual(["Button"]);
  });

  test("NEVER opens a .tsx (design §11)", async () => {
    const root = freshScratch();
    seedLibrary(root, "midnight", "1.2.0");
    const recording = createRecordingFsDeps(nodeDesignSystemFsDeps);

    await listLocalSystems(depsFor(root, recording));

    expect(recording.reads.length).toBeGreaterThan(0);
    for (const read of recording.reads) expect(read.endsWith(".tsx")).toBe(false);
    expect(recording.reads.every((read) => read.endsWith("design-system.json"))).toBe(true);
  });

  test("skips a folder with no manifest rather than failing the whole listing", async () => {
    const root = freshScratch();
    seedLibrary(root, "midnight", "1.2.0");
    fs.mkdirSync(localSystemDir(root, "empty" as never), { recursive: true });

    const listed = await listLocalSystems(depsFor(root));
    if (listed instanceof Error) throw listed;
    expect(listed.map((summary) => summary.id)).toEqual(["midnight"]);
  });

  test("skips a folder whose manifest does not summarize", async () => {
    const root = freshScratch();
    seedLibrary(root, "midnight", "1.2.0");
    writeFixturePackage(localSystemDir(root, "broken" as never), [
      { relPath: "design-system.json", bytes: utf8("{ not json") },
    ]);

    const listed = await listLocalSystems(depsFor(root));
    if (listed instanceof Error) throw listed;
    expect(listed.map((summary) => summary.id)).toEqual(["midnight"]);
  });

  test("skips a directory whose name is not a legal system id, and every non-directory entry", async () => {
    const root = freshScratch();
    seedLibrary(root, "midnight", "1.2.0");
    fs.mkdirSync(path.join(root, "design-systems", "local", "Not A System"), { recursive: true });
    fs.writeFileSync(path.join(root, "design-systems", "local", "stray.txt"), "x");

    const listed = await listLocalSystems(depsFor(root));
    if (listed instanceof Error) throw listed;
    expect(listed.map((summary) => summary.id)).toEqual(["midnight"]);
  });
});
