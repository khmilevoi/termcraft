import { describe, expect, test } from "bun:test"

import { parsePageSlug } from "../../entities/page"
import type { PageSlug } from "../../entities/page"
import { checkManifestSlice } from "./manifest"

/** Test helper: a known-good slug, or throw (fixtures must use valid slugs deliberately). */
function slug(raw: string): PageSlug {
  const parsed = parsePageSlug(raw)
  if (parsed instanceof Error) throw new Error(`fixture slug invalid: ${raw}`)
  return parsed
}

function codes(text: string, present: PageSlug[]): string[] {
  return checkManifestSlice({ manifestText: text, presentSlugs: present }).errors.map((e) => e.code)
}

describe("checkManifestSlice", () => {
  test("accepts a well-formed manifest that permutes the staged pages", () => {
    const present = [slug("home"), slug("settings")]
    const result = checkManifestSlice({
      manifestText: JSON.stringify({ pages: ["settings", "home"], active: "home" }),
      presentSlugs: present,
    })
    expect(result.errors).toEqual([])
    expect(result.slice).not.toBeNull()
    expect(result.slice?.pages).toEqual([slug("settings"), slug("home")])
    expect(result.slice?.active).toBe(slug("home"))
  })

  test("accepts an absent active slug (null)", () => {
    const result = checkManifestSlice({
      manifestText: JSON.stringify({ pages: ["home"] }),
      presentSlugs: [slug("home")],
    })
    expect(result.errors).toEqual([])
    expect(result.slice?.active).toBeNull()
  })

  test("rejects invalid JSON", () => {
    expect(codes("{ not json", [slug("home")])).toContain("MANIFEST_PARSE")
  })

  test("rejects a non-object top level", () => {
    expect(codes("[]", [slug("home")])).toContain("MANIFEST_SHAPE")
  })

  test("rejects a non-array pages field", () => {
    expect(codes(JSON.stringify({ pages: "home" }), [slug("home")])).toContain("MANIFEST_SHAPE")
  })

  test("rejects a slug that fails the mask", () => {
    expect(codes(JSON.stringify({ pages: ["Home"] }), [])).toContain("MANIFEST_INVALID_SLUG")
  })

  test("rejects a duplicate slug", () => {
    expect(codes(JSON.stringify({ pages: ["home", "home"] }), [slug("home")])).toContain("MANIFEST_DUPLICATE_SLUG")
  })

  test("rejects a manifest entry with no staged page", () => {
    expect(codes(JSON.stringify({ pages: ["home", "ghost"] }), [slug("home")])).toContain("MANIFEST_UNKNOWN_PAGE")
  })

  test("rejects a staged page absent from the manifest", () => {
    expect(codes(JSON.stringify({ pages: ["home"] }), [slug("home"), slug("orphan")])).toContain("MANIFEST_MISSING_PAGE")
  })

  test("rejects an active page not in the list", () => {
    expect(codes(JSON.stringify({ pages: ["home"], active: "settings" }), [slug("home")])).toContain("MANIFEST_ACTIVE_NOT_LISTED")
  })

  test("rejects a non-string active field", () => {
    expect(codes(JSON.stringify({ pages: ["home"], active: 7 }), [slug("home")])).toContain("MANIFEST_SHAPE")
  })
})
