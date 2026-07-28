import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { LeafRejectedError } from "./leaf-identity";
import {
  FsAccessError,
  PathEscapeError,
  ReparsePointRejectedError,
  assertWithinRoot,
  createSafeProjectFs,
  nodeSafeFsDeps,
  openManagedRoot,
  resolveManagedPath,
} from "./no-follow";
import { PathRuleError } from "./path-rules";

const IS_WINDOWS = process.platform === "win32";
const deps = nodeSafeFsDeps();

let scratch = "";
let root = "";
let outside = "";

/** `mklink /J` needs no elevation (Spike F) — the junction tests must actually run. */
function makeJunction(link: string, target: string): boolean {
  if (!IS_WINDOWS) {
    fs.symlinkSync(target, link, "dir");
    return true;
  }
  const made = (() => {
    try {
      execFileSync("cmd", ["/c", "mklink", "/J", link, target], { stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  })();
  return made;
}

beforeAll(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tc-safefs-nf-"));
  root = path.join(scratch, "project-root");
  outside = path.join(scratch, "outside-secret");
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.mkdirSync(path.join(root, "pages"));
  fs.mkdirSync(path.join(root, "pages", "home"));
  fs.writeFileSync(path.join(root, "pages", "home", "page.tsx"), "export const meta = {}\n");
  // The retired `pages/<slug>/page.tsx` fixture above stays — `resolveManagedPath` and
  // `assertWithinRoot` below are namespace-agnostic and still exercise it. Anything that goes
  // through `SafeProjectFs` (`readFile`/`stat`/`readRange`/`list`) enforces the §5.3 grammar,
  // so it needs a leaf that actually classifies — the design tree's `design/pages/home.tsx`.
  fs.mkdirSync(path.join(root, "design", "pages"), { recursive: true });
  fs.writeFileSync(path.join(root, "design", "pages", "home.tsx"), "export const meta = {}\n");
  fs.writeFileSync(path.join(outside, "secret.txt"), "TOP SECRET\n");
});

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

function openRoot() {
  const opened = openManagedRoot({ kind: "project", path: root, deps });
  if (opened instanceof Error) throw new Error(`openManagedRoot failed: ${opened.message}`);
  return opened;
}

describe("openManagedRoot", () => {
  test("opens a real directory and records its resolved path and identity", () => {
    const opened = openRoot();
    expect(opened.kind).toBe("project");
    expect(opened.realPath).toBe(fs.realpathSync(root));
    expect(opened.identity.length).toBeGreaterThan(0);
  });

  test("refuses a root that is not a directory", () => {
    const filePath = path.join(root, "pages", "home", "page.tsx");
    expect(openManagedRoot({ kind: "project", path: filePath, deps })).toBeInstanceOf(
      LeafRejectedError,
    );
  });

  test("refuses a root that does not exist", () => {
    expect(
      openManagedRoot({ kind: "project", path: path.join(scratch, "nope"), deps }),
    ).toBeInstanceOf(FsAccessError);
  });
});

describe("resolveManagedPath", () => {
  test("resolves a valid managed relative path under the opened root", () => {
    const resolved = resolveManagedPath({ root: openRoot(), relPath: "pages/home/page.tsx", deps });
    if (resolved instanceof Error) throw new Error(resolved.message);
    expect(resolved).toBe(path.join(fs.realpathSync(root), "pages", "home", "page.tsx"));
  });

  test("resolves a path whose tail does not exist yet (a create target)", () => {
    const resolved = resolveManagedPath({
      root: openRoot(),
      relPath: "pages/about/page.tsx",
      deps,
    });
    expect(resolved).not.toBeInstanceOf(Error);
  });

  test("rejects a path that violates the §5.1 grammar before touching the filesystem", () => {
    expect(resolveManagedPath({ root: openRoot(), relPath: "../escape.txt", deps })).toBeInstanceOf(
      PathRuleError,
    );
  });
});

describe("planted junction escape (Spike F step 5)", () => {
  let planted = false;
  const linkName = "escape-junction";

  beforeAll(() => {
    planted = makeJunction(path.join(root, linkName), outside);
  });

  test("a naive path.join would have missed the escape, and SafeProjectFs does not", () => {
    if (!planted)
      throw new Error(
        "could not plant a junction; `mklink /J` needs no elevation and must succeed",
      );

    const rel = `${linkName}/secret.txt`;

    // 1. The naive check every unsafe implementation performs: string-join the root and
    //    the relative path and confirm the result "looks like" it is inside the root.
    //    It does — the escape is invisible at the string level (Spike F STEP5_ESCAPE).
    const naiveJoined = path.join(root, rel);
    expect(naiveJoined.startsWith(root + path.sep)).toBe(true);

    // 2. ...but the junction resolves outside the root, and the secret is readable
    //    through the naive path. This is the vulnerability being closed.
    expect(fs.realpathSync(naiveJoined).startsWith(fs.realpathSync(root) + path.sep)).toBe(false);
    expect(fs.readFileSync(naiveJoined, "utf8")).toContain("TOP SECRET");

    // 3. The no-follow walk refuses at the reparse-point component, before any read.
    const resolved = resolveManagedPath({ root: openRoot(), relPath: rel, deps });
    expect(resolved).toBeInstanceOf(ReparsePointRejectedError);

    // 4. And the independent realpath prefix check refuses the same path on its own,
    //    so neither guard is load-bearing alone.
    expect(
      assertWithinRoot({ rootReal: fs.realpathSync(root), absPath: naiveJoined, deps }),
    ).toBeInstanceOf(PathEscapeError);
  });

  test("the junction itself is rejected as a managed directory component", () => {
    if (!planted) throw new Error("could not plant a junction");
    expect(
      resolveManagedPath({ root: openRoot(), relPath: `${linkName}/x.tsx`, deps }),
    ).toBeInstanceOf(ReparsePointRejectedError);
  });

  test("SafeProjectFs.readFile passes zero bytes through a junction", () => {
    if (!planted) throw new Error("could not plant a junction");
    const safeFs = createSafeProjectFs(openRoot(), deps);
    const read = safeFs.readFile(`${linkName}/secret.txt`);
    expect(read).toBeInstanceOf(Error);
    expect(read).not.toBeInstanceOf(Uint8Array);
  });

  test("SafeProjectFs.readRange passes zero bytes through a junction", () => {
    if (!planted) throw new Error("could not plant a junction");
    const safeFs = createSafeProjectFs(openRoot(), deps);
    const read = safeFs.readRange(`${linkName}/secret.txt`, 0, 5);
    expect(read).toBeInstanceOf(Error);
    expect(read).not.toBeInstanceOf(Uint8Array);
  });
});

describe("assertWithinRoot", () => {
  test("accepts the root itself and any real descendant", () => {
    const rootReal = fs.realpathSync(root);
    expect(assertWithinRoot({ rootReal, absPath: rootReal, deps })).toBeNull();
    expect(
      assertWithinRoot({ rootReal, absPath: path.join(rootReal, "pages", "home"), deps }),
    ).toBeNull();
  });

  test("rejects a sibling whose name merely starts with the root's name", () => {
    const rootReal = fs.realpathSync(root);
    const sibling = `${rootReal}-evil`;
    fs.mkdirSync(sibling, { recursive: true });
    expect(assertWithinRoot({ rootReal, absPath: sibling, deps })).toBeInstanceOf(PathEscapeError);
  });
});

describe("SafeProjectFs", () => {
  test("reads a managed leaf and lists a managed directory", () => {
    const safeFs = createSafeProjectFs(openRoot(), deps);
    const bytes = safeFs.readFile("design/pages/home.tsx");
    if (bytes instanceof Error) throw new Error(bytes.message);
    expect(Buffer.from(bytes).toString("utf8")).toContain("export const meta");

    const listed = safeFs.list("design/pages");
    if (listed instanceof Error) throw new Error(listed.message);
    expect(listed).toContain("home.tsx");
  });

  test("refuses a leaf outside the project namespace grammar", () => {
    fs.writeFileSync(path.join(root, "evil.sh"), "rm -rf /\n");
    const safeFs = createSafeProjectFs(openRoot(), deps);
    expect(safeFs.readFile("evil.sh")).toBeInstanceOf(Error);
  });

  test("refuses every §5.1 path class without touching the filesystem", () => {
    const safeFs = createSafeProjectFs(openRoot(), deps);
    for (const hostile of [
      "",
      "..",
      "/etc/passwd",
      "C:/Windows",
      "a\\b",
      "a:b",
      "a/./b",
      "a//b",
      "con",
      "a.",
    ]) {
      expect(safeFs.resolve(hostile)).toBeInstanceOf(PathRuleError);
    }
  });

  // projections §16.1/§16.3: `ChatStore.open`'s bounded-tail reads (finding #3) need a
  // primitive that returns exactly a byte range without ever materializing the whole file.
  describe("stat + readRange (projections §16.1)", () => {
    test("stat reports a managed leaf's current size without reading its content", () => {
      const safeFs = createSafeProjectFs(openRoot(), deps);
      const result = safeFs.stat("design/pages/home.tsx");
      if (result instanceof Error) throw new Error(result.message);
      expect(result.size).toBe(fs.statSync(path.join(root, "design", "pages", "home.tsx")).size);
    });

    test("readRange returns exactly the requested byte range", () => {
      const safeFs = createSafeProjectFs(openRoot(), deps);
      const whole = safeFs.readFile("design/pages/home.tsx");
      if (whole instanceof Error) throw new Error(whole.message);

      const ranged = safeFs.readRange("design/pages/home.tsx", 7, 12);
      if (ranged instanceof Error) throw new Error(ranged.message);
      expect(Buffer.from(ranged)).toEqual(Buffer.from(whole.subarray(7, 12)));
    });

    test("readRange tolerates the file having grown since a caller's earlier stat (an append)", () => {
      const chatId = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d10";
      fs.mkdirSync(path.join(root, "chats"), { recursive: true });
      const target = path.join(root, "chats", `${chatId}.jsonl`);
      fs.writeFileSync(target, "header\n");
      const safeFs = createSafeProjectFs(openRoot(), deps);
      const before = safeFs.stat(`chats/${chatId}.jsonl`);
      if (before instanceof Error) throw new Error(before.message);

      fs.appendFileSync(target, "more bytes appended after the caller's stat\n");

      // Reading exactly the ORIGINAL bounded range still succeeds — an append does not
      // invalidate a bounded read of the immutable prefix that already existed.
      const ranged = safeFs.readRange(`chats/${chatId}.jsonl`, 0, before.size);
      if (ranged instanceof Error) throw new Error(ranged.message);
      expect(Buffer.from(ranged).toString("utf8")).toBe("header\n");
    });

    test("readRange refuses a range past the file's current end rather than silently truncating", () => {
      const safeFs = createSafeProjectFs(openRoot(), deps);
      const stat = safeFs.stat("design/pages/home.tsx");
      if (stat instanceof Error) throw new Error(stat.message);
      expect(safeFs.readRange("design/pages/home.tsx", 0, stat.size + 1_000)).toBeInstanceOf(Error);
    });
  });
});
