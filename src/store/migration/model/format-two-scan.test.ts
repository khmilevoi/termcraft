import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createSafeProjectFs, nodeSafeFsDeps, openManagedRoot } from "store/safe-fs";
import type { SafeProjectFs } from "store/safe-fs";

import { FormatTwoScanError, scanFormatTwoProject } from "./format-two-scan";

const V2_MANIFEST = [
  "format_version = 2",
  'project_id = "019fa002-5f5b-7000-92e3-9931eebd6c52"',
  'name = "clock"',
  'created_at = "2026-07-26T19:58:57.883Z"',
  'target_stack = "js-opentui"',
  "",
].join("\n");

const scratchRoots: string[] = [];
afterEach(() => {
  while (scratchRoots.length > 0) {
    const root = scratchRoots.pop();
    if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
  }
});

/** A `.termcraft` directory holding `manifest`, and optionally `design/pages.json` / `design/system/design-system.json`. */
function seedFormatTwoProject(input: {
  readonly manifest: string;
  readonly pagesJson?: string;
  readonly hasDesignSystem?: boolean;
}): SafeProjectFs {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tc-format-two-scan-"));
  scratchRoots.push(scratch);
  const termcraftDir = path.join(scratch, ".termcraft");
  fs.mkdirSync(termcraftDir);
  fs.writeFileSync(path.join(termcraftDir, "project.toml"), input.manifest);
  if (input.pagesJson !== undefined) {
    fs.mkdirSync(path.join(termcraftDir, "design"), { recursive: true });
    fs.writeFileSync(path.join(termcraftDir, "design", "pages.json"), input.pagesJson);
  }
  if (input.hasDesignSystem === true) {
    fs.mkdirSync(path.join(termcraftDir, "design", "system"), { recursive: true });
    fs.writeFileSync(
      path.join(termcraftDir, "design", "system", "design-system.json"),
      '{"schemaVersion":1}',
    );
  }
  const deps = nodeSafeFsDeps();
  const root = openManagedRoot({ kind: "project-migration", path: termcraftDir, deps });
  if (root instanceof Error) throw root;
  return createSafeProjectFs(root, deps);
}

const validPagesJson = (slugs: readonly string[]) =>
  JSON.stringify({
    schemaVersion: 1,
    pages: slugs.map((slug) => ({ slug, entry: `pages/${slug}.tsx` })),
  });

describe("scanFormatTwoProject (design-systems §9's version-2 reader)", () => {
  test("reads a format-2 project's five portable fields and its page count", () => {
    const scanned = scanFormatTwoProject(
      seedFormatTwoProject({
        manifest: V2_MANIFEST,
        pagesJson: validPagesJson(["dashboard", "calendar"]),
      }),
    );
    expect(scanned).not.toBeInstanceOf(Error);
    if (scanned instanceof Error) return;
    expect(scanned.formatVersion).toBe(2);
    expect(scanned.projectId).toBe("019fa002-5f5b-7000-92e3-9931eebd6c52");
    expect(scanned.name).toBe("clock");
    expect(scanned.createdAt).toBe("2026-07-26T19:58:57.883Z");
    expect(scanned.targetStack).toBe("js-opentui");
    expect(scanned.pageCount).toBe(2);
    expect(scanned.hasDesignSystem).toBe(false);
  });

  test("a format-1 project is NOT_VERSION_2", () => {
    const scanned = scanFormatTwoProject(
      seedFormatTwoProject({ manifest: V2_MANIFEST.replace("= 2", "= 1") }),
    );
    expect(scanned).toBeInstanceOf(FormatTwoScanError);
    if (!(scanned instanceof Error)) throw new Error("expected a FormatTwoScanError");
    expect(scanned.code).toBe("NOT_VERSION_2");
  });

  test("a format-3 project is NOT_VERSION_2", () => {
    const scanned = scanFormatTwoProject(
      seedFormatTwoProject({ manifest: V2_MANIFEST.replace("= 2", "= 3") }),
    );
    expect(scanned).toBeInstanceOf(FormatTwoScanError);
    if (!(scanned instanceof Error)) throw new Error("expected a FormatTwoScanError");
    expect(scanned.code).toBe("NOT_VERSION_2");
  });

  test("a lingering `pages` key in project.toml is MANIFEST_SHAPE", () => {
    const scanned = scanFormatTwoProject(
      seedFormatTwoProject({ manifest: `${V2_MANIFEST}pages = ["a"]\n` }),
    );
    expect(scanned).toBeInstanceOf(FormatTwoScanError);
    if (!(scanned instanceof Error)) throw new Error("expected a FormatTwoScanError");
    expect(scanned.code).toBe("MANIFEST_SHAPE");
  });

  test("an absent design/pages.json is pageCount 0, not a failure", () => {
    const scanned = scanFormatTwoProject(seedFormatTwoProject({ manifest: V2_MANIFEST }));
    expect(scanned).not.toBeInstanceOf(Error);
    if (scanned instanceof Error) return;
    expect(scanned.pageCount).toBe(0);
  });

  test("an undecodable design/pages.json is PAGES_MANIFEST_UNREADABLE", () => {
    const scanned = scanFormatTwoProject(
      seedFormatTwoProject({ manifest: V2_MANIFEST, pagesJson: "not json" }),
    );
    expect(scanned).toBeInstanceOf(FormatTwoScanError);
    if (!(scanned instanceof Error)) throw new Error("expected a FormatTwoScanError");
    expect(scanned.code).toBe("PAGES_MANIFEST_UNREADABLE");
  });

  test("an existing design/system/design-system.json is reported as hasDesignSystem", () => {
    const scanned = scanFormatTwoProject(
      seedFormatTwoProject({ manifest: V2_MANIFEST, hasDesignSystem: true }),
    );
    expect(scanned).not.toBeInstanceOf(Error);
    if (scanned instanceof Error) return;
    expect(scanned.hasDesignSystem).toBe(true);
  });
});
