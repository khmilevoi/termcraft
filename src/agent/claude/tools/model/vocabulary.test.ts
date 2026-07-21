import { describe, expect, test } from "bun:test"
import { CLAUDE_CONFINEMENT_TABLES, CLAUDE_DISALLOWED_TOOLS, PATH_FIELDS, TARGET_FIELDS } from "./vocabulary"

describe("derived tables match the pre-unification literals", () => {
  test("denied tools", () => {
    expect([...CLAUDE_CONFINEMENT_TABLES.deniedTools].sort()).toEqual(
      ["Bash", "BashOutput", "KillShell", "WebFetch", "WebSearch"].sort(),
    )
  })

  test("disallowedTools passed to the SDK equals the denied set", () => {
    expect([...CLAUDE_DISALLOWED_TOOLS].sort()).toEqual([...CLAUDE_CONFINEMENT_TABLES.deniedTools].sort())
  })

  test("file tools", () => {
    expect([...CLAUDE_CONFINEMENT_TABLES.fileTools].sort()).toEqual(
      ["Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Grep", "Glob", "LS"].sort(),
    )
  })

  test("optional-path tools", () => {
    expect([...CLAUDE_CONFINEMENT_TABLES.optionalPathTools].sort()).toEqual(["Grep", "Glob", "LS"].sort())
  })

  test("path fields keep their original order", () => {
    expect(PATH_FIELDS).toEqual(["file_path", "path", "notebook_path", "notebookPath"])
  })

  test("target fields extend path fields and never feed confinement", () => {
    expect(TARGET_FIELDS).toEqual([...PATH_FIELDS, "command", "pattern", "url"])
    expect(CLAUDE_CONFINEMENT_TABLES.pathFields).toEqual(PATH_FIELDS)
    expect(CLAUDE_CONFINEMENT_TABLES.pathFields).not.toContain("command")
    expect(CLAUDE_CONFINEMENT_TABLES.pathFields).not.toContain("url")
  })
})
