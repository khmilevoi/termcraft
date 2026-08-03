import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";

import type { DesignFileEntryV1 } from "entities/design-tree";

import { ProtocolError } from "../../protocol";
import { registerRuntimeResolver } from "./resolver";
import {
  computeSourceHash,
  createTreePathVerifier,
  computeSourceHash as hashBytes,
  loadPage,
  scanClosureImports,
} from "./source-mount";

describe("computeSourceHash", () => {
  test("is the lowercase-hex SHA-256 of the exact bytes", () => {
    const hash = computeSourceHash(new TextEncoder().encode("hello world\n"));
    expect(hash).toBe("a948904f2f0f479b8f8197694b30184b0d2ed1c1cd2a1ec0fb85d299a192a447");
    expect(hash).toHaveLength(64);
  });

  test("differs for a one-byte change", () => {
    const a = computeSourceHash(new TextEncoder().encode("a"));
    const b = computeSourceHash(new TextEncoder().encode("b"));
    expect(a).not.toBe(b);
  });
});

/** A `has` over a fixed tree-relative path list — the inventory predicate `loadPage` builds. */
const hasOf =
  (...relPaths: string[]) =>
  (relPath: string): boolean =>
    relPaths.includes(relPath);

describe("scanClosureImports", () => {
  test("accepts a page importing only @termcraft/runtime", () => {
    const src = `import { definePage, Panel } from "@termcraft/runtime"
import type { PageMeta } from "@termcraft/runtime"
export default function P() { return null }`;
    expect(
      scanClosureImports({
        sources: new Map([["pages/home.tsx", src]]),
        has: hasOf("pages/home.tsx"),
      }),
    ).toBeUndefined();
  });

  test("accepts a RELATIVE edge that resolves inside the tree — the rule the design tree added", () => {
    const result = scanClosureImports({
      sources: new Map([
        [
          "pages/home.tsx",
          `import { theme } from "../lib/theme"\nexport default function P() { return null }`,
        ],
        ["lib/theme.ts", `export const theme = 1\n`],
      ]),
      has: hasOf("pages/home.tsx", "lib/theme.ts"),
    });
    expect(result).toBeUndefined();
  });

  test("rejects a relative edge that resolves to nothing in the tree", () => {
    const result = scanClosureImports({
      sources: new Map([["pages/home.tsx", `import { x } from "./missing"`]]),
      has: hasOf("pages/home.tsx"),
    });
    expect(result).toBeInstanceOf(ProtocolError);
    expect((result as ProtocolError).code).toBe("MALFORMED_PROTOCOL");
  });

  test("rejects a relative edge that escapes the tree", () => {
    const result = scanClosureImports({
      sources: new Map([["pages/home.tsx", `import { x } from "../../outside"`]]),
      has: hasOf("pages/home.tsx"),
    });
    expect(result).toBeInstanceOf(ProtocolError);
    expect((result as ProtocolError).reason).toContain("design/");
  });

  test("rejects a bare react import", () => {
    const result = scanClosureImports({
      sources: new Map([["pages/home.tsx", `import { useState } from "react"`]]),
      has: hasOf("pages/home.tsx"),
    });
    expect(result).toBeInstanceOf(ProtocolError);
    expect((result as ProtocolError).code).toBe("MALFORMED_PROTOCOL");
    expect((result as ProtocolError).reason).toContain("react");
  });

  test("rejects a dynamic import of a forbidden module", () => {
    const result = scanClosureImports({
      sources: new Map([["pages/home.tsx", `const m = () => import("@termcraft/kit")`]]),
      has: hasOf("pages/home.tsx"),
    });
    expect(result).toBeInstanceOf(ProtocolError);
    expect((result as ProtocolError).reason).toContain("@termcraft/kit");
  });

  test("rejects an @opentui side-effect import", () => {
    const result = scanClosureImports({
      sources: new Map([["pages/home.tsx", `import "@opentui/core"`]]),
      has: hasOf("pages/home.tsx"),
    });
    expect(result).toBeInstanceOf(ProtocolError);
  });

  test("returns a ProtocolError (never a throw) for unparseable source", () => {
    // Bun.Transpiler.scanImports throws a BuildMessage on syntactically broken
    // TSX; scanClosureImports must convert that throw into a typed ProtocolError.
    const result = scanClosureImports({
      sources: new Map([["pages/home.tsx", `export default function P() { return <text>hi`]]),
      has: hasOf("pages/home.tsx"),
    });
    expect(result).toBeInstanceOf(ProtocolError);
    expect((result as ProtocolError).code).toBe("MALFORMED_PROTOCOL");
  });

  test("rejects a dynamic import of the runtime — only a static import is allowed (§3.1)", () => {
    const result = scanClosureImports({
      sources: new Map([["pages/home.tsx", `const rt = () => import("@termcraft/runtime")`]]),
      has: hasOf("pages/home.tsx"),
    });
    expect(result).toBeInstanceOf(ProtocolError);
    expect((result as ProtocolError).reason).toContain("@termcraft/runtime");
  });

  test("rejects a require of the runtime — only a static import is allowed (§3.1)", () => {
    const result = scanClosureImports({
      sources: new Map([["pages/home.tsx", `const rt = require("@termcraft/runtime")`]]),
      has: hasOf("pages/home.tsx"),
    });
    expect(result).toBeInstanceOf(ProtocolError);
  });

  test("scans EVERY source, not only the entry — a shared module's violation is caught", () => {
    const result = scanClosureImports({
      sources: new Map([
        [
          "pages/home.tsx",
          `import { theme } from "../lib/theme"\nexport default function P() { return null }`,
        ],
        ["lib/theme.ts", `import fs from "node:fs"\nexport const theme = 1\n`],
      ]),
      has: hasOf("pages/home.tsx", "lib/theme.ts"),
    });
    expect(result).toBeInstanceOf(ProtocolError);
    expect((result as ProtocolError).reason).toContain("node:fs");
    expect((result as ProtocolError).reason).toContain("lib/theme.ts");
  });

  test("a `.ts` file's type assertion is not read as JSX — the loader follows the extension", () => {
    // `const x = <string>y;` is legal TypeScript in a `.ts` file and an unclosed JSX element in
    // a `.tsx` one. A fixed `tsx` loader would report this legal file as unparseable, so the
    // scan must pick its loader from `parsesJsx` (entities/design-tree's measured predicate).
    const result = scanClosureImports({
      sources: new Map([["lib/cast.ts", `const y: unknown = 1\nexport const x = <string>y\n`]]),
      has: hasOf("lib/cast.ts"),
    });
    expect(result).toBeUndefined();
  });
});

const HOME_IMPORTING_THEME = `import { definePage } from "@termcraft/runtime"
import { theme } from "../lib/theme"

export const meta = definePage({
  kitApiVersion: 1,
  title: "Home",
  minSize: { w: 10, h: 2 },
  theme: "dark-default",
})

export default function Home() {
  return <text>{theme}</text>
}
`;

const THEME = `export const theme = "one"\n`;
const THEME_EDITED = `export const theme = "two"\n`;

/**
 * Write a design tree into its OWN fresh temporary directory and return its absolute root.
 *
 * ONE DIRECTORY PER TREE IS LOAD-BEARING, not tidiness: `loadPage` ends in `await import()`,
 * and Bun's module cache is keyed by absolute path over a case-insensitive filesystem on
 * Windows. Reusing a root across tests would serve an earlier test's module for a later test's
 * bytes — the exact methodology trap task 12b's measurement hit twice.
 */
async function writeTree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(`${tmpdir()}/termcraft-tree-`);
  for (const [relPath, text] of Object.entries(files)) {
    await Bun.write(`${root}/${relPath}`, text);
  }
  return root;
}

/** The tree's `(relPath, sha256)` inventory, hashed off the bytes actually on disk. */
async function inventoryOf(
  root: string,
  relPaths: readonly string[],
): Promise<readonly DesignFileEntryV1[]> {
  const files: DesignFileEntryV1[] = [];
  for (const relPath of relPaths) {
    files.push({ relPath, sha256: hashBytes(await Bun.file(`${root}/${relPath}`).bytes()) });
  }
  return files;
}

const fixturesRoot = `${import.meta.dir}/../fixtures`;

/** The fixture directory read as a tree root — the fixture's own name is its entry relPath. */
async function fixtureInventory(...names: string[]): Promise<readonly DesignFileEntryV1[]> {
  return inventoryOf(fixturesRoot, names);
}

describe("loadPage", () => {
  test("loads a valid facade page and validates its meta", async () => {
    registerRuntimeResolver();
    const loaded = await loadPage({
      treeRoot: fixturesRoot,
      entryRelPath: "probe-page.tsx",
      expectedFiles: await fixtureInventory("probe-page.tsx"),
    });
    expect(loaded).not.toBeInstanceOf(ProtocolError);
    if (loaded instanceof ProtocolError) throw loaded;
    expect(loaded.meta.kitApiVersion).toBe(1);
    expect(loaded.meta.title).toBe("Probe page");
    expect(loaded.meta.minSize).toEqual({ w: 10, h: 2 });
    expect(typeof loaded.component).toBe("function");
  });

  test("rejects a source-hash mismatch with SOURCE_HASH_MISMATCH", async () => {
    const result = await loadPage({
      treeRoot: fixturesRoot,
      entryRelPath: "probe-page.tsx",
      expectedFiles: [{ relPath: "probe-page.tsx", sha256: "0".repeat(64) }],
    });
    expect(result).toBeInstanceOf(ProtocolError);
    expect((result as ProtocolError).code).toBe("SOURCE_HASH_MISMATCH");
    expect((result as ProtocolError).reason).toContain("source hash");
  });

  test("rejects a page importing a forbidden module before it runs", async () => {
    const result = await loadPage({
      treeRoot: fixturesRoot,
      entryRelPath: "forbidden-react.tsx",
      expectedFiles: await fixtureInventory("forbidden-react.tsx"),
    });
    expect(result).toBeInstanceOf(ProtocolError);
    expect((result as ProtocolError).reason).toContain("react");
  });

  test("rejects a missing source path", async () => {
    const result = await loadPage({
      treeRoot: fixturesRoot,
      entryRelPath: "does-not-exist.tsx",
      expectedFiles: [{ relPath: "does-not-exist.tsx", sha256: "0".repeat(64) }],
    });
    expect(result).toBeInstanceOf(ProtocolError);
    expect((result as ProtocolError).code).toBe("SOURCE_HASH_MISMATCH");
  });

  test("returns a typed ProtocolError (not a rejection) for a hash-matching but unparseable page", async () => {
    // A hand-edited canonical file or an old snapshot whose stored bytes are
    // syntactically broken still passes the hash + UTF-8 gates and reaches the
    // import scan, which throws. loadPage must surface a typed ProtocolError so
    // the state machine can emit its best-effort `error` envelope (§5/§12).
    const result = await loadPage({
      treeRoot: fixturesRoot,
      entryRelPath: "broken-syntax.tsx",
      expectedFiles: await fixtureInventory("broken-syntax.tsx"),
    });
    expect(result).toBeInstanceOf(ProtocolError);
    expect((result as ProtocolError).code).toBe("MALFORMED_PROTOCOL");
  });

  test("refuses an entry that is not listed in its own expected inventory", async () => {
    const result = await loadPage({
      treeRoot: fixturesRoot,
      entryRelPath: "probe-page.tsx",
      expectedFiles: [],
    });
    expect(result).toBeInstanceOf(ProtocolError);
    expect((result as ProtocolError).code).toBe("MALFORMED_PROTOCOL");
    expect((result as ProtocolError).reason).toContain("inventory");
  });

  test("loads a page whose closure spans several files", async () => {
    registerRuntimeResolver();
    const root = await writeTree({
      "pages/home.tsx": HOME_IMPORTING_THEME,
      "lib/theme.ts": THEME,
    });
    const loaded = await loadPage({
      treeRoot: root,
      entryRelPath: "pages/home.tsx",
      expectedFiles: await inventoryOf(root, ["pages/home.tsx", "lib/theme.ts"]),
    });
    if (loaded instanceof ProtocolError) throw loaded;
    expect(typeof loaded.component).toBe("function");
    expect(loaded.meta.title).toBe("Home");
  });

  test("a SHARED module whose bytes drifted is a SOURCE_HASH_MISMATCH", async () => {
    const root = await writeTree({
      "pages/home.tsx": HOME_IMPORTING_THEME,
      "lib/theme.ts": THEME,
    });
    const expectedFiles = await inventoryOf(root, ["pages/home.tsx", "lib/theme.ts"]);
    await Bun.write(`${root}/lib/theme.ts`, THEME_EDITED);
    const result = await loadPage({
      treeRoot: root,
      entryRelPath: "pages/home.tsx",
      expectedFiles,
    });
    expect(result).toBeInstanceOf(ProtocolError);
    expect((result as ProtocolError).code).toBe("SOURCE_HASH_MISMATCH");
    expect((result as ProtocolError).reason).toContain("lib/theme.ts");
  });

  test("a forbidden import inside a SHARED module is caught before any code runs", async () => {
    const root = await writeTree({
      "pages/home.tsx": HOME_IMPORTING_THEME,
      "lib/theme.ts": 'import fs from "node:fs"\nexport const theme = 1\n',
    });
    const result = await loadPage({
      treeRoot: root,
      entryRelPath: "pages/home.tsx",
      expectedFiles: await inventoryOf(root, ["pages/home.tsx", "lib/theme.ts"]),
    });
    expect(result).toBeInstanceOf(ProtocolError);
    expect((result as ProtocolError).code).toBe("MALFORMED_PROTOCOL");
    expect((result as ProtocolError).reason).toContain("node:fs");
  });

  test("a specifier escaping the tree is rejected even when the file exists on disk", async () => {
    const root = await writeTree({
      "pages/home.tsx":
        'import x from "../../outside"\nexport default function P() { return null }\n',
    });
    await Bun.write(`${root}/../outside.ts`, "export default 1\n");
    const result = await loadPage({
      treeRoot: root,
      entryRelPath: "pages/home.tsx",
      expectedFiles: await inventoryOf(root, ["pages/home.tsx"]),
    });
    expect(result).toBeInstanceOf(ProtocolError);
    expect((result as ProtocolError).code).toBe("MALFORMED_PROTOCOL");
  });

  test("a closure member absent from the expected inventory is refused, not silently imported", async () => {
    const root = await writeTree({
      "pages/home.tsx": HOME_IMPORTING_THEME,
      "lib/theme.ts": THEME,
    });
    // The supervisor's expected set is STALE: it does not know about the shared module the
    // entry reaches. Nothing may be imported off a set that does not describe the page.
    const result = await loadPage({
      treeRoot: root,
      entryRelPath: "pages/home.tsx",
      expectedFiles: await inventoryOf(root, ["pages/home.tsx"]),
    });
    expect(result).toBeInstanceOf(ProtocolError);
    expect((result as ProtocolError).code).toBe("MALFORMED_PROTOCOL");
  });

  test("a non-code closure member is hash-verified but never tokenized", async () => {
    registerRuntimeResolver();
    const root = await writeTree({
      "pages/home.tsx": HOME_IMPORTING_THEME,
      "lib/theme.ts": THEME,
      // Bun's loader does not execute a `.md`, so it carries no module edge — its bytes
      // spelling `eval` or `import fs from "node:fs"` must not manufacture a fatal. It is not
      // in the closure either, so it is only here to prove the inventory may hold one.
      "NOTES.md": 'eval is a word, and so is import fs from "node:fs"\n',
    });
    const loaded = await loadPage({
      treeRoot: root,
      entryRelPath: "pages/home.tsx",
      expectedFiles: await inventoryOf(root, ["pages/home.tsx", "lib/theme.ts", "NOTES.md"]),
    });
    if (loaded instanceof ProtocolError) throw loaded;
    expect(typeof loaded.component).toBe("function");
  });

  test("the returned sourceHash is the ENTRY's own hash, not the closure's", async () => {
    registerRuntimeResolver();
    const root = await writeTree({
      "pages/home.tsx": HOME_IMPORTING_THEME,
      "lib/theme.ts": THEME,
    });
    const expectedFiles = await inventoryOf(root, ["pages/home.tsx", "lib/theme.ts"]);
    const loaded = await loadPage({
      treeRoot: root,
      entryRelPath: "pages/home.tsx",
      expectedFiles,
    });
    if (loaded instanceof ProtocolError) throw loaded;
    const entryRow = expectedFiles.find((file) => file.relPath === "pages/home.tsx");
    if (entryRow === undefined) throw new Error("the fixture inventory must list the entry");
    expect(loaded.sourceHash).toBe(entryRow.sha256);
    expect(loaded.sourceHash).not.toBe(
      expectedFiles.find((file) => file.relPath === "lib/theme.ts")?.sha256,
    );
  });

  test("a traversing entry path is refused before any read", async () => {
    const root = await writeTree({ "pages/home.tsx": HOME_IMPORTING_THEME });
    const result = await loadPage({
      treeRoot: root,
      entryRelPath: "../outside.tsx",
      expectedFiles: [{ relPath: "../outside.tsx", sha256: "0".repeat(64) }],
    });
    expect(result).toBeInstanceOf(ProtocolError);
    expect((result as ProtocolError).code).toBe("MALFORMED_PROTOCOL");
    expect((result as ProtocolError).reason).toContain("traversing");
  });
});

describe("createTreePathVerifier", () => {
  test("a directory prefix shared by several closure members is lstat-ed once per mount", async () => {
    const seen: string[] = [];
    const verify = createTreePathVerifier({
      lstat: async (path: string) => {
        seen.push(path);
        return { isSymbolicLink: () => false } as never;
      },
    });

    // Three members under one deep directory — the shape a page plus two shared modules has.
    expect(await verify("/t", "lib/deep/a.ts")).toBeUndefined();
    expect(await verify("/t", "lib/deep/b.ts")).toBeUndefined();
    expect(await verify("/t", "lib/deep/c.ts")).toBeUndefined();

    // Before the memo: 9 stats. After: 5 — `lib`, `lib/deep`, and one per distinct file.
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual([
      "/t/lib",
      "/t/lib/deep",
      "/t/lib/deep/a.ts",
      "/t/lib/deep/b.ts",
      "/t/lib/deep/c.ts",
    ]);
  });

  test("a symlinked FILE is still caught after its directory was verified for a sibling", async () => {
    // The memo must never vouch for the final component. Without this, memoizing the walk would
    // turn a shared directory into a blanket pass for everything under it.
    const verify = createTreePathVerifier({
      lstat: async (path: string) => ({ isSymbolicLink: () => path.endsWith("evil.ts") }) as never,
    });
    expect(await verify("/t", "lib/deep/a.ts")).toBeUndefined();
    const refused = await verify("/t", "lib/deep/evil.ts");
    expect(refused).toBeInstanceOf(ProtocolError);
    // Asked twice on purpose: if `verified.add` ran BEFORE the symlink check, evil.ts would be
    // memoised on the first refusal and this second call would return undefined — the blanket
    // pass the docblock names as the thing this ordering exists to prevent.
    expect(await verify("/t", "lib/deep/evil.ts")).toBeInstanceOf(ProtocolError);
  });

  // The plan's own third test (`expect(first).not.toBe(second)`) proves only that two closures
  // are distinct objects — true by construction, and no evidence about memo isolation. The
  // operator ruling that supersedes it for this task: a second verifier must RE-LSTAT the same
  // directory prefixes the first already proved, counted through the injected `lstat`. That is
  // what "nothing is vouched for across mounts" actually means, so this test proves it by
  // observation rather than by object identity.
  test("each mount gets its own verifier, so a second one re-lstats every prefix the first already proved", async () => {
    const seenA: string[] = [];
    const verifyA = createTreePathVerifier({
      lstat: async (path: string) => {
        seenA.push(path);
        return { isSymbolicLink: () => false } as never;
      },
    });
    expect(await verifyA("/t", "lib/deep/a.ts")).toBeUndefined();
    expect(seenA).toEqual(["/t/lib", "/t/lib/deep", "/t/lib/deep/a.ts"]);

    // A SECOND mount's verifier, over the SAME tree root and the SAME path. If any state leaked
    // across mounts, `lib` and `lib/deep` would be skipped here — they must not be.
    const seenB: string[] = [];
    const verifyB = createTreePathVerifier({
      lstat: async (path: string) => {
        seenB.push(path);
        return { isSymbolicLink: () => false } as never;
      },
    });
    expect(await verifyB("/t", "lib/deep/a.ts")).toBeUndefined();
    expect(seenB).toEqual(["/t/lib", "/t/lib/deep", "/t/lib/deep/a.ts"]);
  });
});
