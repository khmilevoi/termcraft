import type { PageMeta } from "../types";

/** The runtime API version this binary authors new pages against (§7.1). */
export const CURRENT_KIT_API_VERSION = 1;

/**
 * Declares a page's static metadata (§5.1). The Gate reads this call's object
 * literal from the AST without executing the page, so at authoring time this
 * only supplies types; at render time it returns the same object unchanged.
 */
export function definePage(meta: PageMeta): PageMeta {
  return meta;
}
