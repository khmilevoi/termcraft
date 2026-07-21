import { describe, expect, test } from "bun:test";

import { context, wrap } from "@reatom/core";

import {
  type StateMachine,
  type TurnAction,
  type TurnState,
  reatomTurnStateMachine,
} from "core/machines";
import type { StagedTurnReadSetV1, TurnWorkspaceV1 } from "core/ports";
import { type FakeStagingService, createFakeStagingService } from "core/ports/fakes";
import type { FailureDtoV1, Sha256Hex } from "core/protocol";
import { type PageSlug, parsePageSlug } from "entities/page";

import { type FreezeTurnCandidateDeps, freezeTurnCandidate } from "./candidate";

/**
 * `freezeTurnCandidate` against 6D's fake `StagingService` only, matching
 * `admission.test.ts`'s/`finalize.test.ts`'s own harness style.
 */

function slug(value: string): PageSlug {
  const parsed = parsePageSlug(value);
  if (parsed instanceof Error) throw parsed;
  return parsed;
}

const PAGE_HOME = slug("home");
const PAGE_ABOUT = slug("about");
const PAGE_GONE = slug("gone");

const SHA_A = "a".repeat(64) as Sha256Hex;
const SHA_B = "b".repeat(64) as Sha256Hex;

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
    canonicalPages: [{ pageSlug: PAGE_HOME, snapshot: { sha256: SHA_A, size: 100 } }],
    chat: { length: 10, prefixSha256: SHA_A },
    pins: [],
    ...overrides,
  };
}

function harness(readSet: StagedTurnReadSetV1 = baseReadSet()) {
  const machine = machineAtSnapshotting();
  const staging = createFakeStagingService();
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

      expect(h.staging.calls).toEqual([{ method: "snapshotToCandidate", turnId: "turn-1" }]);
      expect(h.machine.phase()).toBe("validating");
      expect(result.candidate.root).toBe("/fake-candidate/turn-1");
    });
  });

  test("present slugs are derived from the candidate's page files, in file order", async () => {
    await context.start(async () => {
      const h = harness();
      queueCandidate(h.staging, [
        { relPath: "pages.json", sha256: SHA_A, size: 2 },
        { relPath: "pages/about.tsx", sha256: SHA_B, size: 40 },
        { relPath: "pages/home.tsx", sha256: SHA_A, size: 100 },
        { relPath: "RUNTIME.md", sha256: SHA_A, size: 5 },
      ]);

      const result = await wrap(freezeTurnCandidate(h.deps, { workspace: h.workspace }));
      if (result.kind !== "captured")
        throw new Error(`expected captured, got ${JSON.stringify(result)}`);

      expect(result.candidate.presentSlugs).toEqual([PAGE_ABOUT, PAGE_HOME]);
    });
  });

  test("diff: unchanged page (same sha256) produces no change entry", async () => {
    await context.start(async () => {
      const h = harness(
        baseReadSet({
          canonicalPages: [{ pageSlug: PAGE_HOME, snapshot: { sha256: SHA_A, size: 100 } }],
        }),
      );
      queueCandidate(h.staging, [{ relPath: "pages/home.tsx", sha256: SHA_A, size: 100 }]);

      const result = await wrap(freezeTurnCandidate(h.deps, { workspace: h.workspace }));
      if (result.kind !== "captured")
        throw new Error(`expected captured, got ${JSON.stringify(result)}`);

      expect(result.candidate.changes).toEqual([]);
    });
  });

  test("diff: a changed hash on an already-present page is 'modified'", async () => {
    await context.start(async () => {
      const h = harness(
        baseReadSet({
          canonicalPages: [{ pageSlug: PAGE_HOME, snapshot: { sha256: SHA_A, size: 100 } }],
        }),
      );
      queueCandidate(h.staging, [{ relPath: "pages/home.tsx", sha256: SHA_B, size: 120 }]);

      const result = await wrap(freezeTurnCandidate(h.deps, { workspace: h.workspace }));
      if (result.kind !== "captured")
        throw new Error(`expected captured, got ${JSON.stringify(result)}`);

      expect(result.candidate.changes).toEqual([
        { pageSlug: PAGE_HOME, change: "modified", sha256: SHA_B, size: 120 },
      ]);
    });
  });

  test("diff: an expected-absent page (null snapshot) that now exists is 'added'", async () => {
    await context.start(async () => {
      const h = harness(
        baseReadSet({
          canonicalPages: [
            { pageSlug: PAGE_HOME, snapshot: { sha256: SHA_A, size: 100 } },
            { pageSlug: PAGE_ABOUT, snapshot: null },
          ],
        }),
      );
      queueCandidate(h.staging, [
        { relPath: "pages/home.tsx", sha256: SHA_A, size: 100 },
        { relPath: "pages/about.tsx", sha256: SHA_B, size: 30 },
      ]);

      const result = await wrap(freezeTurnCandidate(h.deps, { workspace: h.workspace }));
      if (result.kind !== "captured")
        throw new Error(`expected captured, got ${JSON.stringify(result)}`);

      expect(result.candidate.changes).toEqual([
        { pageSlug: PAGE_ABOUT, change: "added", sha256: SHA_B, size: 30 },
      ]);
    });
  });

  test("diff: a page present at admission but absent from the candidate is 'removed'", async () => {
    await context.start(async () => {
      const h = harness(
        baseReadSet({
          canonicalPages: [
            { pageSlug: PAGE_HOME, snapshot: { sha256: SHA_A, size: 100 } },
            { pageSlug: PAGE_GONE, snapshot: { sha256: SHA_A, size: 50 } },
          ],
        }),
      );
      queueCandidate(h.staging, [{ relPath: "pages/home.tsx", sha256: SHA_A, size: 100 }]);

      const result = await wrap(freezeTurnCandidate(h.deps, { workspace: h.workspace }));
      if (result.kind !== "captured")
        throw new Error(`expected captured, got ${JSON.stringify(result)}`);

      expect(result.candidate.changes).toEqual([
        { pageSlug: PAGE_GONE, change: "removed", sha256: null, size: null },
      ]);
    });
  });

  test("diff never touches file content — only relPath/sha256/size are read", async () => {
    // projections §9: "The Kernel computes each initial source hash while copying. It does
    // not make a second full source snapshot merely for diffing." This is a structural
    // guard: `StagedFileV1` carries no byte content at all, so there is nothing for this
    // module to read even if it tried — proven by a page whose sha256 changed being
    // reported from the HASH alone.
    await context.start(async () => {
      const h = harness(
        baseReadSet({
          canonicalPages: [{ pageSlug: PAGE_HOME, snapshot: { sha256: SHA_A, size: 100 } }],
        }),
      );
      queueCandidate(h.staging, [{ relPath: "pages/home.tsx", sha256: SHA_B, size: 100 }]);

      const result = await wrap(freezeTurnCandidate(h.deps, { workspace: h.workspace }));
      if (result.kind !== "captured")
        throw new Error(`expected captured, got ${JSON.stringify(result)}`);

      expect(result.candidate.changes).toEqual([
        { pageSlug: PAGE_HOME, change: "modified", sha256: SHA_B, size: 100 },
      ]);
    });
  });
});
