import type { PageSlug, Size } from "entities/page"

/**
 * The export size ladder (kernel-command-contract §7.5, §12.5, §11.4): every page's own
 * `minSize` plus the two standard export sizes. A candidate narrower or shorter than the
 * page's own `minSize` is DROPPED — that page cannot legibly render there — and an exact
 * duplicate (e.g. `minSize` already equals 120x40) is deduped, never rendered twice.
 */
export const STANDARD_EXPORT_SIZES: readonly Size[] = [
  { w: 120, h: 40 },
  { w: 160, h: 40 },
]

function sizeKey(size: Size): string {
  return `${size.w}x${size.h}`
}

function bySizeAscending(a: Size, b: Size): number {
  if (a.w !== b.w) return a.w - b.w
  return a.h - b.h
}

/** One page's own candidate render sizes: `minSize` plus the standard ladder, dropped/deduped, ordered by (w, h). */
export function computePageSizeLadder(minSize: Size): readonly Size[] {
  const candidates = [minSize, ...STANDARD_EXPORT_SIZES]
  const seen = new Set<string>()
  const kept: Size[] = []

  for (const candidate of candidates) {
    if (candidate.w < minSize.w || candidate.h < minSize.h) continue
    const key = sizeKey(candidate)
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(candidate)
  }

  return kept.sort(bySizeAscending)
}

export interface SizeLadderPageInputV1 {
  readonly pageSlug: PageSlug
  readonly manifestIndex: number
  readonly minSize: Size
}

export interface SizeLadderEntryV1 {
  readonly manifestIndex: number
  readonly pageSlug: PageSlug
  readonly size: Size
}

/** The whole project's ladder across every page, ordered by (manifestIndex, w, h) (§11.4). */
export function computeExportSizeLadder(pages: readonly SizeLadderPageInputV1[]): readonly SizeLadderEntryV1[] {
  const entries: SizeLadderEntryV1[] = []
  for (const page of pages) {
    for (const size of computePageSizeLadder(page.minSize)) {
      entries.push({ manifestIndex: page.manifestIndex, pageSlug: page.pageSlug, size })
    }
  }

  return entries.sort((a, b) => {
    if (a.manifestIndex !== b.manifestIndex) return a.manifestIndex - b.manifestIndex
    return bySizeAscending(a.size, b.size)
  })
}
