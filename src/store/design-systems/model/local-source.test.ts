import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseDesignSystemId, parseDesignSystemVersion } from "entities/design-system-ref";
import { systemClock } from "infrastructure/clock";

import type { PackageFile } from "../types";
import { allowAllPackageAdmission, nodeDesignSystemFsDeps } from "./fs-deps";
import { createLocalDesignSystemSource } from "./local-source";

const scratchRoots: string[] = [];
function freshScratch(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-ds-local-"));
  scratchRoots.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of scratchRoots) fs.rmSync(dir, { recursive: true, force: true });
});

const utf8 = (text: string) => new Uint8Array(Buffer.from(text, "utf8"));

const FILES: readonly PackageFile[] = [
  {
    relPath: "design-system.json",
    bytes: utf8(
      JSON.stringify({
        schemaVersion: 1,
        id: "midnight",
        name: "Midnight",
        version: "1.2.0",
        kitApiVersion: 1,
        defaultTheme: "dark",
        themes: { dark: { label: "Dark", tokens: { accent: "#4cc9f0" } } },
        components: [],
      }),
    ),
  },
];

function sourceFor(root: string) {
  return createLocalDesignSystemSource({
    userStateRoot: root,
    fs: nodeDesignSystemFsDeps,
    admission: allowAllPackageAdmission,
    clock: systemClock,
  });
}

describe("createLocalDesignSystemSource", () => {
  test("declares its identity, label and publish capability", () => {
    const source = sourceFor(freshScratch());
    expect(source.id).toBe("local" as never);
    expect(source.label).toBe("Local library");
    expect(source.canPublish).toBe(true);
  });

  test("publish then list then fetch is one coherent round trip", async () => {
    const root = freshScratch();
    const source = sourceFor(root);

    const systemId = parseDesignSystemId("midnight");
    const version = parseDesignSystemVersion("1.2.0");
    if (systemId instanceof Error) throw systemId;
    if (version instanceof Error) throw version;

    const receipt = await source.publish({ systemId, version, files: FILES });
    if (receipt instanceof Error) throw receipt;

    const listed = await source.list();
    if (listed instanceof Error) throw listed;
    expect(listed.map((summary) => summary.id)).toEqual(["midnight"]);

    const fetched = await source.fetch(receipt.ref);
    if (fetched instanceof Error) throw fetched;
    expect(fetched.contentHash).toBe(receipt.contentHash);
    expect(fetched.summary.name).toBe("Midnight");
  });

  test("an empty library lists nothing rather than failing", async () => {
    expect(await sourceFor(freshScratch()).list()).toEqual([]);
  });
});
