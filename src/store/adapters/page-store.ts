import type { AssertConforms, PageMutations, PageReader, PageSourceV1 } from "core/ports";
import type { FailureDtoV1, PageRemovePlanV1 } from "core/protocol";
import type { PageSlug } from "entities/page";

import { toFailureDto } from "./failure";
import type { StoreAdapterDeps } from "./types";
import { nowIso } from "./types";

// `createPageStoreAdapter` — the `PageReader & PageMutations` port over `OpenProject.pages`/
// `OpenProject.transactions` (plan Task 1).
//
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

export function createPageStoreAdapter(deps: StoreAdapterDeps): PageReader & PageMutations {
  const { open } = deps;

  async function readSource(pageSlug: PageSlug): Promise<FailureDtoV1 | PageSourceV1> {
    const result = await open.pages.readSource(pageSlug);
    if (result instanceof Error) return toFailureDto(result);
    return result;
  }

  async function listSlugs(): Promise<FailureDtoV1 | readonly PageSlug[]> {
    const result = await open.pages.listSlugs();
    if (result instanceof Error) return toFailureDto(result);
    return result;
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
    const manifestBefore = await open.manifest.read();
    if (manifestBefore instanceof Error) return toFailureDto(manifestBefore);

    const result = await open.transactions.removePage({
      transactionId: deps.uuidv7(),
      actionId: deps.uuidv7(),
      manifestBefore,
      pageSlug: plan.pageSlug as PageSlug,
      createdAt: nowIso(deps.clock),
    });
    if (result instanceof Error) return toFailureDto(result);
    return undefined;
  }

  return { readSource, listSlugs, renameTitle, reorder, remove };
}

type _Conforms = AssertConforms<
  PageReader & PageMutations,
  ReturnType<typeof createPageStoreAdapter>
>;
