import type { AgentPromptContextV1 } from "core/ports";

import { ANSWER_STYLE, DESIGN_CODE_RULES, PAGE_FILE_LAYOUT, ROLE, SELF_CHECK } from "./prose";

/**
 * Renders the one part of the prompt that depends on THIS turn's own context — everything
 * else in `prose.ts` is process-wide static text. Every fact here traces to
 * `AgentPromptContextV1`'s own fixed shape (Task 1) — nothing invented.
 */
function renderContext(context: AgentPromptContextV1): string {
  const activeLine =
    context.activePageSlug === null
      ? "No page is currently active."
      : `The currently active page is "${context.activePageSlug}".`;
  const orderLine =
    context.pageOrder.length === 0
      ? "This project has no pages yet — the first one you create becomes active once " +
        "pages.json requests it."
      : `This project's pages, in portable order: ${context.pageOrder.join(", ")}.`;
  const kitApiLine = `Any page you create or rewrite must declare meta.kitApiVersion: ${context.kitApiVersion}.`;
  const pinsLines =
    context.openPins.length === 0
      ? "No pins are currently open."
      : [
          "Open pins the user placed on the currently active page — treat each as a " +
            "specific, located request:",
          ...context.openPins.map((pin) => `- (${pin.pageSlug}) ${pin.text}`),
        ].join("\n");
  return [activeLine, orderLine, kitApiLine, pinsLines].join("\n");
}

/**
 * Composes the full system prompt: the static role/rules/layout/self-check/answer-style sections
 * plus this turn's own honestly-held context.
 *
 * `SELF_CHECK` sits AFTER the layout and BEFORE the turn context deliberately: it refers to the
 * `design/` tree the layout section has just introduced, and it is an instruction about how to
 * finish, which belongs next to the answer style rather than buried among the code rules.
 */
export function buildSystemPrompt(context: AgentPromptContextV1): string {
  return [
    ROLE,
    DESIGN_CODE_RULES,
    PAGE_FILE_LAYOUT,
    SELF_CHECK,
    renderContext(context),
    ANSWER_STYLE,
  ].join("\n\n");
}
