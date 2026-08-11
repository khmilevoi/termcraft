import { SyntaxStyle } from "@opentui/core";
import type { StyleDefinitionInput } from "@opentui/core";
import * as errore from "errore";

import { log } from "infrastructure/debug-log";

import type { TokenMap } from "../types";
import { computed } from "./reatom";
import { themeTokensAtom } from "./tokens";

/**
 * The native render library could not allocate a syntax style. Every consumer degrades to
 * plain text on it (plan P8 D3) — `syntaxStyle` is a REQUIRED prop on OpenTUI's `CodeOptions`
 * and `MarkdownOptions`, so there is no "render `<code>` without a style" branch to take.
 */
export class SyntaxStyleUnavailableError extends errore.createTaggedError({
  name: "SyntaxStyleUnavailableError",
  message: "the terminal render library could not allocate a syntax style",
}) {}

/**
 * THE ROLES → SYNTAX-SCOPES MAPPING, AND THE DESIGN GAP IT ANSWERS (plan P8, Decision D1).
 *
 * FLAGGED, NOT INVENTED. termcraft's design system covers no code display: `design/`'s
 * `termcraft-engine.js` carries fifteen palette keys and a cell model of
 * `{ch, fg, bg, bold, blink}`, has no draw method for source text, diffs or fenced blocks, and
 * none of the 27 `design/*.dc.html` screens shows code. There is therefore NO per-scope design
 * source to copy, and this table does not pretend there is one. It is the closest faithful
 * reading of the design's own vocabulary, and it is what a future design pass overrides.
 *
 * THE PRINCIPLE, instead of a borrowed editor theme. The design's language is warm amber
 * emphasis over a neutral ramp, with green reserved for healthy/complete (`● live`,
 * `✓ read current design`) and red for failure (`✗ codex not found`). Painting strings green —
 * the reflex from every mainstream editor theme — would import a foreign convention AND
 * contradict the design's own semantics. So the mapping uses the neutral ramp
 * (`foreground` → `foregroundMuted` → `foregroundFaint`) and the accent family
 * (`accent` → `accentHi` → `accentDim`) along the design's existing three-step emphasis
 * hierarchy, and touches a status hue exactly once: `markup.list.checked` → `success`, where
 * the design's own green `✓` already means "done".
 *
 * DIVERGENCE, STATED RATHER THAN SILENTLY SUBSTITUTED: `markup.italic` is not italic. The
 * design's cell model has `bold` and `blink` and no italic, so italic is outside its
 * vocabulary; the faithful reading of "lighter emphasis" is the design's own secondary tier,
 * `foregroundMuted`.
 *
 * WHY THE DOTTED `markup.*` SCOPES ARE REGISTERED EXPLICITLY, and why this list is longer than
 * a base-scope list would be. `SyntaxStyle.getStyleId`/`getStyle` fall back with
 * `name.split(".")[0]` — the FIRST segment, not one level up. `markup.heading.1` therefore
 * resolves to `markup`, never to `markup.heading`. Registering only base scopes would render
 * every markdown heading as plain body text. (The design spec's wording — "strips one dot level
 * only" — describes the intent, not the shipped behaviour; the behaviour is what this follows.)
 *
 * `spell`, `nospell` and `none` are deliberately absent: tree-sitter applies them to whole
 * prose runs, so registering them would repaint entire paragraphs. Unregistered, they fall
 * through to `default`, which is the intent.
 */
export function syntaxScopeStyles(tokens: TokenMap): Record<string, StyleDefinitionInput> {
  const heading: StyleDefinitionInput = { fg: tokens.accent, bold: true };
  const literal: StyleDefinitionInput = { fg: tokens.accentDim };
  const secondary: StyleDefinitionInput = { fg: tokens.foregroundMuted };
  const aside: StyleDefinitionInput = { fg: tokens.foregroundFaint };
  const emphasised: StyleDefinitionInput = { fg: tokens.accentHi };
  const content: StyleDefinitionInput = { fg: tokens.foreground };

  return {
    // The fallback every unmatched span resolves through.
    default: content,

    // Content tier.
    variable: content,
    property: content,
    embedded: content,

    // Emphasis tier.
    keyword: { fg: tokens.accent },
    function: emphasised,
    constructor: emphasised,
    type: emphasised,

    // Literals — accent family, deliberately not the point. Never `success`.
    string: literal,
    number: literal,
    boolean: literal,
    constant: literal,
    character: literal,

    // Secondary tier: grammar and metadata.
    operator: secondary,
    label: secondary,
    module: secondary,
    attribute: secondary,

    // De-emphasis endpoint: structural chrome and asides.
    punctuation: aside,
    comment: aside,
    conceal: aside,

    // Markdown. The dotted entries are mandatory — see this function's doc comment.
    markup: content,
    "markup.heading": heading,
    "markup.heading.1": heading,
    "markup.heading.2": heading,
    "markup.heading.3": heading,
    "markup.heading.4": heading,
    "markup.heading.5": heading,
    "markup.heading.6": heading,
    "markup.strong": { fg: tokens.foreground, bold: true },
    "markup.italic": secondary,
    "markup.strikethrough": aside,
    "markup.raw": literal,
    "markup.raw.block": literal,
    "markup.link": { fg: tokens.accent },
    "markup.link.label": { fg: tokens.accent },
    "markup.link.url": secondary,
    "markup.quote": secondary,
    "markup.list": secondary,
    "markup.list.unchecked": secondary,
    "markup.list.checked": { fg: tokens.success },
  };
}

/**
 * Build one native `SyntaxStyle` from a theme's token map.
 *
 * `SyntaxStyle.create()` reaches the native render library through `resolveRenderLib()`, which
 * is an uncontrolled boundary — so it is wrapped once, HERE, with `errore.try`, and the failure
 * travels as a value (plan P8 D3). Nothing above this line ever throws.
 */
export function buildSyntaxStyle(tokens: TokenMap): SyntaxStyleUnavailableError | SyntaxStyle {
  return errore.try({
    try: () => SyntaxStyle.fromStyles(syntaxScopeStyles(tokens)),
    catch: (cause) => new SyntaxStyleUnavailableError({ cause }),
  });
}

/**
 * The active theme's syntax style, memoised by Reatom.
 *
 * A `computed` rather than a hand-rolled `Map` keyed on the token object: Reatom already owns
 * exactly this memo, and it invalidates on precisely the right input (`themeTokensAtom`).
 *
 * ACCEPTED, STATED LEAK: a superseded `SyntaxStyle` is not `destroy()`ed. Stage 1 seeds the
 * theme once per mount and ships no switcher (spec §4.2), so a process holds at most two.
 * THE TRIGGER TO REVISIT: a shell-side theme switcher, at which point this needs a disconnect
 * hook that destroys the previous handle.
 */
export const syntaxStyleAtom = computed<SyntaxStyleUnavailableError | SyntaxStyle>(
  () => buildSyntaxStyle(themeTokensAtom()),
  "runtime.syntaxStyle",
);

/**
 * A catalog component's read of the active syntax style — the same current-value (untracked)
 * shape `activeTokens()` uses, for the same stage-1 reason recorded there.
 *
 * INTERNAL, and not on the `@termcraft/runtime` facade (plan P8 D10): a `SyntaxStyle` is a
 * native handle, and handing one to an authored page is the renderer-internal access the
 * wrapper layer exists to prevent. Plan P9's `Diff` consumes it the same way this module's
 * siblings consume `activeTokens()` — `import { activeSyntaxStyle } from "../model/syntax-style"`.
 */
export function activeSyntaxStyle(): SyntaxStyleUnavailableError | SyntaxStyle {
  const style = syntaxStyleAtom();
  if (style instanceof Error) {
    log.warn(
      "runtime/syntax-style: no syntax style could be allocated; code and markdown render as " +
        "plain text:",
      style.message,
    );
  }
  return style;
}
