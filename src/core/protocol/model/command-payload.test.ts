import { describe, expect, test } from "bun:test"

import { uuidv7 } from "infrastructure/uuid"

import { COMMAND_KINDS_V1, type CommandKindV1 } from "./command-kind"
import { commandPayloadSchemaFor, commandPayloadSchemas } from "./command-payload"

const SHA = "a".repeat(40)

interface Fixture {
  readonly valid: unknown
  readonly breaks: readonly unknown[]
}

/**
 * One valid payload plus at least one unknown-key break and one wrong-type/edge break per
 * kernel-command-contract §8.2 row. Field names for prose-only rows are pinned to the
 * choices documented in command-payload.ts; a name drift there must fail here too.
 */
const FIXTURES: Record<CommandKindV1, Fixture> = {
  "project.create": {
    valid: {
      root: "/abs/project",
      creationDefaults: { trust: "trusted", workspaceIdentity: "ws-1" },
      text: "build me a dashboard",
    },
    breaks: [
      {
        root: "/abs/project",
        creationDefaults: { trust: "trusted", workspaceIdentity: "ws-1" },
        text: "hi",
        extra: 1,
      },
      { root: "", creationDefaults: { trust: "trusted", workspaceIdentity: "ws-1" }, text: "hi" },
      { root: "/abs/project", creationDefaults: { trust: "trusted" }, text: "hi" },
      { root: "/abs/project", creationDefaults: { trust: "trusted", workspaceIdentity: "w" }, text: "" },
    ],
  },
  "project.open": {
    valid: { root: "/abs/project" },
    breaks: [{ root: "/abs/project", extra: 1 }, { root: "" }, {}],
  },
  "project.retryOpen": {
    valid: { recovery: { kind: "restore", restoreActionId: uuidv7() } },
    breaks: [
      { recovery: { kind: "restore", restoreActionId: uuidv7(), extra: 1 } },
      { recovery: { kind: "unknown", restoreActionId: uuidv7() } },
      { recovery: { kind: "restore", restoreActionId: "not-a-uuid" } },
    ],
  },
  "project.close": {
    valid: {},
    breaks: [{ extra: 1 }, "not-an-object"],
  },
  "project.setTrust": {
    valid: { trust: "trusted", workspaceIdentity: "ws-1" },
    breaks: [
      { trust: "trusted", workspaceIdentity: "ws-1", extra: 1 },
      { trust: "unknown", workspaceIdentity: "ws-1" },
      { workspaceIdentity: "ws-1" },
    ],
  },
  "turn.start": {
    valid: { text: "hello there" },
    breaks: [{ text: "hello", extra: 1 }, { text: "" }, { text: 5 }],
  },
  "turn.cancel": {
    valid: { turnId: uuidv7() },
    breaks: [{ turnId: uuidv7(), extra: 1 }, { turnId: "not-a-uuid" }, {}],
  },
  "chat.create": {
    valid: {},
    breaks: [{ extra: 1 }, "nope"],
  },
  "chat.switch": {
    valid: { chatId: uuidv7() },
    breaks: [{ chatId: uuidv7(), extra: 1 }, { chatId: "not-a-uuid" }, {}],
  },
  "model.select": {
    valid: { backend: "claude", model: "claude-opus-4-8", effort: "high" },
    breaks: [
      { backend: "claude", model: "claude-opus-4-8", effort: "high", extra: 1 },
      { backend: "", model: "claude-opus-4-8", effort: "high" },
      { model: "claude-opus-4-8", effort: "high" },
    ],
  },
  "page.renameTitle": {
    valid: { pageSlug: "dashboard", title: "Dashboard" },
    breaks: [
      { pageSlug: "dashboard", title: "Dashboard", extra: 1 },
      { pageSlug: "NOPE", title: "Dashboard" },
      { pageSlug: "dashboard", title: "" },
    ],
  },
  "page.removePlan": {
    valid: { pageSlug: "dashboard" },
    breaks: [{ pageSlug: "dashboard", extra: 1 }, { pageSlug: "NOPE" }, {}],
  },
  "page.removeConfirm": {
    valid: { pageRemovePlanId: uuidv7() },
    breaks: [{ pageRemovePlanId: uuidv7(), extra: 1 }, { pageRemovePlanId: "bad" }, {}],
  },
  "page.removeDiscardPlan": {
    valid: { pageRemovePlanId: uuidv7() },
    breaks: [{ pageRemovePlanId: uuidv7(), extra: 1 }, { pageRemovePlanId: "bad" }, {}],
  },
  "page.reorder": {
    valid: { pageSlugs: ["dashboard", "settings"] },
    breaks: [
      { pageSlugs: ["dashboard", "settings"], extra: 1 },
      { pageSlugs: ["dashboard", "NOPE"] },
      { pageSlugs: "dashboard" },
    ],
  },
  "history.open": {
    valid: { pageSlug: "dashboard" },
    breaks: [{ pageSlug: "dashboard", extra: 1 }, { pageSlug: "NOPE" }, {}],
  },
  "preview.selectPage": {
    valid: { pageSlug: "dashboard" },
    breaks: [{ pageSlug: "dashboard", extra: 1 }, { pageSlug: "NOPE" }, {}],
  },
  "preview.selectHistorical": {
    valid: { pageSlug: "dashboard", sourceCommit: SHA },
    breaks: [
      { pageSlug: "dashboard", sourceCommit: SHA, extra: 1 },
      { pageSlug: "dashboard", sourceCommit: "" },
      { pageSlug: "dashboard" },
    ],
  },
  "preview.selectCurrent": {
    valid: { pageSlug: "dashboard" },
    breaks: [{ pageSlug: "dashboard", extra: 1 }, { pageSlug: "NOPE" }, {}],
  },
  "preview.resize": {
    valid: { previewSessionId: uuidv7(), width: 80, height: 24 },
    breaks: [
      { previewSessionId: uuidv7(), width: 80, height: 24, extra: 1 },
      { previewSessionId: uuidv7(), width: 0, height: 24 },
      { previewSessionId: uuidv7(), width: 80 },
    ],
  },
  "preview.setThemeCapabilities": {
    valid: { previewSessionId: uuidv7(), themeId: "dark-default", terminalCapabilities: { colorDepth: 24 } },
    breaks: [
      {
        previewSessionId: uuidv7(),
        themeId: "dark-default",
        terminalCapabilities: { colorDepth: 24 },
        extra: 1,
      },
      { previewSessionId: uuidv7(), themeId: "", terminalCapabilities: { colorDepth: 24 } },
      {
        previewSessionId: uuidv7(),
        themeId: "dark-default",
        terminalCapabilities: { colorDepth: 24, mouse: true },
      },
    ],
  },
  "preview.setMode": {
    valid: { previewSessionId: uuidv7(), mode: "interactive" },
    breaks: [
      { previewSessionId: uuidv7(), mode: "interactive", extra: 1 },
      { previewSessionId: uuidv7(), mode: "weird" },
      { previewSessionId: uuidv7() },
    ],
  },
  "preview.forwardInput": {
    valid: { previewSessionId: uuidv7(), input: { kind: "key", key: "Enter" } },
    breaks: [
      { previewSessionId: uuidv7(), input: { kind: "key", key: "Enter", extra: 1 } },
      { previewSessionId: uuidv7(), input: { kind: "unknown" } },
      { previewSessionId: uuidv7(), input: { kind: "key", key: "" } },
    ],
  },
  "preview.setTweak": {
    valid: { previewSessionId: uuidv7(), tweakId: "accent-color", value: { kind: "string", value: "red" } },
    breaks: [
      {
        previewSessionId: uuidv7(),
        tweakId: "accent-color",
        value: { kind: "string", value: "red" },
        extra: 1,
      },
      { previewSessionId: uuidv7(), tweakId: "accent-color", value: { kind: "string", value: 5 } },
      { previewSessionId: uuidv7(), tweakId: "", value: { kind: "string", value: "red" } },
    ],
  },
  "preview.queryGeometry": {
    valid: { frameToken: uuidv7(), query: { kind: "hit", x: 10, y: 4 } },
    breaks: [
      { frameToken: uuidv7(), query: { kind: "hit", x: 10, y: 4 }, extra: 1 },
      { frameToken: uuidv7(), query: { kind: "hit", x: 10 } },
      { frameToken: "not-a-uuid", query: { kind: "hit", x: 10, y: 4 } },
    ],
  },
  "preview.retry": {
    valid: { previewSessionId: uuidv7() },
    breaks: [{ previewSessionId: uuidv7(), extra: 1 }, { previewSessionId: "bad" }, {}],
  },
  "preview.close": {
    valid: { previewSessionId: uuidv7() },
    breaks: [{ previewSessionId: uuidv7(), extra: 1 }, { previewSessionId: "bad" }, {}],
  },
  "selection.set": {
    valid: { pageSlug: "dashboard", elementId: "header" },
    breaks: [
      { pageSlug: "dashboard", elementId: "header", extra: 1 },
      { pageSlug: "dashboard", elementId: "" },
      { pageSlug: "NOPE", elementId: "header" },
    ],
  },
  "selection.clear": {
    valid: {},
    breaks: [{ extra: 1 }, "nope"],
  },
  "pin.create": {
    valid: { geometryToken: uuidv7(), text: "tighten this" },
    breaks: [
      { geometryToken: uuidv7(), text: "tighten this", extra: 1 },
      { geometryToken: "bad", text: "tighten this" },
      { text: "tighten this" },
    ],
  },
  "pin.setStatus": {
    valid: { pinId: uuidv7(), status: "open" },
    breaks: [
      { pinId: uuidv7(), status: "open", extra: 1 },
      { pinId: uuidv7(), status: "archived" },
      { status: "open" },
    ],
  },
  "restore.plan": {
    valid: { pageSlug: "dashboard", sourceCommit: SHA },
    breaks: [
      { pageSlug: "dashboard", sourceCommit: SHA, extra: 1 },
      { pageSlug: "dashboard", sourceCommit: "" },
      { pageSlug: "NOPE", sourceCommit: SHA },
    ],
  },
  "restore.confirm": {
    valid: { restorePlanId: uuidv7(), overwriteAcknowledged: false },
    breaks: [
      { restorePlanId: uuidv7(), overwriteAcknowledged: false, extra: 1 },
      { restorePlanId: uuidv7(), overwriteAcknowledged: "yes" },
      { restorePlanId: uuidv7() },
    ],
  },
  "restore.discardPlan": {
    valid: { restorePlanId: uuidv7() },
    breaks: [{ restorePlanId: uuidv7(), extra: 1 }, { restorePlanId: "bad" }, {}],
  },
  "restore.retryRecord": {
    valid: { restoreActionId: uuidv7() },
    breaks: [{ restoreActionId: uuidv7(), extra: 1 }, { restoreActionId: "bad" }, {}],
  },
  "commit.plan": {
    valid: { scope: "current-page" },
    breaks: [{ scope: "current-page", extra: 1 }, { scope: "unknown" }, {}],
  },
  "commit.confirm": {
    valid: { commitPlanId: uuidv7(), message: "chore: sync termcraft", warningAcknowledged: true },
    breaks: [
      { commitPlanId: uuidv7(), message: "chore: sync termcraft", warningAcknowledged: true, extra: 1 },
      { commitPlanId: uuidv7(), message: "", warningAcknowledged: true },
      { commitPlanId: uuidv7(), message: "chore: sync termcraft", warningAcknowledged: "true" },
    ],
  },
  "commit.discardPlan": {
    valid: { commitPlanId: uuidv7() },
    breaks: [{ commitPlanId: uuidv7(), extra: 1 }, { commitPlanId: "bad" }, {}],
  },
  "export.start": {
    valid: {},
    breaks: [{ extra: 1 }, "nope"],
  },
  "migration.plan": {
    valid: {},
    breaks: [{ extra: 1 }, { scope: { fileKinds: [] } }, { scope: {} }],
  },
  "migration.confirm": {
    valid: { migrationPlanId: uuidv7(), acknowledged: true },
    breaks: [
      { migrationPlanId: uuidv7(), acknowledged: true, extra: 1 },
      { migrationPlanId: uuidv7(), acknowledged: false },
      { migrationPlanId: uuidv7() },
    ],
  },
  "migration.discardPlan": {
    valid: { migrationPlanId: uuidv7() },
    breaks: [{ migrationPlanId: uuidv7(), extra: 1 }, { migrationPlanId: "bad" }, {}],
  },
  "migration.retryRecovery": {
    valid: { migrationActionId: uuidv7() },
    breaks: [{ migrationActionId: uuidv7(), extra: 1 }, { migrationActionId: "bad" }, {}],
  },
}

describe("commandPayloadSchemas", () => {
  test("covers exactly the 43 v1 command kinds — no missing or extra entry", () => {
    expect(Object.keys(commandPayloadSchemas).sort()).toEqual([...COMMAND_KINDS_V1].sort())
  })

  for (const kind of COMMAND_KINDS_V1) {
    test(`${kind}: accepts its valid payload and rejects every break`, () => {
      const schema = commandPayloadSchemas[kind]
      const fixture = FIXTURES[kind]
      expect(schema.safeParse(fixture.valid).success).toBe(true)
      for (const bad of fixture.breaks) {
        expect(schema.safeParse(bad).success).toBe(false)
      }
    })
  }
})

describe("commandPayloadSchemaFor", () => {
  test("returns the exact same schema instance the map holds", () => {
    for (const kind of COMMAND_KINDS_V1) {
      expect(commandPayloadSchemaFor(kind)).toBe(commandPayloadSchemas[kind])
    }
  })
})

describe("project.retryOpen — closed recovery discriminated union", () => {
  test("accepts all three recovery kinds", () => {
    const schema = commandPayloadSchemas["project.retryOpen"]
    expect(schema.safeParse({ recovery: { kind: "restore", restoreActionId: uuidv7() } }).success).toBe(
      true,
    )
    expect(schema.safeParse({ recovery: { kind: "export", operationId: uuidv7() } }).success).toBe(true)
    expect(
      schema.safeParse({ recovery: { kind: "migration", migrationActionId: uuidv7() } }).success,
    ).toBe(true)
  })

  test("rejects a variant carrying another variant's id field", () => {
    const schema = commandPayloadSchemas["project.retryOpen"]
    expect(schema.safeParse({ recovery: { kind: "restore", operationId: uuidv7() } }).success).toBe(
      false,
    )
  })
})

describe("preview.queryGeometry — closed hit/rect/describe/layout/pin-anchor query union", () => {
  const schema = commandPayloadSchemas["preview.queryGeometry"]
  const frameToken = uuidv7()

  test("accepts every closed query kind", () => {
    expect(schema.safeParse({ frameToken, query: { kind: "hit", x: 1, y: 2 } }).success).toBe(true)
    expect(schema.safeParse({ frameToken, query: { kind: "rect", elementId: "header" } }).success).toBe(
      true,
    )
    expect(
      schema.safeParse({ frameToken, query: { kind: "describe", elementId: "header" } }).success,
    ).toBe(true)
    expect(schema.safeParse({ frameToken, query: { kind: "layout" } }).success).toBe(true)
    expect(schema.safeParse({ frameToken, query: { kind: "pin-anchor", x: 1, y: 2 } }).success).toBe(
      true,
    )
  })

  test("rejects an unlisted query kind", () => {
    expect(schema.safeParse({ frameToken, query: { kind: "scroll" } }).success).toBe(false)
  })

  test("rejects a layout query carrying extra fields", () => {
    expect(schema.safeParse({ frameToken, query: { kind: "layout", x: 1 } }).success).toBe(false)
  })
})

describe("preview.forwardInput — closed key/click/mousemove union", () => {
  const schema = commandPayloadSchemas["preview.forwardInput"]
  const previewSessionId = uuidv7()

  test("accepts every closed input kind", () => {
    expect(
      schema.safeParse({ previewSessionId, input: { kind: "key", key: "Enter" } }).success,
    ).toBe(true)
    expect(
      schema.safeParse({ previewSessionId, input: { kind: "click", x: 1, y: 2, button: "left" } })
        .success,
    ).toBe(true)
    expect(
      schema.safeParse({ previewSessionId, input: { kind: "mousemove", x: 1, y: 2 } }).success,
    ).toBe(true)
  })

  test("rejects a click missing its button", () => {
    expect(schema.safeParse({ previewSessionId, input: { kind: "click", x: 1, y: 2 } }).success).toBe(
      false,
    )
  })
})

describe("preview.setTweak — closed string/number/boolean tweak value union", () => {
  const schema = commandPayloadSchemas["preview.setTweak"]
  const previewSessionId = uuidv7()

  test("accepts every closed tweak value kind", () => {
    expect(
      schema.safeParse({
        previewSessionId,
        tweakId: "accent-color",
        value: { kind: "string", value: "red" },
      }).success,
    ).toBe(true)
    expect(
      schema.safeParse({
        previewSessionId,
        tweakId: "accent-color",
        value: { kind: "number", value: 42 },
      }).success,
    ).toBe(true)
    expect(
      schema.safeParse({
        previewSessionId,
        tweakId: "accent-color",
        value: { kind: "boolean", value: true },
      }).success,
    ).toBe(true)
  })

  test("rejects an unlisted tweak value kind", () => {
    expect(
      schema.safeParse({ previewSessionId, tweakId: "accent-color", value: { kind: "object", value: {} } })
        .success,
    ).toBe(false)
  })
})

describe("project.setTrust — closed trust enum", () => {
  test("accepts both trust values", () => {
    const schema = commandPayloadSchemas["project.setTrust"]
    expect(schema.safeParse({ trust: "trusted", workspaceIdentity: "ws-1" }).success).toBe(true)
    expect(
      schema.safeParse({ trust: "untrusted-read-only", workspaceIdentity: "ws-1" }).success,
    ).toBe(true)
  })
})

describe("preview.setMode — closed mode enum", () => {
  test("accepts both static and interactive modes", () => {
    const schema = commandPayloadSchemas["preview.setMode"]
    const previewSessionId = uuidv7()
    expect(schema.safeParse({ previewSessionId, mode: "static" }).success).toBe(true)
    expect(schema.safeParse({ previewSessionId, mode: "interactive" }).success).toBe(true)
  })
})

describe("pin.setStatus — closed status enum", () => {
  test("accepts both open and resolved statuses", () => {
    const schema = commandPayloadSchemas["pin.setStatus"]
    const pinId = uuidv7()
    expect(schema.safeParse({ pinId, status: "open" }).success).toBe(true)
    expect(schema.safeParse({ pinId, status: "resolved" }).success).toBe(true)
  })
})

describe("commit.plan — closed scope enum", () => {
  test("accepts all three commit scopes", () => {
    const schema = commandPayloadSchemas["commit.plan"]
    expect(schema.safeParse({ scope: "current-page" }).success).toBe(true)
    expect(schema.safeParse({ scope: "infrastructure" }).success).toBe(true)
    expect(schema.safeParse({ scope: "whole-project" }).success).toBe(true)
  })
})

describe("migration.plan — empty or typed selected file-kind scope", () => {
  const schema = commandPayloadSchemas["migration.plan"]

  test("accepts the exact empty object", () => {
    expect(schema.safeParse({}).success).toBe(true)
  })

  test("accepts a typed selected file-kind scope", () => {
    expect(schema.safeParse({ scope: { fileKinds: ["legacy-page"] } }).success).toBe(true)
  })

  test("rejects a non-empty fileKinds-less scope and an empty fileKinds list", () => {
    expect(schema.safeParse({ scope: {} }).success).toBe(false)
    expect(schema.safeParse({ scope: { fileKinds: [] } }).success).toBe(false)
  })
})

describe("pin.create — geometryToken plus text, no other identity", () => {
  const schema = commandPayloadSchemas["pin.create"]

  test("allows empty pin text, matching the stored PinDtoV1 convention", () => {
    expect(schema.safeParse({ geometryToken: uuidv7(), text: "" }).success).toBe(true)
  })

  test("rejects a page/element/rectangle riding along with the token", () => {
    expect(
      schema.safeParse({ geometryToken: uuidv7(), text: "note", pageSlug: "dashboard" }).success,
    ).toBe(false)
  })
})

describe("page.reorder — exact permutation of listed slugs", () => {
  const schema = commandPayloadSchemas["page.reorder"]

  test("accepts the empty permutation", () => {
    expect(schema.safeParse({ pageSlugs: [] }).success).toBe(true)
  })
})
