import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CreateTurnWorkspaceInputV1 } from "core/ports";
import { createFakeStagingService } from "core/ports/fakes";
import { parsePageSlug } from "entities/page";
import type { PageSlug } from "entities/page";
import { uuidv7 } from "infrastructure/uuid";

import { createStagingAdapter } from "./staging";
import { cleanupScratchRoots, createRealProjectFixture } from "./test-support";

afterEach(cleanupScratchRoots);

function mustParseSlug(raw: string): PageSlug {
  const slug = parsePageSlug(raw);
  if (slug instanceof Error) throw new Error(`fixture bug: ${slug.message}`);
  return slug;
}

const HOME_SLUG = mustParseSlug("home");

const extraScratch: string[] = [];
function freshSourceDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-staging-source-"));
  extraScratch.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of extraScratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function buildInput(homeSourcePath: string): CreateTurnWorkspaceInputV1 {
  return {
    turnId: uuidv7(),
    targetChatId: uuidv7(),
    pages: [{ pageSlug: HOME_SLUG, sourcePath: homeSourcePath }],
    manifestSlice: new TextEncoder().encode(JSON.stringify({ pages: ["home"] })),
    runtimeDocs: [],
    readSet: {
      manifest: null,
      canonicalPages: [{ pageSlug: HOME_SLUG, snapshot: null }],
      chat: { length: 0, prefixSha256: "0".repeat(64) },
      pins: [],
    },
  };
}

describe("createStagingAdapter — contract test (fake vs. real)", () => {
  test("createTurnWorkspace() stages a real page file at pages/<slug>.tsx (the fixed fake-fidelity path)", async () => {
    const sourceDir = freshSourceDir();
    const homeSourcePath = path.join(sourceDir, "home.tsx");
    fs.writeFileSync(homeSourcePath, "export const meta = { title: 'Home' };\n");

    const fake = createFakeStagingService();
    const fakeWorkspace = await fake.createTurnWorkspace(buildInput(homeSourcePath));
    if ("code" in fakeWorkspace) throw new Error("fixture bug: fake createTurnWorkspace failed");
    expect(fakeWorkspace.files.some((f) => f.relPath === "pages/home.tsx")).toBe(true);

    const { open, deps } = await createRealProjectFixture();
    try {
      const adapter = createStagingAdapter(deps);
      const workspace = await adapter.createTurnWorkspace(buildInput(homeSourcePath));
      if ("code" in workspace) throw new Error(`fixture bug: ${workspace.safeMessage}`);
      expect(workspace.files.some((f) => f.relPath === "pages/home.tsx")).toBe(true);
      expect(workspace.files.some((f) => f.relPath === "pages.json")).toBe(true);
      expect(fs.readFileSync(path.join(workspace.root, "pages", "home.tsx"), "utf8")).toBe(
        "export const meta = { title: 'Home' };\n",
      );
    } finally {
      await open.close();
    }
  });

  test("snapshotToCandidate() + readCandidateFile() round-trips staged bytes from a candidate outside the workspace", async () => {
    const sourceDir = freshSourceDir();
    const homeSourcePath = path.join(sourceDir, "home.tsx");
    const homeSource = "export const meta = { title: 'Home' };\n";
    fs.writeFileSync(homeSourcePath, homeSource);

    const { open, deps } = await createRealProjectFixture();
    try {
      const adapter = createStagingAdapter(deps);
      const workspace = await adapter.createTurnWorkspace(buildInput(homeSourcePath));
      if ("code" in workspace) throw new Error(`fixture bug: ${workspace.safeMessage}`);

      const candidate = await adapter.snapshotToCandidate(workspace);
      if ("code" in candidate) throw new Error(`fixture bug: ${candidate.safeMessage}`);
      expect(candidate.root).not.toBe(workspace.root);
      expect(fs.existsSync(candidate.root)).toBe(true);

      const bytes = await adapter.readCandidateFile(candidate.root, "pages/home.tsx");
      if ("code" in bytes) throw new Error(`fixture bug: ${bytes.safeMessage}`);
      expect(new TextDecoder().decode(bytes)).toBe(homeSource);

      const manifestBytes = await adapter.readCandidateFile(candidate.root, "pages.json");
      if ("code" in manifestBytes) throw new Error(`fixture bug: ${manifestBytes.safeMessage}`);
      expect(new TextDecoder().decode(manifestBytes)).toBe(JSON.stringify({ pages: ["home"] }));

      // The candidate survives workspace retirement (it lives outside `turns/<turnId>/`).
      const retired = await adapter.retireWorkspace(workspace);
      expect(retired).toBeUndefined();
      expect(fs.existsSync(candidate.root)).toBe(true);
      const stillReadable = await adapter.readCandidateFile(candidate.root, "pages/home.tsx");
      if ("code" in stillReadable) throw new Error(`fixture bug: ${stillReadable.safeMessage}`);
      expect(new TextDecoder().decode(stillReadable)).toBe(homeSource);
    } finally {
      await open.close();
    }
  });

  test("readCandidateFile() returns a FailureDtoV1 for a relPath outside the candidate's own namespace grammar", async () => {
    const sourceDir = freshSourceDir();
    const homeSourcePath = path.join(sourceDir, "home.tsx");
    fs.writeFileSync(homeSourcePath, "export const meta = { title: 'Home' };\n");

    const { open, deps } = await createRealProjectFixture();
    try {
      const adapter = createStagingAdapter(deps);
      const workspace = await adapter.createTurnWorkspace(buildInput(homeSourcePath));
      if ("code" in workspace) throw new Error(`fixture bug: ${workspace.safeMessage}`);
      const candidate = await adapter.snapshotToCandidate(workspace);
      if ("code" in candidate) throw new Error(`fixture bug: ${candidate.safeMessage}`);

      const result = await adapter.readCandidateFile(candidate.root, "not-a-real-file.txt");
      expect("code" in result).toBe(true);
    } finally {
      await open.close();
    }
  });

  test("retireWorkspace() on an unknown workspace is an idempotent no-op", async () => {
    const { open, deps } = await createRealProjectFixture();
    try {
      const adapter = createStagingAdapter(deps);
      const result = await adapter.retireWorkspace({
        turnId: uuidv7(),
        root: "/never-staged",
        files: [],
        totalBytes: 0,
        readSet: {
          manifest: null,
          canonicalPages: [],
          chat: { length: 0, prefixSha256: "0".repeat(64) },
          pins: [],
        },
      });
      expect(result).toBeUndefined();
    } finally {
      await open.close();
    }
  });
});
