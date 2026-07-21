import type { FailureDtoV1, PageRemovePlanV1, Sha256Hex } from "core/protocol"
import type { PageSlug } from "entities/page"

/**
 * The page read/write surface `core` consumes, split the same way as `chat-store.ts`:
 * `PageReader` is plain read access; `PageMutations` are the three page-mutating command
 * targets (kernel-command-contract §8.2 — `page.renameTitle`, `page.reorder`,
 * `page.removeConfirm`).
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

export interface PageSourceV1 {
  readonly bytes: Uint8Array
  readonly sourceHash: Sha256Hex
}

export interface PageReader {
  readSource(pageSlug: PageSlug): Promise<FailureDtoV1 | PageSourceV1>
  /** = the manifest's `pages` array (the manifest is the sole ordering authority, storage-identity §5.1). */
  listSlugs(): Promise<FailureDtoV1 | readonly PageSlug[]>
}

export interface PageMutations {
  /** `page.renameTitle` (§8.2): "Mechanically rewrite static `meta.title` through one `project-mutation` transaction." */
  renameTitle(pageSlug: PageSlug, title: string): Promise<FailureDtoV1 | undefined>
  /** `page.reorder` (§8.2): "Replace only portable page order through one transaction." `order` is the exact permutation of already-listed slugs — never a subset or an added/removed identity. */
  reorder(order: readonly PageSlug[]): Promise<FailureDtoV1 | undefined>
  /** `page.removeConfirm` (§8.2): "Revalidate the complete active plan under the project-write mutex and execute its one bound `project-mutation`." */
  remove(plan: PageRemovePlanV1): Promise<FailureDtoV1 | undefined>
}
