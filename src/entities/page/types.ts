declare const pageSlugBrand: unique symbol;

/**
 * A validated page slug — the page's stable identity, its directory name
 * under `.termcraft/pages/`, and its Git-history identity (master spec §3.3).
 * Obtain one only through `parsePageSlug`.
 */
export type PageSlug = string & { readonly [pageSlugBrand]: true };

/** A terminal-cell size (columns × rows). */
export interface Size {
  readonly w: number;
  readonly h: number;
}

/** The static `meta` export of a page module (master spec §5.1). */
export interface PageMeta {
  readonly kitApiVersion: number;
  readonly title: string;
  readonly minSize: Size;
  /**
   * The declared theme this page pins to (design-systems §4.6). OPTIONAL: absent means the
   * project's own `design/system/design-system.json` `defaultTheme`, which is the ordinary case.
   * Resolution to a concrete id happens exactly once, in `core/project`'s
   * `resolveActiveThemeId` — never here, and never a second time downstream.
   */
  readonly theme?: string;
}
