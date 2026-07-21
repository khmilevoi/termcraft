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
  readonly theme: string;
}
