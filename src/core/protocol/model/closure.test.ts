import { describe, expect, test } from "bun:test";

import { COMMAND_KINDS_V1, COMMAND_KIND_COUNT, commandFamilyOf } from "./command-kind";
import { commandPayloadSchemas } from "./command-payload";
import { EVENT_KINDS_V1, EVENT_KIND_COUNT } from "./event-kind";
import { eventPayloadV1SchemaByKind } from "./event-payload";

/**
 * The §13.2 "DTO round trip and closure" contract: "every `CommandKindV1` has exactly one
 * closed `CommandPayloadByKindV1` schema and target extractor, every `EventKindV1` has
 * exactly one closed `EventPayloadByKindV1` schema".
 *
 * The literal arrays below are transcribed from the spec text (§8.1 KCC:425-444 and §9
 * KCC:694-713), NOT derived from the source. That is the entire point: a test that
 * iterates the same constant the schema is built from is tautologically true and cannot
 * fail on a misspelling. Pinning against an independent transcription catches a typo, a
 * reordering, an omission, and an addition — the four ways a closed union silently drifts.
 */

const COMMAND_KINDS_PER_SPEC: string[] = [
  "project.create",
  "project.open",
  "project.retryOpen",
  "project.close",
  "project.setTrust",
  "turn.start",
  "turn.cancel",
  "chat.create",
  "chat.switch",
  "chat.load-older",
  "model.select",
  "page.renameTitle",
  "page.removePlan",
  "page.removeConfirm",
  "page.removeDiscardPlan",
  "page.reorder",
  "history.open",
  "preview.selectPage",
  "preview.selectHistorical",
  "preview.selectCurrent",
  "preview.resize",
  "preview.setThemeCapabilities",
  "preview.setMode",
  "preview.forwardInput",
  "preview.setTweak",
  "preview.queryGeometry",
  "preview.retry",
  "preview.close",
  "selection.set",
  "selection.clear",
  "pin.create",
  "pin.setStatus",
  "restore.plan",
  "restore.confirm",
  "restore.discardPlan",
  "restore.retryRecord",
  "commit.plan",
  "commit.confirm",
  "commit.discardPlan",
  "export.start",
  "migration.plan",
  "migration.confirm",
  "migration.discardPlan",
  "migration.retryRecovery",
  "designSystem.list",
  "designSystem.preview",
  "designSystem.install",
  "designSystem.publish",
];

const EVENT_KINDS_PER_SPEC: string[] = [
  "kernel.snapshot",
  "kernel.stateChanged",
  "kernel.capabilitiesChanged",
  "page.removePlanReady",
  "page.descriptorsChanged",
  "turn.started",
  "turn.attemptStarted",
  "turn.progress",
  "turn.gateRejected",
  "turn.applyStarted",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "restore.planReady",
  "restore.started",
  "restore.recordPending",
  "restore.completed",
  "restore.failed",
  "commit.planReady",
  "commit.started",
  "commit.completed",
  "commit.failed",
  "export.started",
  "export.progress",
  "export.completed",
  "export.failed",
  "migration.planReady",
  "migration.started",
  "migration.progress",
  "migration.completed",
  "migration.failed",
  "preview.sourceChanged",
  "preview.sessionReady",
  "preview.geometryResult",
  "preview.backpressured",
  "preview.writable",
  "preview.failed",
  "preview.circuitOpened",
  "chat.changed",
  "chat.records",
  "chat.records.older",
  "selection.changed",
  "pins.changed",
  "git.statusChanged",
  "diagnostics.changed",
  "designSystem.listed",
  "designSystem.listFailed",
  "designSystem.previewStarted",
  "designSystem.previewed",
  "designSystem.previewFailed",
  "designSystem.installed",
  "designSystem.installFailed",
  "designSystem.published",
  "designSystem.publishFailed",
];

describe("CommandKindV1 closure", () => {
  test("matches the §8.1 union verbatim, in spec order", () => {
    const actual: string[] = [...COMMAND_KINDS_V1];
    expect(actual).toEqual(COMMAND_KINDS_PER_SPEC);
  });

  test("has exactly the count the spec fixes, and the constant agrees with the array", () => {
    expect(COMMAND_KINDS_PER_SPEC.length).toBe(48);
    expect(COMMAND_KIND_COUNT).toBe(48);
    expect(COMMAND_KINDS_V1.length).toBe(COMMAND_KIND_COUNT);
  });

  test("contains no duplicate member", () => {
    expect(new Set(COMMAND_KINDS_V1).size).toBe(COMMAND_KINDS_V1.length);
  });

  test("every kind resolves to a family, and every family is non-empty", () => {
    const families = new Set(COMMAND_KINDS_V1.map(commandFamilyOf));
    for (const kind of COMMAND_KINDS_V1) {
      expect(kind.startsWith(`${commandFamilyOf(kind)}.`)).toBe(true);
    }
    expect(families.size).toBeGreaterThan(0);
  });
});

describe("EventKindV1 closure", () => {
  test("matches the §9 union verbatim, in spec order", () => {
    const actual: string[] = [...EVENT_KINDS_V1];
    expect(actual).toEqual(EVENT_KINDS_PER_SPEC);
  });

  test("has exactly the count the spec fixes, and the constant agrees with the array", () => {
    expect(EVENT_KINDS_PER_SPEC.length).toBe(54);
    expect(EVENT_KIND_COUNT).toBe(54);
    expect(EVENT_KINDS_V1.length).toBe(EVENT_KIND_COUNT);
  });

  test("contains no duplicate member", () => {
    expect(new Set(EVENT_KINDS_V1).size).toBe(EVENT_KINDS_V1.length);
  });

  test("carries no frame kind — frames use the separate PreviewSession stream (§7.6)", () => {
    for (const kind of EVENT_KINDS_V1) {
      expect(kind.includes("frame")).toBe(false);
    }
  });
});

describe("payload map closure", () => {
  test("every command kind has exactly one payload schema, and the map has no extra key", () => {
    const keys: string[] = Object.keys(commandPayloadSchemas);
    expect(keys.sort()).toEqual([...COMMAND_KINDS_PER_SPEC].sort());
  });

  test("every event kind has exactly one payload schema, and the map has no extra key", () => {
    const keys: string[] = Object.keys(eventPayloadV1SchemaByKind);
    expect(keys.sort()).toEqual([...EVENT_KINDS_PER_SPEC].sort());
  });

  test("every command payload schema actually parses — none is a placeholder stub", () => {
    for (const kind of COMMAND_KINDS_V1) {
      const schema = commandPayloadSchemas[kind];
      expect(typeof schema.safeParse).toBe("function");
      // A schema that accepts literally anything would silently disable payload
      // validation for that kind; every §8.2 payload rejects at least a non-object.
      expect(schema.safeParse(Symbol("nope")).success).toBe(false);
    }
  });

  test("every event payload schema actually parses — none is a placeholder stub", () => {
    for (const kind of EVENT_KINDS_V1) {
      const schema = eventPayloadV1SchemaByKind[kind];
      expect(typeof schema.safeParse).toBe("function");
      expect(schema.safeParse(Symbol("nope")).success).toBe(false);
    }
  });
});
