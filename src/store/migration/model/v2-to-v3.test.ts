import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createDesignSystemSeedFiles } from "store/model/design-system-seed";
import { createSafeProjectFs, nodeSafeFsDeps, openManagedRoot } from "store/safe-fs";
import { decodeProjectManifest } from "store/toml";
import { nodeTransactionFsDeps } from "store/transaction";
import type { TransactionOperation } from "store/transaction";

import type { FormatTwoProjectV1 } from "../types";
import { scanFormatTwoProject } from "./format-two-scan";
import { buildV2ToV3Operations, planV2ToV3 } from "./v2-to-v3";

const USER_STATE_ROOT = "C:\\Users\\dev\\AppData\\Local\\termcraft";
const PROJECT_ID = "019fa002-5f5b-7000-92e3-9931eebd6c52";
const PLAN_ID = "019fb111-0000-7000-8000-000000000001";

const scan = (input: {
  readonly pageCount?: number;
  readonly hasDesignSystem?: boolean;
}): FormatTwoProjectV1 => ({
  formatVersion: 2,
  projectId: PROJECT_ID,
  name: "clock",
  createdAt: "2026-07-26T19:58:57.883Z",
  targetStack: "js-opentui",
  pageCount: input.pageCount ?? 0,
  hasDesignSystem: input.hasDesignSystem ?? false,
});

describe("planV2ToV3 (design-systems §9's seed offer)", () => {
  test("moves nothing — the plan's move list is empty", () => {
    const plan = planV2ToV3({
      scan: scan({ pageCount: 2 }),
      userStateRoot: USER_STATE_ROOT,
      migrationPlanId: PLAN_ID,
    });
    expect(plan.moves).toEqual([]);
    expect(plan.pinLogCount).toBe(0);
  });

  test("carries the version pair, the page count and the caller's plan id verbatim", () => {
    const plan = planV2ToV3({
      scan: scan({ pageCount: 5 }),
      userStateRoot: USER_STATE_ROOT,
      migrationPlanId: PLAN_ID,
    });
    expect(plan).toMatchObject({
      migrationPlanId: PLAN_ID,
      fromVersion: 2,
      toVersion: 3,
      projectId: PROJECT_ID,
      pageCount: 5,
    });
  });

  test("seedsDesignSystem is true only when the scan found none", () => {
    expect(
      planV2ToV3({
        scan: scan({ hasDesignSystem: false }),
        userStateRoot: USER_STATE_ROOT,
        migrationPlanId: PLAN_ID,
      }).seedsDesignSystem,
    ).toBe(true);
    expect(
      planV2ToV3({
        scan: scan({ hasDesignSystem: true }),
        userStateRoot: USER_STATE_ROOT,
        migrationPlanId: PLAN_ID,
      }).seedsDesignSystem,
    ).toBe(false);
  });

  test("names the real backup directory", () => {
    const plan = planV2ToV3({
      scan: scan({}),
      userStateRoot: USER_STATE_ROOT,
      migrationPlanId: PLAN_ID,
    });
    expect(plan.backupsDir).toContain("backups");
    expect(plan.backupsDir).toContain(PROJECT_ID);
    expect(plan.backupsDir).not.toContain(".termcraft");
  });
});

// ---- buildV2ToV3Operations ----------------------------------------------------------------

const scratchRoots: string[] = [];
afterEach(() => {
  while (scratchRoots.length > 0) {
    const root = scratchRoots.pop();
    if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
  }
});

let payloadCounter = 0;
const nextPayloadId = () => `payload-${++payloadCounter}`;

function seedForOperations(input: { readonly hasDesignSystem?: boolean }) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tc-v2v3-"));
  scratchRoots.push(scratch);
  const termcraftDir = path.join(scratch, ".termcraft");
  fs.mkdirSync(termcraftDir);
  fs.writeFileSync(
    path.join(termcraftDir, "project.toml"),
    [
      "format_version = 2",
      `project_id = "${PROJECT_ID}"`,
      'name = "clock"',
      'created_at = "2026-07-26T19:58:57.883Z"',
      'target_stack = "js-opentui"',
      "",
    ].join("\n"),
  );
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
  const safeFs = createSafeProjectFs(root, deps);
  const scanned = scanFormatTwoProject(safeFs);
  if (scanned instanceof Error) throw scanned;
  return {
    fsDeps: { fs: nodeTransactionFsDeps(safeFs), append: { newPayloadId: nextPayloadId } },
    scanned,
  };
}

function payloadFor(
  built: { operations: readonly TransactionOperation[]; payloads: ReadonlyMap<string, Uint8Array> },
  target: string,
): Uint8Array | undefined {
  const op = built.operations.find((o) => o.target === target);
  if (op?.payloadId === undefined) return undefined;
  return built.payloads.get(op.payloadId);
}

describe("buildV2ToV3Operations (AT MOST THREE WRITES, project.toml LAST, no deletes)", () => {
  test("writes exactly three targets, and deletes nothing", () => {
    const { fsDeps, scanned } = seedForOperations({});
    const built = buildV2ToV3Operations(fsDeps, {
      scan: scanned,
      kitApiVersion: 1,
      newPayloadId: nextPayloadId,
    });
    if (built instanceof Error) throw built;
    expect(built.operations.map((o) => o.target)).toEqual([
      "design/system/design-system.json",
      "design/system/tokens.ts",
      "project.toml",
    ]);
    expect(built.operations.every((o) => o.mode === "replace")).toBe(true);
  });

  test("the seed bytes are IDENTICAL to createProject's", () => {
    const { fsDeps, scanned } = seedForOperations({});
    const built = buildV2ToV3Operations(fsDeps, {
      scan: scanned,
      kitApiVersion: 1,
      newPayloadId: nextPayloadId,
    });
    if (built instanceof Error) throw built;
    const expected = createDesignSystemSeedFiles({ kitApiVersion: 1 });
    expect(payloadFor(built, "design/system/design-system.json")).toEqual(expected[0]!.bytes);
    expect(payloadFor(built, "design/system/tokens.ts")).toEqual(expected[1]!.bytes);
  });

  test("project.toml is rewritten at format_version 3, every other field verbatim", () => {
    const { fsDeps, scanned } = seedForOperations({});
    const built = buildV2ToV3Operations(fsDeps, {
      scan: scanned,
      kitApiVersion: 1,
      newPayloadId: nextPayloadId,
    });
    if (built instanceof Error) throw built;
    const rewritten = decodeProjectManifest(
      new TextDecoder().decode(payloadFor(built, "project.toml")),
    );
    expect(rewritten).not.toBeInstanceOf(Error);
    if (rewritten instanceof Error) return;
    expect(rewritten.formatVersion).toBe(3);
    expect(rewritten.projectId).toBe(scanned.projectId);
    expect(rewritten.createdAt).toBe(scanned.createdAt);
  });

  test("backupFiles holds project.toml and nothing else", () => {
    const { fsDeps, scanned } = seedForOperations({});
    const built = buildV2ToV3Operations(fsDeps, {
      scan: scanned,
      kitApiVersion: 1,
      newPayloadId: nextPayloadId,
    });
    if (built instanceof Error) throw built;
    expect(built.backupFiles.map((f) => f.relPath)).toEqual(["project.toml"]);
  });

  test("NO page source is touched", () => {
    const { fsDeps, scanned } = seedForOperations({});
    const built = buildV2ToV3Operations(fsDeps, {
      scan: scanned,
      kitApiVersion: 1,
      newPayloadId: nextPayloadId,
    });
    if (built instanceof Error) throw built;
    expect(built.operations.some((o) => o.target.startsWith("design/pages/"))).toBe(false);
  });

  test("an existing design system is preserved — only project.toml is rewritten", () => {
    const { fsDeps, scanned } = seedForOperations({ hasDesignSystem: true });
    const built = buildV2ToV3Operations(fsDeps, {
      scan: scanned,
      kitApiVersion: 1,
      newPayloadId: nextPayloadId,
    });
    if (built instanceof Error) throw built;
    expect(built.operations.map((o) => o.target)).toEqual(["project.toml"]);
  });

  test("operation indexes are a dense 0..n-1 sequence", () => {
    const { fsDeps, scanned } = seedForOperations({});
    const built = buildV2ToV3Operations(fsDeps, {
      scan: scanned,
      kitApiVersion: 1,
      newPayloadId: nextPayloadId,
    });
    if (built instanceof Error) throw built;
    expect(built.operations.map((o) => o.index)).toEqual(
      built.operations.map((_op, index) => index),
    );
  });
});
