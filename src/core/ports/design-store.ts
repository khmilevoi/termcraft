import type { FailureDtoV1, PageRemovePlanV1, Sha256Hex } from "core/protocol";
import type { PagesManifestV1 } from "entities/design-tree";
import type { PageSlug } from "entities/page";

/**
 * The design-tree read/write surface `core` consumes, split the same way as `chat-store.ts`:
 * `DesignTreeReader` is plain read access over the canonical tree, `PageMutations` are the
 * three page-mutating command targets (kernel-command-contract §8.2 — `page.renameTitle`,
 * `page.reorder`, `page.removeConfirm`).
 *
 * NOTHING HERE COMPUTES A SLUG -> PATH MAPPING (multi-file design tree design §3, §7's
 * governing rule for this whole plan): a page's file is whatever `design/pages.json`'s
 * `entry` value says, so every read below is keyed by TREE-relative path or goes through
 * `readManifest()` — never by `PageSlug` alone. Renamed from `PageReader`/`page-store.ts`
 * (plan Task 7): the old `PageReader.readSource(pageSlug)`/`listSlugs()` pair assumed a
 * slug directly named a canonical page file, which the multi-file tree design retires.
 *
 * `page.removeConfirm`'s payload is `{ pageRemovePlanId }` ONLY — §7.1: "never accepts an
 * acknowledgement boolean or page identity from the UI." `remove` below therefore takes the
 * complete, already-minted `PageRemovePlanV1` (reused verbatim from `core/protocol` — it is
 * already the exact core-owned DTO, not a store type) rather than a bare `PageSlug`: the
 * page machine holds the active plan and hands it to this port only after revalidating it
 * is still current, which is what "no page identity accepted from the UI" actually protects
 * against — a stale plan, not a legitimately-sourced identity.
 *
 * All three `PageMutations` members are among the six commands blocker B3 names as
 * unreachable through `store`'s current public surface ("this blocks `chat.create`,
 * `page.renameTitle`, `page.reorder`, `page.removeConfirm`, `pin.setStatus`,
 * `model.select`"); B3's resolution — named domain methods grown onto `store`'s
 * `TransactionEngine` — is upstream work a sibling agent owns in this same slice.
 */

export interface DesignTreeFileV1 {
  readonly bytes: Uint8Array;
  readonly sha256: Sha256Hex;
}

export interface DesignTreeReader {
  /** One tree file's bytes by TREE-relative path. */
  readTreeFile(relPath: string): Promise<FailureDtoV1 | DesignTreeFileV1>;
  /** Every file of the canonical tree, as `(relPath, sha256, size)` — no bytes. */
  listTree(): Promise<
    | FailureDtoV1
    | readonly { readonly relPath: string; readonly sha256: Sha256Hex; readonly size: number }[]
  >;
  /** The decoded `design/pages.json` — the sole page-order and page-identity authority. */
  readManifest(): Promise<FailureDtoV1 | PagesManifestV1>;
}

export interface PageMutations {
  /** `page.renameTitle` (§8.2): mechanically rewrites the page's entry file's static `meta.title` through one `project-mutation` transaction. */
  renameTitle(pageSlug: PageSlug, title: string): Promise<FailureDtoV1 | undefined>;
  /** `page.reorder` (§8.2): replaces only `design/pages.json`'s page order through one transaction — the exact permutation of already-listed slugs, never a subset or an added/removed identity. */
  reorder(order: readonly PageSlug[]): Promise<FailureDtoV1 | undefined>;
  /** `page.removeConfirm` (§8.2): revalidates the complete active plan under the project-write mutex and executes its one bound `project-mutation`, rewriting `design/pages.json` and/or deleting a tree file. */
  remove(plan: PageRemovePlanV1): Promise<FailureDtoV1 | undefined>;
}
