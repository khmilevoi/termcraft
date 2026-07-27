import { wrap } from "@reatom/core";

import type { PublishableEventV1 } from "core/mailbox";
import { PageDescriptorsAssemblyError, buildPageDescriptorsChangedPayload } from "core/project";
import type { FailureDtoV1, PageDescriptorV1 } from "core/protocol";
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
 * Reads one page's source and runs it through the Gate, mapping the result to a
 * `PageDescriptorV1`. A source-read failure is returned to the caller (on the open path it
 * blocks the whole open, matching `core/project/model/open-sequence.ts`'s own
 * `validateProjectContents`); a Gate rejection produces an `"invalid"` descriptor for just that
 * page, never a failure for the rest.
 */
export async function buildPageDescriptors(
  context: HandlerContext,
  slugs: readonly PageSlug[],
): Promise<FailureDtoV1 | readonly PageDescriptorV1[]> {
  const descriptors: PageDescriptorV1[] = [];
  for (const pageSlug of slugs) {
    const source = await wrap(context.deps.pageReader.readSource(pageSlug));
    if ("code" in source) return source;

    const result = await wrap(
      context.deps.gateRunner.runPage({
        source: new TextDecoder().decode(source.bytes),
        slug: pageSlug,
      }),
    );

    if (result.ok && result.descriptor !== null) {
      const { meta } = result.descriptor;
      descriptors.push({
        status: "ready",
        pageSlug,
        sourceHash: source.sourceHash,
        title: meta.title,
        minSize: meta.minSize,
        theme: meta.theme,
        kitApiVersion: meta.kitApiVersion,
      });
      continue;
    }

    const firstError = result.errors[0];
    descriptors.push({
      status: "invalid",
      pageSlug,
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
  const slugs = await wrap(context.deps.pageReader.listSlugs());
  if ("code" in slugs) {
    console.warn(
      `core/kernel/handlers/page-descriptors: could not list pages for a "${reason}" descriptor announcement: ${slugs.safeMessage}`,
    );
    return [];
  }

  const descriptors = await wrap(buildPageDescriptors(context, slugs));
  if ("code" in descriptors) {
    console.warn(
      `core/kernel/handlers/page-descriptors: could not read a page source for a "${reason}" descriptor announcement: ${descriptors.safeMessage}`,
    );
    return [];
  }

  const activePageSlug = await wrap(resolveActivePageSlug(context, slugs));
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
 * open path already applies (`workspaceStateResult.state.activePageSlug ?? manifest.pages[0] ??
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
