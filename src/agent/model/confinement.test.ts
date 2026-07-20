import { expect, test } from "bun:test"
import path from "node:path"
import { makeConfinementPolicy } from "./confinement"

const staging = path.resolve("C:\\state\\turns\\019a\\workspace")
const policy = makeConfinementPolicy(staging)

test("allows a Write inside staging (Spike H case 1)", () => {
  const r = policy("Write", { file_path: path.join(staging, "pages", "main.tsx"), content: "x" })
  expect(r.behavior).toBe("allow")
})

test("denies a Write to an absolute path outside staging (Spike H case 2)", () => {
  const r = policy("Write", { file_path: "C:\\Users\\Khmil\\ok.txt", content: "x" })
  expect(r.behavior).toBe("deny")
})

test("denies a ../ relative escape (Spike H case 3)", () => {
  const r = policy("Write", { file_path: path.join(staging, "..", "escape.txt"), content: "x" })
  expect(r.behavior).toBe("deny")
})

test("denies Bash outright (Spike H case 4)", () => {
  const r = policy("Bash", { command: "echo BASHPROBE > bash-probe.txt" })
  expect(r.behavior).toBe("deny")
})

test("denies WebFetch outright (Spike H case 5)", () => {
  const r = policy("WebFetch", { url: "https://example.com" })
  expect(r.behavior).toBe("deny")
})

test("denies an unknown tool by default", () => {
  const r = policy("SomeFutureTool", { anything: true })
  expect(r.behavior).toBe("deny")
})

test("allows a Grep with an explicit path only when that path stays inside staging", () => {
  const inside = policy("Grep", { pattern: "gauge", path: path.join(staging, "pages") })
  expect(inside.behavior).toBe("allow")
  const outside = policy("Grep", { pattern: "gauge", path: "C:\\Windows" })
  expect(outside.behavior).toBe("deny")
})

test("[13] denies a file-tool call that carries no resolvable path field at all", () => {
  const r = policy("Read", {})
  expect(r.behavior).toBe("deny")
})

test("[7] blockedPath wins over an innocuous input.file_path — the SDK's own resolved-target signal", () => {
  const r = policy(
    "Write",
    { file_path: path.join(staging, "pages", "main.tsx"), content: "x" },
    "C:\\Users\\Khmil\\outside.txt",
  )
  expect(r.behavior).toBe("deny")
})
