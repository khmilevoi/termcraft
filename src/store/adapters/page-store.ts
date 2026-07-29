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
// CORRECTED RATIONALE (plan Task 7, fix round 1 — review caught the original comment here
// stating a false reason): `PageReader`'s old `readSource(pageSlug)`/`listSlugs()` pair is
// gone from `core/ports`, replaced by `DesignTreeReader`'s `readTreeFile(relPath)`/
// `listTree()`/`readManifest()`. Removing this file's OWN `readSource`/`listSlugs` methods
// and replacing them with `DesignTreeReader`'s three was NEVER required to keep anything
// LOADING — the retired `PageReader`/`PageSourceV1` names were only ever imported here
// `import type`, which Bun erases before running anything; an unresolved type-only import is
// a `tsc`-only concern, never a runtime `SyntaxError`. (The genuine load-crash risk this
// plan's dispatch warns about was a VALUE import — `createFakePageStore` in this file's own
// test, and in 16 unrelated production test files — which `core/ports/fakes/
// legacy-page-store.ts` fixes independently of anything below.)
//
// The real reason `readTreeFile`/`listTree`/`readManifest` exist on this adapter at all: the
// bottom-of-file `AssertConforms<DesignTreeReader & PageMutations, ...>` check — the same
// compile-time convention every adapter in this ring follows (`core/ports/index.ts`'s own
// doc) — needs a real implementation of every `DesignTreeReader` member to typecheck.
// `store/model/factory.ts`'s `DesignTreeStore` (Task 9's job) does not exist yet, so these
// three each return an honest "not wired yet" failure rather than a fabricated tree read.
//
// MEASURED REGRESSION, FIXED (fix round 1): the first version of this file DELETED
// `readSource`/`listSlugs` outright instead of adding the new three alongside them. That
// broke a REAL runtime caller: `entrypoint/model/create-shell.ts` wires this SAME adapter
// instance into BOTH `KernelDeps.pageReader` AND `.pageMutations`, and `core/kernel/model/
// handlers/{page-descriptors,page-pin,preview-export}.ts` (all untouched by this plan until
// Tasks 13/14) call `.readSource(...)`/`.listSlugs()` on it directly — a real, observed
// `smoke.test.ts` failure ("`deps.pageReader.listSlugs is not a function`"). Confirmed by
// reverting and re-running: restoring `readSource`/`listSlugs` (delegating to `open.pages`,
// unchanged from before this task) makes that exact error disappear; the one `smoke.test.ts`
// case that still fails afterward ("a host that crash-loops on a LIVE session...") was
// ALREADY in `red-baseline-after-task-6.txt` before this task touched anything, and still
// fails for its OWN pre-existing, already-tracked reason (`store/model/factory.ts`'s
// `listSlugs()` returns `read.pages`, a field Task 5 already removed from `ProjectManifest`
// — Task 9's debt, not this task's). So both method sets are kept: `readSource`/`listSlugs`
// for the real, still-relied-upon callers above; `readTreeFile`/`listTree`/`readManifest`
// for `AssertConforms` and for whichever task migrates those callers onto `DesignTreeReader`
// for real. `PageMutations`'s three methods are UNCHANGED below — they already call
// `open.pages`/`open.manifest`/`open.transactions` methods whose own signatures Task 7 does
// not touch, and already surface Task 9's `DesignTreeStoreNotWiredError` at runtime via the
// existing `open.transactions.*` calls (Task 6's placeholder).
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

/** The retired `PageReader`'s own page-source shape (`core/ports/page-store.ts`, before Task 7 deleted it) — kept locally, verbatim, for `readSource` below; never re-exported as a real port. */
interface LegacyPageSourceV1 {
  readonly bytes: Uint8Array;
  readonly sourceHash: Sha256Hex;
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

// No explicit return-type annotation (unlike every other adapter's `createXAdapter`): this
// one genuinely returns MORE than `DesignTreeReader & PageMutations` (see this file's header,
// "MEASURED REGRESSION, FIXED") — `readSource`/`listSlugs` are real, extra members a
// still-untouched caller depends on. Annotating the declared type here would trigger an
// excess-property error on the object literal below; the bottom-of-file `AssertConforms`
// check still proves the REQUIRED port shape is present, which is the actual guarantee that
// matters.
export function createPageStoreAdapter(deps: StoreAdapterDeps) {
  const { open } = deps;

  async function readSource(pageSlug: PageSlug): Promise<FailureDtoV1 | LegacyPageSourceV1> {
    const result = await open.pages.readSource(pageSlug);
    if (result instanceof Error) return toFailureDto(result);
    return result;
  }

  async function listSlugs(): Promise<FailureDtoV1 | readonly PageSlug[]> {
    const result = await open.pages.listSlugs();
    if (result instanceof Error) return toFailureDto(result);
    return result;
  }

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

  return {
    readSource,
    listSlugs,
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
  ReturnType<typeof createPageStoreAdapter>
>;
