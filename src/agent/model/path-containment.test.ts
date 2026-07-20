import { expect, test } from "bun:test"
import path from "node:path"
import { isInsideStaging } from "./path-containment"

const staging = path.resolve("C:\\state\\turns\\019a\\workspace")

test("Spike H case 1: an in-staging path is inside", () => {
  expect(isInsideStaging(path.join(staging, "pages", "main.tsx"), staging)).toBe(true)
})

test("Spike H case 2: an absolute path outside staging is rejected", () => {
  expect(isInsideStaging("C:\\Users\\Khmil\\ok.txt", staging)).toBe(false)
})

test("Spike H case 3: a ../ escape is rejected", () => {
  expect(isInsideStaging(path.join(staging, "..", "escape.txt"), staging)).toBe(false)
})

test("a sibling directory sharing a prefix is rejected (workspace-evil vs workspace)", () => {
  expect(isInsideStaging("C:\\state\\turns\\019a\\workspace-evil\\x.txt", staging)).toBe(false)
})

test("the staging root itself is inside", () => {
  expect(isInsideStaging(staging, staging)).toBe(true)
})

test("Spike F: a junction/reparse point inside staging is rejected via the backstop hook", () => {
  const target = path.join(staging, "link", "x.txt")
  expect(isInsideStaging(target, staging, { hasReparsePoint: () => true })).toBe(false)
})

test("Windows drive-letter case is not a containment escape", () => {
  // Only rewrites a leading "X:" drive letter (win32 paths); a no-op on POSIX
  // absolute paths, so this stays a meaningful assertion cross-platform too.
  const inStaging = path.join(staging, "pages", "main.tsx")
  const lowerDrive = inStaging.replace(/^([A-Za-z]):/, (_m, d: string) => `${d.toLowerCase()}:`)
  expect(isInsideStaging(lowerDrive, staging)).toBe(true)
})
