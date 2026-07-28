import type { DesignTreeInventoryV1 } from "../types";
import { SpecifierRejectedError, resolveDesignSpecifier } from "./specifier";

/** One page's transitive file set (design §7). `files` is sorted and always contains `entry`. */
export interface ClosureV1 {
  readonly entry: string;
  readonly files: readonly string[];
}

/**
 * Walk one entry's transitive module graph (design §7). Every edge goes through
 * {@link resolveDesignSpecifier}, so an illegal edge ANYWHERE in the closure is fatal here
 * rather than merely skipped — a page whose shared module imports `node:fs` must not resolve
 * to a smaller, apparently-legal closure.
 *
 * A cycle terminates: a file already visited is not re-walked. Cycles are LEGAL under the
 * design (§8 step 2 makes them a warning, not a fatal) and detecting them is plan 2's job —
 * this walk only has to not hang on one.
 *
 * `edgesOf` returns the raw authored specifiers of a file. The caller owns how it gets them:
 * the Gate uses its own lexer (Task 11), the host uses `Bun.Transpiler.scanImports`
 * (Task 15). Neither reads bytes through this function.
 */
export function resolveClosure(input: {
  readonly entry: string;
  readonly has: (relPath: string) => boolean;
  readonly edgesOf: (relPath: string) => readonly string[];
}): SpecifierRejectedError | ClosureV1 {
  if (!input.has(input.entry)) {
    return new SpecifierRejectedError({
      from: input.entry,
      specifier: input.entry,
      code: "UNRESOLVED",
      reason: "the entry names no file in the tree",
    });
  }

  const visited = new Set<string>([input.entry]);
  const queue: string[] = [input.entry];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    for (const specifier of input.edgesOf(current)) {
      const resolved = resolveDesignSpecifier({ from: current, specifier, has: input.has });
      if (resolved instanceof Error) return resolved;
      if (resolved.kind === "runtime") continue;
      if (visited.has(resolved.relPath)) continue;
      visited.add(resolved.relPath);
      queue.push(resolved.relPath);
    }
  }

  return { entry: input.entry, files: [...visited].sort() };
}

/**
 * Fold `(relPath, sha256)` pairs into one canonical text and hash it. Kept private and
 * shared by both hashes below so a change to the framing can never desynchronize them.
 * Each pair is LENGTH-PREFIXED (`<len>:<relPath><sha256>`) rather than delimiter-separated:
 * that is unambiguous for every possible path, including one holding a space or a newline,
 * without this module having to make any claim about the path grammar.
 */
function foldMerkle(pairs: readonly (readonly [string, string])[]): string {
  const canonical = pairs
    .map(([relPath, sha256]) => `${relPath.length}:${relPath}${sha256}`)
    .join("");
  return new Bun.CryptoHasher("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * The page's `closureHash` (design §7): a Merkle hash over its closure's `(relPath, sha256)`
 * pairs sorted by `relPath`. `null` when any closure file is absent from the inventory — an
 * honest "cannot be computed", never a hash over a partial set, because a partial hash would
 * silently equal a legitimately smaller closure.
 */
export function computeClosureHash(input: {
  readonly files: readonly string[];
  readonly sha256Of: (relPath: string) => string | null;
}): string | null {
  const pairs: (readonly [string, string])[] = [];
  for (const relPath of [...input.files].sort()) {
    const sha256 = input.sha256Of(relPath);
    if (sha256 === null) return null;
    pairs.push([relPath, sha256]);
  }
  return foldMerkle(pairs);
}

/**
 * The whole tree's `treeRevision` (design §7): a Merkle hash over the ENTIRE inventory —
 * `pages.json` and files no page reaches included. This is what plan 3 will key a host
 * incarnation on; in this plan it exists so the value is computed and tested from the day the
 * tree lands, rather than introduced later against a live host.
 */
export function computeTreeRevision(inventory: DesignTreeInventoryV1): string {
  return foldMerkle(inventory.files.map((file) => [file.relPath, file.sha256] as const));
}
