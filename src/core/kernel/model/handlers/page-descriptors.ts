import { wrap } from "@reatom/core";

import type { PublishableEventV1 } from "core/mailbox";
import type { GateErrorV1 } from "core/ports";
import {
  PageDescriptorsAssemblyError,
  buildPageDescriptorsChangedPayload,
  readCanonicalTreeIndex,
  readPageEntrySource,
  readPageOrder,
} from "core/project";
import type { FailureDtoV1, PageDescriptorV1 } from "core/protocol";
import { DESIGN_DIRNAME } from "entities/design-tree";
import type { PageEntryV1 } from "entities/design-tree";
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

/** Where each of the whole-tree pass's errors lands once it is routed to descriptors. */
interface PassErrorRoutingV1 {
  /**
   * Errors that invalidate EVERY descriptor, because the pass is reporting about the TREE and not
   * about any page in it — see {@link routePassErrors}'s second case.
   */
  readonly treeWide: readonly GateErrorV1[];
  /** Errors that invalidate exactly the pages they name in `blockedPages`. */
  readonly byPage: ReadonlyMap<PageSlug, readonly GateErrorV1[]>;
}

/**
 * Route the whole-tree pass's errors onto descriptors. THREE cases, and the difference between the
 * last two is the whole point of this function:
 *
 * 1. `blockedPages` names pages — invalidate exactly those. A shared module's fault is a fault for
 *    every page reaching it and for no other.
 *
 * 2. No `blockedPages` and NO `file` — invalidate EVERY descriptor. A pass error with no file is
 *    not a statement about a page at all; it is a statement about the run. The case that makes
 *    this load-bearing is `gate/model/type-check.ts`'s crash path: a crashed or unavailable
 *    compiler yields exactly ONE fatal `TYPE_CHECK_UNAVAILABLE` for the WHOLE tree, deliberately
 *    carrying no `file` so it is never mis-attributed to one page. Any global/config diagnostic
 *    the compiler cannot place in a tree file lands here too.
 *
 *    TREATING THIS LIKE CASE 3 IS A FAIL-OPEN, and it was the shape of this code for one review
 *    round: a file-less crash error is structurally indistinguishable from "no closure reaches
 *    this" under a test that only asks whether `blockedPages` is empty, so every page in the
 *    project published `"ready"` while the type check had not run at all. That is precisely the
 *    failure this whole task exists to prevent — "type errors silently stop reaching descriptors,
 *    a fail-open dressed as a refactor" — reintroduced one layer further down. The compiler not
 *    running is never evidence that the tree is clean.
 *
 * 3. No `blockedPages` but a real `file` — the orphan-module case: a genuine diagnostic in a file
 *    no page's closure reaches. It invalidates nothing, because there is no descriptor it could
 *    honestly belong to, and it is LOGGED rather than dropped (errore: never swallow an error
 *    without leaving a trace). This is not a defect in the pass; the `dead-module` warning that
 *    will explain why nothing reaches that file is a later task's job.
 */
function routePassErrors(errors: readonly GateErrorV1[]): PassErrorRoutingV1 {
  const treeWide: GateErrorV1[] = [];
  const byPage = new Map<PageSlug, GateErrorV1[]>();
  for (const error of errors) {
    const blocked = error.blockedPages ?? [];
    if (blocked.length > 0) {
      for (const slug of blocked) {
        const existing = byPage.get(slug);
        if (existing === undefined) {
          byPage.set(slug, [error]);
          continue;
        }
        existing.push(error);
      }
      continue;
    }
    if (error.file === undefined) {
      treeWide.push(error);
      continue;
    }
    console.warn(
      `core/kernel/handlers/page-descriptors: the whole-tree pass reported [${error.kind}/${error.code}] at "${error.file}" that no page's closure reaches, so it invalidates no descriptor: ${error.message}`,
    );
  }
  return { treeWide, byPage };
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
 * A page is `"invalid"` if ANY of three things holds: its own `runPage` reported a fatal, the pass
 * reported one naming it in `blockedPages`, or the pass reported a TREE-WIDE fatal — one carrying
 * no file at all, such as a crashed compiler. See {@link routePassErrors} for why that third case
 * cannot be folded into "names no page". Errors are ordered most-specific first — the page's own,
 * then the ones attributed to it, then the tree-wide ones — so a broken page contract still leads,
 * which is what keeps this change invisible to every page that has its own defect.
 *
 * THE TREE READ AND THE PASS BOTH COME FROM `readCanonicalTreeIndex` (design-tree phase 2 Task 5),
 * which replaced this file's own `readTreeInventory`/`readTreeSources` pair and its ad-hoc
 * `runTree` call. The index is the one place a tree read produces an inventory, a `treeRevision`
 * and a per-page `closureHash` together, so the descriptor path and the preview/export paths can
 * no longer derive different answers about the same tree.
 */
export async function buildPageDescriptors(
  context: HandlerContext,
  pages: readonly PageEntryV1[],
): Promise<FailureDtoV1 | readonly PageDescriptorV1[]> {
  // Read ONCE for the whole publish, like the manifest list threaded in above: the inventory the
  // Gate's smoke stage hash-verifies each page's closure against (design §9.2), the text the
  // whole-tree pass scans and type-checks, and that pass's own verdict.
  const index = await wrap(readCanonicalTreeIndex(context.deps));
  if ("code" in index) return index;
  const treeRoot = designTreeRoot(context.deps.projectStore.root);

  const routed = routePassErrors(index.errors);
  // The pass judged `index.pages` — its own read of `design/pages.json` — while this loop
  // publishes a descriptor per entry of the caller's `pages`, which the caller also uses to pick
  // the announcement's `activePageSlug`. Both lists come from `readPageOrder` over the same
  // reader inside one publish, so they agree; a slug the pass never saw would nonetheless get no
  // `blockedPages` attribution, which is a fail-open (a page published `"ready"` that the type
  // check never covered). Checked rather than assumed — see the loop's own `unjudged` branch.
  const judged = new Set(index.pages.map((entry) => entry.slug));
  if (routed.treeWide.length > 0 && pages.length === 0) {
    // No descriptor exists to carry them, so they would otherwise vanish here. The manifest naming
    // no page is the only way to reach this, and it is still worth a trace: "the compiler crashed"
    // is a fact about the run, not about how many pages the project happens to have.
    console.warn(
      `core/kernel/handlers/page-descriptors: the whole-tree pass reported ${routed.treeWide.length} tree-wide fatal(s) but the manifest lists no page to attribute them to: ${routed.treeWide.map((error) => `[${error.kind}/${error.code}] ${error.message}`).join("; ")}`,
    );
  }

  const descriptors: PageDescriptorV1[] = [];
  for (const entry of pages) {
    // The already-read manifest list is threaded through, so this loop reads
    // `design/pages.json` ONCE for every page rather than once per page.
    //
    // KNOWN, OWNED COST: this re-reads the entry file the index above already read, so a publish
    // does `tree + pages` reads rather than `tree`. Kept deliberately — `readPageEntrySource` is
    // what owns "the manifest binds this slug to this file, and here is its hash", and
    // reproducing that lookup off `index.files` here would be a second reading of the same
    // binding for the sake of one file read.
    const source = await wrap(readPageEntrySource(context.deps.designReader, entry.slug, pages));
    if ("code" in source) return source;

    const result = await wrap(
      context.deps.gateRunner.runPage({
        source: new TextDecoder().decode(source.bytes),
        slug: entry.slug,
        treeRoot,
        expectedFiles: index.inventory.files,
        entryRelPath: source.relPath,
      }),
    );

    // DEFENSIVE, AND NOT COSMETIC: a slug the whole-tree pass never judged has no `blockedPages`
    // entry that could ever name it, so folding only `routed` would publish it `"ready"` on the
    // strength of a type check that never covered it. Only a manifest rewritten between the
    // caller's own `readPageOrder` and the index's can reach this; it is reported as the page's
    // own fatal rather than trusted.
    const unjudged: readonly GateErrorV1[] = judged.has(entry.slug)
      ? []
      : [
          {
            kind: "manifest",
            code: "PAGE_NOT_JUDGED",
            message: `the design tree changed while descriptors were being read: the whole-tree pass never judged "${entry.slug}"`,
          },
        ];
    const errors = [
      ...result.errors,
      ...unjudged,
      ...(routed.byPage.get(entry.slug) ?? []),
      ...routed.treeWide,
    ];
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
