import { describe, expect, test } from "bun:test";

import { parsePageSlug } from "entities/page";
import type { PageSlug } from "entities/page";

import type { ProjectManifest } from "../types";
import {
  ManifestCorruptError,
  ManifestTooNewError,
  PROJECT_MANIFEST_FILENAME,
  PROJECT_MANIFEST_FORMAT_VERSION,
  decodeProjectManifest,
  encodeProjectManifest,
  encodeTomlString,
} from "./project-toml";

function slug(value: string): PageSlug {
  const parsed = parsePageSlug(value);
  if (parsed instanceof Error) throw parsed;
  return parsed;
}

const manifest: ProjectManifest = {
  formatVersion: 1,
  projectId: "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d10",
  name: "Checkout Flow",
  createdAt: "2026-07-19T10:11:12Z",
  targetStack: "rust-ratatui",
  pages: [slug("home"), slug("checkout"), slug("settings")],
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
  test("emits format_version = 1 and exactly the five semantic fields, in order", () => {
    const text = encodeProjectManifest(manifest);
    expect(text.trimEnd().split("\n")).toEqual([
      "format_version = 1",
      `project_id = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d10"`,
      `name = "Checkout Flow"`,
      `created_at = "2026-07-19T10:11:12Z"`,
      `target_stack = "rust-ratatui"`,
      `pages = ["home", "checkout", "settings"]`,
    ]);
  });

  test("is deterministic — the same manifest always serializes byte-identically", () => {
    expect(encodeProjectManifest(manifest)).toBe(encodeProjectManifest({ ...manifest }));
  });

  test("PORTABLE SNAPSHOT (§16.1): target stack and page order travel, local state does not", () => {
    const text = encodeProjectManifest(manifest);
    // Target stack and the exact page order are portable.
    expect(text).toContain(`target_stack = "rust-ratatui"`);
    expect(text).toContain(`pages = ["home", "checkout", "settings"]`);
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

  test("a newer format_version is a hard ManifestTooNewError NAMING the file", () => {
    const decoded = decodeProjectManifest(
      encodeProjectManifest(manifest).replace("format_version = 1", "format_version = 2"),
    );
    expect(decoded).toBeInstanceOf(ManifestTooNewError);
    const error = decoded as ManifestTooNewError;
    expect(error.file).toBe(PROJECT_MANIFEST_FILENAME);
    expect(error.found).toBe(2);
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

  test("rejects a duplicate page slug and an invalid slug", () => {
    const duplicated = encodeProjectManifest({ ...manifest, pages: [slug("home"), slug("home")] });
    expect(decodeProjectManifest(duplicated)).toBeInstanceOf(ManifestCorruptError);
    expect(
      decodeProjectManifest(encodeProjectManifest(manifest).replace(`"home"`, `"Home"`)),
    ).toBeInstanceOf(ManifestCorruptError);
  });

  test("preserves page ORDER rather than sorting it", () => {
    const reversed = { ...manifest, pages: [slug("settings"), slug("checkout"), slug("home")] };
    const decoded = decodeProjectManifest(encodeProjectManifest(reversed));
    expect((decoded as ProjectManifest).pages).toEqual(reversed.pages);
  });
});
