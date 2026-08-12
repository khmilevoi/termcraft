import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { PageSlug } from "entities/page";
import { createDesignSystemSeedFiles } from "store/model/design-system-seed";
import { createSafeProjectFs, nodeSafeFsDeps, openManagedRoot } from "store/safe-fs";
import { nodeTransactionFsDeps } from "store/transaction";

import type { LegacyProjectV1 } from "../types";
import { scanLegacyProject } from "./legacy-scan";
import { buildV1ToV2Operations, planV1ToV2 } from "./v1-to-v2";

const USER_STATE_ROOT = "C:\\Users\\dev\\AppData\\Local\\termcraft";
const PROJECT_ID = "019fa002-5f5b-7000-92e3-9931eebd6c52";
const PLAN_ID = "019fb111-0000-7000-8000-000000000001";

const scan = (input: {
  readonly slugs: readonly string[];
  readonly pinned?: readonly string[];
  readonly hasDesignSystem?: boolean;
}): LegacyProjectV1 => ({
  formatVersion: 1,
  projectId: PROJECT_ID,
  name: "clock",
  createdAt: "2026-07-26T19:58:57.883Z",
  targetStack: "js-opentui",
  pages: input.slugs.map((slug) => ({
    slug: slug as PageSlug,
    legacySourcePath: `pages/${slug}/page.tsx`,
    legacyPinsPath: (input.pinned ?? []).includes(slug) ? `pages/${slug}/comments.jsonl` : null,
  })),
  hasDesignSystem: input.hasDesignSystem ?? false,
});

describe("planV1ToV2 (design-tree §12.2 track 1's move set)", () => {
  test("moves each page source into the design tree, in manifest order", () => {
    const plan = planV1ToV2({
      scan: scan({ slugs: ["dashboard", "calendar"] }),
      userStateRoot: USER_STATE_ROOT,
      migrationPlanId: PLAN_ID,
    });
    expect(plan.moves.filter((move) => move.what === "page-source")).toEqual([
      { from: "pages/dashboard/page.tsx", to: "design/pages/dashboard.tsx", what: "page-source" },
      { from: "pages/calendar/page.tsx", to: "design/pages/calendar.tsx", what: "page-source" },
    ]);
  });

  test("moves only the pin logs that exist", () => {
    const plan = planV1ToV2({
      scan: scan({ slugs: ["dashboard", "calendar"], pinned: ["calendar"] }),
      userStateRoot: USER_STATE_ROOT,
      migrationPlanId: PLAN_ID,
    });
    expect(plan.moves.filter((move) => move.what === "pin-log")).toEqual([
      { from: "pages/calendar/comments.jsonl", to: "pins/calendar.jsonl", what: "pin-log" },
    ]);
    expect(plan.pinLogCount).toBe(1);
  });

  test("counts pages and names the real backup directory, not the mock's path", () => {
    const plan = planV1ToV2({
      scan: scan({ slugs: ["dashboard", "calendar"] }),
      userStateRoot: USER_STATE_ROOT,
      migrationPlanId: PLAN_ID,
    });
    expect(plan.pageCount).toBe(2);
    expect(plan.pinLogCount).toBe(0);
    expect(plan.backupsDir).toContain("backups");
    expect(plan.backupsDir).toContain(PROJECT_ID);
    expect(plan.backupsDir).not.toContain(".termcraft");
  });

  test("carries the version pair and the caller's plan id verbatim — straight to format 3", () => {
    const plan = planV1ToV2({
      scan: scan({ slugs: [] }),
      userStateRoot: USER_STATE_ROOT,
      migrationPlanId: PLAN_ID,
    });
    expect(plan).toMatchObject({ migrationPlanId: PLAN_ID, fromVersion: 1, toVersion: 3 });
    expect(plan.moves).toEqual([]);
    expect(plan.seedsDesignSystem).toBe(true);
  });

  test("seedsDesignSystem is false when the scan already found one (ruling 4)", () => {
    const plan = planV1ToV2({
      scan: scan({ slugs: [], hasDesignSystem: true }),
      userStateRoot: USER_STATE_ROOT,
      migrationPlanId: PLAN_ID,
    });
    expect(plan.seedsDesignSystem).toBe(false);
  });
});

// ---- buildV1ToV2Operations ---------------------------------------------------------------

const scratchRoots: string[] = [];
afterEach(() => {
  while (scratchRoots.length > 0) {
    const root = scratchRoots.pop();
    if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
  }
});

let payloadCounter = 0;
const nextPayloadId = () => `payload-${++payloadCounter}`;

function seedForOperations(input: {
  readonly slugs: readonly string[];
  readonly pinned?: readonly string[];
  /** A hand-edit or an abandoned earlier attempt's `design/system/design-system.json`, already
   *  present before the scan+build pipeline runs — the case ruling 4 guards against. */
  readonly hasDesignSystem?: boolean;
}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tc-v1v2-"));
  scratchRoots.push(scratch);
  const termcraftDir = path.join(scratch, ".termcraft");
  fs.mkdirSync(termcraftDir);
  fs.writeFileSync(
    path.join(termcraftDir, "project.toml"),
    [
      "format_version = 1",
      'project_id = "019fa002-5f5b-7000-92e3-9931eebd6c52"',
      'name = "clock"',
      'created_at = "2026-07-26T19:58:57.883Z"',
      'target_stack = "js-opentui"',
      `pages = [${input.slugs.map((slug) => `"${slug}"`).join(", ")}]`,
      "",
    ].join("\n"),
  );
  const sourceBytes = new Map<string, Uint8Array>();
  for (const slug of input.slugs) {
    fs.mkdirSync(path.join(termcraftDir, "pages", slug), { recursive: true });
    const bytes = new TextEncoder().encode(`export const meta = { title: "${slug}" };\n`);
    fs.writeFileSync(path.join(termcraftDir, "pages", slug, "page.tsx"), bytes);
    sourceBytes.set(slug, bytes);
    if ((input.pinned ?? []).includes(slug))
      fs.writeFileSync(
        path.join(termcraftDir, "pages", slug, "comments.jsonl"),
        '{"kind":"header"}\n',
      );
  }
  if (input.hasDesignSystem === true) {
    fs.mkdirSync(path.join(termcraftDir, "design", "system"), { recursive: true });
    fs.writeFileSync(
      path.join(termcraftDir, "design", "system", "design-system.json"),
      '{"schemaVersion":1,"hand-edited":true}',
    );
  }
  const deps = nodeSafeFsDeps();
  const root = openManagedRoot({ kind: "project-migration", path: termcraftDir, deps });
  if (root instanceof Error) throw root;
  const safeFs = createSafeProjectFs(root, deps);
  const scanned = scanLegacyProject(safeFs);
  if (scanned instanceof Error) throw scanned;
  return {
    fsDeps: { fs: nodeTransactionFsDeps(safeFs), append: { newPayloadId: nextPayloadId } },
    scanned,
    sourceBytes,
  };
}

describe("buildV1ToV2Operations (one transaction, writes before deletes)", () => {
  test("writes the moved sources, the synthesized manifest and the rewritten project.toml", () => {
    const { fsDeps, scanned } = seedForOperations({ slugs: ["dashboard", "calendar"] });
    const built = buildV1ToV2Operations(fsDeps, {
      scan: scanned,
      kitApiVersion: 1,
      newPayloadId: nextPayloadId,
    });
    if (built instanceof Error) throw built;

    const byTarget = new Map(built.operations.map((op) => [op.target, op]));
    expect([...byTarget.keys()].sort()).toEqual(
      [
        "design/pages.json",
        "design/pages/calendar.tsx",
        "design/pages/dashboard.tsx",
        "design/system/design-system.json",
        "design/system/tokens.ts",
        "pages/calendar/page.tsx",
        "pages/dashboard/page.tsx",
        "project.toml",
      ].sort(),
    );
    expect(byTarget.get("design/pages/dashboard.tsx")?.mode).toBe("replace");
    expect(byTarget.get("pages/dashboard/page.tsx")?.mode).toBe("delete");
  });

  test("the seeded design system's bytes are IDENTICAL to createProject's", () => {
    const { fsDeps, scanned } = seedForOperations({ slugs: [] });
    const built = buildV1ToV2Operations(fsDeps, {
      scan: scanned,
      kitApiVersion: 1,
      newPayloadId: nextPayloadId,
    });
    if (built instanceof Error) throw built;
    const expected = createDesignSystemSeedFiles({ kitApiVersion: 1 });
    const manifestOp = built.operations.find(
      (op) => op.target === "design/system/design-system.json",
    );
    expect(built.payloads.get(manifestOp?.payloadId ?? "")).toEqual(expected[0]!.bytes);
  });

  test("every delete operation is ordered after every write operation", () => {
    const { fsDeps, scanned } = seedForOperations({ slugs: ["dashboard"] });
    const built = buildV1ToV2Operations(fsDeps, {
      scan: scanned,
      kitApiVersion: 1,
      newPayloadId: nextPayloadId,
    });
    if (built instanceof Error) throw built;
    const lastWrite = built.operations.findLastIndex((op) => op.mode === "replace");
    const firstDelete = built.operations.findIndex((op) => op.mode === "delete");
    expect(firstDelete).toBeGreaterThan(lastWrite);
  });

  test("operation indexes are a dense 0..n-1 sequence", () => {
    const { fsDeps, scanned } = seedForOperations({ slugs: ["dashboard", "calendar"] });
    const built = buildV1ToV2Operations(fsDeps, {
      scan: scanned,
      kitApiVersion: 1,
      newPayloadId: nextPayloadId,
    });
    if (built instanceof Error) throw built;
    expect(built.operations.map((op) => op.index)).toEqual(
      built.operations.map((_op, index) => index),
    );
  });

  test("the moved page source's payload is the ORIGINAL bytes, unedited", () => {
    const { fsDeps, scanned, sourceBytes } = seedForOperations({ slugs: ["dashboard"] });
    const built = buildV1ToV2Operations(fsDeps, {
      scan: scanned,
      kitApiVersion: 1,
      newPayloadId: nextPayloadId,
    });
    if (built instanceof Error) throw built;
    const moved = built.operations.find((op) => op.target === "design/pages/dashboard.tsx");
    const payload = built.payloads.get(moved?.payloadId ?? "");
    expect(payload).toEqual(sourceBytes.get("dashboard"));
  });

  test("the synthesized pages.json preserves manifest order and points at the moved entries", () => {
    const { fsDeps, scanned } = seedForOperations({ slugs: ["dashboard", "calendar"] });
    const built = buildV1ToV2Operations(fsDeps, {
      scan: scanned,
      kitApiVersion: 1,
      newPayloadId: nextPayloadId,
    });
    if (built instanceof Error) throw built;
    const manifestOp = built.operations.find((op) => op.target === "design/pages.json");
    const text = new TextDecoder().decode(built.payloads.get(manifestOp?.payloadId ?? ""));
    expect(JSON.parse(text)).toEqual({
      schemaVersion: 1,
      pages: [
        { slug: "dashboard", entry: "pages/dashboard.tsx" },
        { slug: "calendar", entry: "pages/calendar.tsx" },
      ],
    });
  });

  test("the rewritten project.toml is format 3 and carries no pages array", () => {
    const { fsDeps, scanned } = seedForOperations({ slugs: ["dashboard"] });
    const built = buildV1ToV2Operations(fsDeps, {
      scan: scanned,
      kitApiVersion: 1,
      newPayloadId: nextPayloadId,
    });
    if (built instanceof Error) throw built;
    const manifestOp = built.operations.find((op) => op.target === "project.toml");
    const text = new TextDecoder().decode(built.payloads.get(manifestOp?.payloadId ?? ""));
    expect(text).toContain("format_version = 3");
    expect(text).not.toContain("pages");
    expect(text).toContain('project_id = "019fa002-5f5b-7000-92e3-9931eebd6c52"');
    expect(text).toContain('created_at = "2026-07-26T19:58:57.883Z"');
  });

  test("the backup set holds every source byte and the old project.toml", () => {
    const { fsDeps, scanned } = seedForOperations({ slugs: ["dashboard"], pinned: ["dashboard"] });
    const built = buildV1ToV2Operations(fsDeps, {
      scan: scanned,
      kitApiVersion: 1,
      newPayloadId: nextPayloadId,
    });
    if (built instanceof Error) throw built;
    expect(built.backupFiles.map((file) => file.relPath).sort()).toEqual([
      "pages/dashboard/comments.jsonl",
      "pages/dashboard/page.tsx",
      "project.toml",
    ]);
    expect(built.backupFiles.every((file) => file.bytes.byteLength > 0)).toBe(true);
    expect(built.backupFiles.find((f) => f.relPath === "project.toml")?.sourceFormat).toBe(
      "project.toml@1",
    );
  });

  test("a pin log is moved only when the scan found one", () => {
    const { fsDeps, scanned } = seedForOperations({ slugs: ["dashboard"] });
    const built = buildV1ToV2Operations(fsDeps, {
      scan: scanned,
      kitApiVersion: 1,
      newPayloadId: nextPayloadId,
    });
    if (built instanceof Error) throw built;
    expect(built.operations.some((op) => op.target.startsWith("pins/"))).toBe(false);
  });

  test("an existing design system on a format-1 project is preserved — the seed is not written, and backupFiles stays exact (ruling 4)", () => {
    const { fsDeps, scanned } = seedForOperations({ slugs: ["dashboard"], hasDesignSystem: true });
    expect(scanned.hasDesignSystem).toBe(true);
    const built = buildV1ToV2Operations(fsDeps, {
      scan: scanned,
      kitApiVersion: 1,
      newPayloadId: nextPayloadId,
    });
    if (built instanceof Error) throw built;
    expect(built.operations.some((op) => op.target.startsWith("design/system/"))).toBe(false);
    // "never a superset, never a subset" (V1ToV2OperationsV1's own doc comment): the untouched
    // design-system.json must never appear in the backup set either.
    expect(built.backupFiles.map((file) => file.relPath).sort()).toEqual([
      "pages/dashboard/page.tsx",
      "project.toml",
    ]);
  });
});
