import { expect, test } from "bun:test"
import path from "node:path"
import { isInsideStaging } from "./path-containment"

const staging = path.resolve("C:\\state\\turns\\019a\\workspace")

test("Spike H case 1: an in-staging path is inside", () => {
  expect(isInsideStaging(path.join(staging, "pages", "main.tsx"), staging)).toBe(true)
})

// These two literal Windows drive-letter absolute paths are not built via
// `path.join(staging, ...)`, so on a POSIX host `node:path` does not
// recognize them as absolute — they'd resolve underneath `staging` instead
// of outside it, flipping the expected `false` to `true`. Real Windows drive
// paths are only meaningful on win32, so gate them the same way the source
// module's own case-folding branch does (`process.platform === "win32"`).
test.skipIf(process.platform !== "win32")("Spike H case 2: an absolute path outside staging is rejected", () => {
  expect(isInsideStaging("C:\\Users\\Khmil\\ok.txt", staging)).toBe(false)
})

test("Spike H case 3: a ../ escape is rejected", () => {
  expect(isInsideStaging(path.join(staging, "..", "escape.txt"), staging)).toBe(false)
})

// Same platform caveat as Spike H case 2 above: a literal Windows absolute
// path, not one built via `path.join(staging, ...)`, so it only resolves as
// "outside staging" on a win32 host.
test.skipIf(process.platform !== "win32")(
  "a sibling directory sharing a prefix is rejected (workspace-evil vs workspace)",
  () => {
    expect(isInsideStaging("C:\\state\\turns\\019a\\workspace-evil\\x.txt", staging)).toBe(false)
  },
)

test("the staging root itself is inside", () => {
  expect(isInsideStaging(staging, staging)).toBe(true)
})

test("Spike F: a junction/reparse point inside staging is rejected via the backstop hook", () => {
  const target = path.join(staging, "link", "x.txt")
  expect(isInsideStaging(target, staging, { hasReparsePoint: () => true })).toBe(false)
})

test("[6] hasReparsePoint returning false for every segment still allows a clean path", () => {
  const target = path.join(staging, "pages", "main.tsx")
  expect(isInsideStaging(target, staging, { hasReparsePoint: () => false })).toBe(true)
})

test("[12] the reparse backstop is consulted for every ancestor segment, not just the leaf", () => {
  const seen: string[] = []
  const link = path.join(staging, "link")
  const target = path.join(link, "x.txt")
  const result = isInsideStaging(target, staging, {
    hasReparsePoint: (p) => {
      seen.push(p)
      return false
    },
  })
  expect(result).toBe(true)
  // A leaf-only check would only ever record `target`; recording the ancestor
  // segment proves the walk actually inspected it too.
  expect(seen).toContain(link)
  expect(seen).toContain(target)
})

test("[12] a reparse point on an ancestor segment denies the leaf even though the leaf itself is a plain file", () => {
  const link = path.join(staging, "link")
  const target = path.join(link, "x.txt")
  // Only the ancestor "link" is a reparse point — the leaf "x.txt" is not.
  const result = isInsideStaging(target, staging, { hasReparsePoint: (p) => p === link })
  expect(result).toBe(false)
})

test("[33] a relative candidate resolves against the staging root, not this process's cwd", () => {
  expect(isInsideStaging("pages", staging)).toBe(true)
  expect(isInsideStaging(path.join("pages", "main.tsx"), staging)).toBe(true)
})

test("[33] a relative ../ escape is still rejected once resolved against the staging root", () => {
  expect(isInsideStaging(path.join("..", "evil.txt"), staging)).toBe(false)
})

test("Windows drive-letter case is not a containment escape", () => {
  // Only rewrites a leading "X:" drive letter (win32 paths); a no-op on POSIX
  // absolute paths, so this stays a meaningful assertion cross-platform too.
  const inStaging = path.join(staging, "pages", "main.tsx")
  const lowerDrive = inStaging.replace(/^([A-Za-z]):/, (_m, d: string) => `${d.toLowerCase()}:`)
  expect(isInsideStaging(lowerDrive, staging)).toBe(true)
})
