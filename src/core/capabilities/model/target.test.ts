import { describe, expect, test } from "bun:test";

import { COMMAND_KINDS_V1, type CommandKindV1 } from "core/protocol";
import { uuidv7 } from "infrastructure/uuid";

import {
  CapabilityTargetExtractionError,
  capabilityTargetExtractors,
  extractCapabilityTarget,
} from "./target";

/**
 * kernel-command-contract §10.1's central security property, transcribed verbatim:
 * "No target contains message/initial/title/pin/commit text, an acknowledgement,
 * terminal/input/tweak/geometry raw input, dimensions, coordinates, rectangle fractions, or
 * a page-order permutation." §13.2 restates it as a contract-test requirement.
 *
 * The single test below ("no forbidden field or sentinel survives extraction...") is THE
 * point of this file: for every one of the 44 `CommandKindV1` members it builds a
 * schema-valid payload where every field §10.1 forbids from the target carries a unique,
 * grep-able sentinel value (or, for enum/boolean fields a sentinel value cannot represent,
 * a forbidden KEY that must not appear on the target object), extracts the target, and
 * proves neither the sentinel VALUE nor the forbidden KEY survived serialization. A naive
 * extractor that forwarded its payload wholesale — the exact failure mode this table
 * exists to prevent — fails this test immediately, both via the sentinel-leak check and
 * via the `toEqual` shape check.
 */

/** The one call signature every extractor satisfies, for iterating the heterogeneous table. */
type AnyTargetExtractor = (payload: unknown) => unknown;

// --- test-local sentinel generators ------------------------------------------------

let sentinelSeq = 0;
/** A value unique within this run, embedded verbatim into a payload field under test. */
function sentinel(label: string): string {
  sentinelSeq += 1;
  return `FORBIDDEN_SENTINEL__${label}__${sentinelSeq}`;
}

// A monotonically increasing 9-digit base — astronomically unlikely to appear as a
// coincidental decimal substring inside a random UUIDv7's hex digits.
let numberSentinelSeq = 900_000_001;
function numberSentinel(): number {
  numberSentinelSeq += 1;
  return numberSentinelSeq;
}

let slugSeq = 0;
/** Satisfies entities/page's slug mask `^[a-z0-9][a-z0-9-]{0,31}$`. */
function slug(): string {
  slugSeq += 1;
  return `slug-${slugSeq}`;
}

interface Case {
  readonly kind: CommandKindV1;
  readonly payload: unknown;
  readonly expectedTarget: unknown;
  /** Values present in `payload` that must NOT survive, by value, into the extracted target. */
  readonly forbiddenSentinels: readonly string[];
  /** Top-level target keys that must be absent — covers enum/boolean fields a value sentinel cannot represent. */
  readonly forbiddenKeys: readonly string[];
}

function buildCases(): readonly Case[] {
  const cases: Case[] = [];

  // --- the nine null-target kinds (§10.1 row 1) ------------------------------------
  {
    const root = sentinel("project.create.root");
    const workspaceIdentity = sentinel("project.create.workspaceIdentity");
    const text = sentinel("project.create.text");
    cases.push({
      kind: "project.create",
      payload: { root, creationDefaults: { trust: "trusted", workspaceIdentity }, text },
      expectedTarget: null,
      forbiddenSentinels: [root, workspaceIdentity, text],
      forbiddenKeys: [],
    });
  }
  {
    const root = sentinel("project.open.root");
    cases.push({
      kind: "project.open",
      payload: { root },
      expectedTarget: null,
      forbiddenSentinels: [root],
      forbiddenKeys: [],
    });
  }
  cases.push({
    kind: "project.close",
    payload: {},
    expectedTarget: null,
    forbiddenSentinels: [],
    forbiddenKeys: [],
  });
  {
    const text = sentinel("turn.start.text");
    cases.push({
      kind: "turn.start",
      payload: { text },
      expectedTarget: null,
      forbiddenSentinels: [text],
      forbiddenKeys: [],
    });
  }
  cases.push({
    kind: "chat.create",
    payload: {},
    expectedTarget: null,
    forbiddenSentinels: [],
    forbiddenKeys: [],
  });
  {
    const pageSlugs = [slug(), slug(), slug()];
    cases.push({
      kind: "page.reorder",
      payload: { pageSlugs },
      expectedTarget: null,
      forbiddenSentinels: pageSlugs,
      forbiddenKeys: [],
    });
  }
  cases.push({
    kind: "selection.clear",
    payload: {},
    expectedTarget: null,
    forbiddenSentinels: [],
    forbiddenKeys: [],
  });
  cases.push({
    kind: "export.start",
    payload: {},
    expectedTarget: null,
    forbiddenSentinels: [],
    forbiddenKeys: [],
  });
  {
    const fileKind = sentinel("migration.plan.fileKind");
    cases.push({
      kind: "migration.plan",
      payload: { scope: { fileKinds: [fileKind] } },
      expectedTarget: null,
      forbiddenSentinels: [fileKind],
      forbiddenKeys: [],
    });
  }

  // --- the four designSystem.* null-target kinds (project-design-systems Wave 3 / P10,
  // scope escape — see `target.ts`'s matching row comment) -------------------------------
  cases.push({
    kind: "designSystem.list",
    payload: {},
    expectedTarget: null,
    forbiddenSentinels: [],
    forbiddenKeys: [],
  });
  {
    const ref = sentinel("designSystem.preview.ref");
    cases.push({
      kind: "designSystem.preview",
      payload: { ref },
      expectedTarget: null,
      forbiddenSentinels: [ref],
      forbiddenKeys: [],
    });
  }
  {
    const installId = uuidv7();
    cases.push({
      kind: "designSystem.install",
      payload: { installId },
      expectedTarget: null,
      forbiddenSentinels: [installId],
      forbiddenKeys: [],
    });
  }
  {
    const sourceId = sentinel("designSystem.publish.sourceId");
    cases.push({
      kind: "designSystem.publish",
      payload: { sourceId },
      expectedTarget: null,
      forbiddenSentinels: [sourceId],
      forbiddenKeys: [],
    });
  }

  // --- project.retryOpen: fully copied, closed discriminated union -----------------
  {
    const restoreActionId = uuidv7();
    cases.push({
      kind: "project.retryOpen",
      payload: { recovery: { kind: "restore", restoreActionId } },
      expectedTarget: { recovery: { kind: "restore", restoreActionId } },
      forbiddenSentinels: [],
      forbiddenKeys: [],
    });
  }

  // --- project.setTrust: workspaceIdentity kept, trust omitted ---------------------
  {
    const workspaceIdentity = sentinel("project.setTrust.workspaceIdentity");
    cases.push({
      kind: "project.setTrust",
      payload: { trust: "untrusted-read-only", workspaceIdentity },
      expectedTarget: { workspaceIdentity },
      forbiddenSentinels: [],
      forbiddenKeys: ["trust"],
    });
  }

  // --- turn.cancel / chat.switch: single id copied ----------------------------------
  {
    const turnId = uuidv7();
    cases.push({
      kind: "turn.cancel",
      payload: { turnId },
      expectedTarget: { turnId },
      forbiddenSentinels: [],
      forbiddenKeys: [],
    });
  }
  {
    const chatId = uuidv7();
    cases.push({
      kind: "chat.switch",
      payload: { chatId },
      expectedTarget: { chatId },
      forbiddenSentinels: [],
      forbiddenKeys: [],
    });
  }
  {
    const chatId = uuidv7();
    const generation = numberSentinel();
    const beforeOffset = numberSentinel();
    cases.push({
      kind: "chat.load-older",
      payload: { chatId, cursor: { generation, beforeOffset } },
      expectedTarget: { chatId },
      forbiddenSentinels: [String(generation), String(beforeOffset)],
      forbiddenKeys: ["cursor"],
    });
  }

  // --- model.select: all three fields copied ----------------------------------------
  {
    const backend = sentinel("model.select.backend");
    const model = sentinel("model.select.model");
    const effort = sentinel("model.select.effort");
    cases.push({
      kind: "model.select",
      payload: { backend, model, effort },
      expectedTarget: { backend, model, effort },
      forbiddenSentinels: [],
      forbiddenKeys: [],
    });
  }

  // --- page.renameTitle: pageSlug kept, title omitted -------------------------------
  {
    const pageSlug = slug();
    const title = sentinel("page.renameTitle.title");
    cases.push({
      kind: "page.renameTitle",
      payload: { pageSlug, title },
      expectedTarget: { pageSlug },
      forbiddenSentinels: [title],
      forbiddenKeys: ["title"],
    });
  }

  // --- pageSlug-only targets ---------------------------------------------------------
  for (const kind of [
    "page.removePlan",
    "history.open",
    "preview.selectPage",
    "preview.selectCurrent",
  ] as const) {
    const pageSlug = slug();
    cases.push({
      kind,
      payload: { pageSlug },
      expectedTarget: { pageSlug },
      forbiddenSentinels: [],
      forbiddenKeys: [],
    });
  }

  // --- pageRemovePlanId-only targets --------------------------------------------------
  for (const kind of ["page.removeConfirm", "page.removeDiscardPlan"] as const) {
    const pageRemovePlanId = uuidv7();
    cases.push({
      kind,
      payload: { pageRemovePlanId },
      expectedTarget: { pageRemovePlanId },
      forbiddenSentinels: [],
      forbiddenKeys: [],
    });
  }

  // --- preview.selectHistorical / restore.plan: pageSlug + sourceCommit copied ------
  for (const kind of ["preview.selectHistorical", "restore.plan"] as const) {
    const pageSlug = slug();
    const sourceCommit = "a".repeat(40);
    cases.push({
      kind,
      payload: { pageSlug, sourceCommit },
      expectedTarget: { pageSlug, sourceCommit },
      forbiddenSentinels: [],
      forbiddenKeys: [],
    });
  }

  // --- preview.resize: previewSessionId kept, width/height (dimensions) dropped -----
  {
    const previewSessionId = uuidv7();
    const width = numberSentinel();
    const height = numberSentinel();
    cases.push({
      kind: "preview.resize",
      payload: { previewSessionId, width, height },
      expectedTarget: { previewSessionId },
      forbiddenSentinels: [String(width), String(height)],
      forbiddenKeys: ["width", "height"],
    });
  }

  // --- preview.setThemeCapabilities: previewSessionId + themeId kept, terminal caps dropped
  {
    const previewSessionId = uuidv7();
    const themeId = sentinel("preview.setThemeCapabilities.themeId");
    const colorDepth = numberSentinel();
    cases.push({
      kind: "preview.setThemeCapabilities",
      payload: { previewSessionId, themeId, terminalCapabilities: { colorDepth } },
      expectedTarget: { previewSessionId, themeId },
      forbiddenSentinels: [String(colorDepth)],
      forbiddenKeys: ["terminalCapabilities"],
    });
  }

  // --- preview.setMode: previewSessionId + closed mode both copied -------------------
  {
    const previewSessionId = uuidv7();
    cases.push({
      kind: "preview.setMode",
      payload: { previewSessionId, mode: "interactive" },
      expectedTarget: { previewSessionId, mode: "interactive" },
      forbiddenSentinels: [],
      forbiddenKeys: [],
    });
  }

  // --- preview.forwardInput: previewSessionId kept, raw input dropped ----------------
  {
    const previewSessionId = uuidv7();
    const key = sentinel("preview.forwardInput.input.key");
    cases.push({
      kind: "preview.forwardInput",
      payload: { previewSessionId, input: { kind: "key", key } },
      expectedTarget: { previewSessionId },
      forbiddenSentinels: [key],
      forbiddenKeys: ["input"],
    });
  }

  // --- preview.setTweak: previewSessionId + tweakId kept, typed value dropped --------
  {
    const previewSessionId = uuidv7();
    const tweakId = sentinel("preview.setTweak.tweakId");
    const value = sentinel("preview.setTweak.value");
    cases.push({
      kind: "preview.setTweak",
      payload: { previewSessionId, tweakId, value: { kind: "string", value } },
      expectedTarget: { previewSessionId, tweakId },
      forbiddenSentinels: [value],
      forbiddenKeys: ["value"],
    });
  }

  // --- preview.queryGeometry: frameToken renamed to frameTokenId, only query.kind kept
  {
    const frameToken = uuidv7();
    const x = numberSentinel();
    const y = numberSentinel();
    cases.push({
      kind: "preview.queryGeometry",
      payload: { frameToken, query: { kind: "hit", x, y } },
      expectedTarget: { frameTokenId: frameToken, queryKind: "hit" },
      forbiddenSentinels: [String(x), String(y)],
      forbiddenKeys: ["query", "frameToken"],
    });
  }

  // --- previewSessionId-only targets --------------------------------------------------
  for (const kind of ["preview.retry", "preview.close"] as const) {
    const previewSessionId = uuidv7();
    cases.push({
      kind,
      payload: { previewSessionId },
      expectedTarget: { previewSessionId },
      forbiddenSentinels: [],
      forbiddenKeys: [],
    });
  }

  // --- selection.set: pageSlug + elementId both copied --------------------------------
  {
    const pageSlug = slug();
    const elementId = sentinel("selection.set.elementId");
    cases.push({
      kind: "selection.set",
      payload: { pageSlug, elementId },
      expectedTarget: { pageSlug, elementId },
      forbiddenSentinels: [],
      forbiddenKeys: [],
    });
  }

  // --- pin.create: geometryToken renamed to geometryTokenId, pin text dropped --------
  {
    const geometryToken = uuidv7();
    const text = sentinel("pin.create.text");
    cases.push({
      kind: "pin.create",
      payload: { geometryToken, text },
      expectedTarget: { geometryTokenId: geometryToken },
      forbiddenSentinels: [text],
      forbiddenKeys: ["text", "geometryToken"],
    });
  }

  // --- pin.setStatus: pinId + status both copied ---------------------------------------
  {
    const pinId = uuidv7();
    cases.push({
      kind: "pin.setStatus",
      payload: { pinId, status: "resolved" },
      expectedTarget: { pinId, status: "resolved" },
      forbiddenSentinels: [],
      forbiddenKeys: [],
    });
  }

  // --- restore.confirm: restorePlanId kept, acknowledgement dropped --------------------
  {
    const restorePlanId = uuidv7();
    cases.push({
      kind: "restore.confirm",
      payload: { restorePlanId, overwriteAcknowledged: true },
      expectedTarget: { restorePlanId },
      forbiddenSentinels: [],
      forbiddenKeys: ["overwriteAcknowledged"],
    });
  }

  // --- restorePlanId-only / restoreActionId-only targets --------------------------------
  {
    const restorePlanId = uuidv7();
    cases.push({
      kind: "restore.discardPlan",
      payload: { restorePlanId },
      expectedTarget: { restorePlanId },
      forbiddenSentinels: [],
      forbiddenKeys: [],
    });
  }
  {
    const restoreActionId = uuidv7();
    cases.push({
      kind: "restore.retryRecord",
      payload: { restoreActionId },
      expectedTarget: { restoreActionId },
      forbiddenSentinels: [],
      forbiddenKeys: [],
    });
  }

  // --- commit.plan: closed scope copied --------------------------------------------------
  cases.push({
    kind: "commit.plan",
    payload: { scope: "whole-project" },
    expectedTarget: { scope: "whole-project" },
    forbiddenSentinels: [],
    forbiddenKeys: [],
  });

  // --- commit.confirm: commitPlanId kept, message + acknowledgement dropped --------------
  {
    const commitPlanId = uuidv7();
    const message = sentinel("commit.confirm.message");
    cases.push({
      kind: "commit.confirm",
      payload: { commitPlanId, message, warningAcknowledged: true },
      expectedTarget: { commitPlanId },
      forbiddenSentinels: [message],
      forbiddenKeys: ["message", "warningAcknowledged"],
    });
  }

  // --- commitPlanId-only target -----------------------------------------------------------
  {
    const commitPlanId = uuidv7();
    cases.push({
      kind: "commit.discardPlan",
      payload: { commitPlanId },
      expectedTarget: { commitPlanId },
      forbiddenSentinels: [],
      forbiddenKeys: [],
    });
  }

  // --- migration.confirm: migrationPlanId kept, acknowledged dropped ---------------------
  {
    const migrationPlanId = uuidv7();
    cases.push({
      kind: "migration.confirm",
      payload: { migrationPlanId, acknowledged: true },
      expectedTarget: { migrationPlanId },
      forbiddenSentinels: [],
      forbiddenKeys: ["acknowledged"],
    });
  }

  // --- migrationPlanId-only / migrationActionId-only targets -----------------------------
  {
    const migrationPlanId = uuidv7();
    cases.push({
      kind: "migration.discardPlan",
      payload: { migrationPlanId },
      expectedTarget: { migrationPlanId },
      forbiddenSentinels: [],
      forbiddenKeys: [],
    });
  }
  {
    const migrationActionId = uuidv7();
    cases.push({
      kind: "migration.retryRecovery",
      payload: { migrationActionId },
      expectedTarget: { migrationActionId },
      forbiddenSentinels: [],
      forbiddenKeys: [],
    });
  }

  return cases;
}

const cases = buildCases();

describe("capabilityTargetExtractors — §10.1 exhaustive security property", () => {
  test("the case table covers all 48 command kinds, each exactly once", () => {
    const kinds = cases.map((c) => c.kind).sort();
    expect(kinds).toEqual([...COMMAND_KINDS_V1].sort());
    expect(new Set(kinds).size).toBe(48);
  });

  test("test self-check: every forbidden sentinel really is present in its own payload", () => {
    for (const c of cases) {
      const payloadJson = JSON.stringify(c.payload);
      for (const s of c.forbiddenSentinels) {
        expect(
          payloadJson.includes(s),
          `${c.kind}: sentinel "${s}" is missing from its own payload`,
        ).toBe(true);
      }
    }
  });

  test("no forbidden field, sentinel value, or forbidden key survives extraction — for every one of the 43 kinds", () => {
    for (const c of cases) {
      // Indexing the map yields the UNION of all 43 differently-typed extractors, whose
      // parameter narrows to `never`; this case table is deliberately heterogeneous, so a
      // single common call signature is the honest shape here.
      const extractor = capabilityTargetExtractors[c.kind] as AnyTargetExtractor;
      const target = extractor(c.payload);

      expect(target instanceof Error, `${c.kind}: extraction unexpectedly failed`).toBe(false);
      if (target instanceof Error) continue;

      expect(target, `${c.kind}: target shape mismatch`).toEqual(c.expectedTarget);

      const targetJson = JSON.stringify(target);
      for (const s of c.forbiddenSentinels) {
        expect(
          targetJson.includes(s),
          `${c.kind}: forbidden sentinel "${s}" leaked into the target`,
        ).toBe(false);
      }
      for (const key of c.forbiddenKeys) {
        const hasKey =
          target !== null &&
          typeof target === "object" &&
          Object.prototype.hasOwnProperty.call(target, key);
        expect(hasKey, `${c.kind}: forbidden key "${key}" is present on the target`).toBe(false);
      }
    }
  });
});

describe("null targets (§10.1 row 1)", () => {
  const nullKinds = new Set<CommandKindV1>([
    "project.create",
    "project.open",
    "project.close",
    "turn.start",
    "chat.create",
    "page.reorder",
    "selection.clear",
    "export.start",
    "migration.plan",
  ]);

  test("the spec fixes exactly nine null-target kinds", () => {
    expect(nullKinds.size).toBe(9);
  });

  test("each returns literal null — not undefined, not an empty object", () => {
    for (const c of cases) {
      if (!nullKinds.has(c.kind)) continue;
      const extractor = capabilityTargetExtractors[c.kind] as AnyTargetExtractor;
      const target = extractor(c.payload);
      expect(target, `${c.kind}: expected literal null`).toBeNull();
      expect(target, `${c.kind}: got undefined instead of null`).not.toBeUndefined();
      // JSON.stringify(undefined) === undefined and JSON.stringify({}) === "{}" — only a
      // literal null serializes to the four-character string "null".
      expect(JSON.stringify(target), `${c.kind}: did not serialize as literal null`).toBe("null");
    }
  });
});

describe("the frameToken/geometryToken naming trap (§10.1 vs. §8.2)", () => {
  test("preview.queryGeometry renames payload's frameToken to target's frameTokenId", () => {
    const frameToken = uuidv7();
    const target = extractCapabilityTarget("preview.queryGeometry", {
      frameToken,
      query: { kind: "layout" },
    });
    expect(target).toEqual({ frameTokenId: frameToken, queryKind: "layout" });
  });

  test("pin.create renames payload's geometryToken to target's geometryTokenId", () => {
    const geometryToken = uuidv7();
    const target = extractCapabilityTarget("pin.create", { geometryToken, text: "hello" });
    expect(target).toEqual({ geometryTokenId: geometryToken });
  });
});

describe("§10.1 ordering rule: validate CommandPayloadByKindV1 before extracting", () => {
  test("returns CapabilityTargetExtractionError, not a target, for a payload that fails its own kind's schema", () => {
    const result = extractCapabilityTarget("turn.cancel", { turnId: "not-a-uuid" });
    expect(result).toBeInstanceOf(CapabilityTargetExtractionError);
  });

  test("rejects a payload shaped for a different kind", () => {
    // chat.switch requires chatId; turn.cancel's shape does not satisfy it.
    const result = extractCapabilityTarget("chat.switch", { turnId: uuidv7() });
    expect(result).toBeInstanceOf(CapabilityTargetExtractionError);
  });

  test("rejects non-object payloads outright, for every kind", () => {
    for (const bad of [null, undefined, "nope", 42, [], Symbol("nope")]) {
      const result = extractCapabilityTarget("turn.cancel", bad);
      expect(result).toBeInstanceOf(CapabilityTargetExtractionError);
    }
  });
});

describe("capabilityTargetExtractors map", () => {
  test("is total over exactly the 44 command kinds — no missing or extra key", () => {
    const keys = Object.keys(capabilityTargetExtractors).sort();
    expect(keys).toEqual([...COMMAND_KINDS_V1].sort());
  });
});
