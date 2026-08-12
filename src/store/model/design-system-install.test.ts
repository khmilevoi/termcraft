import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseDesignSystemRef } from "entities/design-system-ref";
import { computeTreeRevision, createDesignTreeInventory } from "entities/design-tree";
import { uuidv7 } from "infrastructure/uuid";
import { CURRENT_KIT_API_VERSION } from "runtime";
import {
  DESIGN_SYSTEM_PROVENANCE_SCHEMA_VERSION,
  encodeDesignSystemProvenance,
} from "store/design-systems";
import type { DesignSystemProvenanceV1 } from "store/design-systems";
import { sha256Hex } from "store/jsonl";
import {
  FsAccessError,
  createSafeProjectFs,
  isNotFound,
  nodeSafeFsDeps,
  openManagedRoot,
} from "store/safe-fs";
import type { SafeProjectFs } from "store/safe-fs";
import {
  DesignSystemInstallInputError,
  TRANSACTION_JOURNAL_FORMAT_VERSION,
  buildDesignSystemInstallOperations,
  listTransactionIds,
  nodeTransactionFsDeps,
  readPlan,
  runCrashCase,
} from "store/transaction";
import type {
  ChildPayload,
  TransactionBoundary,
  TransactionOperation,
  TransactionPlan,
  TransactionWrapperDeps,
} from "store/transaction";

import type { OpenProject, StoreDeps } from "../types";
import { DesignSystemTreeDriftedError, createStore, nodeStoreDeps } from "./factory";

// Task 5 (P10 install-and-picker, D11): `installDesignSystem` writes every `design/system/**`
// file AND the provenance record in ONE recoverable `project-mutation` transaction. This file
// covers both halves of that claim: `buildDesignSystemInstallOperations`'s pure operation
// shaping (containment, target vocabulary) and the full engine round-trip (writes/deletes/
// provenance land together, in exactly one journal plan, and survive a crash at every boundary).

const TS = "2026-07-21T10:00:00Z";

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

const NEXT_MANIFEST = '{"id":"midnight","version":"1.2.0"}';
const BUTTON = "export const Button = () => null;";

const PROVENANCE_REF = parseDesignSystemRef("local:midnight@1.2.0");
if (PROVENANCE_REF instanceof Error) throw new Error(`fixture bug: ${PROVENANCE_REF.message}`);
const PROVENANCE: DesignSystemProvenanceV1 = {
  schemaVersion: DESIGN_SYSTEM_PROVENANCE_SCHEMA_VERSION,
  ref: PROVENANCE_REF,
  contentHash: sha256Hex(bytesOf("stub-package-bytes")),
  installedAt: TS,
};

// ---- low-level harness (mirrors `wrappers.test.ts`): a bare `.termcraft` root, no full
// project — used for `buildDesignSystemInstallOperations`'s own operation-shaping tests. -------

const lowLevelScratchRoots: string[] = [];

function freshTermcraftDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-design-system-install-"));
  lowLevelScratchRoots.push(dir);
  const inner = path.join(dir, ".termcraft");
  fs.mkdirSync(inner);
  return inner;
}

function openSafeFs(dir: string): SafeProjectFs {
  const deps = nodeSafeFsDeps();
  const root = openManagedRoot({ kind: "project", path: dir, deps });
  if (root instanceof Error) throw new Error(`openManagedRoot failed: ${root.message}`);
  return createSafeProjectFs(root, deps);
}

function wrapperDeps(dir: string): TransactionWrapperDeps {
  return { fs: nodeTransactionFsDeps(openSafeFs(dir)), append: { newPayloadId: uuidv7 } };
}

afterEach(() => {
  for (const dir of lowLevelScratchRoots.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("buildDesignSystemInstallOperations — operation shaping (D11)", () => {
  test("targets are PROJECT-relative and go through designFilePath — never a raw tree path", () => {
    const termcraftDir = freshTermcraftDir();
    const operations = buildDesignSystemInstallOperations(wrapperDeps(termcraftDir), {
      nextFiles: [{ treeRelPath: "system/design-system.json", bytes: bytesOf(NEXT_MANIFEST) }],
      removedTreeRelPaths: [],
      provenanceBytes: bytesOf("{}"),
    });
    expect(operations).not.toBeInstanceOf(Error);
    if (operations instanceof Error) return;
    expect(operations.map((b) => b.operation.target)).toEqual([
      "design/system/design-system.json",
      "design-system-source.json",
    ]);
  });

  test("nothing outside `system/` may be written", () => {
    const termcraftDir = freshTermcraftDir();
    const result = buildDesignSystemInstallOperations(wrapperDeps(termcraftDir), {
      nextFiles: [{ treeRelPath: "pages/dashboard.tsx", bytes: bytesOf("x") }],
      removedTreeRelPaths: [],
      provenanceBytes: bytesOf("{}"),
    });
    expect(result).toBeInstanceOf(DesignSystemInstallInputError);
  });

  test("nothing outside `system/` may be deleted", () => {
    const termcraftDir = freshTermcraftDir();
    const result = buildDesignSystemInstallOperations(wrapperDeps(termcraftDir), {
      nextFiles: [],
      removedTreeRelPaths: ["pages.json"],
      provenanceBytes: bytesOf("{}"),
    });
    expect(result).toBeInstanceOf(DesignSystemInstallInputError);
  });
});

// ---- full-engine harness (mirrors `transaction-engine-methods.test.ts`) -----------------------

const openScratchRoots: string[] = [];

function testDeps(userStateRoot: string): StoreDeps {
  return nodeStoreDeps({ userStateRoot });
}

async function freshOpenProject(): Promise<OpenProject> {
  const userStateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tc-design-install-userstate-"));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tc-design-install-project-"));
  openScratchRoots.push(userStateRoot, projectRoot);
  const store = createStore(testDeps(userStateRoot));
  const opened = await store.createProject({
    root: projectRoot,
    name: "Design System Install",
    targetStack: "generic",
    kitApiVersion: CURRENT_KIT_API_VERSION,
  });
  if (opened instanceof Error)
    throw new Error(`fixture bug: createProject failed: ${opened.message}`);
  return opened;
}

afterEach(() => {
  for (const dir of openScratchRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function designSystemPath(opened: OpenProject, relPath: string): string {
  return path.join(opened.root, ".termcraft", "design", ...relPath.split("/"));
}

function seedDesignSystemFile(opened: OpenProject, relPath: string, bytes: Uint8Array): void {
  const abs = designSystemPath(opened, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);
}

function readProjectFile(opened: OpenProject, relPath: string): string {
  const bytes = opened.safeFs.readFile(relPath);
  if (bytes instanceof Error) throw new Error(`fixture bug: ${bytes.message}`);
  return new TextDecoder().decode(bytes);
}

function existsProjectFile(opened: OpenProject, relPath: string): boolean {
  const bytes = opened.safeFs.readFile(relPath);
  if (bytes instanceof Error) {
    if (bytes instanceof FsAccessError && isNotFound(bytes)) return false;
    throw new Error(`fixture bug: ${bytes.message}`);
  }
  return true;
}

/**
 * The whole `design/` tree's `treeRevision` (I2 fix), computed the SAME way
 * `core/project/model/tree-index.ts`'s `readCanonicalTreeIndex` computes it at preview time and
 * `store/model/factory.ts`'s `assertDesignTreeNotDrifted` recomputes it at commit time —
 * `opened.pages.listTree()` is the store-side counterpart of the `DesignTreeReader` port both of
 * those use. A test captures this BEFORE whatever state it wants to treat as "what the preview
 * saw", then passes it as `expectedTreeRevision` to `installDesignSystem`.
 */
async function currentTreeRevision(opened: OpenProject): Promise<string> {
  const listed = await opened.pages.listTree();
  if (listed instanceof Error) throw new Error(`fixture bug: ${listed.message}`);
  const inventory = createDesignTreeInventory(
    listed.map((file) => ({ relPath: file.relPath, sha256: file.sha256 })),
  );
  if (inventory instanceof Error) throw new Error(`fixture bug: ${inventory.message}`);
  return computeTreeRevision(inventory);
}

/**
 * Every durable journal plan under `transactions.local/` whose `mutationKind` matches, decoded.
 * Filtered by kind rather than listed wholesale: `freshOpenProject()`'s own `createProject` call
 * already commits a `project-creation` plan of its own before the test ever runs, so an
 * unfiltered listing would never read `1` even when the install genuinely used exactly one
 * transaction — the property this helper exists to prove.
 */
function designSystemInstallPlans(opened: OpenProject): readonly TransactionPlan[] {
  const fsDeps = nodeTransactionFsDeps(opened.safeFs);
  const ids = listTransactionIds(fsDeps);
  if (ids instanceof Error) throw new Error(`fixture bug: ${ids.message}`);
  const plans: TransactionPlan[] = [];
  for (const id of ids) {
    const plan = readPlan(fsDeps, id);
    if (plan instanceof Error) throw new Error(`fixture bug: ${plan.message}`);
    if (plan === null) continue;
    if (plan.kind !== "project-mutation") continue;
    if (plan.domain.mutationKind !== "design-system-install") continue;
    plans.push(plan);
  }
  return plans;
}

describe("TransactionEngine.installDesignSystem — one recoverable transaction (D11, §8.3, §8.5)", () => {
  test("writes every new system file, deletes every removed one, and the provenance record", async () => {
    const opened = await freshOpenProject();
    try {
      seedDesignSystemFile(
        opened,
        "system/components/Legacy.tsx",
        bytesOf("export const Legacy = () => null;"),
      );
      const expectedTreeRevision = await currentTreeRevision(opened);

      const built = await opened.transactions.installDesignSystem({
        transactionId: uuidv7(),
        actionId: uuidv7(),
        nextFiles: [
          { treeRelPath: "system/design-system.json", bytes: bytesOf(NEXT_MANIFEST) },
          { treeRelPath: "system/components/Button.tsx", bytes: bytesOf(BUTTON) },
        ],
        removedTreeRelPaths: ["system/components/Legacy.tsx"],
        provenanceBytes: encodeDesignSystemProvenance(PROVENANCE),
        expectedTreeRevision,
        createdAt: TS,
      });
      expect(built).not.toBeInstanceOf(Error);

      expect(readProjectFile(opened, "design/system/design-system.json")).toBe(NEXT_MANIFEST);
      expect(readProjectFile(opened, "design/system/components/Button.tsx")).toBe(BUTTON);
      expect(existsProjectFile(opened, "design/system/components/Legacy.tsx")).toBe(false);
      expect(readProjectFile(opened, "design-system-source.json")).toContain(
        "local:midnight@1.2.0",
      );
    } finally {
      await opened.close();
    }
  }, 20_000);

  test("the provenance record and the system files land in ONE transaction", async () => {
    const opened = await freshOpenProject();
    try {
      const expectedTreeRevision = await currentTreeRevision(opened);
      const built = await opened.transactions.installDesignSystem({
        transactionId: uuidv7(),
        actionId: uuidv7(),
        nextFiles: [{ treeRelPath: "system/design-system.json", bytes: bytesOf(NEXT_MANIFEST) }],
        removedTreeRelPaths: [],
        provenanceBytes: encodeDesignSystemProvenance(PROVENANCE),
        expectedTreeRevision,
        createdAt: TS,
      });
      if (built instanceof Error) throw built;

      // `designSystemInstallPlans` already filters on `domain.mutationKind ===
      // "design-system-install"`, so `toHaveLength(1)` alone is the whole assertion: exactly one
      // journal plan of that kind exists, not two (a system-files plan plus a separate
      // provenance plan).
      const plans = designSystemInstallPlans(opened);
      expect(plans).toHaveLength(1);
    } finally {
      await opened.close();
    }
  }, 20_000);
});

// ---- I2 fix: tree-drift protection between preview and commit ---------------------------------
//
// `assertDesignTreeNotDrifted` (`./factory.ts`) refuses `installDesignSystem` when the whole
// `design/` tree changed since `expectedTreeRevision` was captured — closing the window a
// designer's held breakage-preview dialog would otherwise leave open. Both drift and no-drift use
// ONLY `installDesignSystem` itself (the store's own normal write path into `design/system/**`),
// never a raw filesystem poke, so "drift" here is exactly what it would be in production: a
// second install (a concurrent turn's own commit path is the identical shape at the engine level
// — one `runProjectMutation` under the same write mutex) landing between this test's captured
// `expectedTreeRevision` and its own `installDesignSystem` call.
describe("TransactionEngine.installDesignSystem — tree-drift protection (I2 fix)", () => {
  test("a concurrent install between preview and commit is refused, and the stale commit's own files are never written", async () => {
    const opened = await freshOpenProject();
    try {
      // The "preview": captured before anything else changes the tree.
      const staleExpectedTreeRevision = await currentTreeRevision(opened);

      // A CONCURRENT install lands first, through the identical `installDesignSystem` path — the
      // "an agent turn committed design/system/extra.tsx while the dialog was open" scenario.
      // It carries its OWN freshly-captured revision, so it is not itself drifted, and succeeds.
      const concurrent = await opened.transactions.installDesignSystem({
        transactionId: uuidv7(),
        actionId: uuidv7(),
        nextFiles: [{ treeRelPath: "system/extra.tsx", bytes: bytesOf("export const x = 1;") }],
        removedTreeRelPaths: [],
        provenanceBytes: encodeDesignSystemProvenance(PROVENANCE),
        expectedTreeRevision: staleExpectedTreeRevision,
        createdAt: TS,
      });
      expect(concurrent).not.toBeInstanceOf(Error);
      expect(existsProjectFile(opened, "design/system/extra.tsx")).toBe(true);

      // The STALE commit — still carrying the revision captured BEFORE the concurrent install —
      // is refused rather than overwriting whatever the concurrent install just landed.
      const stale = await opened.transactions.installDesignSystem({
        transactionId: uuidv7(),
        actionId: uuidv7(),
        nextFiles: [{ treeRelPath: "system/design-system.json", bytes: bytesOf(NEXT_MANIFEST) }],
        removedTreeRelPaths: [],
        provenanceBytes: encodeDesignSystemProvenance(PROVENANCE),
        expectedTreeRevision: staleExpectedTreeRevision,
        createdAt: TS,
      });
      expect(stale).toBeInstanceOf(DesignSystemTreeDriftedError);

      // The tree is untouched by the refused commit: `design-system.json` is still whatever
      // `createProject` originally seeded (`freshOpenProject` scaffolds one), NEVER the stale
      // attempt's `NEXT_MANIFEST` — neither the concurrent install nor the refused one touched
      // this path. `extra.tsx` from the concurrent install is still exactly as it landed, and no
      // second `design-system-install` transaction plan was ever produced for the refused call.
      expect(readProjectFile(opened, "design/system/design-system.json")).not.toBe(NEXT_MANIFEST);
      expect(existsProjectFile(opened, "design/system/extra.tsx")).toBe(true);
      expect(designSystemInstallPlans(opened)).toHaveLength(1);
    } finally {
      await opened.close();
    }
  }, 20_000);

  test("regression guard: no drift since the captured revision — the commit still succeeds unchanged", async () => {
    const opened = await freshOpenProject();
    try {
      const expectedTreeRevision = await currentTreeRevision(opened);

      const built = await opened.transactions.installDesignSystem({
        transactionId: uuidv7(),
        actionId: uuidv7(),
        nextFiles: [{ treeRelPath: "system/design-system.json", bytes: bytesOf(NEXT_MANIFEST) }],
        removedTreeRelPaths: [],
        provenanceBytes: encodeDesignSystemProvenance(PROVENANCE),
        expectedTreeRevision,
        createdAt: TS,
      });
      expect(built).not.toBeInstanceOf(Error);
      expect(readProjectFile(opened, "design/system/design-system.json")).toBe(NEXT_MANIFEST);
    } finally {
      await opened.close();
    }
  }, 20_000);
});

// ---- §11 crash sweep: every named boundary, never a half-replaced system ----------------------

const CRASH_BOUNDARIES: readonly TransactionBoundary[] = [
  "payload-installed",
  "plan-installed",
  "precondition-checked",
  "intent-installed",
  "operation-target-applied",
  "operation-marker-installed",
  "committed-installed",
];

/**
 * Builds one design-system-install plan directly against a bare `.termcraft` root — the same
 * low-level shape `crash-harness.test.ts`'s own `multiOpPlan` uses, since the crash harness
 * spawns a real child process that re-opens `termcraftDir` from scratch and knows nothing about
 * `OpenProject`. `system/components/Legacy.tsx` and a prior provenance record are pre-seeded so
 * the plan exercises a `replace`, a `delete`, and a provenance `replace` with a real (non-absent)
 * `oldImage` — the same three-op shape the engine test above proves end to end.
 */
function designSystemInstallPlan(
  transactionId: string,
  dir: string,
): { plan: TransactionPlan; payloads: readonly ChildPayload[] } {
  fs.mkdirSync(path.join(dir, "design", "system", "components"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "design", "system", "components", "Legacy.tsx"),
    bytesOf("export const Legacy = () => null;"),
  );
  const oldProvenance = encodeDesignSystemProvenance({
    ...PROVENANCE,
    installedAt: "2026-07-01T00:00:00Z",
  });
  fs.writeFileSync(path.join(dir, "design-system-source.json"), oldProvenance);

  const deps = wrapperDeps(dir);
  const built = buildDesignSystemInstallOperations(deps, {
    nextFiles: [
      { treeRelPath: "system/design-system.json", bytes: bytesOf(NEXT_MANIFEST) },
      { treeRelPath: "system/components/Button.tsx", bytes: bytesOf(BUTTON) },
    ],
    removedTreeRelPaths: ["system/components/Legacy.tsx"],
    provenanceBytes: encodeDesignSystemProvenance(PROVENANCE),
  });
  if (built instanceof Error) throw new Error(`fixture bug: ${built.message}`);

  const operations: TransactionOperation[] = built.map((entry, index) => ({
    ...entry.operation,
    index,
  }));
  const payloads: ChildPayload[] = built.flatMap((entry) =>
    entry.payload === undefined
      ? []
      : [
          {
            payloadId: entry.payload[0],
            bytesBase64: Buffer.from(entry.payload[1]).toString("base64"),
          },
        ],
  );

  const plan: TransactionPlan = {
    journalVersion: TRANSACTION_JOURNAL_FORMAT_VERSION,
    transactionId,
    kind: "project-mutation",
    domain: { actionId: uuidv7(), mutationKind: "design-system-install" },
    createdAt: TS,
    operations,
  };
  return { plan, payloads };
}

describe("§11: a crash between quarantine and commit never leaves a half-replaced system", () => {
  test("every named boundary recovers to exactly pre-intent or exactly committed — never mixed", async () => {
    for (const boundary of CRASH_BOUNDARIES) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-design-install-crash-"));
      const termcraftScratch = path.join(dir, ".termcraft");
      fs.mkdirSync(termcraftScratch);
      try {
        const { plan, payloads } = designSystemInstallPlan(uuidv7(), termcraftScratch);
        const outcome = await runCrashCase({
          termcraftDir: termcraftScratch,
          plan,
          payloads,
          crash: { kind: "boundary", boundary },
        });
        if (!outcome.ok) throw new Error(`fixture bug: ${outcome.error.message}`);
        if (outcome.targetsState instanceof Error) throw outcome.targetsState;

        expect(outcome.targetsState).not.toBe("mixed");
        expect(outcome.recovery.ok).toBe(true);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 120_000);
});
