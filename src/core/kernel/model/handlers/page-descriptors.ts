import { wrap } from "@reatom/core";

import type { PublishableEventV1 } from "core/mailbox";
import type { GateErrorV1 } from "core/ports";
import {
  PageDescriptorsAssemblyError,
  buildPageDescriptorsChangedPayload,
  readPageEntrySource,
  readPageOrder,
} from "core/project";
import type { FailureDtoV1, PageDescriptorV1 } from "core/protocol";
import { DESIGN_DIRNAME } from "entities/design-tree";
import type { DesignFileEntryV1, PageEntryV1 } from "entities/design-tree";
import type { PageSlug } from "entities/page";

import type { HandlerContext } from "./types";

/**
 * The `page.descriptorsChanged` producer both the project family (on open) and the turn family
 * (after a commit) build their event through — one place that reads pages off disk, runs them
 * through the Gate, and assembles §9's payload.
 *
 * Extracted from `handlers/project.ts` (defect fix, 2026-07-26). The turn family needed the
 * identical capability and had none: `page.descriptorsChanged` was published by `project.ts`
 * ALONE, so nothing in the whole system ever announced a page a TURN created or edited, even
 * though the reason union has carried a dedicated `"turn-apply"` member since the contract was
 * written (`core/protocol/model/event-payload.ts`). See {@link publishPageDescriptorsChanged}
 * for what that cost the user.
 */

/**
 * `.termcraft` — the project-state directory name. Transcribed here, not imported: `core` may
 * not import `store`, the same reason `handlers/turn.ts` and `handlers/preview-export.ts` each
 * carry their own copy of this constant.
 */
const PROJECT_STATE_DIRNAME = ".termcraft";

/**
 * One canonical tree file's absolute path — `<projectRoot>/.termcraft/design/<treeRelPath>`.
 *
 * REPLACES `canonicalPageSourcePath(projectRoot, pageSlug)` (task 14). That helper computed
 * `.termcraft/pages/<slug>/page.tsx` FROM THE SLUG, which the multi-file design tree retires
 * outright: a page's file is whatever `design/pages.json` binds to it, and nothing else may
 * derive it. `treeRelPath` here always arrives from that manifest lookup
 * (`readPageEntrySource`), never from a slug.
 *
 * The Gate's smoke stage hands this straight to a host child that resolves it with `Bun.file`
 * from its OWN fresh scratch cwd (`host/session/model/source-mount.ts`'s `loadPage`), so a
 * tree-relative path — the fallback `gate/adapters/gate-runner.ts` applies when no path is
 * supplied — can never resolve there. Omitting it made EVERY descriptor `invalid` with
 * `cannot read source at <slug>.tsx`: the tab strip fell back to the slug, `minSize`/`theme`
 * were lost, and one host child was spawned and thrown away per page on every open and turn.
 */
export function designTreeFilePath(projectRoot: string, treeRelPath: string): string {
  return `${designTreeRoot(projectRoot)}/${treeRelPath}`;
}

/**
 * The canonical tree's own absolute root — `<projectRoot>/.termcraft/design`.
 *
 * The mount unit since task 15: `loadPage` reads a page's whole closure from a tree root plus
 * tree-relative paths, so every producer of a `HostSessionSpecV1`/`ExportRenderTaskV1`/
 * `runPage` call names the directory rather than one file. {@link designTreeFilePath} is
 * expressed in terms of it so the two conventions cannot drift apart.
 */
export function designTreeRoot(projectRoot: string): string {
  return `${projectRoot}/${PROJECT_STATE_DIRNAME}/${DESIGN_DIRNAME}`;
}

/**
 * The canonical tree's `(relPath, sha256)` inventory, read through `DesignTreeReader.listTree()`
 * — what a mount hash-verifies its closure against (design §9.2).
 *
 * `listTree()` already returns exactly these fields plus `size`; this narrows rather than
 * recomputes, so nothing here re-hashes a file the store already hashed.
 */
export async function readTreeInventory(
  designReader: HandlerContext["deps"]["designReader"],
): Promise<FailureDtoV1 | readonly DesignFileEntryV1[]> {
  const listed = await wrap(designReader.listTree());
  if ("code" in listed) return listed;
  return listed.map((file) => ({ relPath: file.relPath, sha256: file.sha256 }));
}

/**
 * The canonical tree's inventory AND every file's text, read together in ONE pass over
 * `listTree()`. Shaped after `core/export/model/snapshot.ts`'s `readWholeTree`, and for the same
 * reason: a read failure anywhere is a wholesale refusal, never a partial tree — judging a
 * design against a file set that is missing the module its pages import would produce
 * diagnostics about the reader, not about the design.
 *
 * The text is UNFILTERED, deliberately. `gate` alone decides which files are code
 * (`entities/design-tree`'s measured `isCodeFile`), and a predicate here would be a second,
 * independently derived copy of it — see `core/turns/model/validation.ts`'s `files` doc for the
 * full argument and its measurement.
 */
async function readTreeSources(designReader: HandlerContext["deps"]["designReader"]): Promise<
  | FailureDtoV1
  | {
      readonly inventory: readonly DesignFileEntryV1[];
      readonly files: ReadonlyMap<string, string>;
    }
> {
  const inventory = await readTreeInventory(designReader);
  if ("code" in inventory) return inventory;

  const decoder = new TextDecoder();
  const files = new Map<string, string>();
  for (const file of inventory) {
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
  return { inventory, files };
}

/**
 * The whole-tree pass's errors, indexed by the pages each one names in `blockedPages`.
 *
 * A pass error naming NO page invalidates nothing — there is no descriptor it could honestly
 * belong to — but it is LOGGED rather than dropped (errore: never swallow an error without
 * leaving a trace). That case is real and not a defect in the pass: a type error in a module no
 * page's closure reaches is still fatal for the tree, and the `dead-module` warning that will
 * explain why nothing reaches it is a later task's job.
 */
function indexPassErrorsByPage(
  errors: readonly GateErrorV1[],
): ReadonlyMap<PageSlug, GateErrorV1[]> {
  const bySlug = new Map<PageSlug, GateErrorV1[]>();
  for (const error of errors) {
    const blocked = error.blockedPages ?? [];
    if (blocked.length === 0) {
      console.warn(
        `core/kernel/handlers/page-descriptors: the whole-tree pass reported [${error.kind}/${error.code}] at "${error.file ?? "<no file>"}" that no page's closure reaches, so it invalidates no descriptor: ${error.message}`,
      );
      continue;
    }
    for (const slug of blocked) {
      const existing = bySlug.get(slug);
      if (existing === undefined) {
        bySlug.set(slug, [error]);
        continue;
      }
      existing.push(error);
    }
  }
  return bySlug;
}

/**
 * Runs the project's pages through the Gate and maps each result to a `PageDescriptorV1`. A
 * source-read failure is returned to the caller (on the open path it blocks the whole open,
 * matching `core/project/model/open-sequence.ts`'s own `validateProjectContents`); a Gate
 * rejection produces an `"invalid"` descriptor for just that page, never a failure for the rest.
 *
 * TWO GATE CALLS, AND THE FIRST IS NOT OPTIONAL (design-tree phase 2 Task 3). `GateRunner
 * .runTree` — the whole-tree pass — runs ONCE for the whole publish, then `runPage` once per
 * entry. The pass is where the TYPE CHECK lives now: it moved out of `runPage`, because the
 * per-file program it used to run could not see a sibling module at all (a page importing shared
 * code failed with a spurious `TS2307`, measured). A descriptor path that kept calling only
 * `runPage` would therefore publish `"ready"` for a page that does not compile — a fail-open
 * dressed as a refactor, which is precisely why this call is here and not deferred.
 *
 * A page is `"invalid"` if EITHER its own `runPage` reported a fatal or the pass reported one
 * naming it in `blockedPages`. Its own error is reported first when both exist: a broken page
 * contract is a better first thing to show than a shared module's type error, and preserving
 * that ordering is what keeps this change invisible to every page that has its own defect.
 */
export async function buildPageDescriptors(
  context: HandlerContext,
  pages: readonly PageEntryV1[],
): Promise<FailureDtoV1 | readonly PageDescriptorV1[]> {
  // Read ONCE for the whole publish, like the manifest list threaded in above: the inventory the
  // Gate's smoke stage hash-verifies each page's closure against (design §9.2), and the text the
  // whole-tree pass scans and type-checks.
  const tree = await readTreeSources(context.deps.designReader);
  if ("code" in tree) return tree;
  const treeRoot = designTreeRoot(context.deps.projectStore.root);

  const pass = await wrap(
    context.deps.gateRunner.runTree({
      files: tree.files,
      treePaths: tree.inventory.map((file) => file.relPath),
      pages,
    }),
  );
  const passErrorsByPage = indexPassErrorsByPage(pass.errors);

  const descriptors: PageDescriptorV1[] = [];
  for (const entry of pages) {
    // The already-read manifest list is threaded through, so this loop reads
    // `design/pages.json` ONCE for every page rather than once per page.
    //
    // KNOWN, OWNED COST: this re-reads the entry file `readTreeSources` above already read, so a
    // publish does `tree + pages` reads rather than `tree`. Kept deliberately — `readPageEntrySource`
    // is what owns "the manifest binds this slug to this file, and here is its hash", and
    // reproducing that lookup off the map here would be a second reading of the same binding for
    // the sake of one file read. The whole redundancy disappears when the canonical tree index
    // lands and both halves come from one read.
    const source = await wrap(readPageEntrySource(context.deps.designReader, entry.slug, pages));
    if ("code" in source) return source;

    const result = await wrap(
      context.deps.gateRunner.runPage({
        source: new TextDecoder().decode(source.bytes),
        slug: entry.slug,
        treeRoot,
        expectedFiles: tree.inventory,
        entryRelPath: source.relPath,
      }),
    );

    const errors = [...result.errors, ...(passErrorsByPage.get(entry.slug) ?? [])];
    if (errors.length === 0 && result.descriptor !== null) {
      const { meta } = result.descriptor;
      descriptors.push({
        status: "ready",
        pageSlug: entry.slug,
        entry: source.relPath,
        sourceHash: source.sourceHash,
        title: meta.title,
        minSize: meta.minSize,
        theme: meta.theme,
        kitApiVersion: meta.kitApiVersion,
      });
      continue;
    }

    const firstError = errors[0];
    descriptors.push({
      status: "invalid",
      pageSlug: entry.slug,
      entry: source.relPath,
      sourceHash: source.sourceHash,
      error:
        firstError !== undefined
          ? { code: firstError.code, safeMessage: firstError.message }
          : { code: "GATE_REJECTED", safeMessage: "page failed Gate validation" },
    });
  }
  return descriptors;
}

/**
 * Re-reads the project's pages from disk and publishes the `page.descriptorsChanged` that
 * announces them, diffed against the last list this Kernel published
 * (`HandlerContext.currentPageDescriptors`).
 *
 * WHY THIS EXISTS (defect fix, 2026-07-26). Before it, `page.descriptorsChanged` was published
 * on project open and nowhere else, so a turn's own result never reached the UI's page model:
 *
 * - `ui/mirror` sets `project.activePageSlug` from THIS event alone. On a brand-new project the
 *   open publishes an empty list with `activePageSlug: null`, so after the very first turn
 *   created a page the slug was still `null` — and `ui/app/model/deps.ts`'s preview subscriber
 *   only asks for a session once a non-null slug appears. The first generation therefore ended
 *   on "preparing preview…" forever: the app's core promise, describe a TUI and see it, did not
 *   complete.
 * - Editing the page already on screen was equally invisible: the slug does not change, the
 *   mirror's descriptor list kept the pre-turn `sourceHash`, and the live preview session went
 *   on rendering the old source. Contradicts the master design's own §"The preview updates
 *   after the recoverable turn transaction commits."
 *
 * Failures here are logged, never propagated: the turn ALREADY committed durably by the time
 * this runs, and a descriptor announcement that could not be assembled must not turn a
 * successful turn into a failed one (the same rule `handlers/project.ts` applies to its own
 * assembly failure on the open path). Returns the events to publish — possibly empty.
 */
export async function publishPageDescriptorsChanged(
  context: HandlerContext,
  reason: "turn-apply",
): Promise<readonly PublishableEventV1[]> {
  const pages = await wrap(readPageOrder(context.deps.designReader));
  if ("code" in pages) {
    console.warn(
      `core/kernel/handlers/page-descriptors: could not read design/pages.json for a "${reason}" descriptor announcement: ${pages.safeMessage}`,
    );
    return [];
  }

  const descriptors = await wrap(buildPageDescriptors(context, pages));
  if ("code" in descriptors) {
    console.warn(
      `core/kernel/handlers/page-descriptors: could not read a page source for a "${reason}" descriptor announcement: ${descriptors.safeMessage}`,
    );
    return [];
  }

  const activePageSlug = await wrap(
    resolveActivePageSlug(
      context,
      pages.map((entry) => entry.slug),
    ),
  );
  const payload = buildPageDescriptorsChangedPayload(
    reason,
    context.currentPageDescriptors(),
    descriptors,
    activePageSlug,
  );
  if (payload instanceof PageDescriptorsAssemblyError) {
    console.warn(
      `core/kernel/handlers/page-descriptors: could not assemble a "${reason}" page.descriptorsChanged: ${payload.message}`,
    );
    return [];
  }
  return [{ kind: "page.descriptorsChanged", payload }];
}

/**
 * Which page the announcement names as active: the one already active if it still exists,
 * otherwise the first in the ordered list.
 *
 * The fallback is NOT invented for this file — it is the same rule `handlers/project.ts`'s own
 * open path already applies (`workspaceStateResult.state.activePageSlug ?? pages[0]?.slug ??
 * null`), which is exactly what makes a fresh project's first generated page become the active
 * one instead of leaving the Workspace pointing at nothing.
 *
 * A workspace-state read failure is not fatal here either: it only costs the "keep the current
 * one" preference, so it falls back to the first descriptor rather than refusing to announce
 * pages that genuinely exist.
 */
async function resolveActivePageSlug(
  context: HandlerContext,
  slugs: readonly PageSlug[],
): Promise<PageSlug | null> {
  // Taken from the SLUG list, not from the descriptors: `PageDescriptorV1.pageSlug` is a plain
  // wire `string`, while this payload field is the branded `PageSlug`. `listSlugs()` already
  // returns branded values and the descriptors are built from it in order, so the two lists
  // agree element-for-element — reading the branded one avoids a cast (forbidden project-wide).
  const first = slugs[0] ?? null;
  const workspace = await wrap(context.deps.projectStore.readWorkspaceState());
  if ("code" in workspace) {
    console.warn(
      `core/kernel/handlers/page-descriptors: could not read workspace state to keep the active page — falling back to the first page: ${workspace.safeMessage}`,
    );
    return first;
  }
  const active = workspace.state.activePageSlug;
  if (active === null) return first;
  return slugs.includes(active) ? active : first;
}
