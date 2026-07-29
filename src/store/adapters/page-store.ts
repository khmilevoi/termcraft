import type { AssertConforms, DesignTreeFileV1, DesignTreeReader, PageMutations } from "core/ports";
import type { FailureDtoV1, PageRemovePlanV1, Sha256Hex } from "core/protocol";
import type { PagesManifestV1 } from "entities/design-tree";
import { parsePageSlug } from "entities/page";
import type { PageSlug } from "entities/page";

import { toFailureDto } from "./failure";
import type { StoreAdapterDeps } from "./types";
import { nowIso } from "./types";

// `createPageStoreAdapter` — the `DesignTreeReader & PageMutations` port over
// `OpenProject.pages`/`OpenProject.transactions` (plan Task 1).
//
// NOT MECHANICALLY RENAMEABLE (plan Task 7, adjacent-file fix beyond the brief's own file
// list — mirrors Task 6's `DesignTreeStoreNotWiredError` precedent in `store/model/
// factory.ts` for the identical reason): `PageReader`'s old `readSource(pageSlug)`/
// `listSlugs()` pair is gone from `core/ports`, replaced by `DesignTreeReader`'s
// `readTreeFile(relPath)`/`listTree()`/`readManifest()`. `OpenProject.pages`
// (`store/types.ts`'s `PageStore`) exposes only the OLD `readSource`/`listSlugs` shape — it
// has no tree-relative read surface to delegate to, because that surface does not exist yet
// (`store/model/factory.ts`'s `DesignTreeStore`, Task 9's job). Rather than invent one (this
// plan's single most important rule), `readTreeFile`/`listTree`/`readManifest` below each
// return an honest "not wired yet" failure — never a fabricated tree read — so this file
// keeps COMPILING and its test file keeps LOADING (Bun aborts an entire test file on a
// missing named export; leaving the old `PageReader`/`PageSourceV1` import unresolved would
// have silently deleted this file's whole test run, masking Task 9's own already-tracked
// debt instead of leaving it visible). `PageMutations`'s three methods are UNCHANGED below —
// they already call `open.pages`/`open.manifest`/`open.transactions` methods whose own
// signatures Task 7 does not touch, and already surface Task 9's `DesignTreeStoreNotWiredError`
// at runtime via the existing `open.transactions.*` calls (Task 6's placeholder) — so this
// file does strictly less new work than before, nothing invented.
// RESOLVED SIGNATURE MISMATCH (plan Task 1, `renameTitle`, "flag, don't guess"): the port
// takes `(pageSlug, title)`, but `TransactionEngine.renamePageTitle` takes the page's
// COMPLETE new source bytes (`store/types.ts:260-267`: "the meta.title edit is baked into
// the source by the caller"). This is NOT left ambiguous — the already-landed, frozen
// `core/project/model/page-mutations.ts` (`renameTitle`) calls
// `pageStore.renameTitle(pageSlug, title)` with a plain title string, so `core` has already
// committed to this exact port shape and performs no byte rewrite itself. The mechanical
// meta.title rewrite (kernel-command-contract §8.2: "Mechanically rewrite static
// `meta.title`") is therefore this adapter's job, not core's — an honest adapter-level
// composition: read the current source, rewrite the `definePage({...})` call's `title`
// field IN PLACE (same quote character, nothing else touched), and pass the resulting bytes
// to the engine. `gate`'s tokenizer is NOT imported here — that would be a new store->gate
// module dependency the plan does not authorize — this is a narrow, local text rewrite
// scoped to the `definePage({...})` argument's own balanced-brace span, not a full parse.

/** The balanced-brace span of `definePage({...})`'s object-literal argument, or `null` if the call is not found. */
function findDefinePageObjectSpan(
  source: string,
): { readonly start: number; readonly end: number } | null {
  const callIndex = source.indexOf("definePage(");
  if (callIndex === -1) return null;
  const braceStart = source.indexOf("{", callIndex);
  if (braceStart === -1) return null;
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return { start: braceStart, end: i + 1 };
    }
  }
  return null;
}

/** Matches `title: <quoted string>` — the same quote char is captured so the replacement reuses it. */
const TITLE_FIELD_PATTERN = /title\s*:\s*(['"`])((?:\\.|(?!\1)[\s\S])*)\1/;

function escapeForQuote(text: string, quote: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll(quote, `\\${quote}`);
}

/**
 * Mechanically replace `meta`'s `title` field with `newTitle`, byte-identical everywhere
 * else. Returns `null` when the page source does not contain a recognizable
 * `definePage({...title: "..."...})` shape — a page that reaches `renameTitle` should
 * already satisfy the Gate page contract, so this is a defensive "should not happen", not
 * an expected miss.
 */
function rewriteMetaTitle(source: string, newTitle: string): string | null {
  const span = findDefinePageObjectSpan(source);
  if (span === null) return null;
  const objectText = source.slice(span.start, span.end);
  const match = TITLE_FIELD_PATTERN.exec(objectText);
  if (match === null) return null;
  const quote = match[1];
  if (quote === undefined) return null;
  const replacedField = `title: ${quote}${escapeForQuote(newTitle, quote)}${quote}`;
  const replacedObject =
    objectText.slice(0, match.index) +
    replacedField +
    objectText.slice(match.index + match[0].length);
  return source.slice(0, span.start) + replacedObject + source.slice(span.end);
}

function invalidPageSourceFailure(pageSlug: PageSlug): FailureDtoV1 {
  console.warn(
    `store/adapters/page-store: page ${pageSlug} source has no rewritable meta.title — Gate should have already rejected this page`,
  );
  return {
    code: "PERSISTENCE_FAILED",
    retryable: false,
    safeMessage: `page ${pageSlug} source is not in the expected definePage({...title...}) shape`,
    details: {},
  };
}

/**
 * `PageRemovePlanV1.pageSlug` is a plain `string` on the DTO (never the branded `PageSlug`
 * `entities/page` mints) — a plan that reaches `remove()` should already carry a slug Gate
 * validated, so a `parsePageSlug` miss here is a defensive "should not happen", the same
 * shape as {@link invalidPageSourceFailure} above. This is the honest validation path: the
 * previous code cast `plan.pageSlug as PageSlug` straight past `parsePageSlug`, which this
 * codebase bans — a cast asserts a runtime fact never checked.
 */
function invalidPageSlugFailure(rawSlug: string, reason: string): FailureDtoV1 {
  console.warn(
    `store/adapters/page-store: page removal plan named an invalid pageSlug "${rawSlug}": ${reason} — Gate should have already rejected this plan`,
  );
  return {
    code: "PERSISTENCE_FAILED",
    retryable: false,
    safeMessage: "page removal plan pageSlug is not a valid page slug",
    details: {},
  };
}

/** Shared "not wired yet" refusal for every {@link DesignTreeReader} method below — see this file's header. */
function designTreeNotWiredFailure(method: string): FailureDtoV1 {
  console.warn(
    `store/adapters/page-store: ${method} cannot read the design tree yet — DesignTreeStore is not wired into this adapter (plan Task 9)`,
  );
  return {
    code: "PERSISTENCE_FAILED",
    retryable: false,
    safeMessage: `${method} is not yet implemented — the design tree is not wired into this adapter`,
    details: { method },
  };
}

export function createPageStoreAdapter(deps: StoreAdapterDeps): DesignTreeReader & PageMutations {
  const { open } = deps;

  async function readTreeFile(relPath: string): Promise<FailureDtoV1 | DesignTreeFileV1> {
    return designTreeNotWiredFailure(`readTreeFile(${relPath})`);
  }

  async function listTree(): Promise<
    | FailureDtoV1
    | readonly { readonly relPath: string; readonly sha256: Sha256Hex; readonly size: number }[]
  > {
    return designTreeNotWiredFailure("listTree()");
  }

  async function readManifest(): Promise<FailureDtoV1 | PagesManifestV1> {
    return designTreeNotWiredFailure("readManifest()");
  }

  async function renameTitle(pageSlug: PageSlug, title: string): Promise<FailureDtoV1 | undefined> {
    const current = await open.pages.readSource(pageSlug);
    if (current instanceof Error) return toFailureDto(current);

    const rewritten = rewriteMetaTitle(new TextDecoder().decode(current.bytes), title);
    if (rewritten === null) return invalidPageSourceFailure(pageSlug);

    const result = await open.transactions.renamePageTitle({
      transactionId: deps.uuidv7(),
      actionId: deps.uuidv7(),
      pageSlug,
      newBytes: new TextEncoder().encode(rewritten),
      createdAt: nowIso(deps.clock),
    });
    if (result instanceof Error) return toFailureDto(result);
    return undefined;
  }

  async function reorder(order: readonly PageSlug[]): Promise<FailureDtoV1 | undefined> {
    const manifestBefore = await open.manifest.read();
    if (manifestBefore instanceof Error) return toFailureDto(manifestBefore);

    const result = await open.transactions.reorderPages({
      transactionId: deps.uuidv7(),
      actionId: deps.uuidv7(),
      manifestBefore,
      orderedSlugs: order,
      createdAt: nowIso(deps.clock),
    });
    if (result instanceof Error) return toFailureDto(result);
    return undefined;
  }

  async function remove(plan: PageRemovePlanV1): Promise<FailureDtoV1 | undefined> {
    const pageSlug = parsePageSlug(plan.pageSlug);
    if (pageSlug instanceof Error) return invalidPageSlugFailure(plan.pageSlug, pageSlug.message);

    const manifestBefore = await open.manifest.read();
    if (manifestBefore instanceof Error) return toFailureDto(manifestBefore);

    const result = await open.transactions.removePage({
      transactionId: deps.uuidv7(),
      actionId: deps.uuidv7(),
      manifestBefore,
      pageSlug,
      createdAt: nowIso(deps.clock),
    });
    if (result instanceof Error) return toFailureDto(result);
    return undefined;
  }

  return { readTreeFile, listTree, readManifest, renameTitle, reorder, remove };
}

type _Conforms = AssertConforms<
  DesignTreeReader & PageMutations,
  ReturnType<typeof createPageStoreAdapter>
>;
