import { afterEach, describe, expect, test } from "bun:test";

import { createFakeProjectStore } from "core/ports/fakes";

import { createProjectStoreAdapter } from "./project-store";
import { cleanupScratchRoots, createRealProjectFixture } from "./test-support";

afterEach(cleanupScratchRoots);

describe("createProjectStoreAdapter — contract test (fake vs. real)", () => {
  test("readManifest returns the same shape from both the fake and the real adapter", async () => {
    const fake = createFakeProjectStore({ root: "/fake-root", manifest: { name: "Contract Co" } });
    const fakeManifest = await fake.readManifest();
    if ("code" in fakeManifest) throw new Error("fixture bug: fake readManifest failed");
    expect(fakeManifest.name).toBe("Contract Co");
    expect(fakeManifest.pages).toEqual([]);

    const { open, deps } = await createRealProjectFixture({ name: "Contract Co" });
    try {
      const realAdapter = createProjectStoreAdapter(deps);
      const realManifest = await realAdapter.readManifest();
      if ("code" in realManifest) throw new Error("fixture bug: real readManifest failed");
      expect(realManifest.name).toBe("Contract Co");
      expect(realManifest.pages).toEqual([]);
      expect(realManifest.targetStack).toBe("generic");
      expect(() => new Date(realManifest.createdAt).toISOString()).not.toThrow();
    } finally {
      await open.close();
    }
  });

  test("readManifestSnapshot returns an honest hash+size of project.toml's own bytes", async () => {
    const { open, deps } = await createRealProjectFixture();
    try {
      const adapter = createProjectStoreAdapter(deps);
      const snapshot = await adapter.readManifestSnapshot();
      if ("code" in snapshot) throw new Error("fixture bug: readManifestSnapshot failed");
      expect(snapshot.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(snapshot.size).toBeGreaterThan(0);

      // Re-reading returns the identical hash — no drift across repeated reads of unchanged state.
      const again = await adapter.readManifestSnapshot();
      expect(again).toEqual(snapshot);
    } finally {
      await open.close();
    }
  });

  test("readWorkspaceState reports the deterministic defaults with missing:true before any write", async () => {
    const { open, deps } = await createRealProjectFixture();
    try {
      const adapter = createProjectStoreAdapter(deps);
      const read = await adapter.readWorkspaceState();
      if ("code" in read) throw new Error("fixture bug: readWorkspaceState failed");
      expect(read.missing).toBe(false); // createProject already writes the defaults file
      expect(read.corrupt).toBe(false);
      expect(read.state.activePageSlug).toBeNull();
      expect(read.state.renderMode).toBe("static");
    } finally {
      await open.close();
    }
  });

  test("writeWorkspaceState patches only the given fields; a later read reflects the patch", async () => {
    const { open, deps } = await createRealProjectFixture();
    try {
      const adapter = createProjectStoreAdapter(deps);
      const wrote = await adapter.writeWorkspaceState({ themeOverride: "midnight" });
      expect(wrote).toBeUndefined();

      const read = await adapter.readWorkspaceState();
      if ("code" in read) throw new Error("fixture bug: readWorkspaceState failed");
      expect(read.state.themeOverride).toBe("midnight");
      expect(read.state.renderMode).toBe("static"); // untouched fields survive the patch
    } finally {
      await open.close();
    }
  });

  test("root and lease.root mirror the real project's opened root", async () => {
    const { open, deps } = await createRealProjectFixture();
    try {
      const adapter = createProjectStoreAdapter(deps);
      expect(adapter.root).toBe(open.root);
      expect(adapter.lease.root).toBe(open.root);
    } finally {
      await open.close();
    }
  });

  test("close() delegates to the real project's own close", async () => {
    const { open, deps } = await createRealProjectFixture();
    const adapter = createProjectStoreAdapter(deps);
    await adapter.close(); // must not throw; a second close is idempotent per OpenProject.close
    await open.close();
  });
});
