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

/**
 * The slug one step from the active tab, or `null` when there is nowhere to step.
 *
 * DESIGN EXTENSION (flagged, not invented silently): §3.8's two hotkey tiers name no key for
 * moving between pages at all — the design switches tabs by mouse only. The keyboard route the
 * maintainer asked for (2026-07-27) needs SOME order semantics, and this is the narrowest one:
 * strip order (which is descriptor order, the portable `pages.json` order) with NO wrap-around.
 * Stopping at the ends keeps a held key from cycling the whole project past the page you meant,
 * and — unlike wrapping — it never re-establishes a preview session the user did not ask for.
 *
 * With no active tab (a project whose pages exist but whose active slug has not resolved yet),
 * a step enters the strip from the side the direction comes from rather than doing nothing.
 */
export function neighbourTabSlug(tabs: readonly TabEntry[], delta: -1 | 1): string | null {
  if (tabs.length === 0) return null;
  const activeIndex = tabs.findIndex((tab) => tab.active);
  if (activeIndex === -1) return (delta === 1 ? tabs[0] : tabs[tabs.length - 1])?.pageSlug ?? null;
  return tabs[activeIndex + delta]?.pageSlug ?? null;
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
