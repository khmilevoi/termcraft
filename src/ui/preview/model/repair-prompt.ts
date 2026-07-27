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
 * CANONICAL page storage, PROJECT-RELATIVE. The Kernel's own `canonicalPageSourcePath`
 * (`core/kernel/model/handlers/preview-export.ts`) returns the ABSOLUTE form, which the host
 * child needs and this message must not carry: an absolute path belongs neither in a §13
 * diagnostic nor in a line the user reads in their chat. Same layout, project-relative —
 * transcribed rather than imported, because `ui` may not reach into `core`'s handler internals.
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
