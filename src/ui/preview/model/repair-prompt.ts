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

/** The directory canonical project state lives in, under the project root (storage-identity §4). */
const PROJECT_STATE_DIRNAME = ".termcraft";

/**
 * CANONICAL page storage, PROJECT-RELATIVE. An absolute path belongs neither in a §13
 * diagnostic nor in a line the user reads in their chat, so this is the project-relative form.
 *
 * KNOWN DEFECT, NOT COSMETIC — registered in `red-debt.md` as "UI: the repair prompt names a
 * path that cannot exist", raised by task-14 review round 1 (Important 3). AFTER the
 * design-tree plan, `.termcraft/pages/` DOES NOT EXIST AT ALL: canonical storage is
 * `.termcraft/design/<entry>`, where `<entry>` is whatever `design/pages.json` binds to the
 * slug and is always inside `design/`. So the string below is wrong for EVERY project, on two
 * user-visible surfaces — the composer text F6 writes ("Fix the render error in that file")
 * and `HostCrashPanel.tsx:91` on screen — and `repair-prompt.test.ts`'s
 * `relativePageSourcePath` case PINS the wrong value.
 *
 * NOT FIXED HERE, for two reasons that are about authority rather than effort:
 *   1. The real path needs the page's `entry`, which `ui` does not have: `PageDescriptorV1`
 *      (`core/protocol/model/event-payload.ts`) carries `pageSlug`/`sourceHash`/meta and no
 *      entry, so honestly naming the file means widening a wire DTO and its producer — outside
 *      task 14's Files list.
 *   2. `design/termcraft-engine.js:1153` (`wsHostCrash`) still DRAWS `·
 *      .termcraft/pages/main/page.tsx`. The design is this project's source of truth for what
 *      this frame says, and it has not been updated for the design tree. CLAUDE.md's rule for
 *      exactly this case is to flag the gap, not to guess a replacement — so the string stays
 *      wrong-but-design-matching until the design covers the new layout.
 */
export function relativePageSourcePath(pageSlug: string): string {
  return `${PROJECT_STATE_DIRNAME}/pages/${pageSlug}/page.tsx`;
}

export interface RepairPromptInput {
  readonly pageSlug: string;
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
    `  file:     ${relativePageSourcePath(input.pageSlug)}`,
    `  error:    ${input.safeMessage}`,
    `  attempts: ${input.attempts} host ${incarnations} failed before the preview circuit opened`,
    "",
    "Fix the render error in that file. Keep the page's behaviour and layout as they",
    "are — this is a repair, not a redesign.",
  ].join("\n");
}
