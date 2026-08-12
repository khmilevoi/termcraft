import { describe, expect, test } from "bun:test";

import type { ProjectManifest } from "../types";
import {
  ManifestCorruptError,
  ManifestMigrationRequiredError,
  ManifestTooNewError,
  PROJECT_MANIFEST_FILENAME,
  PROJECT_MANIFEST_FORMAT_VERSION,
  decodeProjectManifest,
  encodeProjectManifest,
  encodeTomlString,
} from "./project-toml";

const manifest: ProjectManifest = {
  formatVersion: 3,
  projectId: "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d10",
  name: "Checkout Flow",
  createdAt: "2026-07-19T10:11:12Z",
  targetStack: "rust-ratatui",
};

describe("encodeTomlString", () => {
  test("escapes quotes, backslashes, and control characters", () => {
    expect(encodeTomlString(`a"b\\c`)).toBe(`"a\\"b\\\\c"`);
    expect(encodeTomlString("line\nbreak\ttab")).toBe(`"line\\nbreak\\ttab"`);
    expect(encodeTomlString(String.fromCharCode(1))).toBe(`"\\u0001"`);
    expect(encodeTomlString("")).toBe(`""`);
  });
});

describe("encodeProjectManifest", () => {
  test("emits format_version = 2 and exactly the four semantic fields, in order", () => {
    const text = encodeProjectManifest(manifest);
    expect(text.trimEnd().split("\n")).toEqual([
      "format_version = 3",
      `project_id = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d10"`,
      `name = "Checkout Flow"`,
      `created_at = "2026-07-19T10:11:12Z"`,
      `target_stack = "rust-ratatui"`,
    ]);
  });

  test("is deterministic — the same manifest always serializes byte-identically", () => {
    expect(encodeProjectManifest(manifest)).toBe(encodeProjectManifest({ ...manifest }));
  });

  test("PORTABLE SNAPSHOT (§16.1): target stack travels; local state and page order do not", () => {
    const text = encodeProjectManifest(manifest);
    // Target stack is portable.
    expect(text).toContain(`target_stack = "rust-ratatui"`);
    // Page order/enumeration moved to design/pages.json as of format_version 2 (§3, §12.1) —
    // project.toml never carries a `pages` key again.
    expect(text).not.toContain("pages");
    // Active page/chat, backend/model/effort, preview/UI state, and sessions never appear.
    for (const forbidden of [
      "active_page",
      "active_chat",
      "backend",
      "model",
      "effort",
      "preview",
      "theme",
      "color_capability",
      "render_mode",
      "fullscreen",
      "session",
      "source_hash",
      "min_size",
      "title",
      "git",
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });
});

describe("decodeProjectManifest", () => {
  test("round-trips an encoded manifest", () => {
    const decoded = decodeProjectManifest(encodeProjectManifest(manifest));
    expect(decoded).toEqual(manifest);
  });

  test("accepts every target_stack enum member", () => {
    for (const stack of ["rust-ratatui", "go-bubbletea", "js-opentui", "generic"] as const) {
      const decoded = decodeProjectManifest(
        encodeProjectManifest({ ...manifest, targetStack: stack }),
      );
      expect(decoded).not.toBeInstanceOf(Error);
      expect((decoded as ProjectManifest).targetStack).toBe(stack);
    }
  });

  test("a version-1 manifest is a migration-required refusal, not a shape error, even with otherwise-valid fields", () => {
    const decoded = decodeProjectManifest(
      encodeProjectManifest(manifest).replace("format_version = 3", "format_version = 1"),
    );
    expect(decoded).toBeInstanceOf(ManifestMigrationRequiredError);
    expect(decoded).not.toBeInstanceOf(ManifestCorruptError);
    const error = decoded as ManifestMigrationRequiredError;
    expect(error._tag).toBe("ManifestMigrationRequiredError");
    expect(error.file).toBe(PROJECT_MANIFEST_FILENAME);
    expect(error.found).toBe(1);
    expect(error.supported).toBe(PROJECT_MANIFEST_FORMAT_VERSION);
    expect(error.message).toContain("migrated");
  });

  test("a newer format_version is a hard ManifestTooNewError NAMING the file", () => {
    const decoded = decodeProjectManifest(
      encodeProjectManifest(manifest).replace("format_version = 3", "format_version = 4"),
    );
    expect(decoded).toBeInstanceOf(ManifestTooNewError);
    const error = decoded as ManifestTooNewError;
    expect(error._tag).toBe("ManifestTooNewError");
    expect(error.file).toBe(PROJECT_MANIFEST_FILENAME);
    expect(error.found).toBe(4);
    expect(error.supported).toBe(PROJECT_MANIFEST_FORMAT_VERSION);
    expect(error.message).toContain(PROJECT_MANIFEST_FILENAME);
  });

  test("the too-new check runs before schema validation, so a future shape still reports too-new", () => {
    const decoded = decodeProjectManifest(
      `format_version = 9\nsomething_new = true\n`,
      "pages/project.toml",
    );
    expect(decoded).toBeInstanceOf(ManifestTooNewError);
    expect((decoded as ManifestTooNewError).file).toBe("pages/project.toml");
  });

  test("the older-than check runs before schema validation too, so a stale shape still reports migration-required", () => {
    const decoded = decodeProjectManifest(
      `format_version = 1\nsomething_old = true\n`,
      "pages/project.toml",
    );
    expect(decoded).toBeInstanceOf(ManifestMigrationRequiredError);
    expect((decoded as ManifestMigrationRequiredError).file).toBe("pages/project.toml");
  });

  test("rejects any non-portable field", () => {
    for (const extra of [
      `active_page_slug = "home"`,
      `active_chat_id = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d11"`,
      `backend = "claude-code"`,
      `model = "opus"`,
      `effort = "high"`,
      `preview_size_mode = "auto"`,
      `theme_override = "light-default"`,
      `fullscreen_preview = true`,
    ]) {
      const decoded = decodeProjectManifest(`${encodeProjectManifest(manifest)}${extra}\n`);
      expect(decoded).toBeInstanceOf(ManifestCorruptError);
    }
  });

  test("a version-2 manifest carrying `pages` is corrupt — pages.json is the only order", () => {
    const decoded = decodeProjectManifest(`${encodeProjectManifest(manifest)}pages = ["a"]\n`);
    expect(decoded).toBeInstanceOf(ManifestCorruptError);
    expect((decoded as ManifestCorruptError)._tag).toBe("ManifestCorruptError");
  });

  test("rejects a missing or non-integer format_version", () => {
    expect(
      decodeProjectManifest(`project_id = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d10"\n`),
    ).toBeInstanceOf(ManifestCorruptError);
    expect(decodeProjectManifest(`format_version = "1"\n`)).toBeInstanceOf(ManifestCorruptError);
  });

  test("rejects unparsable TOML without throwing", () => {
    const decoded = decodeProjectManifest("format_version = = 1");
    expect(decoded).toBeInstanceOf(ManifestCorruptError);
    expect((decoded as ManifestCorruptError).cause).toBeDefined();
  });

  test("rejects a non-canonical projectId, a non-UTC createdAt, and an unknown target stack", () => {
    expect(
      decodeProjectManifest(encodeProjectManifest({ ...manifest, projectId: "not-a-uuid" })),
    ).toBeInstanceOf(ManifestCorruptError);
    expect(
      decodeProjectManifest(
        encodeProjectManifest({ ...manifest, createdAt: "2026-07-19T10:11:12+02:00" }),
      ),
    ).toBeInstanceOf(ManifestCorruptError);
    expect(
      decodeProjectManifest(encodeProjectManifest({ ...manifest, targetStack: "rust" as never })),
    ).toBeInstanceOf(ManifestCorruptError);
  });

  test("encode round-trips and omits pages", () => {
    const text = encodeProjectManifest(manifest);
    expect(text).not.toContain("pages");
    expect(decodeProjectManifest(text)).toEqual(manifest);
  });
});

// Task 5 brief's own sample, kept verbatim (values, structure) alongside the suite above,
// which folds the same coverage into the file's established `manifest` fixture style.
const V2 = [
  "format_version = 3",
  'project_id = "019fa002-5f5b-7000-92e3-9931eebd6c52"',
  'name = "clock"',
  'created_at = "2026-07-26T19:58:57.883Z"',
  'target_stack = "js-opentui"',
  "",
].join("\n");

test("decodes a version-3 manifest with no pages field", () => {
  const decoded = decodeProjectManifest(V2);
  if (decoded instanceof Error) throw decoded;
  expect(decoded.formatVersion).toBe(3);
  expect(decoded.name).toBe("clock");
  expect("pages" in decoded).toBe(false);
});

test("a version-1 manifest is a migration-required refusal, not a shape error", () => {
  const result = decodeProjectManifest(V2.replace("format_version = 3", "format_version = 1"));
  expect(result).toBeInstanceOf(ManifestMigrationRequiredError);
  expect(String(result)).toContain("migrated");
});

test("a version-2 manifest carrying `pages` is corrupt — pages.json is the only order", () => {
  const result = decodeProjectManifest(`${V2}pages = ["a"]\n`);
  expect(result).toBeInstanceOf(ManifestCorruptError);
});

test("a version-4 manifest is still too-new, not migration-required", () => {
  const result = decodeProjectManifest(V2.replace("format_version = 3", "format_version = 4"));
  expect(result).toBeInstanceOf(ManifestTooNewError);
  expect(result).not.toBeInstanceOf(ManifestMigrationRequiredError);
});

test("encode round-trips and omits pages", () => {
  const decoded = decodeProjectManifest(V2);
  if (decoded instanceof Error) throw decoded;
  const text = encodeProjectManifest(decoded);
  expect(text).not.toContain("pages");
  expect(decodeProjectManifest(text)).toEqual(decoded);
});
