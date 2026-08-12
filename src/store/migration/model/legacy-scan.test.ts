import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createSafeProjectFs, nodeSafeFsDeps, openManagedRoot } from "store/safe-fs";
import type { SafeProjectFs } from "store/safe-fs";

import { LegacyScanError, scanLegacyProject } from "./legacy-scan";

const V1_MANIFEST = [
  "format_version = 1",
  'project_id = "019fa002-5f5b-7000-92e3-9931eebd6c52"',
  'name = "clock"',
  'created_at = "2026-07-26T19:58:57.883Z"',
  'target_stack = "js-opentui"',
  'pages = ["dashboard", "calendar"]',
  "",
].join("\n");

const scratchRoots: string[] = [];
afterEach(() => {
  while (scratchRoots.length > 0) {
    const root = scratchRoots.pop();
    if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
  }
});

/** A `.termcraft` directory with `manifest` and one `pages/<slug>/page.tsx` per `slugs` entry. */
function seedLegacyProject(input: {
  readonly manifest: string;
  readonly slugs: readonly string[];
  readonly pinnedSlugs?: readonly string[];
  /** A hand-edit or an abandoned earlier attempt's `design/system/design-system.json`, already
   *  present before this scan runs — the case ruling 4 guards against. */
  readonly hasDesignSystem?: boolean;
}): SafeProjectFs {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tc-legacy-scan-"));
  scratchRoots.push(scratch);
  const termcraftDir = path.join(scratch, ".termcraft");
  fs.mkdirSync(termcraftDir);
  fs.writeFileSync(path.join(termcraftDir, "project.toml"), input.manifest);
  for (const slug of input.slugs) {
    fs.mkdirSync(path.join(termcraftDir, "pages", slug), { recursive: true });
    fs.writeFileSync(
      path.join(termcraftDir, "pages", slug, "page.tsx"),
      `export const meta = { title: "${slug}" };\n`,
    );
  }
  for (const slug of input.pinnedSlugs ?? []) {
    fs.writeFileSync(
      path.join(termcraftDir, "pages", slug, "comments.jsonl"),
      '{"kind":"header"}\n',
    );
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

describe("scanLegacyProject (design-tree §12.2 track 1's only reader of the old layout)", () => {
  test("reads identity, ordered slugs and each page's source path", () => {
    const scanned = scanLegacyProject(
      seedLegacyProject({ manifest: V1_MANIFEST, slugs: ["dashboard", "calendar"] }),
    );
    expect(scanned).not.toBeInstanceOf(Error);
    if (scanned instanceof Error) return;
    expect(scanned.formatVersion).toBe(1);
    expect(scanned.projectId).toBe("019fa002-5f5b-7000-92e3-9931eebd6c52");
    expect(scanned.name).toBe("clock");
    expect(scanned.targetStack).toBe("js-opentui");
    expect(scanned.pages.map((page) => page.slug as string)).toEqual(["dashboard", "calendar"]);
    expect(scanned.pages[0]?.legacySourcePath).toBe("pages/dashboard/page.tsx");
    expect(scanned.hasDesignSystem).toBe(false);
  });

  test("reports hasDesignSystem true when design/system/design-system.json already exists", () => {
    const scanned = scanLegacyProject(
      seedLegacyProject({
        manifest: V1_MANIFEST,
        slugs: ["dashboard", "calendar"],
        hasDesignSystem: true,
      }),
    );
    if (scanned instanceof Error) throw scanned;
    expect(scanned.hasDesignSystem).toBe(true);
  });

  test("reports an absent pin log as null, never as a fabricated path", () => {
    const scanned = scanLegacyProject(
      seedLegacyProject({
        manifest: V1_MANIFEST,
        slugs: ["dashboard", "calendar"],
        pinnedSlugs: ["calendar"],
      }),
    );
    if (scanned instanceof Error) throw scanned;
    expect(scanned.pages[0]?.legacyPinsPath).toBeNull();
    expect(scanned.pages[1]?.legacyPinsPath).toBe("pages/calendar/comments.jsonl");
  });

  test("refuses a manifest that is already format 2", () => {
    const scanned = scanLegacyProject(
      seedLegacyProject({ manifest: V1_MANIFEST.replace("= 1", "= 2"), slugs: [] }),
    );
    expect(scanned).toBeInstanceOf(LegacyScanError);
    expect((scanned as LegacyScanError).code).toBe("NOT_VERSION_1");
  });

  test("refuses a listed page whose source file is missing — never skips it silently", () => {
    const scanned = scanLegacyProject(
      seedLegacyProject({ manifest: V1_MANIFEST, slugs: ["dashboard"] }),
    );
    expect(scanned).toBeInstanceOf(LegacyScanError);
    expect((scanned as LegacyScanError).code).toBe("PAGE_SOURCE_MISSING");
    expect((scanned as LegacyScanError).message).toContain("calendar");
  });

  test("refuses a manifest whose pages array holds an invalid slug", () => {
    const scanned = scanLegacyProject(
      seedLegacyProject({
        manifest: V1_MANIFEST.replace('"calendar"', '"Calendar"'),
        slugs: ["dashboard"],
      }),
    );
    expect(scanned).toBeInstanceOf(LegacyScanError);
    expect((scanned as LegacyScanError).code).toBe("MANIFEST_SHAPE");
  });

  test("refuses a version-1 manifest missing the pages array", () => {
    const scanned = scanLegacyProject(
      seedLegacyProject({
        manifest: V1_MANIFEST.split("\n")
          .filter((line) => !line.startsWith("pages"))
          .join("\n"),
        slugs: [],
      }),
    );
    expect(scanned).toBeInstanceOf(LegacyScanError);
    expect((scanned as LegacyScanError).code).toBe("MANIFEST_SHAPE");
  });
});
