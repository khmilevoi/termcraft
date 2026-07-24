import { describe, expect, test } from "bun:test";

import type { FailureDtoV1 } from "core/protocol";
import { parsePageSlug } from "entities/page";
import type { PageSlug } from "entities/page";

import type { CreateTurnWorkspaceInputV1 } from "../staging";
import { createFakeStagingService } from "./staging";

function slug(value: string): PageSlug {
  const parsed = parsePageSlug(value);
  if (parsed instanceof Error) throw parsed;
  return parsed;
}

const FAILURE: FailureDtoV1 = {
  code: "PERSISTENCE_FAILED",
  retryable: false,
  safeMessage: "workspace write failed",
  details: {},
};

const input: CreateTurnWorkspaceInputV1 = {
  turnId: "t1",
  targetChatId: "chat-1",
  pages: [{ pageSlug: slug("home"), sourcePath: "C:/proj/pages/home/index.tsx" }],
  manifestSlice: new Uint8Array([1, 2]),
  runtimeDocs: [],
  readSet: {
    manifest: null,
    canonicalPages: [],
    chat: { length: 0, prefixSha256: "a".repeat(64) },
    pins: [],
  },
};

describe("createFakeStagingService", () => {
  test("createTurnWorkspace() builds a workspace rooted at a path derived from turnId", async () => {
    const service = createFakeStagingService();
    const workspace = await service.createTurnWorkspace(input);
    if ("code" in workspace) throw new Error("unexpected failure");
    expect(workspace.turnId).toBe("t1");
    expect(workspace.root).toContain("t1");
    expect(workspace.files.length).toBeGreaterThan(0);
  });

  test("snapshotToCandidate() freezes the workspace into a candidate at a different root", async () => {
    const service = createFakeStagingService();
    const workspace = await service.createTurnWorkspace(input);
    if ("code" in workspace) throw new Error("unexpected failure");
    const candidate = await service.snapshotToCandidate(workspace);
    if ("code" in candidate) throw new Error("unexpected failure");
    expect(candidate.root).not.toBe(workspace.root);
    expect(candidate.files).toEqual(workspace.files);
  });

  test("retireWorkspace() then failing to retire twice is still safe (idempotent no-op)", async () => {
    const service = createFakeStagingService();
    const workspace = await service.createTurnWorkspace(input);
    if ("code" in workspace) throw new Error("unexpected failure");
    const first = await service.retireWorkspace(workspace);
    const second = await service.retireWorkspace(workspace);
    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
  });

  test("failNext() queues one failure for createTurnWorkspace()", async () => {
    const service = createFakeStagingService();
    service.failNext("createTurnWorkspace", FAILURE);
    const first = await service.createTurnWorkspace(input);
    expect(first).toEqual(FAILURE);
    const second = await service.createTurnWorkspace(input);
    expect("code" in second).toBe(false);
  });

  test("records calls across the whole workspace lifecycle in order", async () => {
    const service = createFakeStagingService();
    const workspace = await service.createTurnWorkspace(input);
    if ("code" in workspace) throw new Error("unexpected failure");
    await service.snapshotToCandidate(workspace);
    await service.retireWorkspace(workspace);
    expect(service.calls.map((c) => c.method)).toEqual([
      "createTurnWorkspace",
      "snapshotToCandidate",
      "retireWorkspace",
    ]);
  });

  describe("readCandidateFile()", () => {
    test("reads back the exact manifest-slice bytes handed to createTurnWorkspace(), by the candidate's own root and the manifest's own relPath", async () => {
      const service = createFakeStagingService();
      const workspace = await service.createTurnWorkspace(input);
      if ("code" in workspace) throw new Error("unexpected failure");
      const candidate = await service.snapshotToCandidate(workspace);
      if ("code" in candidate) throw new Error("unexpected failure");

      const manifestFile = candidate.files.find((f) => f.relPath === "pages.json");
      if (manifestFile === undefined) throw new Error("expected a pages.json entry");

      const bytes = await service.readCandidateFile(candidate.root, manifestFile.relPath);
      if ("code" in bytes) throw new Error("unexpected failure");
      expect(bytes).toEqual(input.manifestSlice);
    });

    test("reads back SOME deterministic bytes for a staged page file", async () => {
      const service = createFakeStagingService();
      const workspace = await service.createTurnWorkspace(input);
      if ("code" in workspace) throw new Error("unexpected failure");
      const candidate = await service.snapshotToCandidate(workspace);
      if ("code" in candidate) throw new Error("unexpected failure");

      const pageFile = candidate.files.find((f) => f.relPath !== "pages.json");
      if (pageFile === undefined) throw new Error("expected a staged page file");

      const first = await service.readCandidateFile(candidate.root, pageFile.relPath);
      const second = await service.readCandidateFile(candidate.root, pageFile.relPath);
      if ("code" in first || "code" in second) throw new Error("unexpected failure");
      expect(first.length).toBeGreaterThan(0);
      expect(first).toEqual(second); // deterministic, not random per call
    });

    test("returns a FailureDtoV1 for a relPath the candidate never staged", async () => {
      const service = createFakeStagingService();
      const workspace = await service.createTurnWorkspace(input);
      if ("code" in workspace) throw new Error("unexpected failure");
      const candidate = await service.snapshotToCandidate(workspace);
      if ("code" in candidate) throw new Error("unexpected failure");

      const result = await service.readCandidateFile(candidate.root, "pages/never-staged.tsx");
      if (!("code" in result)) throw new Error("expected a failure");
      expect(result.code).toBe("PERSISTENCE_FAILED");
    });

    test("returns a FailureDtoV1 for a root that was never frozen into a candidate", async () => {
      const service = createFakeStagingService();
      const result = await service.readCandidateFile("/never-a-candidate", "pages.json");
      if (!("code" in result)) throw new Error("expected a failure");
      expect(result.code).toBe("PERSISTENCE_FAILED");
    });

    test("failNext() queues one failure for readCandidateFile()", async () => {
      const service = createFakeStagingService();
      const workspace = await service.createTurnWorkspace(input);
      if ("code" in workspace) throw new Error("unexpected failure");
      const candidate = await service.snapshotToCandidate(workspace);
      if ("code" in candidate) throw new Error("unexpected failure");
      const manifestFile = candidate.files.find((f) => f.relPath === "pages.json");
      if (manifestFile === undefined) throw new Error("expected a pages.json entry");

      service.failNext("readCandidateFile", FAILURE);
      const first = await service.readCandidateFile(candidate.root, manifestFile.relPath);
      expect(first).toEqual(FAILURE);
      const second = await service.readCandidateFile(candidate.root, manifestFile.relPath);
      expect("code" in second).toBe(false);
    });

    test("records calls in order alongside the rest of the lifecycle", async () => {
      const service = createFakeStagingService();
      const workspace = await service.createTurnWorkspace(input);
      if ("code" in workspace) throw new Error("unexpected failure");
      const candidate = await service.snapshotToCandidate(workspace);
      if ("code" in candidate) throw new Error("unexpected failure");
      await service.readCandidateFile(candidate.root, "pages.json");
      expect(service.calls.map((c) => c.method)).toEqual([
        "createTurnWorkspace",
        "snapshotToCandidate",
        "readCandidateFile",
      ]);
    });
  });
});
