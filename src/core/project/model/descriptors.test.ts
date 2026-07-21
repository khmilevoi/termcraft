import { describe, expect, test } from "bun:test"

import { eventPayloadV1SchemaByKind, type PageDescriptorV1, type Sha256Hex } from "core/protocol"
import { parsePageSlug, type PageSlug } from "entities/page"

import { buildPageDescriptorsChangedPayload, computePageDescriptorChanges } from "./descriptors"

function slug(value: string): PageSlug {
  const parsed = parsePageSlug(value)
  if (parsed instanceof Error) throw parsed
  return parsed
}

const HASH_A = "a".repeat(64) as Sha256Hex
const HASH_B = "b".repeat(64) as Sha256Hex

function ready(pageSlug: PageSlug, sourceHash: Sha256Hex, title = "Title"): PageDescriptorV1 {
  return {
    status: "ready",
    pageSlug,
    sourceHash,
    title,
    minSize: { w: 80, h: 24 },
    theme: "default",
    kitApiVersion: 1,
  }
}

function invalid(pageSlug: PageSlug, sourceHash: Sha256Hex): PageDescriptorV1 {
  return {
    status: "invalid",
    pageSlug,
    sourceHash,
    error: { code: "SYNTAX", safeMessage: "bad module" },
  }
}

describe("computePageDescriptorChanges", () => {
  test("reports no changes for two identical, identically ordered lists", () => {
    const before = [ready(slug("home"), HASH_A), ready(slug("about"), HASH_B)]
    const after = [ready(slug("home"), HASH_A), ready(slug("about"), HASH_B)]
    expect(computePageDescriptorChanges(before, after)).toEqual([])
  })

  test("a page present only in `after` is \"added\" with a null beforeSourceHash", () => {
    const before = [ready(slug("home"), HASH_A)]
    const after = [ready(slug("home"), HASH_A), ready(slug("about"), HASH_B)]
    const changes = computePageDescriptorChanges(before, after)
    expect(changes).toContainEqual({
      pageSlug: slug("about"),
      kind: "added",
      beforeSourceHash: null,
      afterSourceHash: HASH_B,
    })
  })

  test("a page present only in `before` is \"removed\" with a null afterSourceHash", () => {
    const before = [ready(slug("home"), HASH_A), ready(slug("about"), HASH_B)]
    const after = [ready(slug("home"), HASH_A)]
    const changes = computePageDescriptorChanges(before, after)
    expect(changes).toContainEqual({
      pageSlug: slug("about"),
      kind: "removed",
      beforeSourceHash: HASH_B,
      afterSourceHash: null,
    })
  })

  test("a changed sourceHash for the same page is \"updated\" carrying both hashes", () => {
    const before = [ready(slug("home"), HASH_A)]
    const after = [ready(slug("home"), HASH_B)]
    const changes = computePageDescriptorChanges(before, after)
    expect(changes).toEqual([
      { pageSlug: slug("home"), kind: "updated", beforeSourceHash: HASH_A, afterSourceHash: HASH_B },
    ])
  })

  test("a status flip (ready -> invalid) at the same hash is still \"updated\"", () => {
    const before = [ready(slug("home"), HASH_A)]
    const after = [invalid(slug("home"), HASH_A)]
    const changes = computePageDescriptorChanges(before, after)
    expect(changes).toEqual([
      { pageSlug: slug("home"), kind: "updated", beforeSourceHash: HASH_A, afterSourceHash: HASH_A },
    ])
  })

  test("an unchanged page that moved position is \"reordered\", not \"updated\"", () => {
    const before = [ready(slug("home"), HASH_A), ready(slug("about"), HASH_B)]
    const after = [ready(slug("about"), HASH_B), ready(slug("home"), HASH_A)]
    const changes = computePageDescriptorChanges(before, after)
    expect(changes).toHaveLength(2)
    expect(changes).toContainEqual({
      pageSlug: slug("home"),
      kind: "reordered",
      beforeSourceHash: HASH_A,
      afterSourceHash: HASH_A,
    })
    expect(changes).toContainEqual({
      pageSlug: slug("about"),
      kind: "reordered",
      beforeSourceHash: HASH_B,
      afterSourceHash: HASH_B,
    })
  })

  test("a title-only change on a ready descriptor is \"updated\" even though the hash column is equal", () => {
    // title differs but callers always recompute sourceHash alongside title in practice;
    // this proves the comparison inspects the whole descriptor, not just sourceHash.
    const before = [ready(slug("home"), HASH_A, "Old title")]
    const after = [ready(slug("home"), HASH_A, "New title")]
    const changes = computePageDescriptorChanges(before, after)
    expect(changes).toEqual([
      { pageSlug: slug("home"), kind: "updated", beforeSourceHash: HASH_A, afterSourceHash: HASH_A },
    ])
  })
})

describe("buildPageDescriptorsChangedPayload", () => {
  test("assembles a schema-valid payload with the given reason, descriptors, and activePageSlug", () => {
    const before: readonly PageDescriptorV1[] = []
    const after = [ready(slug("home"), HASH_A)]
    const payload = buildPageDescriptorsChangedPayload("project-open", before, after, slug("home"))
    if (payload instanceof Error) throw payload
    expect(payload).toEqual(eventPayloadV1SchemaByKind["page.descriptorsChanged"].parse(payload))
    expect(payload.reason).toBe("project-open")
    expect(payload.descriptors).toEqual(after)
    expect(payload.activePageSlug).toBe(slug("home"))
    expect(payload.changes).toEqual([
      { pageSlug: slug("home"), kind: "added", beforeSourceHash: null, afterSourceHash: HASH_A },
    ])
  })

  test("keeps the after list COMPLETE and in the exact given order, even with no changes", () => {
    const list = [ready(slug("b"), HASH_A), ready(slug("a"), HASH_B)]
    const payload = buildPageDescriptorsChangedPayload("external-refresh", list, list, null)
    if (payload instanceof Error) throw payload
    expect(payload.descriptors).toEqual(list)
  })

  test("rejects a descriptor list with a duplicate pageSlug rather than silently accepting it", () => {
    const dup = [ready(slug("home"), HASH_A), ready(slug("home"), HASH_B)]
    const payload = buildPageDescriptorsChangedPayload("turn-apply", [], dup, null)
    expect(payload).toBeInstanceOf(Error)
  })
})
