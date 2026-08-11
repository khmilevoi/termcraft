import { SEED_THEME_ID } from "entities/design-system";
import type { DesignSystemManifestV1 } from "entities/design-system";

/**
 * THE ONE PLACE a page's optional `meta.theme` becomes the concrete theme id everything downstream
 * requires (design-systems §4.6). `HostSessionSpec.theme` and `PageDescriptorV1.theme` are both
 * non-empty strings and stay that way — that is what makes the whole feature land with no protocol
 * change (plan P4, decision D5). Resolving in a second place is what would let the preview and the
 * tab strip disagree about which theme a page is drawn in.
 *
 * The chain, in order, each arm answering a different question:
 *  1. `metaTheme` — the page PINNED a theme. Honoured verbatim; membership is the Gate's fatal
 *     (§7), never a silent rewrite here.
 *  2. the manifest's `defaultTheme` — the ordinary case, and what §4.6 means by "absent means the
 *     manifest's defaultTheme".
 *  3. {@link SEED_THEME_ID} — a themeless page in a project with no design system. Reachable
 *     between a page losing its `theme` and the migration seeding a manifest; it is the same id the
 *     runtime's own theme atoms already default to, so a page that lands here renders against the
 *     palette the process is already holding rather than against nothing.
 */
export function resolveActiveThemeId(input: {
  readonly metaTheme?: string;
  readonly designSystem: DesignSystemManifestV1 | null;
}): string {
  if (input.metaTheme !== undefined && input.metaTheme.length > 0) return input.metaTheme;
  return input.designSystem?.defaultTheme ?? SEED_THEME_ID;
}
