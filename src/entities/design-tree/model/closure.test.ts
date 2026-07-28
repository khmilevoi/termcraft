import { describe, expect, test } from "bun:test";

import { computeClosureHash, computeTreeRevision, resolveClosure } from "./closure";
import { createDesignTreeInventory, inventoryHas, inventorySha256 } from "./inventory";

const FILES = [
  { relPath: "pages/dashboard.tsx", sha256: "a".repeat(64) },
  { relPath: "pages/calendar.tsx", sha256: "b".repeat(64) },
  { relPath: "lib/theme.ts", sha256: "c".repeat(64) },
  { relPath: "lib/format.ts", sha256: "d".repeat(64) },
  { relPath: "pages.json", sha256: "e".repeat(64) },
];

const EDGES: Record<string, readonly string[]> = {
  "pages/dashboard.tsx": ["@termcraft/runtime", "../lib/theme", "../lib/format"],
  "pages/calendar.tsx": ["@termcraft/runtime", "../lib/theme"],
  "lib/theme.ts": [],
  "lib/format.ts": ["./theme"],
  "pages.json": [],
};

const inventory = createDesignTreeInventory(FILES);
if (inventory instanceof Error) throw inventory;
const has = inventoryHas(inventory);
const sha256Of = inventorySha256(inventory);
const edgesOf = (relPath: string) => EDGES[relPath] ?? [];

describe("resolveClosure", () => {
  test("returns the entry plus everything it transitively reaches, sorted", () => {
    const closure = resolveClosure({ entry: "pages/dashboard.tsx", has, edgesOf });
    if (closure instanceof Error) throw closure;
    expect(closure.files).toEqual(["lib/format.ts", "lib/theme.ts", "pages/dashboard.tsx"]);
  });

  test("the runtime edge is not a file and never enters the closure", () => {
    const closure = resolveClosure({ entry: "pages/calendar.tsx", has, edgesOf });
    if (closure instanceof Error) throw closure;
    expect(closure.files).toEqual(["lib/theme.ts", "pages/calendar.tsx"]);
  });

  test("a cycle terminates instead of looping forever", () => {
    const cyclic = (relPath: string) =>
      relPath === "lib/theme.ts" ? ["./format"] : (EDGES[relPath] ?? []);
    const closure = resolveClosure({ entry: "pages/dashboard.tsx", has, edgesOf: cyclic });
    if (closure instanceof Error) throw closure;
    expect(closure.files).toEqual(["lib/format.ts", "lib/theme.ts", "pages/dashboard.tsx"]);
  });

  test("an illegal edge anywhere in the closure is fatal, not skipped", () => {
    const hostile = (relPath: string) =>
      relPath === "lib/theme.ts" ? ["node:fs"] : (EDGES[relPath] ?? []);
    const closure = resolveClosure({ entry: "pages/dashboard.tsx", has, edgesOf: hostile });
    expect(closure).toBeInstanceOf(Error);
    expect(String(closure)).toContain("BARE_SPECIFIER");
  });

  test("an entry that is not in the tree is fatal", () => {
    expect(resolveClosure({ entry: "pages/missing.tsx", has, edgesOf })).toBeInstanceOf(Error);
  });
});

describe("computeClosureHash", () => {
  test("is stable, and changes when a shared module's bytes change", () => {
    const closure = resolveClosure({ entry: "pages/dashboard.tsx", has, edgesOf });
    if (closure instanceof Error) throw closure;
    const before = computeClosureHash({ files: closure.files, sha256Of });
    expect(before).toBe(computeClosureHash({ files: closure.files, sha256Of }));

    const edited = createDesignTreeInventory(
      FILES.map((file) =>
        file.relPath === "lib/theme.ts" ? { ...file, sha256: "f".repeat(64) } : file,
      ),
    );
    if (edited instanceof Error) throw edited;
    const after = computeClosureHash({
      files: closure.files,
      sha256Of: inventorySha256(edited),
    });
    expect(after).not.toBe(before);
  });

  test("two pages sharing a module get DIFFERENT hashes", () => {
    const dashboard = resolveClosure({ entry: "pages/dashboard.tsx", has, edgesOf });
    const calendar = resolveClosure({ entry: "pages/calendar.tsx", has, edgesOf });
    if (dashboard instanceof Error) throw dashboard;
    if (calendar instanceof Error) throw calendar;
    expect(computeClosureHash({ files: dashboard.files, sha256Of })).not.toBe(
      computeClosureHash({ files: calendar.files, sha256Of }),
    );
  });

  test("is null when a closure file is missing from the inventory", () => {
    expect(computeClosureHash({ files: ["pages/ghost.tsx"], sha256Of })).toBeNull();
  });
});

describe("computeTreeRevision", () => {
  test("covers files no page reaches, and pages.json", () => {
    const withOrphan = createDesignTreeInventory([
      ...FILES,
      { relPath: "lib/unused.ts", sha256: "9".repeat(64) },
    ]);
    if (withOrphan instanceof Error) throw withOrphan;
    expect(computeTreeRevision(withOrphan)).not.toBe(computeTreeRevision(inventory));
  });

  test("does not depend on the order files were supplied in", () => {
    const reversed = createDesignTreeInventory([...FILES].reverse());
    if (reversed instanceof Error) throw reversed;
    expect(computeTreeRevision(reversed)).toBe(computeTreeRevision(inventory));
  });
});

describe("createDesignTreeInventory", () => {
  test("refuses a duplicate relPath rather than keeping the last one", () => {
    expect(createDesignTreeInventory([...FILES, FILES[0]!])).toBeInstanceOf(Error);
  });

  // `DuplicateInventoryPathError` carries no `code` (unlike `SpecifierRejectedError`, it names
  // exactly one failure mode), so the machine-readable identification that matters here is
  // WHICH path collided — `toBeInstanceOf(Error)` alone can't say that.
  test("the duplicate error names the exact relPath that collided", () => {
    const result = createDesignTreeInventory([...FILES, FILES[0]!]);
    expect(result).toBeInstanceOf(Error);
    if (!(result instanceof Error)) return;
    expect(result._tag).toBe("DuplicateInventoryPathError");
    expect(result.relPath).toBe(FILES[0]!.relPath);
  });
});

// --- Beyond the brief: determinism, sensitivity scoping, cycle proof, and a diamond graph. ---

describe("computeClosureHash — determinism and sensitivity beyond the brief's own cases", () => {
  test("insertion order of the closure's file list does not change the hash", () => {
    const closure = resolveClosure({ entry: "pages/dashboard.tsx", has, edgesOf });
    if (closure instanceof Error) throw closure;
    const forward = computeClosureHash({ files: closure.files, sha256Of });
    const shuffled = computeClosureHash({ files: [...closure.files].reverse(), sha256Of });
    expect(shuffled).toBe(forward);
  });

  test("a byte change in a shared module changes every reaching page's hash, and leaves an unrelated page's hash alone", () => {
    // `lib/format.ts` is reached by dashboard but not by calendar (see EDGES above).
    const dashboard = resolveClosure({ entry: "pages/dashboard.tsx", has, edgesOf });
    const calendar = resolveClosure({ entry: "pages/calendar.tsx", has, edgesOf });
    if (dashboard instanceof Error) throw dashboard;
    if (calendar instanceof Error) throw calendar;

    const dashboardBefore = computeClosureHash({ files: dashboard.files, sha256Of });
    const calendarBefore = computeClosureHash({ files: calendar.files, sha256Of });

    const edited = createDesignTreeInventory(
      FILES.map((file) =>
        file.relPath === "lib/format.ts" ? { ...file, sha256: "9".repeat(64) } : file,
      ),
    );
    if (edited instanceof Error) throw edited;
    const editedSha256Of = inventorySha256(edited);

    const dashboardAfter = computeClosureHash({ files: dashboard.files, sha256Of: editedSha256Of });
    const calendarAfter = computeClosureHash({ files: calendar.files, sha256Of: editedSha256Of });

    // dashboard's closure includes lib/format.ts, so its hash must move.
    expect(dashboardAfter).not.toBe(dashboardBefore);
    // calendar's closure never reaches lib/format.ts, so its hash must be untouched.
    expect(calendarAfter).toBe(calendarBefore);
  });
});

describe("resolveClosure — rejection cases carry a machine-readable code", () => {
  // Per review guidance from an earlier task in this plan: `toBeInstanceOf(Error)` alone
  // cannot say WHICH rule fired. Both of `resolveClosure`'s own rejection paths — an entry
  // absent from the tree, and an illegal edge discovered mid-walk — are asserted on `.code`
  // here, not just on the message string the brief's own verbatim tests already check.
  test("an entry that is not in the tree is rejected with UNRESOLVED", () => {
    const result = resolveClosure({ entry: "pages/missing.tsx", has, edgesOf });
    expect(result).toBeInstanceOf(Error);
    if (!(result instanceof Error)) return;
    expect(result.code).toBe("UNRESOLVED");
  });

  test("an illegal edge mid-walk is rejected with the resolver's own code (BARE_SPECIFIER)", () => {
    const hostile = (relPath: string) =>
      relPath === "lib/theme.ts" ? ["node:fs"] : (EDGES[relPath] ?? []);
    const result = resolveClosure({ entry: "pages/dashboard.tsx", has, edgesOf: hostile });
    expect(result).toBeInstanceOf(Error);
    if (!(result instanceof Error)) return;
    expect(result.code).toBe("BARE_SPECIFIER");
  });
});

describe("resolveClosure — cycle proof and diamond shape", () => {
  test("a two-file cycle (theme <-> format) still terminates and returns exactly the reachable set", () => {
    // lib/theme.ts <-> lib/format.ts, both reachable from the entry. Without cycle detection
    // this would enqueue each of the two files forever.
    const twoCycle = (relPath: string) => {
      if (relPath === "lib/theme.ts") return ["./format"];
      if (relPath === "lib/format.ts") return ["./theme"];
      return EDGES[relPath] ?? [];
    };
    const closure = resolveClosure({ entry: "pages/dashboard.tsx", has, edgesOf: twoCycle });
    if (closure instanceof Error) throw closure;
    expect(closure.files).toEqual(["lib/format.ts", "lib/theme.ts", "pages/dashboard.tsx"]);
  });

  test("a diamond graph visits the shared module once, not twice", () => {
    // entry -> a.ts, b.ts; both a.ts and b.ts -> shared.ts. shared.ts must appear exactly once
    // in the closure's file list, proving the visited-set dedupes rather than re-walking it.
    const diamondFiles = createDesignTreeInventory([
      { relPath: "pages/diamond.tsx", sha256: "1".repeat(64) },
      { relPath: "lib/a.ts", sha256: "2".repeat(64) },
      { relPath: "lib/b.ts", sha256: "3".repeat(64) },
      { relPath: "lib/shared.ts", sha256: "4".repeat(64) },
    ]);
    if (diamondFiles instanceof Error) throw diamondFiles;
    const diamondHas = inventoryHas(diamondFiles);

    const diamondEdges: Record<string, readonly string[]> = {
      "pages/diamond.tsx": ["../lib/a", "../lib/b"],
      "lib/a.ts": ["./shared"],
      "lib/b.ts": ["./shared"],
      "lib/shared.ts": [],
    };
    const diamondEdgesOf = (relPath: string) => diamondEdges[relPath] ?? [];

    const closure = resolveClosure({
      entry: "pages/diamond.tsx",
      has: diamondHas,
      edgesOf: diamondEdgesOf,
    });
    if (closure instanceof Error) throw closure;
    expect(closure.files).toEqual(["lib/a.ts", "lib/b.ts", "lib/shared.ts", "pages/diamond.tsx"]);
    // Exactly one occurrence — proves the walk deduped rather than double-visiting.
    expect(closure.files.filter((relPath) => relPath === "lib/shared.ts")).toHaveLength(1);
  });
});
