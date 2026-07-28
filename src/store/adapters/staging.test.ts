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
const MAIN_SLUG = mustParseSlug("main");

/**
 * Flips the case of the last cased (letter) character found in `raw`, scanning from the end
 * — used only to build a real-but-differently-cased variant of an existing path for the
 * containment round-trip test below (review finding #9). Windows' default filesystem is
 * case-insensitive, so the flipped variant still resolves to the SAME physical directory
 * while being a different exact string — exactly the shape a future path-normalization step
 * anywhere in the core->port chain could introduce.
 */
function caseFlippedVariant(raw: string): string {
  const chars = raw.split("");
  for (let i = chars.length - 1; i >= 0; i--) {
    const ch = chars[i];
    if (ch === undefined) continue;
    const lower = ch.toLowerCase();
    const upper = ch.toUpperCase();
    if (lower === upper) continue; // not a cased character (digit, separator, dash, …)
    chars[i] = ch === lower ? upper : lower;
    return chars.join("");
  }
  throw new Error("fixture bug: expected at least one cased character in the path");
}

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
  test("createTurnWorkspace() stages a real page file at design/pages/<slug>.tsx (the fixed fake-fidelity path)", async () => {
    const sourceDir = freshSourceDir();
    const homeSourcePath = path.join(sourceDir, "home.tsx");
    fs.writeFileSync(homeSourcePath, "export const meta = { title: 'Home' };\n");

    const fake = createFakeStagingService();
    const fakeWorkspace = await fake.createTurnWorkspace(buildInput(homeSourcePath));
    if ("code" in fakeWorkspace) throw new Error("fixture bug: fake createTurnWorkspace failed");
    expect(fakeWorkspace.files.some((f) => f.relPath === "design/pages/home.tsx")).toBe(true);

    const { open, deps } = await createRealProjectFixture();
    try {
      const adapter = createStagingAdapter(deps);
      const workspace = await adapter.createTurnWorkspace(buildInput(homeSourcePath));
      if ("code" in workspace) throw new Error(`fixture bug: ${workspace.safeMessage}`);
      expect(workspace.files.some((f) => f.relPath === "design/pages/home.tsx")).toBe(true);
      expect(workspace.files.some((f) => f.relPath === "design/pages.json")).toBe(true);
      expect(
        fs.readFileSync(path.join(workspace.root, "design", "pages", "home.tsx"), "utf8"),
      ).toBe("export const meta = { title: 'Home' };\n");
    } finally {
      await open.close();
    }
  });

  // Gap G regression: `core/kernel/handlers/turn.ts`'s `pages.push` used to build its
  // `sourcePath` from the agent WORKSPACE's own flat layout joined onto the PROJECT root — a
  // path that never exists on disk, since canonical page storage is
  // `<root>/.termcraft/pages/<slug>/page.tsx` (`store/safe-fs/model/limits.ts:134-135`,
  // `store/transaction/model/wrappers.ts`'s `canonicalPagePath`). Every other test in this
  // file either stages zero pages or hands `buildInput` a source path from an arbitrary
  // scratch directory, so the one construction that matters — a real canonical layout on
  // disk — was never exercised until now.
  test("stages a page whose source sits at the canonical <root>/.termcraft/pages/<slug>/page.tsx", async () => {
    const { open, deps } = await createRealProjectFixture();
    try {
      const sourcePath = path.join(open.root, ".termcraft", "pages", "main", "page.tsx");
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      fs.writeFileSync(sourcePath, "export default 1;\n");

      const adapter = createStagingAdapter(deps);
      const workspace = await adapter.createTurnWorkspace({
        turnId: uuidv7(),
        targetChatId: uuidv7(),
        pages: [{ pageSlug: MAIN_SLUG, sourcePath }],
        manifestSlice: new TextEncoder().encode(JSON.stringify({ pages: ["main"] })),
        runtimeDocs: [],
        readSet: {
          manifest: null,
          canonicalPages: [{ pageSlug: MAIN_SLUG, snapshot: null }],
          chat: { length: 0, prefixSha256: "0".repeat(64) },
          pins: [],
        },
      });

      if ("code" in workspace) throw new Error(`fixture bug: ${workspace.safeMessage}`);
      expect(workspace.files.some((f) => f.relPath === "design/pages/main.tsx")).toBe(true);
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

      const bytes = await adapter.readCandidateFile(candidate.root, "design/pages/home.tsx");
      if ("code" in bytes) throw new Error(`fixture bug: ${bytes.safeMessage}`);
      expect(new TextDecoder().decode(bytes)).toBe(homeSource);

      const manifestBytes = await adapter.readCandidateFile(candidate.root, "design/pages.json");
      if ("code" in manifestBytes) throw new Error(`fixture bug: ${manifestBytes.safeMessage}`);
      expect(new TextDecoder().decode(manifestBytes)).toBe(JSON.stringify({ pages: ["home"] }));

      // The candidate survives workspace retirement (it lives outside `turns/<turnId>/`).
      const retired = await adapter.retireWorkspace(workspace);
      expect(retired).toBeUndefined();
      expect(fs.existsSync(candidate.root)).toBe(true);
      const stillReadable = await adapter.readCandidateFile(
        candidate.root,
        "design/pages/home.tsx",
      );
      if ("code" in stillReadable) throw new Error(`fixture bug: ${stillReadable.safeMessage}`);
      expect(new TextDecoder().decode(stillReadable)).toBe(homeSource);
    } finally {
      await open.close();
    }
  });

  // A Gate rejection retries WITHIN the same turn, so `snapshotToCandidate` is called a second
  // time for the SAME `turnId` — and the candidate root is keyed by `turnId` alone. Before the
  // fix this hit `mkdirNew`'s create-new `EEXIST` and surfaced as `PERSISTENCE_FAILED`, so every
  // gate-rejected turn died on its own retry and the documented 3-retry budget was unreachable.
  // Observed live on 2026-07-25. The second snapshot must succeed AND show the retry's own bytes,
  // not the first attempt's leftovers.
  test("snapshotToCandidate() twice for the same turn (a Gate retry) succeeds and reflects the retry's bytes", async () => {
    const sourceDir = freshSourceDir();
    const homeSourcePath = path.join(sourceDir, "home.tsx");
    const firstAttempt = "export const meta = { title: 'First' };\n";
    fs.writeFileSync(homeSourcePath, firstAttempt);

    const { open, deps } = await createRealProjectFixture();
    try {
      const adapter = createStagingAdapter(deps);
      const workspace = await adapter.createTurnWorkspace(buildInput(homeSourcePath));
      if ("code" in workspace) throw new Error(`fixture bug: ${workspace.safeMessage}`);

      const first = await adapter.snapshotToCandidate(workspace);
      if ("code" in first) throw new Error(`fixture bug: ${first.safeMessage}`);

      // The agent rewrites the page after the Gate's diagnostics, then the turn re-freezes.
      // Written into the WORKSPACE, not the original source dir: that sandbox copy is what the
      // agent edits and what `snapshotToCandidate` actually freezes.
      const secondAttempt = "export const meta = { title: 'Second' };\n";
      fs.writeFileSync(path.join(workspace.root, "design", "pages", "home.tsx"), secondAttempt);

      const second = await adapter.snapshotToCandidate(workspace);
      if ("code" in second) throw new Error(`retry re-freeze must not fail: ${second.safeMessage}`);

      expect(second.root).toBe(first.root);
      const bytes = await adapter.readCandidateFile(second.root, "design/pages/home.tsx");
      if ("code" in bytes) throw new Error(`fixture bug: ${bytes.safeMessage}`);
      expect(new TextDecoder().decode(bytes)).toBe(secondAttempt);
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

  test("retireCandidate() actually removes the frozen candidate directory from disk", async () => {
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
      expect(fs.existsSync(candidate.root)).toBe(true);

      const result = await adapter.retireCandidate(candidate.root);
      expect(result).toBeUndefined();
      expect(fs.existsSync(candidate.root)).toBe(false);

      // Already-retired path against the REAL adapter (review finding #10): the second call
      // must hit the `isNotFound` branch even though `liveCandidateRoots` deliberately still
      // contains `candidate.root` (this file's own header — "Deliberately never pruned on
      // retire": a real removal makes the directory itself disappear, so a repeat call for
      // the SAME root hits the "nothing exists there" idempotent branch regardless of set
      // membership). Untested before this: the sibling test below only ever exercises the
      // never-frozen-at-all path (`/never-a-candidate`), never a root that WAS a live
      // candidate and has SINCE been retired.
      const second = await adapter.retireCandidate(candidate.root);
      expect(second).toBeUndefined();
    } finally {
      await open.close();
    }
  });

  test("retireCandidate() on an already-retired (or never-frozen) root is an idempotent no-op", async () => {
    const { open, deps } = await createRealProjectFixture();
    try {
      const adapter = createStagingAdapter(deps);
      const first = await adapter.retireCandidate("/never-a-candidate");
      const second = await adapter.retireCandidate("/never-a-candidate");
      expect(first).toBeUndefined();
      expect(second).toBeUndefined();
    } finally {
      await open.close();
    }
  });

  // Review finding #3 (BLOCKER): `retireCandidate` must not delete a caller-supplied path it
  // never froze itself, however real and well-formed that path is. `/never-a-candidate` above
  // only exercises the "nothing exists there" idempotent branch — these three tests exercise
  // the OTHER branch, where something real exists at `root` but is out of contract.
  test("retireCandidate() refuses a root OUTSIDE the sandbox's candidates/ tree that it never froze, and does not delete it", async () => {
    const outsideDir = freshSourceDir(); // a real, existing directory this adapter never staged
    const { open, deps } = await createRealProjectFixture();
    try {
      const adapter = createStagingAdapter(deps);
      const result = await adapter.retireCandidate(outsideDir);
      if (result === undefined) throw new Error("expected retireCandidate() to refuse this root");
      expect("code" in result).toBe(true);
      expect(fs.existsSync(outsideDir)).toBe(true);
    } finally {
      await open.close();
    }
  });

  test("retireCandidate() refuses an empty-string root", async () => {
    const { open, deps } = await createRealProjectFixture();
    try {
      const adapter = createStagingAdapter(deps);
      const result = await adapter.retireCandidate("");
      if (result === undefined) throw new Error("expected retireCandidate() to refuse this root");
      expect("code" in result).toBe(true);
    } finally {
      await open.close();
    }
  });

  test("retireCandidate() refuses a `..`-bearing root, without deleting whatever it happens to resolve to", async () => {
    const { open, deps } = await createRealProjectFixture();
    try {
      const adapter = createStagingAdapter(deps);
      const traversal = path.join(os.tmpdir(), "..");
      expect(fs.existsSync(traversal)).toBe(true); // resolves to a real, pre-existing directory
      const result = await adapter.retireCandidate(traversal);
      if (result === undefined) throw new Error("expected retireCandidate() to refuse this root");
      expect("code" in result).toBe(true);
      expect(fs.existsSync(traversal)).toBe(true);
    } finally {
      await open.close();
    }
  });

  // Review finding #9: `liveCandidateRoots.add(snapshot.root)` (this file's own header,
  // "CONTAINMENT") tracks `snapshot.root` VERBATIM, not realpath-resolved, and `retireCandidate`
  // compares its own `root` argument against that set the same way — by design, to avoid an
  // extra realpath call on every retire. That is safe TODAY because the exact string a caller
  // gets back from `snapshotToCandidate` is the exact string it must hand back to
  // `retireCandidate`. But nothing previously pinned that exact-match requirement: if any layer
  // in the core->port chain (`freezeTurnCandidate` -> `run-turn.ts` -> `terminalize.ts`/
  // `finalize.ts` -> this port) ever normalized that string before the retire call reached
  // here, every production retire would silently start hitting the containment refusal below
  // instead of actually deleting anything — reopening the exact leak this task closed, with no
  // signal beyond a swallowed `console.warn`. This test pins BOTH halves of that contract: a
  // real-but-differently-cased variant of a live root is refused (proving the comparison really
  // is exact-string, not realpath-normalized), and the untouched original string still
  // round-trips to a real, successful retire.
  test("retireCandidate() requires the EXACT string snapshotToCandidate returned — a real-but-differently-cased variant of the same physical directory is refused, pinning the containment round-trip against future normalization", async () => {
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

      const normalizedVariant = caseFlippedVariant(candidate.root);
      expect(normalizedVariant).not.toBe(candidate.root);
      // Confirms the variant genuinely resolves to the SAME real directory (Windows' default
      // case-insensitive filesystem) — otherwise this would only be pinning "an unrelated,
      // nonexistent path is refused", which the sibling tests above already cover.
      expect(fs.existsSync(normalizedVariant)).toBe(true);

      const refused = await adapter.retireCandidate(normalizedVariant);
      if (refused === undefined) {
        throw new Error(
          "expected retireCandidate() to refuse a differently-cased variant that does not match the tracked root verbatim",
        );
      }
      expect("code" in refused).toBe(true);
      expect(fs.existsSync(candidate.root)).toBe(true); // never deleted via the mismatched variant

      // The exact original string still round-trips to a real, successful retire.
      const result = await adapter.retireCandidate(candidate.root);
      expect(result).toBeUndefined();
      expect(fs.existsSync(candidate.root)).toBe(false);
    } finally {
      await open.close();
    }
  });
});
