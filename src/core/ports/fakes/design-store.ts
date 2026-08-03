import type { FailureDtoV1, PageRemovePlanV1, Sha256Hex } from "core/protocol";
import {
  PAGES_MANIFEST_RELPATH,
  PAGES_MANIFEST_SCHEMA_VERSION,
  computeSourceHash,
  encodePagesManifest,
} from "entities/design-tree";
import type { PageEntryV1, PagesManifestV1 } from "entities/design-tree";
import type { PageSlug } from "entities/page";

import type { DesignTreeFileV1, DesignTreeReader, PageMutations } from "../design-store";
import type { AssertConforms } from "../index";

/**
 * In-memory {@link DesignTreeReader}/{@link PageMutations} fake, re-keyed from the retired
 * `fakes/page-store.ts` (plan Task 7). `manifest` is the sole ordering/identity authority —
 * the one document both `listTree()`'s callers and `reorder()`/`remove()` read/mutate — and
 * `files` is a separate map so a test can seed tree bytes independently of manifest entries
 * (a page can be tracked in the manifest before its entry file is staged, matching real turn
 * workflows). NOTHING HERE COMPUTES A PATH FROM A SLUG: `renameTitle`/`remove` look up a
 * page's file only via its manifest `entry`, never by guessing a slug-shaped path.
 */

function notFound(relPath: string): FailureDtoV1 {
  return {
    code: "PERSISTENCE_FAILED",
    retryable: false,
    safeMessage: `no design-tree file at ${relPath}`,
    details: { relPath },
  };
}

/** `reorder()`'s own port doc (`design-store.ts`): "the exact permutation of already-listed slugs — never a subset or an added/removed identity." Named per which invariant broke, matching the sibling `notFound` above. */
function reorderInvariantFailure(reason: string): FailureDtoV1 {
  return {
    code: "PERSISTENCE_FAILED",
    retryable: false,
    safeMessage: `reorder() rejected: ${reason}`,
    details: { reason },
  };
}

/** A deterministic, valid-looking 64-hex-char digest derived from a seed — mirrors `fakes/staging.ts`'s own identical helper. */
function fakeSha256Hex(seed: string): Sha256Hex {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (Math.imul(h, 31) + seed.charCodeAt(i)) | 0;
  const base = (h >>> 0).toString(16).padStart(8, "0");
  return base.repeat(8).slice(0, 64);
}

/**
 * A seeded tree file: `bytes` is mandatory, `sha256` is OPTIONAL — see {@link seededSha256}.
 * `DesignTreeFileV1` (`core/ports/design-store.ts`) itself keeps `sha256` required, because
 * that is the real port's return shape every caller of `readTreeFile()`/`listTree()` gets back;
 * this is strictly the SEED a test hands `createFakeDesignStore`, which is allowed to omit it.
 */
export interface DesignTreeFileSeedV1 {
  readonly bytes: Uint8Array;
  readonly sha256?: Sha256Hex;
}

/**
 * The seeded bytes' REAL SHA-256, computed the same way the real adapter computes it
 * (`entities/design-tree`'s `computeSourceHash`, which `store`'s own `sha256Hex` is pinned
 * against — see `store/jsonl/model/line-codec.test.ts`'s "sha256Hex parity" test), unless the
 * seed pins one explicitly, which a test doing drift/mismatch scenarios needs.
 *
 * A fabricated constant here is not a harmless shortcut: `sha256` is what `closureHash` and
 * `treeRevision` fold and what the host verifies every closure member against at mount, so a
 * fake that reports a hash corresponding to no bytes makes every `core` test blind to a defect
 * that swaps a path for its content.
 */
function seededSha256(file: DesignTreeFileSeedV1): Sha256Hex {
  return file.sha256 ?? computeSourceHash(file.bytes);
}

export type DesignStoreFailableMethod =
  | "readTreeFile"
  | "listTree"
  | "readManifest"
  | "renameTitle"
  | "reorder"
  | "remove";

export type DesignStoreCall =
  | { readonly method: "readTreeFile"; readonly relPath: string }
  | { readonly method: "listTree" }
  | { readonly method: "readManifest" }
  | { readonly method: "renameTitle"; readonly pageSlug: PageSlug; readonly title: string }
  | { readonly method: "reorder"; readonly order: readonly PageSlug[] }
  | { readonly method: "remove"; readonly pageSlug: PageSlug };

export interface FakeDesignStore extends DesignTreeReader, PageMutations {
  readonly calls: readonly DesignStoreCall[];
  /**
   * KNOWN FAKE-FIDELITY GAP (review finding, promoted 5 — read before writing a "rename then
   * read the file" test against this fake): `renameTitle()`'s own port doc says it
   * "mechanically rewrites the page's entry file's static `meta.title`", and the REAL adapter
   * (`store/adapters/page-store.ts`'s `rewriteMetaTitle`) does exactly that. This fake does
   * NOT — it only records the title here, in `titles`, and never touches `files`' bytes. A
   * test that renames a page and then expects `readTreeFile()` to reflect the new title WILL
   * pass against the real adapter and FALSELY pass (or silently prove nothing) against this
   * fake. Recorded here, not fixed, because reproducing the real adapter's `definePage({...})`
   * text-rewrite inside a fake would duplicate production logic this ring's fakes are
   * deliberately "dumb" about (see `fakes/turn-transactions.ts`'s own header: "the fake is
   * dumb and scriptable, not a re-implementation of the engine").
   */
  readonly titles: ReadonlyMap<PageSlug, string>;
  failNext(method: DesignStoreFailableMethod, failure: FailureDtoV1): void;
}

export function createFakeDesignStore(options: {
  readonly manifest: PagesManifestV1;
  readonly files?: ReadonlyMap<string, DesignTreeFileSeedV1>;
}): FakeDesignStore {
  let manifest = options.manifest;
  const files = new Map<string, DesignTreeFileSeedV1>(options.files ?? []);
  const titles = new Map<PageSlug, string>();
  const calls: DesignStoreCall[] = [];

  const queues: Record<DesignStoreFailableMethod, FailureDtoV1[]> = {
    readTreeFile: [],
    listTree: [],
    readManifest: [],
    renameTitle: [],
    reorder: [],
    remove: [],
  };

  function failNext(method: DesignStoreFailableMethod, failure: FailureDtoV1): void {
    queues[method].push(failure);
  }

  async function readTreeFile(relPath: string): Promise<FailureDtoV1 | DesignTreeFileV1> {
    calls.push({ method: "readTreeFile", relPath });
    const queued = queues.readTreeFile.shift();
    if (queued !== undefined) return queued;
    const file = files.get(relPath);
    if (file === undefined) return notFound(relPath);
    return { bytes: file.bytes, sha256: seededSha256(file) };
  }

  async function listTree(): Promise<
    | FailureDtoV1
    | readonly { readonly relPath: string; readonly sha256: Sha256Hex; readonly size: number }[]
  > {
    calls.push({ method: "listTree" });
    const queued = queues.listTree.shift();
    if (queued !== undefined) return queued;
    return [...files.entries()]
      .map(([relPath, file]) => ({
        relPath,
        sha256: seededSha256(file),
        size: file.bytes.byteLength,
      }))
      .sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  }

  async function readManifest(): Promise<FailureDtoV1 | PagesManifestV1> {
    calls.push({ method: "readManifest" });
    const queued = queues.readManifest.shift();
    if (queued !== undefined) return queued;
    return manifest;
  }

  async function renameTitle(pageSlug: PageSlug, title: string): Promise<FailureDtoV1 | undefined> {
    calls.push({ method: "renameTitle", pageSlug, title });
    const queued = queues.renameTitle.shift();
    if (queued !== undefined) return queued;
    titles.set(pageSlug, title);
    return undefined;
  }

  async function reorder(order: readonly PageSlug[]): Promise<FailureDtoV1 | undefined> {
    calls.push({ method: "reorder", order });
    const queued = queues.reorder.shift();
    if (queued !== undefined) return queued;

    const bySlug = new Map<PageSlug, PageEntryV1>(
      manifest.pages.map((entry) => [entry.slug, entry]),
    );
    // The port's own doc: "the exact permutation of already-listed slugs — never a subset or
    // an added/removed identity." Checked both directions rather than silently filtering an
    // unknown slug out (review finding, promoted 4) — a caller passing a stale/foreign slug
    // finds out immediately, instead of the fake quietly reordering fewer pages than it holds.
    if (order.length !== manifest.pages.length) {
      return reorderInvariantFailure(
        `order has ${order.length} slugs but the manifest holds ${manifest.pages.length}`,
      );
    }
    // A DUPLICATED slug (review finding, Task 9): `[home, home]` against `[home, about]`
    // passes the length check above and, without this, silently drops `about` — exactly the
    // class of bug the length check was added to eliminate. Checked before the resolve loop
    // so a duplicate is refused before any lookup, matching the length check's own "before
    // any write" ordering.
    if (new Set(order).size !== order.length) {
      return reorderInvariantFailure("order names a duplicate pageSlug");
    }
    const reordered: PageEntryV1[] = [];
    for (const slug of order) {
      const entry = bySlug.get(slug);
      if (entry === undefined) return reorderInvariantFailure(`unknown pageSlug "${slug}"`);
      reordered.push(entry);
    }
    manifest = { ...manifest, pages: reordered };
    return undefined;
  }

  async function remove(plan: PageRemovePlanV1): Promise<FailureDtoV1 | undefined> {
    const pageSlug = plan.pageSlug as PageSlug;
    calls.push({ method: "remove", pageSlug });
    const queued = queues.remove.shift();
    if (queued !== undefined) return queued;
    const removed = manifest.pages.find((entry) => entry.slug === pageSlug);
    manifest = { ...manifest, pages: manifest.pages.filter((entry) => entry.slug !== pageSlug) };
    if (removed !== undefined) files.delete(removed.entry);
    titles.delete(pageSlug);
    return undefined;
  }

  return {
    readTreeFile,
    listTree,
    readManifest,
    renameTitle,
    reorder,
    remove,
    calls,
    titles,
    failNext,
  };
}

/** Builds a deterministic {@link DesignTreeFileV1} from a seed string — no real crypto/randomness, matching every other fake's own convention. */
export function fakeDesignTreeFile(seed: string): DesignTreeFileV1 {
  const bytes = new TextEncoder().encode(seed);
  return { bytes, sha256: fakeSha256Hex(seed) };
}

/**
 * A page to seed into {@link createFakeDesignStoreForPages}: its slug, its source bytes, and
 * — optionally — the tree-relative `entry` `design/pages.json` binds it to. `sha256` is
 * OPTIONAL (Task 7, fix round 1): omit it and {@link createFakeDesignStoreForPages} derives the
 * real hash of `bytes` the same way `createFakeDesignStore` does; pass it explicitly only for a
 * test that needs a hash pinned away from what `bytes` actually hashes to (a drift/mismatch
 * scenario).
 */
export interface FakeDesignPageV1 {
  readonly pageSlug: PageSlug;
  readonly bytes: Uint8Array;
  readonly sha256?: Sha256Hex;
  /** Defaults to {@link defaultFakeEntry}. Pass an arbitrary path when the test is ABOUT manifest lookup. */
  readonly entry?: string;
}

/**
 * The default `entry` this fixture binds a slug to.
 *
 * DELIBERATELY NOT `pages/<slug>.tsx` (task 14; the branch's own recurring test-quality trap:
 * "a fixture whose `entry` equals `pages/<slug>.tsx` proves nothing about manifest lookup").
 * That was the exact path the retired `PageReader.readSource(slug)` computed, so a fixture
 * using it would keep passing against code that still derived a path from the slug instead of
 * reading `design/pages.json` — which is the one thing every caller migrated in task 14 had to
 * stop doing.
 *
 * It is still a TEMPLATE, and a template is still a function of the slug: this default proves
 * production does not derive `pages/<slug>.tsx`, not that it derives nothing at all. Tests
 * whose SUBJECT is the manifest lookup pass a genuinely arbitrary `entry` instead (see
 * `src/entrypoint/model/turn-import-perimeter.test.ts`'s `screens/landing/main.tsx` row and
 * `core/turns/model/validation.test.ts`'s own entries).
 */
export function defaultFakeEntry(pageSlug: PageSlug): string {
  return `screens/${pageSlug}/view.tsx`;
}

/**
 * A {@link FakeDesignStore} seeded from a page list — the shape the retired
 * `createFakePageStore({order, sources})` fixture had, re-expressed over a REAL manifest so the
 * ~16 kernel/export/project test files that used it keep their per-test intent while their
 * subject reads through `design/pages.json` like production now does.
 *
 * `extraFiles` seeds tree files that belong to NO page — shared modules, assets — which is what
 * makes a fixture able to exercise the design tree's whole point.
 */
export function createFakeDesignStoreForPages(options: {
  readonly pages: readonly FakeDesignPageV1[];
  readonly extraFiles?: ReadonlyMap<string, DesignTreeFileSeedV1>;
  readonly requestedActivePage?: PageSlug | null;
}): FakeDesignStore {
  const files = new Map<string, DesignTreeFileSeedV1>(options.extraFiles ?? []);
  const entries: PageEntryV1[] = [];
  for (const page of options.pages) {
    const entry = page.entry ?? defaultFakeEntry(page.pageSlug);
    entries.push({ slug: page.pageSlug, entry });
    files.set(entry, { bytes: page.bytes, sha256: page.sha256 });
  }
  const manifest: PagesManifestV1 = {
    schemaVersion: PAGES_MANIFEST_SCHEMA_VERSION,
    pages: entries,
    requestedActivePage: options.requestedActivePage ?? null,
  };
  // `design/pages.json` IS A REAL TREE FILE, so `listTree()` must name it (design §3, §4 — the
  // manifest lives inside the tree and staging copies it like any other file). Seeded here as
  // its own encoded bytes rather than left implicit, because two real behaviours depend on the
  // INVENTORY naming it, not merely on `readManifest()` answering:
  //   - `core/kernel`'s turn staging stages every path `listTree()` returns, so a fake that
  //     omitted it would stage a workspace with no manifest at all;
  //   - `core/project`'s `readPageOrder` distinguishes "this project has no manifest yet" from
  //     "the manifest is unreadable" by asking whether the tree names `pages.json` — a fake
  //     that omitted it would turn every scripted `failNext("readManifest", ...)` into a silent
  //     honest-empty page order, and four tests measured exactly that before this line existed.
  // `createFakeDesignStore` itself deliberately does NOT do this: a caller using it directly
  // is the one modelling a tree-less or partially-staged project.
  //
  // `sha256` is OMITTED here (Task 7, fix round 1) rather than run through `fakeSha256Hex` —
  // `seededSha256` derives the real hash of these exact manifest bytes on read, the same way it
  // does for every page file above.
  files.set(PAGES_MANIFEST_RELPATH, {
    bytes: new TextEncoder().encode(encodePagesManifest(manifest)),
  });
  return createFakeDesignStore({ manifest, files });
}

type _ReaderConforms = AssertConforms<DesignTreeReader, FakeDesignStore>;
type _MutationsConforms = AssertConforms<PageMutations, FakeDesignStore>;
