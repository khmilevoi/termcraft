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
 * The literal ASCII domain-separation prefix folded ahead of a `closureHash`'s fields (design
 * §7), distinct from {@link TREE_REVISION_V1_PREFIX}. `closureHash` re-keys the page-metadata
 * cache and `treeRevision` keys a host incarnation — two different things a caller must never
 * confuse, so even the degenerate case (an empty pair list, or a page whose closure happens to
 * equal the whole inventory) cannot produce the same digest from both functions. The trailing
 * `v1` also versions the framing: changing it on a future encoding change makes the change loud
 * (every consumer's cached key moves) instead of silently rotating keys under an unchanged name.
 */
const CLOSURE_HASH_V1_PREFIX = "termcraft-design-tree-closure-v1";

/** The `treeRevision` counterpart of {@link CLOSURE_HASH_V1_PREFIX}; see its comment. */
const TREE_REVISION_V1_PREFIX = "termcraft-design-tree-revision-v1";

/**
 * One field: `u32be(UTF-8 byte length) || UTF-8 bytes`. Mirrors `store/trust/model/subject.ts`'s
 * `encodeField` — read that file before touching this one, this is not a new framing.
 *
 * A fixed-WIDTH binary length ahead of the bytes (not a decimal-and-colon TEXT prefix) is what
 * makes {@link foldMerkle} injective for arbitrary field content, with no precondition on either
 * field's shape. The previous framing length-prefixed only `relPath` and joined `sha256` bare;
 * that let two different `(relPath, sha256)` sequences fold to the identical canonical string
 * whenever a caller-supplied `sha256Of` returned something other than 64 hex characters — for
 * example `files: ["x"], sha256Of: () => "1:yh"` and `files: ["x","y"], sha256Of: (p) => p ===
 * "x" ? "" : "h"` both produced `"1:x1:yh"`. `sha256Of` is typed `string | null`, so an
 * honest-empty `""` is legal input today, not a hypothetical. Length-prefixing EVERY field
 * removes that precondition entirely rather than validating a width this module has no business
 * asserting.
 *
 * Deliberately NOT NFC-normalized, unlike `subject.ts`'s `encodeField`: `relPath` normalization
 * is an explicitly deferred concern for this plan's final review, not part of this fix.
 */
function encodeField(value: string): Uint8Array {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.byteLength);
  return Buffer.concat([length, bytes]);
}

/**
 * Fold a domain-separation prefix plus `(relPath, sha256)` pairs into one canonical BINARY
 * buffer and hash it. Kept private and shared by both hashes below so a change to the framing
 * can never desynchronize them. Layout, mirroring `subject.ts`'s `encodeTrustSubjectV1`: the
 * literal ASCII `prefix`, then exactly one NUL byte, then each pair as two length-prefixed
 * fields in a row (`encodeField(relPath)`, `encodeField(sha256)`) — never a delimiter, so no
 * field's byte content, including a colon, a digit-like prefix, a space, or a newline, can ever
 * be misread as a boundary.
 */
function foldMerkle(prefix: string, pairs: readonly (readonly [string, string])[]): string {
  const head = Buffer.concat([Buffer.from(prefix, "utf8"), Buffer.from([0x00])]);
  const fields = pairs.flatMap(([relPath, sha256]) => [encodeField(relPath), encodeField(sha256)]);
  return new Bun.CryptoHasher("sha256").update(Buffer.concat([head, ...fields])).digest("hex");
}

/**
 * The page's `closureHash` (design §7): a Merkle hash over its closure's `(relPath, sha256)`
 * pairs, deduplicated and sorted by `relPath`, domain-separated from `treeRevision` by
 * {@link CLOSURE_HASH_V1_PREFIX}. `null` when any closure file is absent from the inventory —
 * an honest "cannot be computed", never a hash over a partial set, because a partial hash would
 * silently equal a legitimately smaller closure.
 *
 * Deduplicates `files` before hashing: `resolveClosure`'s own output can never carry a
 * duplicate (it comes out of a `Set`), but this function's signature deliberately accepts a raw
 * file list rather than a `ClosureV1` — a caller holding only a closure's file list (the
 * `GateRunner` port's result, Task 13) must get the identical hash whether or not its list
 * happens to repeat a path, not a different one for `["a","a"]` versus `["a"]`.
 */
export function computeClosureHash(input: {
  readonly files: readonly string[];
  readonly sha256Of: (relPath: string) => string | null;
}): string | null {
  const pairs: (readonly [string, string])[] = [];
  for (const relPath of [...new Set(input.files)].sort()) {
    const sha256 = input.sha256Of(relPath);
    if (sha256 === null) return null;
    pairs.push([relPath, sha256]);
  }
  return foldMerkle(CLOSURE_HASH_V1_PREFIX, pairs);
}

/**
 * The whole tree's `treeRevision` (design §7): a Merkle hash over the ENTIRE inventory —
 * `pages.json` and files no page reaches included — domain-separated from `closureHash` by
 * {@link TREE_REVISION_V1_PREFIX}. This is what plan 3 will key a host incarnation on; in this
 * plan it exists so the value is computed and tested from the day the tree lands, rather than
 * introduced later against a live host.
 */
export function computeTreeRevision(inventory: DesignTreeInventoryV1): string {
  return foldMerkle(
    TREE_REVISION_V1_PREFIX,
    inventory.files.map((file) => [file.relPath, file.sha256] as const),
  );
}
