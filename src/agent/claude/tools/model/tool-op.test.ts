import { expect, test } from "bun:test"
import { mapToolUse } from "./tool-op"

test("Write maps to edit with the file path as target", () => {
  expect(mapToolUse("Write", { file_path: "pages/main.tsx", content: "x" })).toEqual({
    op: "edit",
    target: "pages/main.tsx",
  })
})

test("Read maps to read", () => {
  expect(mapToolUse("Read", { file_path: "pages/main.tsx" }).op).toBe("read")
})

test("Bash maps to run with the command as target", () => {
  expect(mapToolUse("Bash", { command: "ls -la" })).toEqual({ op: "run", target: "ls -la" })
})

test("Grep maps to search with the pattern as target when no path", () => {
  expect(mapToolUse("Grep", { pattern: "gauge" })).toEqual({ op: "search", target: "gauge" })
})

test("an unknown tool maps to other with an empty target when nothing extractable", () => {
  expect(mapToolUse("Mystery", {})).toEqual({ op: "other", target: "" })
})

// Approved behavior delta (task 5): BashOutput and KillShell were absent from
// the pre-unification OP_BY_TOOL, so they fell through to "other". The
// unified vocabulary lists them alongside Bash with op: "run", closing that
// gap intentionally.
test("BashOutput maps to run (approved delta: previously fell through to other)", () => {
  expect(mapToolUse("BashOutput", {}).op).toBe("run")
})

test("KillShell maps to run (approved delta: previously fell through to other)", () => {
  expect(mapToolUse("KillShell", {}).op).toBe("run")
})
