import { describe, expect, test } from "bun:test";

import { context, wrap } from "@reatom/core";

import {
  type StateMachine,
  type TurnAction,
  type TurnState,
  reatomTurnStateMachine,
} from "core/machines";
import type { StagedFileV1, StagedTurnReadSetV1, TurnWorkspaceV1 } from "core/ports";
import { type FakeStagingService, createFakeStagingService } from "core/ports/fakes";
import type { FailureDtoV1, Sha256Hex } from "core/protocol";
import { createDesignTreeInventory } from "entities/design-tree";
import type { DesignTreeInventoryV1 } from "entities/design-tree";
import type { PageSlug } from "entities/page";

import {
  type FreezeTurnCandidateDeps,
  diffTreeInventory,
  freezeTurnCandidate,
  selectChangedPages,
} from "./candidate";

/**
 * `freezeTurnCandidate`/`diffTreeInventory`/`selectChangedPages` against 6D's fake
 * `StagingService` only, matching `admission.test.ts`'s/`finalize.test.ts`'s own harness
 * style.
 */

const SHA_A = "a".repeat(64) as Sha256Hex;
const SHA_B = "b".repeat(64) as Sha256Hex;

/** `design/pages.json`'s own frozen text — never actually parsed by this suite; it only proves the byte-for-byte pass-through. */
const DEFAULT_MANIFEST_TEXT = '{"schemaVersion":1,"pages":[],"requestedActivePage":null}';

function machineAtSnapshotting(): StateMachine<TurnState, TurnAction> {
  const m = reatomTurnStateMachine();
  m.apply("beginAdmission");
  m.apply("finishAdmission");
  m.apply("beginAttempt");
  m.apply("beginStopping");
  m.apply("beginSnapshot");
  return m;
}

function baseReadSet(overrides: Partial<StagedTurnReadSetV1> = {}): StagedTurnReadSetV1 {
  return {
    manifest: { sha256: SHA_A, size: 10 },
    designFiles: [{ relPath: "screens/landing.tsx", snapshot: { sha256: SHA_A, size: 100 } }],
    chat: { length: 10, prefixSha256: SHA_A },
    pins: [],
    ...overrides,
  };
}

/** Stubs the fake's `readCandidateFile` to answer `design/pages.json` with `text`, falling through to the real fake for anything else. */
function stubManifestText(staging: FakeStagingService, text: string = DEFAULT_MANIFEST_TEXT): void {
  const original = staging.readCandidateFile.bind(staging);
  staging.readCandidateFile = async (root: string, relPath: string) => {
    if (relPath === "design/pages.json") return new TextEncoder().encode(text);
    return original(root, relPath);
  };
}

function harness(readSet: StagedTurnReadSetV1 = baseReadSet()) {
  const machine = machineAtSnapshotting();
  const staging = createFakeStagingService();
  stubManifestText(staging);
  const workspace: TurnWorkspaceV1 = {
    turnId: "turn-1",
    root: "/fake-turn-workspace/turn-1",
    files: [],
    totalBytes: 0,
    readSet,
  };
  const deps: FreezeTurnCandidateDeps = { machine, staging };
  return { deps, machine, staging, workspace };
}

/** Programs the fake's NEXT `snapshotToCandidate` result directly, bypassing its default synth. */
function queueCandidate(
  staging: FakeStagingService,
  files: TurnWorkspaceV1["files"],
  totalBytes = 0,
): void {
  const originalSnapshot = staging.snapshotToCandidate.bind(staging);
  staging.snapshotToCandidate = async (workspace: TurnWorkspaceV1) => {
    staging.snapshotToCandidate = originalSnapshot;
    return { root: `/fake-candidate/${workspace.turnId}`, files, totalBytes };
  };
}

describe("freezeTurnCandidate — snapshotting -> validating", () => {
  test("illegal from a non-snapshotting phase: returns illegal, machine phase unchanged", async () => {
    await context.start(async () => {
      const h = harness();
      h.machine.apply("candidateCaptured"); // already "validating" before this run starts

      const result = await wrap(freezeTurnCandidate(h.deps, { workspace: h.workspace }));

      expect(result).toEqual({ kind: "illegal", code: "TURN_ALREADY_ACTIVE" });
      expect(h.machine.phase()).toBe("validating");
    });
  });

  test("propagates a staging failure and does not advance the machine", async () => {
    await context.start(async () => {
      const h = harness();
      const failure: FailureDtoV1 = {
        code: "PERSISTENCE_FAILED",
        retryable: false,
        safeMessage: "boom",
        details: {},
      };
      h.staging.failNext("snapshotToCandidate", failure);

      const result = await wrap(freezeTurnCandidate(h.deps, { workspace: h.workspace }));

      expect(result).toEqual({ kind: "failed", failure });
      expect(h.machine.phase()).toBe("snapshotting");
    });
  });

  test("the happy path calls staging.snapshotToCandidate with the exact workspace, then candidateCaptured", async () => {
    await context.start(async () => {
      const h = harness();

      const result = await wrap(freezeTurnCandidate(h.deps, { workspace: h.workspace }));
      if (result.kind !== "captured")
        throw new Error(`expected captured, got ${JSON.stringify(result)}`);

      expect(h.staging.calls[0]).toEqual({ method: "snapshotToCandidate", turnId: "turn-1" });
      expect(h.machine.phase()).toBe("validating");
      expect(result.candidate.root).toBe("/fake-candidate/turn-1");
    });
  });

  test("a design/pages.json read failure IS a genuine failure when the manifest is listed in the candidate's own files — the machine already advanced to validating", async () => {
    // Distinct from the "absent" test below (task-13 review round 1, Important I2): the
    // manifest IS one of this candidate's own `StagedFileV1` entries, so `readCandidateFile`
    // is within contract here — a failure is therefore a genuine infrastructure problem, not
    // an honest absence.
    await context.start(async () => {
      const h = harness();
      queueCandidate(h.staging, [{ relPath: "design/pages.json", sha256: SHA_A, size: 2 }]);
      const failure: FailureDtoV1 = {
        code: "PERSISTENCE_FAILED",
        retryable: false,
        safeMessage: "no candidate file",
        details: {},
      };
      h.staging.readCandidateFile = async () => failure;

      const result = await wrap(freezeTurnCandidate(h.deps, { workspace: h.workspace }));

      expect(result).toEqual({ kind: "failed", failure });
      // `candidateCaptured` already applied before the manifest read is attempted — the same
      // "already transitioned, then failed" shape `finalize.ts`'s own header documents.
      expect(h.machine.phase()).toBe("validating");
    });
  });

  test("an ABSENT design/pages.json is an honest empty manifestText, never a failed read — captured, and readCandidateFile is never called out of contract (task-13 review round 1, Important I2)", async () => {
    await context.start(async () => {
      const h = harness();
      // Deliberately no `design/pages.json` entry — this candidate never staged one (the agent
      // deleted it, or a fresh tree never had one). A stubbed `readCandidateFile` that would
      // fail for ANY path proves the code path is never reached at all, not merely that it
      // happens to succeed.
      h.staging.readCandidateFile = async () => {
        throw new Error("readCandidateFile must not be called for an unlisted manifest path");
      };
      queueCandidate(h.staging, [
        { relPath: "design/screens/landing.tsx", sha256: SHA_A, size: 100 },
      ]);

      const result = await wrap(freezeTurnCandidate(h.deps, { workspace: h.workspace }));

      if (result.kind !== "captured")
        throw new Error(`expected captured, got ${JSON.stringify(result)}`);
      expect(result.candidate.manifestText).toBe("");
      expect(h.staging.calls.some((c) => c.method === "readCandidateFile")).toBe(false);
    });
  });

  test("manifestText is the frozen candidate's own design/pages.json content, decoded verbatim", async () => {
    await context.start(async () => {
      const h = harness();
      const manifestText =
        '{"schemaVersion":1,"pages":[{"slug":"home","entry":"screens/landing.tsx"}],"requestedActivePage":null}';
      stubManifestText(h.staging, manifestText);
      queueCandidate(h.staging, [{ relPath: "design/pages.json", sha256: SHA_A, size: 40 }]);

      const result = await wrap(freezeTurnCandidate(h.deps, { workspace: h.workspace }));
      if (result.kind !== "captured")
        throw new Error(`expected captured, got ${JSON.stringify(result)}`);

      expect(result.candidate.manifestText).toBe(manifestText);
    });
  });

  test("treeFiles are the candidate's design/ files with the prefix stripped — non-design files (RUNTIME.md) excluded", async () => {
    await context.start(async () => {
      const h = harness();
      queueCandidate(h.staging, [
        { relPath: "design/pages.json", sha256: SHA_A, size: 2 },
        { relPath: "design/pages/about.tsx", sha256: SHA_B, size: 40 },
        { relPath: "design/lib/theme.ts", sha256: SHA_A, size: 12 },
        { relPath: "RUNTIME.md", sha256: SHA_A, size: 5 },
      ]);

      const result = await wrap(freezeTurnCandidate(h.deps, { workspace: h.workspace }));
      if (result.kind !== "captured")
        throw new Error(`expected captured, got ${JSON.stringify(result)}`);

      expect(result.candidate.treeFiles.map((f) => f.relPath).sort()).toEqual([
        "lib/theme.ts",
        "pages.json",
        "pages/about.tsx",
      ]);
    });
  });

  test("diff: an unchanged file (same sha256) produces no change entry", async () => {
    await context.start(async () => {
      const h = harness(
        baseReadSet({
          designFiles: [{ relPath: "screens/landing.tsx", snapshot: { sha256: SHA_A, size: 100 } }],
        }),
      );
      queueCandidate(h.staging, [
        { relPath: "design/screens/landing.tsx", sha256: SHA_A, size: 100 },
      ]);

      const result = await wrap(freezeTurnCandidate(h.deps, { workspace: h.workspace }));
      if (result.kind !== "captured")
        throw new Error(`expected captured, got ${JSON.stringify(result)}`);

      expect(result.candidate.fileChanges).toEqual([]);
    });
  });

  test("diff: a changed hash on an already-present file is 'modified'", async () => {
    await context.start(async () => {
      const h = harness(
        baseReadSet({
          designFiles: [{ relPath: "screens/landing.tsx", snapshot: { sha256: SHA_A, size: 100 } }],
        }),
      );
      queueCandidate(h.staging, [
        { relPath: "design/screens/landing.tsx", sha256: SHA_B, size: 120 },
      ]);

      const result = await wrap(freezeTurnCandidate(h.deps, { workspace: h.workspace }));
      if (result.kind !== "captured")
        throw new Error(`expected captured, got ${JSON.stringify(result)}`);

      expect(result.candidate.fileChanges).toEqual([
        { relPath: "screens/landing.tsx", change: "modified", sha256: SHA_B, size: 120 },
      ]);
    });
  });

  test("diff: an expected-absent file (null snapshot) that now exists is 'added'", async () => {
    await context.start(async () => {
      const h = harness(
        baseReadSet({
          designFiles: [
            { relPath: "screens/landing.tsx", snapshot: { sha256: SHA_A, size: 100 } },
            { relPath: "screens/about.tsx", snapshot: null },
          ],
        }),
      );
      queueCandidate(h.staging, [
        { relPath: "design/screens/landing.tsx", sha256: SHA_A, size: 100 },
        { relPath: "design/screens/about.tsx", sha256: SHA_B, size: 30 },
      ]);

      const result = await wrap(freezeTurnCandidate(h.deps, { workspace: h.workspace }));
      if (result.kind !== "captured")
        throw new Error(`expected captured, got ${JSON.stringify(result)}`);

      expect(result.candidate.fileChanges).toEqual([
        { relPath: "screens/about.tsx", change: "added", sha256: SHA_B, size: 30 },
      ]);
    });
  });

  test("diff: a file present at admission but absent from the candidate is 'removed'", async () => {
    await context.start(async () => {
      const h = harness(
        baseReadSet({
          designFiles: [
            { relPath: "screens/landing.tsx", snapshot: { sha256: SHA_A, size: 100 } },
            { relPath: "lib/gone.ts", snapshot: { sha256: SHA_A, size: 50 } },
          ],
        }),
      );
      queueCandidate(h.staging, [
        { relPath: "design/screens/landing.tsx", sha256: SHA_A, size: 100 },
      ]);

      const result = await wrap(freezeTurnCandidate(h.deps, { workspace: h.workspace }));
      if (result.kind !== "captured")
        throw new Error(`expected captured, got ${JSON.stringify(result)}`);

      expect(result.candidate.fileChanges).toEqual([
        { relPath: "lib/gone.ts", change: "removed", sha256: null, size: null },
      ]);
    });
  });

  test("diff never touches file content — only relPath/sha256/size are read", async () => {
    // projections §9: "The Kernel computes each initial source hash while copying. It does
    // not make a second full source snapshot merely for diffing." This is a structural
    // guard: `StagedFileV1` carries no byte content at all, so there is nothing for this
    // module to read even if it tried — proven by a file whose sha256 changed being
    // reported from the HASH alone.
    await context.start(async () => {
      const h = harness(
        baseReadSet({
          designFiles: [{ relPath: "screens/landing.tsx", snapshot: { sha256: SHA_A, size: 100 } }],
        }),
      );
      queueCandidate(h.staging, [
        { relPath: "design/screens/landing.tsx", sha256: SHA_B, size: 100 },
      ]);

      const result = await wrap(freezeTurnCandidate(h.deps, { workspace: h.workspace }));
      if (result.kind !== "captured")
        throw new Error(`expected captured, got ${JSON.stringify(result)}`);

      expect(result.candidate.fileChanges).toEqual([
        { relPath: "screens/landing.tsx", change: "modified", sha256: SHA_B, size: 100 },
      ]);
    });
  });

  test("PINS the M9 hazard: a read-set entry using the WRONG (project-relative) vocabulary diffs as both added and removed, never unchanged (task-13 review round 1, Minor M9)", async () => {
    // `StagedTurnReadSetV1.designFiles[].relPath` is documented TREE-relative
    // (`core/ports/staging.ts`'s own header) — `toBeforeInventory` silently trusts that. This
    // test is the canary: if a caller ever violated the vocabulary (passed the `design/`-
    // prefixed, PROJECT-relative name instead), nothing here throws a type error — the SAME
    // byte-identical file just silently diffs as both "removed" (its wrong-vocabulary name
    // never matches the candidate's own tree-relative name) and "added" (the candidate's real
    // tree-relative name never matches the wrong-vocabulary one). This is exactly the failure
    // mode the port's own header now documents explicitly, precisely so a future caller cannot
    // violate it without a code comment telling them not to.
    await context.start(async () => {
      const h = harness(
        baseReadSet({
          designFiles: [
            // WRONG: project-relative (`design/`-prefixed), not tree-relative.
            { relPath: "design/screens/landing.tsx", snapshot: { sha256: SHA_A, size: 100 } },
          ],
        }),
      );
      queueCandidate(h.staging, [
        { relPath: "design/screens/landing.tsx", sha256: SHA_A, size: 100 },
      ]);

      const result = await wrap(freezeTurnCandidate(h.deps, { workspace: h.workspace }));
      if (result.kind !== "captured")
        throw new Error(`expected captured, got ${JSON.stringify(result)}`);

      expect(result.candidate.fileChanges).toEqual([
        { relPath: "design/screens/landing.tsx", change: "removed", sha256: null, size: null },
        { relPath: "screens/landing.tsx", change: "added", sha256: SHA_A, size: 100 },
      ]);
    });
  });
});

/** `createDesignTreeInventory`'s own sort/dup-check is exercised by its own suite — this helper only needs an honest, valid inventory. */
function inventoryOf(pairs: readonly (readonly [string, string])[]): DesignTreeInventoryV1 {
  const inventory = createDesignTreeInventory(
    pairs.map(([relPath, sha256]) => ({ relPath, sha256 })),
  );
  if (inventory instanceof Error) throw inventory;
  return inventory;
}

function file(relPath: string, sha256: string, size = 1): StagedFileV1 {
  return { relPath, sha256: sha256 as Sha256Hex, size };
}

describe("diffTreeInventory", () => {
  test("the file diff totals over the union of both sides", () => {
    const { fileChanges } = diffTreeInventory(
      inventoryOf([
        ["a.tsx", "1"],
        ["gone.tsx", "2"],
      ]),
      [file("a.tsx", "1"), file("new.tsx", "3")],
    );
    expect(fileChanges).toEqual([
      { relPath: "gone.tsx", change: "removed", sha256: null, size: null },
      { relPath: "new.tsx", change: "added", sha256: expect.any(String), size: expect.any(Number) },
    ]);
  });
});

describe("selectChangedPages", () => {
  test("a shared-module edit marks EVERY page that reaches it as changed", () => {
    const before = inventoryOf([
      ["pages/a.tsx", "aa"],
      ["pages/b.tsx", "bb"],
      ["pages/c.tsx", "cc"],
      ["lib/theme.ts", "t1"],
    ]);
    const after = inventoryOf([
      ["pages/a.tsx", "aa"],
      ["pages/b.tsx", "bb"],
      ["pages/c.tsx", "cc"],
      ["lib/theme.ts", "t2"],
    ]);
    const changed = selectChangedPages({
      closures: [
        { slug: "a" as PageSlug, files: ["pages/a.tsx", "lib/theme.ts"] },
        { slug: "b" as PageSlug, files: ["pages/b.tsx", "lib/theme.ts"] },
        { slug: "c" as PageSlug, files: ["pages/c.tsx"] },
      ],
      beforeInventory: before,
      afterInventory: after,
    });
    expect([...changed].sort()).toEqual(["a", "b"] as PageSlug[]);
  });

  test("a duplicate slug across two closure entries is reported exactly once, never twice (task-13 review round 1, Minor M2)", () => {
    // `input.closures` is a raw list this function does not control the shape of — nothing
    // upstream guarantees one slug names at most one entry. Two entries naming the SAME slug
    // (here with different file sets, so both independently qualify as changed) must still
    // collapse to one reported slug, not two.
    const before = inventoryOf([
      ["pages/a.tsx", "aa"],
      ["lib/theme.ts", "t1"],
      ["lib/other.ts", "o1"],
    ]);
    const after = inventoryOf([
      ["pages/a.tsx", "aa"],
      ["lib/theme.ts", "t2"],
      ["lib/other.ts", "o2"],
    ]);
    const changed = selectChangedPages({
      closures: [
        { slug: "a" as PageSlug, files: ["pages/a.tsx", "lib/theme.ts"] },
        { slug: "a" as PageSlug, files: ["pages/a.tsx", "lib/other.ts"] },
      ],
      beforeInventory: before,
      afterInventory: after,
    });
    expect(changed).toEqual(["a"] as PageSlug[]);
  });

  test("a page whose closure is byte-identical is NOT reported", () => {
    const inventory = inventoryOf([
      ["pages/a.tsx", "aa"],
      ["lib/theme.ts", "t1"],
    ]);
    expect(
      selectChangedPages({
        closures: [{ slug: "a" as PageSlug, files: ["pages/a.tsx", "lib/theme.ts"] }],
        beforeInventory: inventory,
        afterInventory: inventory,
      }),
    ).toEqual([]);
  });

  test("a newly listed page is changed even with no before-image", () => {
    expect(
      selectChangedPages({
        closures: [{ slug: "new" as PageSlug, files: ["pages/new.tsx"] }],
        beforeInventory: inventoryOf([]),
        afterInventory: inventoryOf([["pages/new.tsx", "nn"]]),
      }),
    ).toEqual(["new"] as PageSlug[]);
  });

  test("closures are matched by SLUG IDENTITY, not by a slug-derived path convention — an entry unrelated to its slug still tracks correctly", () => {
    // Test-quality trap this suite must not repeat: a fixture whose entry equals
    // `pages/<slug>.tsx` proves nothing about closure matching, since that IS the naming
    // convention the whole design-tree plan retires (entries are named by `pages.json`,
    // never derived from the slug). `dashboard`'s own entry below is deliberately unrelated.
    const before = inventoryOf([
      ["screens/main-dashboard.tsx", "d1"],
      ["lib/theme.ts", "t1"],
    ]);
    const after = inventoryOf([
      ["screens/main-dashboard.tsx", "d1"],
      ["lib/theme.ts", "t2"],
    ]);
    const changed = selectChangedPages({
      closures: [
        { slug: "dashboard" as PageSlug, files: ["screens/main-dashboard.tsx", "lib/theme.ts"] },
      ],
      beforeInventory: before,
      afterInventory: after,
    });
    expect(changed).toEqual(["dashboard"] as PageSlug[]);
  });

  test("a closure file absent from BEFORE only (present in after) is honestly reported as changed, never as 'unchanged'", () => {
    // `computeClosureHash` returns `null` when it cannot be computed — "I cannot prove it is
    // unchanged" must never collapse into "unchanged" (this function's own doc comment).
    const before = inventoryOf([["pages/a.tsx", "aa"]]); // "lib/theme.ts" missing from before
    const after = inventoryOf([
      ["pages/a.tsx", "aa"],
      ["lib/theme.ts", "t1"],
    ]);
    const changed = selectChangedPages({
      closures: [{ slug: "a" as PageSlug, files: ["pages/a.tsx", "lib/theme.ts"] }],
      beforeInventory: before,
      afterInventory: after,
    });
    expect(changed).toEqual(["a"] as PageSlug[]);
  });

  test("a closure file absent from AFTER only (present in before) is honestly reported as changed, never as 'unchanged'", () => {
    // The mirror of the BEFORE-only test above — a closure file present at send time but
    // missing from the frozen candidate (e.g. deleted mid-turn) must be exactly as unprovable
    // as the reverse direction (task-13 review round 1, Important I3).
    const before = inventoryOf([
      ["pages/a.tsx", "aa"],
      ["lib/theme.ts", "t1"],
    ]);
    const after = inventoryOf([["pages/a.tsx", "aa"]]); // "lib/theme.ts" missing from after
    const changed = selectChangedPages({
      closures: [{ slug: "a" as PageSlug, files: ["pages/a.tsx", "lib/theme.ts"] }],
      beforeInventory: before,
      afterInventory: after,
    });
    expect(changed).toEqual(["a"] as PageSlug[]);
  });

  test("a closure file absent from BOTH sides is honestly reported as changed — the load-bearing case neither one-sided test above can prove (task-13 review round 1, Important I3)", () => {
    // With `beforeHash`/`afterHash` BOTH null, a guard reduced to plain `beforeHash !==
    // afterHash` (`null !== null` is `false`) would silently report this as UNCHANGED — the
    // exact "I cannot prove it is unchanged" -> "unchanged" collapse this function's own doc
    // comment forbids. Neither one-sided test above exercises this: each leaves the OTHER side
    // a real, non-null hash, so plain `!==` already returns `true` there by coincidence. This
    // is the one case where the explicit `=== null` guard is the only thing keeping the answer
    // honest — mutating it away (`beforeHash !== afterHash` alone) makes exactly this test fail
    // (verified by hand: reverting `selectChangedPages`'s filter to that bare comparison turns
    // this single test red, all others stay green).
    const before = inventoryOf([["pages/a.tsx", "aa"]]); // "lib/theme.ts" missing from both...
    const after = inventoryOf([["pages/a.tsx", "aa"]]); // ...inventories entirely
    const changed = selectChangedPages({
      closures: [{ slug: "a" as PageSlug, files: ["pages/a.tsx", "lib/theme.ts"] }],
      beforeInventory: before,
      afterInventory: after,
    });
    expect(changed).toEqual(["a"] as PageSlug[]);
  });
});
