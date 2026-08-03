import { wrap } from "@reatom/core";

import type { DesignTreeReader, GateErrorV1, GateRunner, GateWarningV1 } from "core/ports";
import type { FailureDtoV1 } from "core/protocol";
import {
  computeClosureHash,
  computeTreeRevision,
  createDesignTreeInventory,
  inventorySha256,
} from "entities/design-tree";
import type { DesignTreeInventoryV1, PageEntryV1 } from "entities/design-tree";
import type { PageSlug } from "entities/page";

import { readPageOrder } from "./descriptors";

/**
 * THE CANONICAL TREE, READ ONCE (design §7; design-tree phase 2 Task 5). Every path that is NOT
 * a turn — descriptor publishing on open and after a commit, preview settings, export capture —
 * needs the same four facts about the tree it is looking at: its inventory, its revision, its
 * page list, and each page's `closureHash`. Before this module each of those paths assembled
 * some subset of them itself, and none could produce a closure hash at all, because resolving a
 * closure means walking the import graph and `core` may not import `gate`.
 *
 * ONE `GateRunner.runTree` CALL PER READ, never one per page. That is the whole shape: the pass
 * already walks every entry's closure in a single sweep (`core/ports/gate-runner.ts`'s own
 * contract), so asking it per page would spawn one compiler program per page for answers one
 * program already holds.
 *
 * `core` COMPUTES THE HASHES ITSELF — the port returns file LISTS, not digests. This is not an
 * arbitrary split: `core/turns/model/candidate.ts`'s `selectChangedPages` already folds a
 * closure the same way, through the same `computeClosureHash` over the same
 * `inventorySha256(inventory)` lookup, and two independent hash implementations is precisely
 * what would make design §7's consumer table (page-meta cache, diagnostics store, export render
 * key, smoke selection) disagree about whether a page changed. Read `selectChangedPages` before
 * touching {@link readCanonicalTreeIndex}'s fold; the two must stay one algorithm.
 *
 * WHY `createDesignTreeInventory` AND NOT A RAW `listTree()` ARRAY: `computeTreeRevision` folds
 * `inventory.files` in ARRAY ORDER without sorting (`entities/design-tree/model/closure.ts`),
 * unlike `computeClosureHash`, which sorts internally. A revision computed over a raw directory
 * walk would therefore be a filesystem-enumeration artifact rather than an identity — the same
 * tree would key differently on another machine. `createDesignTreeInventory` sorts by `relPath`
 * and REFUSES duplicates, and its `DuplicateInventoryPathError` is mapped to a typed refusal
 * below rather than collapsed: a tree-relative path names exactly one byte image, and picking
 * one of two silently is how a hash comes to describe bytes nobody has.
 */

/**
 * One whole read of the canonical tree: what it contains, what it hashes to, which pages it
 * declares, and what the whole-tree pass said about it.
 */
export interface CanonicalTreeIndexV1 {
  /** Sorted, duplicate-free — built through `createDesignTreeInventory`. */
  readonly inventory: DesignTreeInventoryV1;
  /** `computeTreeRevision(inventory)`. */
  readonly treeRevision: string;
  /** `pages.json`'s own entry list, in manifest order. */
  readonly pages: readonly PageEntryV1[];
  /** Every tree file's text, tree-relative — the map `runTree` was given. */
  readonly files: ReadonlyMap<string, string>;
  /**
   * `null` when this page's closure was not proved complete: "cannot compute", never
   * "unchanged". TWO different facts reach it, and both are honest misses — the pass returned no
   * closure for the slug (it is then named in some {@link errors} entry's `blockedPages`), or a
   * closure member is absent from the inventory so `computeClosureHash` refused to fold a
   * partial set. Every downstream consumer in design §7's table must read `null` as
   * changed/miss/re-run.
   */
  closureHashOf(slug: PageSlug): string | null;
  /** The pass's own diagnostics, carried so a caller can attribute them; never swallowed. */
  readonly errors: readonly GateErrorV1[];
  readonly warnings: readonly GateWarningV1[];
}

/**
 * `listTree()` named the same tree-relative path twice. Refused rather than normalized, for
 * `DuplicateInventoryPathError`'s own reason: keeping the last occurrence would silently pick
 * one of two byte images, and both the revision and every closure hash fold that choice.
 * `retryable: false` — re-reading an inconsistent listing produces the same inconsistency.
 */
function duplicateTreePathFailure(relPath: string): FailureDtoV1 {
  return {
    code: "PERSISTENCE_FAILED",
    retryable: false,
    safeMessage: `the design tree inventory lists "${relPath}" more than once`,
    details: { relPath },
  };
}

/**
 * Every inventory file's text, tree-relative. A read failure anywhere is a wholesale refusal,
 * never a partial tree — judging a design against a file set missing the module its pages import
 * produces diagnostics about the reader, not about the design. (Shaped after
 * `core/export/model/snapshot.ts`'s `readWholeTree`, and moved here from
 * `core/kernel/model/handlers/page-descriptors.ts`'s own `readTreeSources`, which this module
 * replaces.)
 *
 * The text is UNFILTERED, deliberately. `gate` alone decides which files are code
 * (`entities/design-tree`'s measured `isCodeFile`), and a predicate here would be a second,
 * independently derived copy of it — see `core/turns/model/validation.ts`'s `files` doc for the
 * full argument and its measurement.
 */
async function readTreeSources(
  designReader: DesignTreeReader,
  inventory: DesignTreeInventoryV1,
): Promise<FailureDtoV1 | ReadonlyMap<string, string>> {
  const decoder = new TextDecoder();
  const files = new Map<string, string>();
  for (const file of inventory.files) {
    const read = await wrap(designReader.readTreeFile(file.relPath));
    if ("code" in read) {
      return {
        code: "PERSISTENCE_FAILED",
        retryable: read.retryable,
        safeMessage: `failed to read design tree file "${file.relPath}": ${read.safeMessage}`,
        details: { relPath: file.relPath },
      };
    }
    files.set(file.relPath, decoder.decode(read.bytes));
  }
  return files;
}

/**
 * Read the canonical tree once and produce everything a non-turn caller needs from it: the
 * sorted inventory, its revision, the manifest's page list, every file's text, the whole-tree
 * pass's diagnostics, and a per-slug `closureHash`.
 *
 * The order is forced by what each step needs from the one before it: the inventory decides
 * which files to read and what `treePaths` the pass is given, the manifest is read against those
 * same `treePaths` (so `readPageOrder`'s "a project has no manifest until its first turn writes
 * one" allowance costs no second `listTree()`), and the pass needs both the text and the page
 * list before it can resolve a single closure.
 */
export async function readCanonicalTreeIndex(deps: {
  readonly designReader: DesignTreeReader;
  readonly gateRunner: GateRunner;
}): Promise<FailureDtoV1 | CanonicalTreeIndexV1> {
  const listed = await wrap(deps.designReader.listTree());
  if ("code" in listed) return listed;

  const inventory = createDesignTreeInventory(
    listed.map((file) => ({ relPath: file.relPath, sha256: file.sha256 })),
  );
  // `String(...)` because `createTaggedError`'s `$relPath` interpolation variable is typed
  // `string | number` at the class, not `string` — the value is always the `relPath` this module
  // itself handed in, so this narrows a template's type, it does not coerce unknown data.
  if (inventory instanceof Error) return duplicateTreePathFailure(String(inventory.relPath));

  const treePaths = inventory.files.map((file) => file.relPath);
  const pages = await wrap(readPageOrder(deps.designReader, treePaths));
  if ("code" in pages) return pages;

  const files = await readTreeSources(deps.designReader, inventory);
  if ("code" in files) return files;

  const pass = await wrap(deps.gateRunner.runTree({ files, treePaths, pages }));

  const sha256Of = inventorySha256(inventory);
  const hashBySlug = new Map<PageSlug, string | null>(
    pass.closures.map((closure) => [
      closure.slug,
      computeClosureHash({ files: closure.files, sha256Of }),
    ]),
  );

  return {
    inventory,
    treeRevision: computeTreeRevision(inventory),
    pages,
    files,
    closureHashOf: (slug) => hashBySlug.get(slug) ?? null,
    errors: pass.errors,
    warnings: pass.warnings,
  };
}
