import type { AgentPromptContextV1 } from "core/ports";
import {
  CORE_TOKEN_ROLES,
  DESIGN_SYSTEM_MANIFEST_RELPATH,
  designSystemComponentRelPath,
} from "entities/design-system";
import type { DesignSystemManifestV1 } from "entities/design-system";
import { DESIGN_DIRNAME } from "entities/design-tree";

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
 * One theme's `id — label` line, marking the manifest's own `defaultTheme` — the agent must know
 * which names exist before it can write a page's `meta.theme` (design-systems §4.2: the manifest
 * is a MAP of themes from day one, never assumed to hold exactly one).
 */
function renderThemeLine(id: string, label: string, isDefault: boolean): string {
  return isDefault ? `${id} — ${label} (default)` : `${id} — ${label}`;
}

/**
 * The default theme's own tokens, `name  #value`. Core roles first, in {@link CORE_TOKEN_ROLES}'
 * own documented order (matching `createSeedManifest`'s own ordering choice), then any
 * project-specific tokens in whatever order the manifest declared them.
 */
function renderTokenLines(theme: DesignSystemManifestV1["themes"][string]): readonly string[] {
  const knownRoles = CORE_TOKEN_ROLES.filter((role) => role in theme.tokens);
  const extraNames = Object.keys(theme.tokens).filter(
    (name) => !CORE_TOKEN_ROLES.some((role) => role === name),
  );
  return [...knownRoles, ...extraNames].map((name) => `${name}  ${theme.tokens[name]}`);
}

/**
 * The declared component catalog, one `Name — import { Export } from "..."` line per entry — or
 * the honest fixed string when there are none. The import specifier is deliberately NOT a real
 * path: `<relative path>` mirrors `design-system-seed.ts`'s own `"<relative path>/system/tokens"`
 * convention, since the actual `../`-depth depends on where the importing file sits in the tree
 * and this prompt has no way to know that in advance.
 */
function renderComponentLines(manifest: DesignSystemManifestV1): readonly string[] {
  if (manifest.components.length === 0) return ["This project declares no shared components yet."];
  return manifest.components.map(
    (component) =>
      `${component.name} — import { ${component.export} } from ` +
      `"<relative path>/${designSystemComponentRelPath(component)}"`,
  );
}

/**
 * The project's own design system (design-systems §5), or nothing at all. Three facts the agent
 * cannot get anywhere else: which token names resolve and what they look like, which themes exist,
 * and which shared components this project already has so it does not roll its own.
 *
 * THE VALUES ARE INCLUDED, not just the names. The agent's job is visual, and "accent is #e6a23c"
 * is the difference between it choosing `accent` for a warm highlight and choosing it because the
 * name sounded right.
 *
 * NO SECTION AT ALL when there is no design system. An invented placeholder would teach a
 * `useTokens()` import that resolves to nothing (§7's own principle, one layer up). Returning `""`
 * here — filtered out in {@link buildSystemPrompt} before joining, never joined bare — is what
 * keeps a `null` design system from leaving a double blank line in the prompt.
 */
function renderDesignSystem(manifest: DesignSystemManifestV1 | null): string {
  if (manifest === null) return "";

  // `defaultTheme` is guaranteed to name a declared theme by the decoder's own invariant
  // (`decodeDesignSystemManifest`'s `DEFAULT_THEME_UNDECLARED` check) — a decoded manifest can
  // never reach here with a dangling `defaultTheme`.
  const defaultTheme = manifest.themes[manifest.defaultTheme]!;

  return [
    `This project's own design system, read from "${DESIGN_DIRNAME}/${DESIGN_SYSTEM_MANIFEST_RELPATH}":`,
    ``,
    `Themes:`,
    ...Object.entries(manifest.themes).map(([id, theme]) =>
      renderThemeLine(id, theme.label, id === manifest.defaultTheme),
    ),
    ``,
    `Tokens of the default theme ("${manifest.defaultTheme}"):`,
    ...renderTokenLines(defaultTheme),
    ``,
    `Declared shared components:`,
    ...renderComponentLines(manifest),
    ``,
    `Read every token with \`const t = useTokens()\` INSIDE the component that uses it, never at`,
    `module scope. Never write a raw hex literal where one of the tokens above already names the`,
    `value.`,
  ].join("\n");
}

/**
 * Composes the full system prompt: the static role/rules/layout/design-system/self-check/
 * answer-style sections plus this turn's own honestly-held context.
 *
 * `SELF_CHECK` sits AFTER the layout and BEFORE the turn context deliberately: it refers to the
 * `design/` tree the layout section has just introduced, and it is an instruction about how to
 * finish, which belongs next to the answer style rather than buried among the code rules.
 *
 * The design-system section sits BETWEEN the two: it describes the same tree the layout section
 * just introduced, and the self-check is an instruction about finishing that presumes the agent
 * has already read what this section carries. Filtered out with `.filter(Boolean)` before
 * joining — `renderDesignSystem` returns `""` for a `null` design system, and joining that bare
 * would leave a double blank line where the section would have been.
 */
export function buildSystemPrompt(context: AgentPromptContextV1): string {
  return [
    ROLE,
    DESIGN_CODE_RULES,
    PAGE_FILE_LAYOUT,
    renderDesignSystem(context.designSystem),
    SELF_CHECK,
    renderContext(context),
    ANSWER_STYLE,
  ]
    .filter((section) => section.length > 0)
    .join("\n\n");
}
