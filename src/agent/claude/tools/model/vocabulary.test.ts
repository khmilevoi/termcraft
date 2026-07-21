import { describe, expect, test } from "bun:test";

import {
  CLAUDE_CONFINEMENT_TABLES,
  CLAUDE_DISALLOWED_TOOLS,
  PATH_FIELDS,
  TARGET_FIELDS,
} from "./vocabulary";

describe("derived tables match the pre-unification literals", () => {
  test("denied tools", () => {
    expect([...CLAUDE_CONFINEMENT_TABLES.deniedTools].sort()).toEqual(
      ["Bash", "BashOutput", "KillShell", "WebFetch", "WebSearch"].sort(),
    );
  });

  test("disallowedTools passed to the SDK equals the denied set", () => {
    expect([...CLAUDE_DISALLOWED_TOOLS].sort()).toEqual(
      [...CLAUDE_CONFINEMENT_TABLES.deniedTools].sort(),
    );
  });

  test("file tools", () => {
    expect([...CLAUDE_CONFINEMENT_TABLES.fileTools].sort()).toEqual(
      ["Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Grep", "Glob", "LS"].sort(),
    );
  });

  test("optional-path tools", () => {
    expect([...CLAUDE_CONFINEMENT_TABLES.optionalPathTools].sort()).toEqual(
      ["Grep", "Glob", "LS"].sort(),
    );
  });

  test("path fields keep their original order", () => {
    expect(PATH_FIELDS).toEqual(["file_path", "path", "notebook_path", "notebookPath"]);
  });

  test("target fields still cover every pre-unification target field", () => {
    // The literal from tool-op.ts's TARGET_FIELDS before unification (commit
    // cb53318), read verbatim rather than re-derived from PATH_FIELDS so this
    // assertion can actually fail if CLAUDE_TOOLS drifts from history.
    const legacyTargetFields = [
      "file_path",
      "path",
      "notebook_path",
      "command",
      "pattern",
      "url",
    ] as const;
    for (const field of legacyTargetFields) expect(TARGET_FIELDS).toContain(field);
  });

  test("target fields add notebookPath, which the old list lacked", () => {
    // Deliberate: PATH_FIELDS already carried the camelCase spelling, and
    // TARGET_FIELDS is now derived from it. Inert in practice — the installed
    // SDK's NotebookEditInput only ever emits notebook_path.
    expect(TARGET_FIELDS).toContain("notebookPath");
  });

  test("target fields never feed confinement with non-path values", () => {
    expect(CLAUDE_CONFINEMENT_TABLES.pathFields).toEqual(PATH_FIELDS);
    expect(CLAUDE_CONFINEMENT_TABLES.pathFields).not.toContain("command");
    expect(CLAUDE_CONFINEMENT_TABLES.pathFields).not.toContain("url");
  });
});
