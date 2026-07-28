import { describe, expect, test } from "bun:test";

import { parsePageSlug } from "entities/page";
import type { PageSlug } from "entities/page";

import type { ResourceLimitOverrides, WorkspaceLocalState } from "../types";
import { encodeProjectManifest } from "./project-toml";
import {
  WORKSPACE_STATE_FILENAME,
  WORKSPACE_STATE_FORMAT_VERSION,
  WorkspaceStateCorruptError,
  WorkspaceStateTooNewError,
  decodeWorkspaceLocalState,
  defaultWorkspaceLocalState,
  encodeWorkspaceLocalState,
  loadWorkspaceLocalState,
} from "./workspace-toml";

function slug(value: string): PageSlug {
  const parsed = parsePageSlug(value);
  if (parsed instanceof Error) throw parsed;
  return parsed;
}

const PREFIX_HASH = "a".repeat(64);

const populated: WorkspaceLocalState = {
  formatVersion: 1,
  activePageSlug: slug("checkout"),
  activeChatId: "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d20",
  backend: "claude-code",
  model: "opus",
  effort: "high",
  previewSizeMode: "custom",
  previewSizePreset: null,
  previewCustomWidth: 100,
  previewCustomHeight: 30,
  themeOverride: "light-default",
  colorCapability: "256",
  renderMode: "interactive",
  fullscreenPreview: true,
  sessionCheckpoints: [
    {
      chatId: "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d20",
      sessionScopeId: "claude-code:opus:acct-7:ws-1",
      sessionId: "sess_abc123",
      recordCount: 12,
      prefixHash: PREFIX_HASH,
    },
  ],
  resourceLimits: { diagnosticsQuotaBytes: 64 * 1024 * 1024, previewFps: 24 },
};

describe("defaultWorkspaceLocalState", () => {
  test("is deterministic and selects nothing the caller must resolve from portable state", () => {
    const defaults = defaultWorkspaceLocalState();
    expect(defaults).toEqual(defaultWorkspaceLocalState());
    expect(defaults).toEqual({
      formatVersion: WORKSPACE_STATE_FORMAT_VERSION,
      activePageSlug: null,
      activeChatId: null,
      backend: null,
      model: null,
      effort: null,
      previewSizeMode: "auto",
      previewSizePreset: null,
      previewCustomWidth: null,
      previewCustomHeight: null,
      themeOverride: null,
      colorCapability: null,
      renderMode: "static",
      fullscreenPreview: false,
      sessionCheckpoints: [],
      resourceLimits: {},
    });
  });
});

describe("encodeWorkspaceLocalState", () => {
  test("omits every unset field and emits only format_version by default", () => {
    expect(encodeWorkspaceLocalState(defaultWorkspaceLocalState()).trimEnd().split("\n")).toEqual([
      "format_version = 1",
      `preview_size_mode = "auto"`,
      `render_mode = "static"`,
      "fullscreen_preview = false",
    ]);
  });

  test("is deterministic for a fully populated state", () => {
    expect(encodeWorkspaceLocalState(populated)).toBe(encodeWorkspaceLocalState({ ...populated }));
  });

  test("emits session checkpoints as an array of tables and limits as a sub-table", () => {
    const text = encodeWorkspaceLocalState(populated);
    expect(text).toContain("[resource_limits]");
    expect(text).toContain("diagnostics_quota_bytes = 67108864");
    expect(text).toContain("[[session_checkpoints]]");
    expect(text).toContain(`prefix_hash = "${PREFIX_HASH}"`);
  });
});

describe("decodeWorkspaceLocalState", () => {
  test("round-trips a fully populated state", () => {
    expect(decodeWorkspaceLocalState(encodeWorkspaceLocalState(populated))).toEqual(populated);
  });

  test("round-trips the defaults", () => {
    expect(
      decodeWorkspaceLocalState(encodeWorkspaceLocalState(defaultWorkspaceLocalState())),
    ).toEqual(defaultWorkspaceLocalState());
  });

  test("round-trips the preset size mode", () => {
    const preset: WorkspaceLocalState = {
      ...populated,
      previewSizeMode: "preset",
      previewSizePreset: "120x40",
      previewCustomWidth: null,
      previewCustomHeight: null,
    };
    expect(decodeWorkspaceLocalState(encodeWorkspaceLocalState(preset))).toEqual(preset);
  });

  test("a newer format_version is a WorkspaceStateTooNewError naming the file", () => {
    const decoded = decodeWorkspaceLocalState("format_version = 2\n");
    expect(decoded).toBeInstanceOf(WorkspaceStateTooNewError);
    const error = decoded as WorkspaceStateTooNewError;
    expect(error.file).toBe(WORKSPACE_STATE_FILENAME);
    expect(error.message).toContain(WORKSPACE_STATE_FILENAME);
  });

  test("rejects an unknown key rather than silently accepting it (§6.1)", () => {
    expect(decodeWorkspaceLocalState('format_version = 1\ncomposer_draft = "hi"\n')).toBeInstanceOf(
      WorkspaceStateCorruptError,
    );
    expect(
      decodeWorkspaceLocalState("format_version = 1\n[resource_limits]\nmystery_budget = 5\n"),
    ).toBeInstanceOf(WorkspaceStateCorruptError);
  });

  test("rejects unparsable TOML without throwing", () => {
    const decoded = decodeWorkspaceLocalState("format_version = = 1");
    expect(decoded).toBeInstanceOf(WorkspaceStateCorruptError);
    expect((decoded as WorkspaceStateCorruptError).cause).toBeDefined();
  });

  test("custom size mode requires both custom width and height", () => {
    expect(
      decodeWorkspaceLocalState(`format_version = 1\npreview_size_mode = "custom"\n`),
    ).toBeInstanceOf(WorkspaceStateCorruptError);
    expect(
      decodeWorkspaceLocalState(
        `format_version = 1\npreview_size_mode = "custom"\npreview_custom_width = 100\n`,
      ),
    ).toBeInstanceOf(WorkspaceStateCorruptError);
  });

  test("preset size mode requires a preset id", () => {
    expect(
      decodeWorkspaceLocalState(`format_version = 1\npreview_size_mode = "preset"\n`),
    ).toBeInstanceOf(WorkspaceStateCorruptError);
    expect(
      decodeWorkspaceLocalState(
        `format_version = 1\npreview_size_mode = "preset"\npreview_size_preset = "640x480"\n`,
      ),
    ).toBeInstanceOf(WorkspaceStateCorruptError);
  });

  describe("resource-limit overrides are validated IN RANGE (§6.1, projections §16.1)", () => {
    const cases: ReadonlyArray<{
      readonly key: keyof ResourceLimitOverrides;
      readonly tomlKey: string;
      readonly min: number;
      readonly max: number;
    }> = [
      {
        key: "diagnosticsQuotaBytes",
        tomlKey: "diagnostics_quota_bytes",
        min: 32 * 1024 * 1024,
        max: 512 * 1024 * 1024,
      },
      {
        key: "renderCacheQuotaBytes",
        tomlKey: "render_cache_quota_bytes",
        min: 64 * 1024 * 1024,
        max: 4 * 1024 * 1024 * 1024,
      },
      { key: "exportWorkers", tomlKey: "export_workers", min: 1, max: 8 },
      { key: "previewFps", tomlKey: "preview_fps", min: 1, max: 60 },
      {
        key: "operationsLogSegmentBytes",
        tomlKey: "operations_log_segment_bytes",
        min: 1024 * 1024,
        max: 20 * 1024 * 1024,
      },
      {
        key: "operationsLogRetentionSegments",
        tomlKey: "operations_log_retention_segments",
        min: 2,
        max: 10,
      },
      { key: "silenceTimeoutSeconds", tomlKey: "silence_timeout_seconds", min: 30, max: 600 },
      {
        key: "absoluteTurnDeadlineMinutes",
        tomlKey: "absolute_turn_deadline_minutes",
        min: 10,
        max: 60,
      },
    ];

    for (const { key, tomlKey, min, max } of cases) {
      test(`${tomlKey}: both bounds are accepted, one step outside either bound is invalid`, () => {
        const render = (value: number) =>
          `format_version = 1\n[resource_limits]\n${tomlKey} = ${value}\n`;

        const atMin = decodeWorkspaceLocalState(render(min));
        expect(atMin).not.toBeInstanceOf(Error);
        expect((atMin as WorkspaceLocalState).resourceLimits[key]).toBe(min);

        const atMax = decodeWorkspaceLocalState(render(max));
        expect(atMax).not.toBeInstanceOf(Error);
        expect((atMax as WorkspaceLocalState).resourceLimits[key]).toBe(max);

        expect(decodeWorkspaceLocalState(render(min - 1))).toBeInstanceOf(
          WorkspaceStateCorruptError,
        );
        expect(decodeWorkspaceLocalState(render(max + 1))).toBeInstanceOf(
          WorkspaceStateCorruptError,
        );
      });
    }

    test("no sentinel disables a mandatory timer (projections §12)", () => {
      for (const value of [0, -1, -30]) {
        expect(
          decodeWorkspaceLocalState(
            `format_version = 1\n[resource_limits]\nsilence_timeout_seconds = ${value}\n`,
          ),
        ).toBeInstanceOf(WorkspaceStateCorruptError);
        expect(
          decodeWorkspaceLocalState(
            `format_version = 1\n[resource_limits]\nabsolute_turn_deadline_minutes = ${value}\n`,
          ),
        ).toBeInstanceOf(WorkspaceStateCorruptError);
      }
    });

    test("a fractional override is invalid", () => {
      expect(
        decodeWorkspaceLocalState("format_version = 1\n[resource_limits]\npreview_fps = 24.5\n"),
      ).toBeInstanceOf(WorkspaceStateCorruptError);
    });
  });

  test("rejects a malformed session checkpoint", () => {
    const base = "format_version = 1\n[[session_checkpoints]]\n";
    const good = `chat_id = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d20"\nsession_scope_id = "s"\nsession_id = "x"\nrecord_count = 3\nprefix_hash = "${PREFIX_HASH}"\n`;
    expect(decodeWorkspaceLocalState(base + good)).not.toBeInstanceOf(Error);
    expect(decodeWorkspaceLocalState(base + good.replace(PREFIX_HASH, "abc"))).toBeInstanceOf(
      WorkspaceStateCorruptError,
    );
    expect(
      decodeWorkspaceLocalState(base + good.replace("record_count = 3", "record_count = -1")),
    ).toBeInstanceOf(WorkspaceStateCorruptError);
    expect(
      decodeWorkspaceLocalState(
        base + good.replace(`"0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d20"`, `"nope"`),
      ),
    ).toBeInstanceOf(WorkspaceStateCorruptError);
  });
});

describe("loadWorkspaceLocalState (§6.1 missing / corrupt behavior)", () => {
  test("a MISSING file yields deterministic defaults with nothing reported", () => {
    const load = loadWorkspaceLocalState({ text: null });
    expect(load.missing).toBe(true);
    expect(load.corrupt).toBeNull();
    expect(load.state).toEqual(defaultWorkspaceLocalState());
  });

  test("a CORRUPT file is reported, defaults are used in memory, and the text is returned untouched for preservation", () => {
    const corruptText = `format_version = 1\ncomposer_draft = "half-written"\n`;
    const load = loadWorkspaceLocalState({ text: corruptText });
    expect(load.missing).toBe(false);
    expect(load.corrupt).toBeInstanceOf(WorkspaceStateCorruptError);
    expect(load.state).toEqual(defaultWorkspaceLocalState());
    // PRESERVED: the loader is pure — it never rewrites or clears the on-disk bytes.
    expect(load.preservedText).toBe(corruptText);
  });

  test("a TOO-NEW local file is also preserved and ignored in favor of defaults", () => {
    const load = loadWorkspaceLocalState({ text: "format_version = 7\n" });
    expect(load.corrupt).toBeInstanceOf(WorkspaceStateTooNewError);
    expect(load.state).toEqual(defaultWorkspaceLocalState());
  });

  test("a valid file loads as-is", () => {
    const load = loadWorkspaceLocalState({ text: encodeWorkspaceLocalState(populated) });
    expect(load.corrupt).toBeNull();
    expect(load.state).toEqual(populated);
  });
});

describe("the portable/local split is airtight (§16.1)", () => {
  test("no local field name appears in a portable manifest, and no portable field leaks into local state", () => {
    const manifestText = encodeProjectManifest({
      formatVersion: 2,
      projectId: "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d10",
      name: "Checkout Flow",
      createdAt: "2026-07-19T10:11:12Z",
      targetStack: "rust-ratatui",
    });
    const localText = encodeWorkspaceLocalState(populated);

    // Local navigation/backend/preview/session keys live ONLY in workspace.local.toml.
    for (const localKey of [
      "active_page_slug",
      "active_chat_id",
      "backend",
      "model",
      "effort",
      "preview_size_mode",
      "preview_custom_width",
      "theme_override",
      "color_capability",
      "render_mode",
      "fullscreen_preview",
      "session_checkpoints",
      "resource_limits",
    ]) {
      expect(localText).toContain(localKey);
      expect(manifestText).not.toContain(localKey);
    }

    // Portable identity/stack keys live ONLY in project.toml. Page order/enumeration moved
    // to design/pages.json as of format_version 2 (§3, §12.1); project.toml never carries a
    // `pages` key.
    for (const portableKey of ["project_id", "created_at", "target_stack"]) {
      expect(manifestText).toContain(portableKey);
      expect(localText).not.toContain(portableKey);
    }
  });

  test("corrupt local state can never be copied into portable state — the decoders share no field", () => {
    const load = loadWorkspaceLocalState({
      text: `format_version = 1\nproject_id = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d10"\n`,
    });
    // A portable key inside the local file is an unknown key: invalid, not adopted.
    expect(load.corrupt).toBeInstanceOf(WorkspaceStateCorruptError);
    expect(load.state).toEqual(defaultWorkspaceLocalState());
  });
});
