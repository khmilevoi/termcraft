import { describe, expect, test } from "bun:test";

import { uuidv7 } from "infrastructure/uuid";

import { capabilityTargetByKindV1Schema } from "./capability-target";
import { type CommandKindV1 } from "./command-kind";

interface Fixture {
  readonly valid: unknown;
  readonly breaks: readonly unknown[];
}

const FULL_COMMIT = "a".repeat(40);

/**
 * One schema-valid target sample plus at least one wrong-shape sample per
 * `CapabilityTargetByKindV1` row (kernel-command-contract §10.1's 43-row table). The
 * `Record<CommandKindV1, Fixture>` annotation makes a missing kind a `tsc` error, the same
 * completeness technique `command-payload.test.ts` already uses for the payload schemas.
 */
const FIXTURES: Record<CommandKindV1, Fixture> = {
  "project.create": { valid: null, breaks: [{}, undefined, "null"] },
  "project.open": { valid: null, breaks: [{}] },
  "project.retryOpen": {
    valid: { recovery: { kind: "restore", restoreActionId: uuidv7() } },
    breaks: [
      { recovery: { kind: "unknown", restoreActionId: uuidv7() } },
      { recovery: { kind: "restore", restoreActionId: uuidv7() }, extra: 1 },
    ],
  },
  "project.close": { valid: null, breaks: [{}] },
  "project.setTrust": {
    valid: { workspaceIdentity: "ws-1" },
    breaks: [{ workspaceIdentity: "" }, { workspaceIdentity: "ws-1", extra: 1 }],
  },
  "turn.start": { valid: null, breaks: [{}] },
  "turn.cancel": {
    valid: { turnId: uuidv7() },
    breaks: [{ turnId: "not-a-uuid" }, { turnId: uuidv7(), extra: 1 }],
  },
  "chat.create": { valid: null, breaks: [{}] },
  "chat.switch": {
    valid: { chatId: uuidv7() },
    breaks: [{ chatId: "not-a-uuid" }],
  },
  "chat.load-older": {
    valid: { chatId: uuidv7() },
    breaks: [{ chatId: "not-a-uuid" }, { chatId: uuidv7(), extra: 1 }],
  },
  "model.select": {
    valid: { backend: "anthropic", model: "claude", effort: "medium" },
    breaks: [
      { backend: "", model: "claude", effort: "medium" },
      { backend: "anthropic", model: "claude" },
    ],
  },
  "page.renameTitle": {
    valid: { pageSlug: "home" },
    breaks: [{ pageSlug: "NOT A SLUG" }, { pageSlug: "home", extra: 1 }],
  },
  "page.removePlan": { valid: { pageSlug: "home" }, breaks: [{ pageSlug: "" }] },
  "page.removeConfirm": {
    valid: { pageRemovePlanId: uuidv7() },
    breaks: [{ pageRemovePlanId: "not-a-uuid" }],
  },
  "page.removeDiscardPlan": {
    valid: { pageRemovePlanId: uuidv7() },
    breaks: [{ pageRemovePlanId: "not-a-uuid" }],
  },
  "page.reorder": { valid: null, breaks: [[]] },
  "history.open": { valid: { pageSlug: "home" }, breaks: [{ pageSlug: "NOT A SLUG" }] },
  "preview.selectPage": { valid: { pageSlug: "home" }, breaks: [{}] },
  "preview.selectHistorical": {
    valid: { pageSlug: "home", sourceCommit: FULL_COMMIT },
    breaks: [{ pageSlug: "home", sourceCommit: "" }],
  },
  "preview.selectCurrent": { valid: { pageSlug: "home" }, breaks: [{}] },
  "preview.resize": {
    valid: { previewSessionId: uuidv7() },
    breaks: [{ previewSessionId: "not-a-uuid" }],
  },
  "preview.setThemeCapabilities": {
    valid: { previewSessionId: uuidv7(), themeId: "dark" },
    breaks: [{ previewSessionId: uuidv7(), themeId: "" }],
  },
  "preview.setMode": {
    valid: { previewSessionId: uuidv7(), mode: "static" },
    breaks: [{ previewSessionId: uuidv7(), mode: "weird" }],
  },
  "preview.forwardInput": {
    valid: { previewSessionId: uuidv7() },
    breaks: [{}],
  },
  "preview.setTweak": {
    valid: { previewSessionId: uuidv7(), tweakId: "font-size" },
    breaks: [{ previewSessionId: uuidv7(), tweakId: "" }],
  },
  "preview.queryGeometry": {
    valid: { frameTokenId: uuidv7(), queryKind: "hit" },
    breaks: [{ frameTokenId: uuidv7(), queryKind: "unknown" }],
  },
  "preview.retry": { valid: { previewSessionId: uuidv7() }, breaks: [{}] },
  "preview.close": { valid: { previewSessionId: uuidv7() }, breaks: [{}] },
  "selection.set": {
    valid: { pageSlug: "home", elementId: "el-1" },
    breaks: [{ pageSlug: "home", elementId: "" }],
  },
  "selection.clear": { valid: null, breaks: [{}] },
  "pin.create": {
    valid: { geometryTokenId: uuidv7() },
    breaks: [{ geometryTokenId: "not-a-uuid" }],
  },
  "pin.setStatus": {
    valid: { pinId: uuidv7(), status: "open" },
    breaks: [{ pinId: uuidv7(), status: "weird" }],
  },
  "restore.plan": {
    valid: { pageSlug: "home", sourceCommit: FULL_COMMIT },
    breaks: [{ pageSlug: "home", sourceCommit: "" }],
  },
  "restore.confirm": {
    valid: { restorePlanId: uuidv7() },
    breaks: [{ restorePlanId: "not-a-uuid" }],
  },
  "restore.discardPlan": {
    valid: { restorePlanId: uuidv7() },
    breaks: [{ restorePlanId: "not-a-uuid" }],
  },
  "restore.retryRecord": {
    valid: { restoreActionId: uuidv7() },
    breaks: [{ restoreActionId: "not-a-uuid" }],
  },
  "commit.plan": {
    valid: { scope: "current-page" },
    breaks: [{ scope: "weird" }],
  },
  "commit.confirm": {
    valid: { commitPlanId: uuidv7() },
    breaks: [{ commitPlanId: "not-a-uuid" }],
  },
  "commit.discardPlan": {
    valid: { commitPlanId: uuidv7() },
    breaks: [{ commitPlanId: "not-a-uuid" }],
  },
  "export.start": { valid: null, breaks: [{}] },
  "migration.plan": { valid: null, breaks: [{}] },
  "migration.confirm": {
    valid: { migrationPlanId: uuidv7() },
    breaks: [{ migrationPlanId: "not-a-uuid" }],
  },
  "migration.discardPlan": {
    valid: { migrationPlanId: uuidv7() },
    breaks: [{ migrationPlanId: "not-a-uuid" }],
  },
  "migration.retryRecovery": {
    valid: { migrationActionId: uuidv7() },
    breaks: [{ migrationActionId: "not-a-uuid" }],
  },
  "designSystem.list": { valid: null, breaks: [{}] },
  "designSystem.preview": { valid: null, breaks: [{}] },
  "designSystem.install": { valid: null, breaks: [{}] },
  "designSystem.publish": { valid: null, breaks: [{}] },
};

describe("capabilityTargetByKindV1Schema", () => {
  for (const [kind, fixture] of Object.entries(FIXTURES) as [CommandKindV1, Fixture][]) {
    test(`${kind}: parses its valid target shape`, () => {
      const result = capabilityTargetByKindV1Schema[kind].safeParse(fixture.valid);
      expect(result.success, JSON.stringify(result.success ? undefined : result.error.issues)).toBe(
        true,
      );
    });

    test(`${kind}: rejects every wrong-shape sample`, () => {
      for (const bad of fixture.breaks) {
        expect(
          capabilityTargetByKindV1Schema[kind].safeParse(bad).success,
          `${kind} accepted an invalid target: ${JSON.stringify(bad)}`,
        ).toBe(false);
      }
    });
  }
});
