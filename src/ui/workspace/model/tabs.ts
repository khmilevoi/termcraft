import type { PageDescriptorV1 } from "core/protocol";

/**
 * Tab-strip derivation (design `drawTabs`, `design/18-tab-management.dc.html`). Pages are
 * agent-created only; the strip renders the ordered page descriptors and marks the active
 * one. Pure — the tab-strip component paints what this returns.
 */
export interface TabEntry {
  readonly pageSlug: string;
  /** Display name: a ready page's title, else its slug (invalid pages fall back to the slug). */
  readonly title: string;
  readonly active: boolean;
  /** A still-generating first page not yet real (design ghost flag → rendered faint). */
  readonly ghost: boolean;
  readonly invalid: boolean;
}

/**
 * Builds the ordered tab entries from the page descriptors, the active slug, and an optional
 * ghost slug (a page being generated for the first time). Descriptor order is authoritative.
 */
export function deriveTabs(
  descriptors: readonly PageDescriptorV1[],
  activePageSlug: string | null,
  ghostSlug?: string | null,
): readonly TabEntry[] {
  return descriptors.map((descriptor) => ({
    pageSlug: descriptor.pageSlug,
    title: descriptor.status === "ready" ? descriptor.title : descriptor.pageSlug,
    active: descriptor.pageSlug === activePageSlug,
    ghost: descriptor.pageSlug === ghostSlug,
    invalid: descriptor.status === "invalid",
  }));
}

/** Approximate rendered width of one tab (design `drawTabs`: `▸ name` +4 active, `name` +3 inactive). */
export function tabWidth(entry: TabEntry): number {
  return entry.title.length + (entry.active ? 4 : 3);
}

/**
 * Whether the strip overflows the available width and needs the `‹ ›` scroll indicators
 * (design `o.scroll`). A best-effort estimate over `tabWidth`; the real renderer clips.
 */
export function tabsOverflow(tabs: readonly TabEntry[], width: number): boolean {
  const total = tabs.reduce((sum, tab) => sum + tabWidth(tab), 0);
  return total > width;
}
