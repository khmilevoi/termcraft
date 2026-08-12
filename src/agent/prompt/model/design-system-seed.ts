/**
 * The design-system code-migration message (design-systems §9). THE DELIVERABLE IS THIS MESSAGE,
 * NOT A CODEMOD: the rewrite needs judgment at every site (which component gets the `const t`, what
 * a shared component's prop type becomes), and a codemod that got one of those wrong would leave a
 * project that compiles and renders the wrong colours.
 *
 * IT IS NEVER RUN AUTOMATICALLY (§9, §12). It is placed in the composer as a draft; the user reads
 * it and presses ⏎. Two reasons, both stated in the spec: the mechanical migration's confirmation
 * dialog covered file changes, not the user's agent budget; and after the mechanical migration
 * commits, every existing page fails the Gate on the `Color` type change (the accepted red window),
 * so an auto-started turn would spend tokens inside a window whose diagnostics the user has not yet
 * seen.
 *
 * ASSERTED BY SUBSTRING, NOT BYTE-FOR-BYTE (§11): "the migration prompt is a reviewed artifact, not
 * a deterministic test — an agent turn's output is not asserted byte-for-byte."
 */
export function designSystemMigrationSeed(input: { readonly pageCount: number }): string {
  const pages = input.pageCount === 1 ? "1 page" : `${input.pageCount} pages`;
  return [
    `This project just gained its own design system at design/system/. Colour props no longer take`,
    `token NAMES — they take concrete values read off the project's own tokens. Rewrite ${pages} to`,
    `match. Change nothing about how anything looks: same hues, same layout, same ids.`,
    ``,
    `1. In every component that sets a colour prop, add \`const t = useTokens()\` as the first line`,
    `   of the component body and \`import { useTokens } from "<relative path>/system/tokens"\` at`,
    `   the top of the file. Then rewrite every \`color="accent"\` as \`color={t.accent}\` — same for`,
    `   \`background\`, \`borderColor\`, \`titleColor\`, and any other colour prop.`,
    `   Read useTokens() INSIDE the component, never at module scope: at module scope it captures`,
    `   one theme's values forever.`,
    `2. If any component is shared between pages and lives at the tree root (for example`,
    `   design/components/), move it into design/system/components/ and declare it in`,
    `   design/system/design-system.json's \`components\` array as`,
    `   { "name": "...", "module": "components/....tsx", "export": "..." }.`,
    `3. Fix every import path that the move changed.`,
    `4. Any component prop typed \`keyof ThemeTokens\` becomes \`Color\` (imported from`,
    `   "@termcraft/runtime").`,
    `5. meta.theme is now optional and defaults to the design system's defaultTheme. Drop it from`,
    `   any page that does not deliberately pin a theme; keep it only where it names a theme`,
    `   design-system.json actually declares.`,
    ``,
    `Do not add tokens, do not rename tokens, and do not change any hue.`,
  ].join("\n");
}
