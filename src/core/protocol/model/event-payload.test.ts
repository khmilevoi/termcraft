import { describe, expect, test } from "bun:test"

import { uuidv7 } from "infrastructure/uuid"

import { EVENT_KINDS_V1, EVENT_KIND_COUNT } from "./event-kind"
import {
  chatChangedPayloadV1Schema,
  commitPlanReadyPayloadV1Schema,
  commitStartedPayloadV1Schema,
  commitTerminalPayloadV1Schema,
  diagnosticsChangedPayloadV1Schema,
  eventPayloadV1SchemaByKind,
  exportProgressPayloadV1Schema,
  exportStartedPayloadV1Schema,
  exportTerminalPayloadV1Schema,
  gitStatusChangedPayloadV1Schema,
  kernelCapabilitiesChangedPayloadV1Schema,
  kernelSnapshotPayloadV1Schema,
  kernelStateChangedPayloadV1Schema,
  migrationFailedPayloadV1Schema,
  migrationPlanReadyPayloadV1Schema,
  migrationProgressPayloadV1Schema,
  migrationStartedPayloadV1Schema,
  migrationTerminalPayloadV1Schema,
  pageDescriptorsChangedPayloadV1Schema,
  pageRemovePlanReadyPayloadV1Schema,
  pinsChangedPayloadV1Schema,
  previewBackpressurePayloadV1Schema,
  previewCircuitOpenedPayloadV1Schema,
  previewFailurePayloadV1Schema,
  previewGeometryResultPayloadV1Schema,
  previewSessionReadyPayloadV1Schema,
  previewSourceChangedPayloadV1Schema,
  restorePlanReadyPayloadV1Schema,
  restoreRecordPendingPayloadV1Schema,
  restoreStartedPayloadV1Schema,
  restoreTerminalPayloadV1Schema,
  selectionChangedPayloadV1Schema,
  turnApplyStartedPayloadV1Schema,
  turnAttemptStartedPayloadV1Schema,
  turnGateRejectedPayloadV1Schema,
  turnProgressPayloadV1Schema,
  turnStartedPayloadV1Schema,
  turnTerminalPayloadV1Schema,
} from "./event-payload"

const SHA = "a".repeat(64)
const NONCE = "c".repeat(32)
const uid = () => uuidv7()
const DEADLINE = "2026-07-21T10:00:00Z"

/** Every payload schema must reject an unexpected top-level key (KCC §9: "Unknown payload keys are invalid"). */
function expectStrict(schema: { safeParse: (v: unknown) => { success: boolean } }, valid: object) {
  expect(schema.safeParse(valid).success).toBe(true)
  expect(schema.safeParse({ ...valid, unexpectedKey: "x" }).success).toBe(false)
}

describe("eventPayloadV1SchemaByKind closure", () => {
  test("has exactly one schema per EventKindV1, in the same order, with no extras", () => {
    const keys = Object.keys(eventPayloadV1SchemaByKind)
    expect(keys.length).toBe(EVENT_KIND_COUNT)
    expect(keys).toEqual([...EVENT_KINDS_V1])
  })
})

describe("kernelSnapshotPayloadV1Schema", () => {
  const valid = {
    models: {
      project: { tag: "ready" },
      turn: { tag: "idle" },
      restore: { tag: "idle" },
      commit: { tag: "idle" },
      export: { tag: "idle" },
      preview: { tag: "idle" },
      migration: { tag: "idle" },
    },
    projectId: uid(),
    activePageSlug: "dashboard",
    activeChatId: uid(),
    trust: "trusted",
    capabilities: [{ id: "turn.start", target: null, state: { available: true } }],
    pageDescriptors: [],
    gitStatus: { repositoryId: "repo-1", head: SHA, sequencerState: "idle", scopes: {} },
    eventSeq: "42",
  }

  test("accepts a complete snapshot and rejects an unknown key", () => {
    expectStrict(kernelSnapshotPayloadV1Schema, valid)
  })

  test("requires nullable identities to be explicit null, never omitted", () => {
    const { projectId: _dropped, ...missing } = valid
    expect(kernelSnapshotPayloadV1Schema.safeParse(missing).success).toBe(false)
    expect(kernelSnapshotPayloadV1Schema.safeParse({ ...valid, projectId: null }).success).toBe(true)
  })

  test("accepts a null trust before the project reaches ready", () => {
    expect(kernelSnapshotPayloadV1Schema.safeParse({ ...valid, trust: null }).success).toBe(true)
  })

  test("accepts both of the two fixed trust states (§7.1, KCC:193)", () => {
    const trustStates = ["trusted", "untrusted-read-only"]
    expect(trustStates.length).toBe(2)
    for (const trust of trustStates) {
      expect(kernelSnapshotPayloadV1Schema.safeParse({ ...valid, trust }).success).toBe(true)
    }
  })

  test("rejects a non-canonical eventSeq", () => {
    expect(kernelSnapshotPayloadV1Schema.safeParse({ ...valid, eventSeq: "007" }).success).toBe(false)
  })
})

describe("kernelStateChangedPayloadV1Schema", () => {
  const valid = {
    modelId: "kernel.turn.state",
    action: "kernel.turn.beginAdmission",
    previousTag: "idle",
    nextTag: "admitting",
    metadata: {},
  }

  test("accepts a valid transition and rejects an unknown key", () => {
    expectStrict(kernelStateChangedPayloadV1Schema, valid)
  })

  test("rejects a modelId outside the seven fixed state-atom names", () => {
    expect(kernelStateChangedPayloadV1Schema.safeParse({ ...valid, modelId: "kernel.chat.state" }).success).toBe(
      false,
    )
  })

  test("accepts every one of the seven fixed state-atom modelIds (§6 factory table, KCC:170-176)", () => {
    const modelIds = [
      "kernel.project.state",
      "kernel.turn.state",
      "kernel.restore.state",
      "kernel.commit.state",
      "kernel.export.state",
      "kernel.preview.state",
      "kernel.migration.state",
    ]
    expect(modelIds.length).toBe(7)
    for (const modelId of modelIds) {
      expect(kernelStateChangedPayloadV1Schema.safeParse({ ...valid, modelId }).success).toBe(true)
    }
  })
})

describe("kernelCapabilitiesChangedPayloadV1Schema", () => {
  const valid = {
    changed: [{ id: "turn.start", target: null, state: { available: true } }],
    removed: [{ id: "turn.cancel", target: { turnId: uid() } }],
  }

  test("accepts a diff and rejects an unknown key", () => {
    expectStrict(kernelCapabilitiesChangedPayloadV1Schema, valid)
  })

  test("rejects an unavailable state missing its non-empty reasons", () => {
    const bad = { changed: [{ id: "turn.start", target: null, state: { available: false, reasons: [] } }], removed: [] }
    expect(kernelCapabilitiesChangedPayloadV1Schema.safeParse(bad).success).toBe(false)
  })
})

describe("pageRemovePlanReadyPayloadV1Schema", () => {
  test("is exactly the shared PageRemovePlanV1 shape", () => {
    const valid = {
      pageRemovePlanId: uid(),
      pageSlug: "dashboard",
      sourceHash: SHA,
      orderedPageSlugs: ["dashboard"],
      pageOrderHash: SHA,
      activePageSlug: "dashboard",
      fallbackPageSlug: null,
      planRevision: "1",
    }
    expectStrict(pageRemovePlanReadyPayloadV1Schema, valid)
  })
})

describe("pageDescriptorsChangedPayloadV1Schema", () => {
  const valid = {
    reason: "turn-apply",
    descriptors: [],
    changes: [],
    activePageSlug: "dashboard",
  }

  test("accepts a valid change set and rejects an unknown key", () => {
    expectStrict(pageDescriptorsChangedPayloadV1Schema, valid)
  })

  test("rejects a reason outside the closed 8-member union", () => {
    expect(pageDescriptorsChangedPayloadV1Schema.safeParse({ ...valid, reason: "hot-reload" }).success).toBe(false)
  })

  test("accepts every one of the eight fixed reasons, verbatim (§9, KCC:797)", () => {
    const reasons = [
      "project-open",
      "turn-apply",
      "restore",
      "migration",
      "rename-title",
      "remove-page",
      "reorder-pages",
      "external-refresh",
    ]
    expect(reasons.length).toBe(8)
    for (const reason of reasons) {
      expect(pageDescriptorsChangedPayloadV1Schema.safeParse({ ...valid, reason }).success).toBe(true)
    }
  })

  test("requires an explicit null active page slug, not omission", () => {
    const { activePageSlug: _dropped, ...missing } = valid
    expect(pageDescriptorsChangedPayloadV1Schema.safeParse(missing).success).toBe(false)
  })
})

describe("turnStartedPayloadV1Schema", () => {
  const valid = { turnId: uid(), chatId: uid(), deadline: DEADLINE }

  test("accepts a valid start and rejects an unknown key", () => {
    expectStrict(turnStartedPayloadV1Schema, valid)
  })

  test("rejects a non-RFC3339 deadline", () => {
    expect(turnStartedPayloadV1Schema.safeParse({ ...valid, deadline: "2026-07-21" }).success).toBe(false)
  })
})

describe("turnAttemptStartedPayloadV1Schema", () => {
  const valid = { turnId: uid(), attempt: 1, deadline: DEADLINE }

  test("accepts attempt 1 and rejects an unknown key", () => {
    expectStrict(turnAttemptStartedPayloadV1Schema, valid)
  })

  test("bounds attempt to the integer range 1 through 4", () => {
    expect(turnAttemptStartedPayloadV1Schema.safeParse({ ...valid, attempt: 0 }).success).toBe(false)
    expect(turnAttemptStartedPayloadV1Schema.safeParse({ ...valid, attempt: 5 }).success).toBe(false)
    expect(turnAttemptStartedPayloadV1Schema.safeParse({ ...valid, attempt: 4 }).success).toBe(true)
  })

  test("never carries leaseNonce — it remains internal", () => {
    expect(turnAttemptStartedPayloadV1Schema.safeParse({ ...valid, leaseNonce: "x" }).success).toBe(false)
  })
})

describe("turnProgressPayloadV1Schema", () => {
  const valid = { turnId: uid(), attempt: 1, content: { kind: "reasoning", text: "thinking" } }

  test("accepts a reasoning event and rejects an unknown key", () => {
    expectStrict(turnProgressPayloadV1Schema, valid)
  })

  test("accepts every normalized AgentEvent kind", () => {
    const contents = [
      { kind: "reasoning", text: "t" },
      { kind: "tool", op: "read", target: "main.tsx" },
      { kind: "final", text: "done" },
      { kind: "usage", tokens: { inputTokens: 1, outputTokens: 2, contextPercent: null } },
      { kind: "error", message: "boom" },
    ]
    for (const content of contents) {
      expect(turnProgressPayloadV1Schema.safeParse({ ...valid, content }).success).toBe(true)
    }
  })

  test("rejects an unnormalized progress kind", () => {
    expect(
      turnProgressPayloadV1Schema.safeParse({ ...valid, content: { kind: "vendor-raw", text: "x" } }).success,
    ).toBe(false)
  })
})

describe("turnGateRejectedPayloadV1Schema", () => {
  const valid = {
    turnId: uid(),
    attempt: 2,
    retryNumber: 1,
    diagnostics: {
      errors: [{ kind: "type", code: "TYPE_ERROR", message: "bad type", file: null, line: null, column: null }],
      warnings: [{ kind: "unguarded-timer", message: "setTimeout without guard", line: null, column: null }],
    },
  }

  test("accepts bounded Gate diagnostics and rejects an unknown key", () => {
    expectStrict(turnGateRejectedPayloadV1Schema, valid)
  })

  test("requires an explicit null location, never an omitted one", () => {
    const { file: _dropped, ...errorWithoutFile } = valid.diagnostics.errors[0]!
    const bad = { ...valid, diagnostics: { ...valid.diagnostics, errors: [errorWithoutFile] } }
    expect(turnGateRejectedPayloadV1Schema.safeParse(bad).success).toBe(false)
  })

  test("rejects an error kind outside Gate's fixed FATAL categories", () => {
    const bad = {
      ...valid,
      diagnostics: {
        ...valid.diagnostics,
        errors: [{ kind: "network", code: "X", message: "y", file: null, line: null, column: null }],
      },
    }
    expect(turnGateRejectedPayloadV1Schema.safeParse(bad).success).toBe(false)
  })

  test("accepts every one of Gate's five fixed FATAL error kinds (gate/types.ts GateErrorKind)", () => {
    const errorKinds = ["import", "contract", "type", "manifest", "smoke"]
    expect(errorKinds.length).toBe(5)
    for (const kind of errorKinds) {
      const bad = {
        ...valid,
        diagnostics: { ...valid.diagnostics, errors: [{ ...valid.diagnostics.errors[0]!, kind }] },
      }
      expect(turnGateRejectedPayloadV1Schema.safeParse(bad).success).toBe(true)
    }
  })

  test("accepts every one of Gate's five fixed warning kinds (gate/types.ts GateWarningKind)", () => {
    const warningKinds = [
      "dropped-id",
      "unpointed-element",
      "unguarded-timer",
      "unguarded-randomness",
      "unlisted-navigation",
    ]
    expect(warningKinds.length).toBe(5)
    for (const kind of warningKinds) {
      const bad = {
        ...valid,
        diagnostics: { ...valid.diagnostics, warnings: [{ ...valid.diagnostics.warnings[0]!, kind }] },
      }
      expect(turnGateRejectedPayloadV1Schema.safeParse(bad).success).toBe(true)
    }
  })
})

describe("turnApplyStartedPayloadV1Schema", () => {
  const valid = { turnId: uid(), candidateHash: SHA, affectedPageSlugs: ["dashboard"] }

  test("accepts a valid apply-start and rejects an unknown key", () => {
    expectStrict(turnApplyStartedPayloadV1Schema, valid)
  })
})

describe("turnTerminalPayloadV1Schema (turn.completed/failed/cancelled)", () => {
  const valid = {
    turnId: uid(),
    outcome: "completed",
    changedPages: [{ pageSlug: "dashboard", sourceHash: SHA }],
    warnings: [],
    failure: null,
  }

  test("accepts a completed outcome and rejects an unknown key", () => {
    expectStrict(turnTerminalPayloadV1Schema, valid)
  })

  test("accepts every fixed outcome code", () => {
    for (const outcome of ["completed", "failed", "cancelled", "stale", "interrupted"]) {
      expect(turnTerminalPayloadV1Schema.safeParse({ ...valid, outcome }).success).toBe(true)
    }
  })

  test("rejects an outcome outside the fixed set", () => {
    expect(turnTerminalPayloadV1Schema.safeParse({ ...valid, outcome: "aborted" }).success).toBe(false)
  })

  test("requires an explicit null failure, not omission", () => {
    const { failure: _dropped, ...missing } = valid
    expect(turnTerminalPayloadV1Schema.safeParse(missing).success).toBe(false)
  })
})

describe("restorePlanReadyPayloadV1Schema", () => {
  const valid = {
    restorePlanId: uid(),
    pageSlug: "dashboard",
    sourceCommitId: "a".repeat(40),
    blobHash: "b".repeat(40),
    preRestoreSourceHash: SHA,
    indexState: "clean",
    gateAttestationHash: SHA,
    planRevision: "1",
    willOverwrite: false,
  }

  test("accepts a valid plan and rejects an unknown key", () => {
    expectStrict(restorePlanReadyPayloadV1Schema, valid)
  })

  test("rejects an index state outside the two facts a ready plan can carry", () => {
    expect(restorePlanReadyPayloadV1Schema.safeParse({ ...valid, indexState: "staged" }).success).toBe(false)
  })

  test("rejects an abbreviated (non-FULL) source commit id", () => {
    expect(restorePlanReadyPayloadV1Schema.safeParse({ ...valid, sourceCommitId: "a".repeat(7) }).success).toBe(
      false,
    )
  })

  test("accepts a full 64-character sha256-object-format commit id", () => {
    expect(restorePlanReadyPayloadV1Schema.safeParse({ ...valid, sourceCommitId: SHA }).success).toBe(true)
  })

  test("rejects a gateAttestationHash that is not a Sha256Hex value", () => {
    expect(restorePlanReadyPayloadV1Schema.safeParse({ ...valid, gateAttestationHash: "not-a-hash" }).success).toBe(
      false,
    )
  })
})

describe("restoreStartedPayloadV1Schema / restoreRecordPendingPayloadV1Schema", () => {
  test("restoreStarted accepts a valid start and rejects an unknown key", () => {
    const valid = {
      restorePlanId: uid(),
      restoreActionId: uid(),
      pageSlug: "dashboard",
      sourceCommitId: "a".repeat(40),
      safeTargetChatDisplay: "Chat #3",
    }
    expectStrict(restoreStartedPayloadV1Schema, valid)
  })

  test("restoreRecordPending accepts a valid record-pending and rejects an unknown key", () => {
    const valid = {
      restoreActionId: uid(),
      pageSlug: "dashboard",
      sourceCommitId: "a".repeat(40),
      safeTargetChatDisplay: "Chat #3",
    }
    expectStrict(restoreRecordPendingPayloadV1Schema, valid)
  })
})

describe("restoreTerminalPayloadV1Schema (restore.completed/failed)", () => {
  const valid = {
    restorePlanId: uid(),
    restoreActionId: uid(),
    pageSlug: "dashboard",
    sourceCommitId: "a".repeat(40),
    phase: "executing",
    failure: null,
  }

  test("accepts a valid terminal restore and rejects an unknown key", () => {
    expectStrict(restoreTerminalPayloadV1Schema, valid)
  })

  test("requires restoreActionId explicit null, never omitted", () => {
    const { restoreActionId: _dropped, ...missing } = valid
    expect(restoreTerminalPayloadV1Schema.safeParse(missing).success).toBe(false)
    expect(restoreTerminalPayloadV1Schema.safeParse({ ...valid, restoreActionId: null }).success).toBe(true)
  })

  test("rejects a phase outside the active-phase set", () => {
    expect(restoreTerminalPayloadV1Schema.safeParse({ ...valid, phase: "planning" }).success).toBe(false)
  })

  test("accepts every one of the three fixed phases (§7.3, KCC:289-291)", () => {
    const phases = ["executing", "record-pending", "recovering"]
    expect(phases.length).toBe(3)
    for (const phase of phases) {
      expect(restoreTerminalPayloadV1Schema.safeParse({ ...valid, phase }).success).toBe(true)
    }
  })
})

describe("commitPlanReadyPayloadV1Schema", () => {
  const valid = {
    commitPlanId: uid(),
    scope: "current-page",
    expectedHead: "a".repeat(40),
    paths: [{ path: ".termcraft/pages/dashboard/index.tsx", state: "modified", contentHash: "c".repeat(40) }],
    messageTemplate: "termcraft: update dashboard",
    detachedHeadWarning: false,
  }

  test("accepts a valid plan and rejects an unknown key", () => {
    expectStrict(commitPlanReadyPayloadV1Schema, valid)
  })

  test("accepts a null content hash for a deleted path", () => {
    const withDelete = {
      ...valid,
      paths: [{ path: "x", state: "deleted", contentHash: null }],
    }
    expect(commitPlanReadyPayloadV1Schema.safeParse(withDelete).success).toBe(true)
  })

  test("rejects a scope outside the closed three-scope union", () => {
    expect(commitPlanReadyPayloadV1Schema.safeParse({ ...valid, scope: "everything" }).success).toBe(false)
  })
})

describe("commitStartedPayloadV1Schema", () => {
  test("accepts a valid start and rejects an unknown key", () => {
    const valid = {
      commitPlanId: uid(),
      operationId: uid(),
      scope: "whole-project",
      selectedPaths: [".termcraft/pages/dashboard/index.tsx"],
    }
    expectStrict(commitStartedPayloadV1Schema, valid)
  })
})

describe("commitTerminalPayloadV1Schema (commit.completed/failed)", () => {
  const valid = {
    commitPlanId: uid(),
    operationId: uid(),
    scope: "infrastructure",
    gitStatus: { repositoryId: "repo-1", head: SHA, sequencerState: "idle", scopes: {} },
    failure: null,
  }

  test("accepts a valid terminal commit and rejects an unknown key", () => {
    expectStrict(commitTerminalPayloadV1Schema, valid)
  })
})

describe("exportStartedPayloadV1Schema", () => {
  test("accepts a valid start and rejects an unknown key", () => {
    const valid = {
      operationId: uid(),
      sourceSnapshotDigest: SHA,
      pageCount: 3,
      renderJobCount: 6,
      destination: "export/2026-07-21T10-00-00Z",
    }
    expectStrict(exportStartedPayloadV1Schema, valid)
  })
})

describe("exportProgressPayloadV1Schema", () => {
  const valid = { operationId: uid(), phase: "rendering", completedJobs: 2, totalJobs: 6, pageSlug: "dashboard", sizeBytes: 1024 }

  test("accepts a valid progress tick and rejects an unknown key", () => {
    expectStrict(exportProgressPayloadV1Schema, valid)
  })

  test("accepts explicit null for the nullable page slug and size", () => {
    expect(exportProgressPayloadV1Schema.safeParse({ ...valid, pageSlug: null, sizeBytes: null }).success).toBe(true)
  })

  test("rejects a phase outside rendering/publishing", () => {
    expect(exportProgressPayloadV1Schema.safeParse({ ...valid, phase: "preparing" }).success).toBe(false)
  })
})

describe("exportTerminalPayloadV1Schema (export.completed/failed)", () => {
  const valid = { operationId: uid(), phase: "publishing", destination: "export/2026-07-21T10-00-00Z", generationId: uid(), failure: null }

  test("accepts a valid terminal export and rejects an unknown key", () => {
    expectStrict(exportTerminalPayloadV1Schema, valid)
  })

  test("accepts an explicit null generation id", () => {
    expect(exportTerminalPayloadV1Schema.safeParse({ ...valid, generationId: null }).success).toBe(true)
  })
})

describe("migrationPlanReadyPayloadV1Schema", () => {
  const valid = {
    migrationPlanId: uid(),
    selectedFileKinds: ["page-source"],
    rewriteEntries: [
      { relativePath: "pages/dashboard/index.tsx", fileKind: "page-source", beforeHash: "a".repeat(40), fromVersion: 1, toVersion: 2, sizeBytes: 512 },
    ],
    backupBytes: 4096,
    requiredFreeBytes: 8192,
    planRevision: "1",
  }

  test("accepts a valid plan and rejects an unknown key", () => {
    expectStrict(migrationPlanReadyPayloadV1Schema, valid)
  })

  test("rejects a non-canonical planRevision", () => {
    expect(migrationPlanReadyPayloadV1Schema.safeParse({ ...valid, planRevision: "01" }).success).toBe(false)
  })
})

describe("migrationStartedPayloadV1Schema", () => {
  test("accepts a valid start (locked to phase backing-up) and rejects an unknown key", () => {
    const valid = { migrationPlanId: uid(), migrationActionId: uid(), selectedFileKinds: ["page-source"], phase: "backing-up" }
    expectStrict(migrationStartedPayloadV1Schema, valid)
  })

  test("rejects any phase other than backing-up", () => {
    const valid = { migrationPlanId: uid(), migrationActionId: uid(), selectedFileKinds: [], phase: "transforming" }
    expect(migrationStartedPayloadV1Schema.safeParse(valid).success).toBe(false)
  })
})

describe("migrationProgressPayloadV1Schema", () => {
  const valid = { migrationPlanId: uid(), migrationActionId: uid(), phase: "transforming", completedItems: 1, totalItems: 4, relativePath: "pages/dashboard/index.tsx" }

  test("accepts a valid tick and rejects an unknown key", () => {
    expectStrict(migrationProgressPayloadV1Schema, valid)
  })

  test("accepts an explicit null relative path", () => {
    expect(migrationProgressPayloadV1Schema.safeParse({ ...valid, relativePath: null }).success).toBe(true)
  })

  test("accepts every one of the four fixed phases, verbatim (§9, KCC:816)", () => {
    const phases = ["backing-up", "transforming", "publishing", "recovering"]
    expect(phases.length).toBe(4)
    for (const phase of phases) {
      expect(migrationProgressPayloadV1Schema.safeParse({ ...valid, phase }).success).toBe(true)
    }
  })
})

describe("migrationTerminalPayloadV1Schema (migration.completed only)", () => {
  const valid = {
    migrationPlanId: uid(),
    migrationActionId: uid(),
    transactionId: uid(),
    migratedFileCount: 12,
    resultingVersions: { "page-source": 2 },
    recovered: false,
  }

  test("accepts a valid completion and rejects an unknown key", () => {
    expectStrict(migrationTerminalPayloadV1Schema, valid)
  })
})

describe("migrationFailedPayloadV1Schema (discriminated union)", () => {
  test("accepts the all-null planning variant", () => {
    const planning = {
      migrationPlanId: null,
      migrationActionId: null,
      transactionId: null,
      phase: "planning",
      failure: { code: "MIGRATION_STALE", retryable: true, safeMessage: "plan expired", details: {} },
    }
    expect(migrationFailedPayloadV1Schema.safeParse(planning).success).toBe(true)
    expect(migrationFailedPayloadV1Schema.safeParse({ ...planning, unexpectedKey: "x" }).success).toBe(false)
  })

  test("accepts the post-plan variant with a nullable transactionId", () => {
    const postPlan = {
      migrationPlanId: uid(),
      migrationActionId: uid(),
      transactionId: null,
      phase: "backing-up",
      failure: { code: "MIGRATION_BACKUP_FAILED", retryable: false, safeMessage: "disk full", details: {} },
    }
    expect(migrationFailedPayloadV1Schema.safeParse(postPlan).success).toBe(true)
  })

  test("rejects the planning variant carrying a non-null id — variants cannot mix", () => {
    const mixed = {
      migrationPlanId: uid(),
      migrationActionId: null,
      transactionId: null,
      phase: "planning",
      failure: { code: "MIGRATION_STALE", retryable: true, safeMessage: "x", details: {} },
    }
    expect(migrationFailedPayloadV1Schema.safeParse(mixed).success).toBe(false)
  })

  test("rejects a phase outside the two variants' closed discriminants", () => {
    const bad = {
      migrationPlanId: uid(),
      migrationActionId: uid(),
      transactionId: null,
      phase: "idle",
      failure: { code: "X", retryable: false, safeMessage: "y", details: {} },
    }
    expect(migrationFailedPayloadV1Schema.safeParse(bad).success).toBe(false)
  })
})

describe("previewSourceChangedPayloadV1Schema", () => {
  test("accepts the current-source variant and rejects an unknown key", () => {
    const valid = { previewSessionId: uid(), pageSlug: "dashboard", source: { kind: "current" }, sourceHash: SHA, hostMode: "process" }
    expectStrict(previewSourceChangedPayloadV1Schema, valid)
  })

  test("accepts the historical-source variant with its full commit id", () => {
    const valid = {
      previewSessionId: uid(),
      pageSlug: "dashboard",
      source: { kind: "historical", sourceCommit: "a".repeat(40) },
      sourceHash: SHA,
      hostMode: "process",
    }
    expect(previewSourceChangedPayloadV1Schema.safeParse(valid).success).toBe(true)
  })

  test("rejects a current-source variant carrying a stray sourceCommit", () => {
    const bad = { previewSessionId: uid(), pageSlug: "dashboard", source: { kind: "current", sourceCommit: "x" }, sourceHash: SHA, hostMode: "process" }
    expect(previewSourceChangedPayloadV1Schema.safeParse(bad).success).toBe(false)
  })
})

describe("previewSessionReadyPayloadV1Schema", () => {
  const valid = {
    previewSessionId: uid(),
    nonce: NONCE,
    pageSlug: "dashboard",
    sourceHash: SHA,
    hostMode: "process",
    interactionMode: "static",
    size: { w: 80, h: 24 },
    theme: "dark-default",
    initialFrameSeq: "0",
  }

  test("accepts a valid session and rejects an unknown key", () => {
    expectStrict(previewSessionReadyPayloadV1Schema, valid)
  })

  test("rejects an interaction mode outside static/interactive", () => {
    expect(previewSessionReadyPayloadV1Schema.safeParse({ ...valid, interactionMode: "readonly" }).success).toBe(false)
  })

  test("accepts both fixed interaction modes, verbatim (§10.1, KCC:888)", () => {
    const interactionModes = ["static", "interactive"]
    expect(interactionModes.length).toBe(2)
    for (const interactionMode of interactionModes) {
      expect(previewSessionReadyPayloadV1Schema.safeParse({ ...valid, interactionMode }).success).toBe(true)
    }
  })
})

describe("previewGeometryResultPayloadV1Schema", () => {
  const frameIdentity = { previewSessionId: uid(), nonce: NONCE, sourceHash: SHA, frameSeq: "3" }
  const valid = {
    previewSessionId: uid(),
    frameTokenId: uid(),
    frameIdentity,
    queryKind: "hit",
    result: {},
    geometryToken: uid(),
  }

  test("accepts a resolving hit with a minted geometry token, and rejects an unknown key", () => {
    expectStrict(previewGeometryResultPayloadV1Schema, valid)
  })

  test("accepts a null geometry token for a non-resolving query", () => {
    expect(previewGeometryResultPayloadV1Schema.safeParse({ ...valid, queryKind: "layout", geometryToken: null }).success).toBe(true)
  })

  test("rejects a query kind outside the closed five-member union", () => {
    expect(previewGeometryResultPayloadV1Schema.safeParse({ ...valid, queryKind: "click" }).success).toBe(false)
  })

  test("accepts every one of the five fixed query kinds, verbatim (§10.1, KCC:890)", () => {
    const queryKinds = ["hit", "rect", "describe", "layout", "pin-anchor"]
    expect(queryKinds.length).toBe(5)
    for (const queryKind of queryKinds) {
      expect(previewGeometryResultPayloadV1Schema.safeParse({ ...valid, queryKind }).success).toBe(true)
    }
  })
})

describe("previewBackpressurePayloadV1Schema (preview.backpressured/writable)", () => {
  const valid = { previewSessionId: uid(), nonce: NONCE, queueSize: 200, capacity: 256, lowWaterMark: 128 }

  test("accepts a valid queue state and rejects an unknown key", () => {
    expectStrict(previewBackpressurePayloadV1Schema, valid)
  })
})

describe("previewFailurePayloadV1Schema", () => {
  const valid = {
    previewSessionId: uid(),
    nonce: NONCE,
    pageSlug: "dashboard",
    sourceHash: SHA,
    phase: "starting",
    failure: { code: "HOST_START_FAILED", retryable: true, safeMessage: "host exited", details: {} },
  }

  test("accepts a valid failure and rejects an unknown key", () => {
    expectStrict(previewFailurePayloadV1Schema, valid)
  })

  test("rejects a phase outside starting/switching/live", () => {
    expect(previewFailurePayloadV1Schema.safeParse({ ...valid, phase: "disabled" }).success).toBe(false)
  })

  test("accepts every one of the three fixed phases (§7.6, KCC:365)", () => {
    const phases = ["starting", "switching", "live"]
    expect(phases.length).toBe(3)
    for (const phase of phases) {
      expect(previewFailurePayloadV1Schema.safeParse({ ...valid, phase }).success).toBe(true)
    }
  })
})

describe("previewCircuitOpenedPayloadV1Schema", () => {
  const valid = {
    previewSessionId: uid(),
    pageSlug: "dashboard",
    sourceHash: SHA,
    attempts: 3,
    finalFailure: { code: "HOST_CIRCUIT_OPEN", retryable: false, safeMessage: "budget exhausted", details: {} },
    retryCapability: { available: false, reasons: [{ code: "OPERATION_BUSY" }] },
  }

  test("accepts a valid circuit-open and rejects an unknown key", () => {
    expectStrict(previewCircuitOpenedPayloadV1Schema, valid)
  })
})

describe("chatChangedPayloadV1Schema", () => {
  const valid = {
    activeChatId: uid(),
    added: [{ chatId: uid(), createdAt: DEADLINE }],
    updated: [],
    removedChatIds: [],
  }

  test("accepts a valid diff and rejects an unknown key", () => {
    expectStrict(chatChangedPayloadV1Schema, valid)
  })
})

describe("selectionChangedPayloadV1Schema", () => {
  test("accepts a bound selection", () => {
    const valid = { pageSlug: "dashboard", elementId: "header", sourceHash: SHA }
    expect(selectionChangedPayloadV1Schema.safeParse(valid).success).toBe(true)
    expect(selectionChangedPayloadV1Schema.safeParse({ ...valid, unexpectedKey: "x" }).success).toBe(false)
  })

  test("accepts a bare null payload for no selection", () => {
    expect(selectionChangedPayloadV1Schema.safeParse(null).success).toBe(true)
  })
})

describe("pinsChangedPayloadV1Schema", () => {
  const pin = {
    pinId: uid(),
    pageSlug: "dashboard",
    elementId: "header",
    fx: 0.5,
    fy: 0.5,
    text: "tighten",
    status: "open",
    createdRecordId: uid(),
    latestRecordId: uid(),
    updatedAt: DEADLINE,
  }
  const valid = { pageSlug: "dashboard", affectedPins: [pin], affectedRecordIds: [uid()], causeId: uid() }

  test("accepts a valid batch and rejects an unknown key", () => {
    expectStrict(pinsChangedPayloadV1Schema, valid)
  })
})

describe("gitStatusChangedPayloadV1Schema", () => {
  test("accepts a valid projection and rejects an unknown key", () => {
    const valid = { repositoryId: "repo-1", head: SHA, sequencerState: "idle", scopes: {} }
    expectStrict(gitStatusChangedPayloadV1Schema, valid)
  })

  test("accepts a null HEAD for an unborn repository", () => {
    const valid = { repositoryId: "repo-1", head: null, sequencerState: "idle", scopes: {} }
    expect(gitStatusChangedPayloadV1Schema.safeParse(valid).success).toBe(true)
  })
})

describe("diagnosticsChangedPayloadV1Schema", () => {
  const valid = {
    generation: "5",
    upserts: [
      {
        diagnosticId: uid(),
        scope: "turn",
        severity: "warning",
        code: "UNGUARDED_TIMER",
        safeMessage: "timer is not guarded",
      },
    ],
    removedDiagnosticIds: [uid()],
  }

  test("accepts a valid diff and rejects an unknown key", () => {
    expectStrict(diagnosticsChangedPayloadV1Schema, valid)
  })

  test("rejects a non-canonical generation counter", () => {
    expect(diagnosticsChangedPayloadV1Schema.safeParse({ ...valid, generation: "-1" }).success).toBe(false)
  })
})
