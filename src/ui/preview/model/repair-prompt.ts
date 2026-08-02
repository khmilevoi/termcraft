/**
 * The message `F6` writes into the composer when the preview host has stopped — the text the
 * user reads and sends. NOT sent on their behalf: `intent.ts`'s `compose-repair` effect fills
 * the composer and moves focus there, and the design says so on the frame itself
 * (`design/termcraft-engine.js`'s `wsHostCrash`: "nothing is sent — you press ⏎").
 *
 * Only ever built for a `DESIGN_RENDER_FAILED` circuit-open (spec §3.2.1) — the one class of
 * failure the page IS responsible for. A spawn failure or a broken pipe gets no repair offer at
 * all, because no edit to the file named below could fix either.
 *
 * It deliberately does not re-teach the runtime API. `reatom-guide.md` is already in the
 * agent's system prompt (`agent/prompt/model/runtime-docs.ts`) and covers exactly the
 * `ctx.spy is not a function` case; this message's whole job is to state the failure.
 */

import { DESIGN_DIRNAME } from "entities/design-tree";

/** The directory canonical project state lives in, under the project root (storage-identity §4). */
const PROJECT_STATE_DIRNAME = ".termcraft";

/**
 * CANONICAL page storage, PROJECT-RELATIVE. An absolute path belongs neither in a §13
 * diagnostic nor in a line the user reads in their chat, so this is the project-relative form.
 *
 * FIXED IN TASK 16 — it was registered in `red-debt.md` as "UI: the repair prompt names a path
 * that cannot exist" (task-14 review round 1, Important 3). It used to derive
 * `.termcraft/pages/<slug>/page.tsx` FROM THE SLUG, a directory the design tree retires
 * outright: canonical storage is `.termcraft/design/<entry>`, where `entry` is whatever
 * `design/pages.json` binds to the slug. The string was wrong for EVERY project on two
 * user-visible surfaces — the composer text F6 writes and `HostCrashPanel.tsx` on screen.
 *
 * Both halves of what blocked the fix are closed rather than worked around:
 *   1. `ui` now HAS the entry. `PageDescriptorV1` (`core/protocol/model/shared-dto.ts`) carries
 *      it on both variants, because a slug alone cannot name a page's file any more — see that
 *      type's own comment.
 *   2. The design was updated FIRST, then the code followed it, which is the order CLAUDE.md's
 *      "design is a source of truth" rule requires: `design/termcraft-engine.js`'s `wsHostCrash`,
 *      git-history caption, diff and restore frames all drew `.termcraft/pages/main/page.tsx`
 *      and now draw `.termcraft/design/pages/main.tsx`. That is a transposition of the same
 *      element onto the storage layout the design spec's own §3 defines — not an invented value.
 */
export function relativePageSourcePath(entryRelPath: string): string {
  return `${PROJECT_STATE_DIRNAME}/${DESIGN_DIRNAME}/${entryRelPath}`;
}

/**
 * The page's entry as read off the descriptor list, or `null` when the list does not name it.
 *
 * `null` IS A REAL ANSWER, not a defensive shrug: a page absent from `design/pages.json` has no
 * entry to name, and every surface below says "unknown" rather than printing a slug-derived
 * guess. Guessing is exactly the defect this function's callers were fixed for — a path that
 * cannot exist reads as a path that does, and the user edits nothing.
 */
export function pageEntryOf(
  descriptors: readonly { readonly pageSlug: string; readonly entry: string }[],
  pageSlug: string,
): string | null {
  return descriptors.find((descriptor) => descriptor.pageSlug === pageSlug)?.entry ?? null;
}

export interface RepairPromptInput {
  readonly pageSlug: string;
  /**
   * The page's TREE-relative entry, straight off its `PageDescriptorV1` ({@link pageEntryOf}).
   * Never derived from the slug: which file a page lives in is `design/pages.json`'s answer
   * alone. `null` when the descriptor list does not name this page — see {@link pageEntryOf}.
   */
  readonly entryRelPath: string | null;
  /** The host's own bounded error text, as the Kernel published it. Quoted verbatim. */
  readonly safeMessage: string;
  /**
   * How many host incarnations died. Always known: the only caller is the `circuit-open`
   * phase, whose mirror fold carries the count the supervisor reported. It is 4 for a budgeted
   * crash-loop and 1 for a deterministic failure that opened the circuit immediately.
   */
  readonly attempts: number;
}

export function buildRepairPrompt(input: RepairPromptInput): string {
  const incarnations = input.attempts === 1 ? "incarnation" : "incarnations";
  return [
    `The preview cannot render the "${input.pageSlug}" page.`,
    "",
    "This is a runtime error from the preview host, not a Gate rejection — the page",
    "passed every static check and then threw while rendering.",
    "",
    `  file:     ${
      input.entryRelPath === null
        ? `unknown — "${input.pageSlug}" has no entry in design/pages.json`
        : relativePageSourcePath(input.entryRelPath)
    }`,
    `  error:    ${input.safeMessage}`,
    `  attempts: ${input.attempts} host ${incarnations} failed before the preview circuit opened`,
    "",
    input.entryRelPath === null
      ? "Find this page's entry in design/pages.json and fix the render error there."
      : "Fix the render error in that file.",
    "Keep the page's behaviour and layout as they are — this is a repair, not a redesign.",
  ].join("\n");
}
