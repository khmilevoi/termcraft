import type { AssertConforms, DesignTreeFileV1, DesignTreeReader, PageMutations } from "core/ports";
import type { FailureDtoV1, PageRemovePlanV1, Sha256Hex } from "core/protocol";
import type { PagesManifestV1 } from "entities/design-tree";
import { parsePageSlug } from "entities/page";
import type { PageSlug } from "entities/page";
import { log } from "infrastructure/debug-log";

import { toFailureDto } from "./failure";
import type { StoreAdapterDeps } from "./types";
import { nowIso } from "./types";

// `createDesignStoreAdapter` — the `DesignTreeReader & PageMutations` port over
// `OpenProject.pages`/`OpenProject.transactions` (plan Task 1).
//
// `readTreeFile`/`listTree`/`readManifest` now delegate to the real `DesignTreeStore`
// (`store/model/design-tree-store.ts`'s `createDesignTreeStore`, Task 9) instead of the placeholder
// `designTreeNotWiredFailure` refusal Task 7 left here. `readSource`/`listSlugs` — the retired
// `PageReader` pair this adapter kept alive for still-untouched callers — are DELETED as of
// task 14, together with their `LegacyPageSourceV1` shape: `entrypoint/model/create-shell.ts`
// now wires this instance into `KernelDeps.designReader`, and every former caller
// (`core/kernel/model/handlers/{page-descriptors,page-pin,preview-export,selection-model,
// turn}.ts`, `core/project/model/{page-mutations,open-sequence}.ts`, `core/export/model/
// {snapshot,publish}.ts`) reads through `design/pages.json`'s own `entry` instead.
//
// NO SLUG-DERIVED path is used to READ or WRITE a design-tree file any more. Checked, not
// claimed: `grep -rn 'pages/\${' src/ --include=*.ts --include=*.tsx | grep -v '\.test\.'`
// returns exactly three sites, none of them a tree access, and each flagged in
// `.superpowers/sdd/2026-07-28-design-tree-canonical-source/task-14-report.md` §9 —
// `core/export/model/package.ts:84,186` name the EXPORT ARTIFACT's own internal layout
// (Task 16's call whether that should mirror the tree), and
// `ui/preview/model/repair-prompt.ts:27` builds a DISPLAY string for a repair prompt, which
// now names a path that need not exist. Re-run that grep before restating this.
//
// RESOLVED SIGNATURE MISMATCH (plan Task 1, `renameTitle`, "flag, don't guess"): the port
// takes `(pageSlug, title)`, but `TransactionEngine.renamePageTitle` targets an explicit
// `entryRelPath` (Task 9) rather than a slug. So `renameTitle` below reads the manifest,
// looks up `pageSlug`'s `entry`, reads THAT tree file (`open.pages.readTreeFile`, never
// `readSource` — this is the one call site that must prove the manifest lookup, not a
// slug-computed guess), rewrites `meta.title` mechanically in place (unchanged from before —
// the mechanical `definePage({...title})` rewrite is orthogonal to the tree), and passes the
// resolved `entryRelPath` through to the engine. `gate`'s tokenizer is NOT imported here —
// that would be a new store->gate module dependency the plan does not authorize — this is a
// narrow, local text rewrite scoped to the `definePage({...})` argument's own balanced-brace
// span, not a full parse.

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
  log.warn(
    `store/adapters/design-store: page ${pageSlug} source has no rewritable meta.title — Gate should have already rejected this page`,
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
  log.warn(
    `store/adapters/design-store: page removal plan named an invalid pageSlug "${rawSlug}": ${reason} — Gate should have already rejected this plan`,
  );
  return {
    code: "PERSISTENCE_FAILED",
    retryable: false,
    safeMessage: "page removal plan pageSlug is not a valid page slug",
    details: {},
  };
}

/** `renameTitle`'s manifest lookup found no `design/pages.json` entry for `pageSlug` — never a slug-computed path guess (design §3, §7). */
function pageEntryNotFoundFailure(pageSlug: PageSlug): FailureDtoV1 {
  log.warn(
    `store/adapters/design-store: renameTitle found no design/pages.json entry for "${pageSlug}"`,
  );
  return {
    code: "PERSISTENCE_FAILED",
    retryable: false,
    safeMessage: `no design-tree entry for page slug ${pageSlug}`,
    details: { pageSlug },
  };
}

// The declared return type is BACK (task 14): the deliberately-dropped annotation existed
// only so the extra `readSource`/`listSlugs` members would not trip an excess-property error.
// Both are gone with their last caller, so the adapter returns exactly the port again and the
// annotation can state it — a stronger guarantee than the bottom-of-file `AssertConforms`
// check alone, which proves the required members are PRESENT but never that no extra,
// slug-shaped reader has crept back in.
export function createDesignStoreAdapter(deps: StoreAdapterDeps): DesignTreeReader & PageMutations {
  const { open } = deps;

  async function readTreeFile(relPath: string): Promise<FailureDtoV1 | DesignTreeFileV1> {
    const result = await open.pages.readTreeFile(relPath);
    if (result instanceof Error) return toFailureDto(result);
    return result;
  }

  async function listTree(): Promise<
    | FailureDtoV1
    | readonly { readonly relPath: string; readonly sha256: Sha256Hex; readonly size: number }[]
  > {
    const result = await open.pages.listTree();
    if (result instanceof Error) return toFailureDto(result);
    return result;
  }

  async function readManifest(): Promise<FailureDtoV1 | PagesManifestV1> {
    const result = await open.pages.readManifest();
    if (result instanceof Error) return toFailureDto(result);
    return result;
  }

  async function renameTitle(pageSlug: PageSlug, title: string): Promise<FailureDtoV1 | undefined> {
    const manifest = await open.pages.readManifest();
    if (manifest instanceof Error) return toFailureDto(manifest);

    const entry = manifest.pages.find((page) => page.slug === pageSlug);
    if (entry === undefined) return pageEntryNotFoundFailure(pageSlug);

    const current = await open.pages.readTreeFile(entry.entry);
    if (current instanceof Error) return toFailureDto(current);

    const rewritten = rewriteMetaTitle(new TextDecoder().decode(current.bytes), title);
    if (rewritten === null) return invalidPageSourceFailure(pageSlug);

    const result = await open.transactions.renamePageTitle({
      transactionId: deps.uuidv7(),
      actionId: deps.uuidv7(),
      pageSlug,
      entryRelPath: entry.entry,
      // The entry file's hash AT THE MOMENT `rewritten` was computed from it — the engine
      // refuses (`EntrySourceDriftedError`) if this no longer matches by the time it
      // acquires the write permit, rather than silently overwriting a concurrent write with
      // a rewrite computed from these now-stale bytes.
      expectedSourceHash: current.sha256,
      newBytes: new TextEncoder().encode(rewritten),
      createdAt: nowIso(deps.clock),
    });
    if (result instanceof Error) return toFailureDto(result);
    return undefined;
  }

  async function reorder(order: readonly PageSlug[]): Promise<FailureDtoV1 | undefined> {
    const manifestBefore = await open.pages.readManifest();
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

    const manifestBefore = await open.pages.readManifest();
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

  return {
    readTreeFile,
    listTree,
    readManifest,
    renameTitle,
    reorder,
    remove,
  };
}

type _Conforms = AssertConforms<
  DesignTreeReader & PageMutations,
  ReturnType<typeof createDesignStoreAdapter>
>;
