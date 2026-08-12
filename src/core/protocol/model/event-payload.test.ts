import { describe, expect, test } from "bun:test";

import { uuidv7 } from "infrastructure/uuid";

import { EVENT_KINDS_V1, EVENT_KIND_COUNT } from "./event-kind";
import {
  agentIdentityV1Schema,
  chatChangedPayloadV1Schema,
  chatRecordsOlderPayloadV1Schema,
  chatRecordsPayloadV1Schema,
  commitPlanReadyPayloadV1Schema,
  commitStartedPayloadV1Schema,
  commitTerminalPayloadV1Schema,
  designSystemListedPayloadV1Schema,
  designSystemPreviewedPayloadV1Schema,
  diagnosticsChangedPayloadV1Schema,
  eventPayloadV1SchemaByKind,
  exportProgressPayloadV1Schema,
  exportStartedPayloadV1Schema,
  exportTerminalPayloadV1Schema,
  geometryQueryResultV1Schema,
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
} from "./event-payload";

const SHA = "a".repeat(64);
const NONCE = "c".repeat(32);
const uid = () => uuidv7();
const DEADLINE = "2026-07-21T10:00:00Z";

/** Every payload schema must reject an unexpected top-level key (KCC §9: "Unknown payload keys are invalid"). */
function expectStrict(schema: { safeParse: (v: unknown) => { success: boolean } }, valid: object) {
  expect(schema.safeParse(valid).success).toBe(true);
  expect(schema.safeParse({ ...valid, unexpectedKey: "x" }).success).toBe(false);
}

describe("eventPayloadV1SchemaByKind closure", () => {
  test("has exactly one schema per EventKindV1, in the same order, with no extras", () => {
    const keys = Object.keys(eventPayloadV1SchemaByKind);
    expect(keys.length).toBe(EVENT_KIND_COUNT);
    expect(keys).toEqual([...EVENT_KINDS_V1]);
  });
});

describe("kernelSnapshotPayloadV1Schema", () => {
  const validModels = {
    project: { phase: "ready", trust: "trusted" },
    turn: { phase: "idle", activeTurnId: null, commitIntentRecorded: false },
    restore: { phase: "idle" },
    commit: { phase: "idle" },
    export: { phase: "idle" },
    preview: { phase: "disabled", sourceKind: null },
    migration: { phase: "idle" },
  };

  const valid = {
    models: validModels,
    projectId: uid(),
    activePageSlug: "dashboard",
    activeChatId: uid(),
    trust: "trusted",
    capabilities: [{ id: "turn.start", target: null, state: { available: true } }],
    pageDescriptors: [],
    gitStatus: { repositoryId: "repo-1", head: SHA, sequencerState: "idle", scopes: {} },
    agentIdentity: { backendId: "claude", modelLabel: "Claude Sonnet 5" },
    eventSeq: "42",
  };

  test("accepts a complete snapshot and rejects an unknown key", () => {
    expectStrict(kernelSnapshotPayloadV1Schema, valid);
  });

  test("requires nullable identities to be explicit null, never omitted", () => {
    const { projectId: _dropped, ...missing } = valid;
    expect(kernelSnapshotPayloadV1Schema.safeParse(missing).success).toBe(false);
    expect(kernelSnapshotPayloadV1Schema.safeParse({ ...valid, projectId: null }).success).toBe(
      true,
    );
  });

  test("accepts a null trust before the project reaches ready", () => {
    expect(kernelSnapshotPayloadV1Schema.safeParse({ ...valid, trust: null }).success).toBe(true);
  });

  test("accepts both of the two fixed trust states (§7.1, KCC:193)", () => {
    const trustStates = ["trusted", "untrusted-read-only"];
    expect(trustStates.length).toBe(2);
    for (const trust of trustStates) {
      expect(kernelSnapshotPayloadV1Schema.safeParse({ ...valid, trust }).success).toBe(true);
    }
  });

  test("rejects a non-canonical eventSeq", () => {
    expect(kernelSnapshotPayloadV1Schema.safeParse({ ...valid, eventSeq: "007" }).success).toBe(
      false,
    );
  });

  test("rejects a model whose phase is outside its own machine's closed set", () => {
    const bad = {
      ...valid,
      models: { ...validModels, project: { phase: "not-a-real-phase", trust: null } },
    };
    expect(kernelSnapshotPayloadV1Schema.safeParse(bad).success).toBe(false);
  });

  test("rejects a phase that is real but belongs to a DIFFERENT machine's model", () => {
    // "publishing" is a real ExportState/MigrationState member, never a ProjectState one.
    const bad = {
      ...valid,
      models: { ...validModels, project: { phase: "publishing", trust: null } },
    };
    expect(kernelSnapshotPayloadV1Schema.safeParse(bad).success).toBe(false);
  });

  test("accepts every one of the seven models at their machine's real initial phase", () => {
    const initial = {
      project: { phase: "closed", trust: null },
      turn: { phase: "idle", activeTurnId: null, commitIntentRecorded: false },
      restore: { phase: "idle" },
      commit: { phase: "idle" },
      export: { phase: "idle" },
      preview: { phase: "disabled", sourceKind: null },
      migration: { phase: "idle" },
    };
    expect(kernelSnapshotPayloadV1Schema.safeParse({ ...valid, models: initial }).success).toBe(
      true,
    );
  });

  test("rejects a turn model missing commitIntentRecorded — no unknown fields allowed dropped either", () => {
    const { commitIntentRecorded: _dropped, ...turnWithoutIntent } = validModels.turn;
    const bad = { ...valid, models: { ...validModels, turn: turnWithoutIntent } };
    expect(kernelSnapshotPayloadV1Schema.safeParse(bad).success).toBe(false);
  });

  test("accepts a null agentIdentity before any backend is selected", () => {
    expect(kernelSnapshotPayloadV1Schema.safeParse({ ...valid, agentIdentity: null }).success).toBe(
      true,
    );
  });

  test("rejects an agentIdentity missing modelLabel", () => {
    const bad = { ...valid, agentIdentity: { backendId: "claude" } };
    expect(kernelSnapshotPayloadV1Schema.safeParse(bad).success).toBe(false);
  });
});

describe("agentIdentityV1Schema", () => {
  test("accepts null and a complete identity, rejects an unknown key", () => {
    expect(agentIdentityV1Schema.safeParse(null).success).toBe(true);
    expect(
      agentIdentityV1Schema.safeParse({ backendId: "claude", modelLabel: "Claude Sonnet 5" })
        .success,
    ).toBe(true);
    expect(
      agentIdentityV1Schema.safeParse({
        backendId: "claude",
        modelLabel: "Claude Sonnet 5",
        extra: "x",
      }).success,
    ).toBe(false);
  });

  test("rejects an empty backendId or modelLabel", () => {
    expect(
      agentIdentityV1Schema.safeParse({ backendId: "", modelLabel: "Claude Sonnet 5" }).success,
    ).toBe(false);
    expect(agentIdentityV1Schema.safeParse({ backendId: "claude", modelLabel: "" }).success).toBe(
      false,
    );
  });
});

describe("kernelStateChangedPayloadV1Schema", () => {
  const valid = {
    modelId: "kernel.turn.state",
    action: "kernel.turn.beginAdmission",
    previousTag: "idle",
    nextTag: "admitting",
    metadata: {},
  };

  test("accepts a valid transition and rejects an unknown key", () => {
    expectStrict(kernelStateChangedPayloadV1Schema, valid);
  });

  test("rejects a modelId outside the seven fixed state-atom names", () => {
    expect(
      kernelStateChangedPayloadV1Schema.safeParse({ ...valid, modelId: "kernel.chat.state" })
        .success,
    ).toBe(false);
  });

  test("accepts every one of the seven fixed state-atom modelIds (§6 factory table, KCC:170-176)", () => {
    const modelIds = [
      "kernel.project.state",
      "kernel.turn.state",
      "kernel.restore.state",
      "kernel.commit.state",
      "kernel.export.state",
      "kernel.preview.state",
      "kernel.migration.state",
    ];
    expect(modelIds.length).toBe(7);
    for (const modelId of modelIds) {
      expect(kernelStateChangedPayloadV1Schema.safeParse({ ...valid, modelId }).success).toBe(true);
    }
  });

  test("rejects a tag outside every one of the seven machines' phase unions", () => {
    expect(
      kernelStateChangedPayloadV1Schema.safeParse({ ...valid, nextTag: "not-a-real-phase" })
        .success,
    ).toBe(false);
    expect(
      kernelStateChangedPayloadV1Schema.safeParse({ ...valid, previousTag: "not-a-real-phase" })
        .success,
    ).toBe(false);
  });

  test("accepts a tag from ANY of the seven machines — the union is flat, not modelId-scoped", () => {
    // "backing-up" is only ever a MigrationState member, yet this is a turn.state row —
    // the task-2 design choice is a flat union over all seven phases, not one
    // discriminated per modelId (see event-payload.ts's own comment on the choice).
    expect(
      kernelStateChangedPayloadV1Schema.safeParse({ ...valid, nextTag: "backing-up" }).success,
    ).toBe(true);
  });

  test("rejects an action outside every one of the seven machines' closed action sets", () => {
    expect(
      kernelStateChangedPayloadV1Schema.safeParse({ ...valid, action: "kernel.turn.doSomething" })
        .success,
    ).toBe(false);
  });

  test("accepts a real full-name action from each of the seven machines", () => {
    const actions = [
      "kernel.project.beginCreate",
      "kernel.turn.beginAdmission",
      "kernel.restore.beginPlan",
      "kernel.commit.beginPlan",
      "kernel.export.begin",
      "kernel.preview.enable",
      "kernel.migration.beginPlan",
    ];
    expect(actions.length).toBe(7);
    for (const action of actions) {
      expect(kernelStateChangedPayloadV1Schema.safeParse({ ...valid, action }).success).toBe(true);
    }
  });

  test("rejects Project/Turn's bare verb form — the wire action is always the FULL kernel.<domain>.<verb> name", () => {
    expect(
      kernelStateChangedPayloadV1Schema.safeParse({ ...valid, action: "beginAdmission" }).success,
    ).toBe(false);
  });
});

describe("kernelCapabilitiesChangedPayloadV1Schema", () => {
  const valid = {
    changed: [{ id: "turn.start", target: null, state: { available: true } }],
    removed: [{ id: "turn.cancel", target: { turnId: uid() } }],
  };

  test("accepts a diff and rejects an unknown key", () => {
    expectStrict(kernelCapabilitiesChangedPayloadV1Schema, valid);
  });

  test("rejects an unavailable state missing its non-empty reasons", () => {
    const bad = {
      changed: [{ id: "turn.start", target: null, state: { available: false, reasons: [] } }],
      removed: [],
    };
    expect(kernelCapabilitiesChangedPayloadV1Schema.safeParse(bad).success).toBe(false);
  });

  test("accepts the real per-kind target shape from Task 1's capability-target table", () => {
    const withRealTarget = {
      changed: [
        {
          id: "preview.setMode",
          target: { previewSessionId: uid(), mode: "static" },
          state: { available: true },
        },
      ],
      removed: [],
    };
    expect(kernelCapabilitiesChangedPayloadV1Schema.safeParse(withRealTarget).success).toBe(true);
  });

  test("rejects a target shape that matches none of the 43 real kinds", () => {
    const bad = {
      changed: [
        {
          id: "turn.start",
          target: { bogusField: "not a real target shape" },
          state: { available: true },
        },
      ],
      removed: [],
    };
    expect(kernelCapabilitiesChangedPayloadV1Schema.safeParse(bad).success).toBe(false);
  });
});

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
    };
    expectStrict(pageRemovePlanReadyPayloadV1Schema, valid);
  });
});

describe("pageDescriptorsChangedPayloadV1Schema", () => {
  const valid = {
    reason: "turn-apply",
    descriptors: [],
    changes: [],
    activePageSlug: "dashboard",
    treeRevision: SHA,
  };

  test("accepts a valid change set and rejects an unknown key", () => {
    expectStrict(pageDescriptorsChangedPayloadV1Schema, valid);
  });

  /**
   * `treeRevision` is a `computeTreeRevision` digest, so the schema validates it as one
   * (design-tree phase 2 Task 10) — a bare `z.string()` would have let a producer put anything
   * in the field the UI keys its live preview session on.
   */
  test("rejects a treeRevision that is not a sha-256 hex digest", () => {
    expect(
      pageDescriptorsChangedPayloadV1Schema.safeParse({ ...valid, treeRevision: "not-a-digest" })
        .success,
    ).toBe(false);
    expect(
      pageDescriptorsChangedPayloadV1Schema.safeParse({ ...valid, treeRevision: undefined })
        .success,
    ).toBe(false);
  });

  test("rejects a reason outside the closed 8-member union", () => {
    expect(
      pageDescriptorsChangedPayloadV1Schema.safeParse({ ...valid, reason: "hot-reload" }).success,
    ).toBe(false);
  });

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
    ];
    expect(reasons.length).toBe(8);
    for (const reason of reasons) {
      expect(pageDescriptorsChangedPayloadV1Schema.safeParse({ ...valid, reason }).success).toBe(
        true,
      );
    }
  });

  test("requires an explicit null active page slug, not omission", () => {
    const { activePageSlug: _dropped, ...missing } = valid;
    expect(pageDescriptorsChangedPayloadV1Schema.safeParse(missing).success).toBe(false);
  });
});

describe("turnStartedPayloadV1Schema", () => {
  const valid = { turnId: uid(), chatId: uid(), deadline: DEADLINE };

  test("accepts a valid start and rejects an unknown key", () => {
    expectStrict(turnStartedPayloadV1Schema, valid);
  });

  test("rejects a non-RFC3339 deadline", () => {
    expect(turnStartedPayloadV1Schema.safeParse({ ...valid, deadline: "2026-07-21" }).success).toBe(
      false,
    );
  });
});

describe("turnAttemptStartedPayloadV1Schema", () => {
  const valid = { turnId: uid(), attempt: 1, deadline: DEADLINE };

  test("accepts attempt 1 and rejects an unknown key", () => {
    expectStrict(turnAttemptStartedPayloadV1Schema, valid);
  });

  test("bounds attempt to the integer range 1 through 4", () => {
    expect(turnAttemptStartedPayloadV1Schema.safeParse({ ...valid, attempt: 0 }).success).toBe(
      false,
    );
    expect(turnAttemptStartedPayloadV1Schema.safeParse({ ...valid, attempt: 5 }).success).toBe(
      false,
    );
    expect(turnAttemptStartedPayloadV1Schema.safeParse({ ...valid, attempt: 4 }).success).toBe(
      true,
    );
  });

  test("never carries leaseNonce — it remains internal", () => {
    expect(turnAttemptStartedPayloadV1Schema.safeParse({ ...valid, leaseNonce: "x" }).success).toBe(
      false,
    );
  });
});

describe("turnProgressPayloadV1Schema", () => {
  const valid = { turnId: uid(), attempt: 1, content: { kind: "reasoning", text: "thinking" } };

  test("accepts a reasoning event and rejects an unknown key", () => {
    expectStrict(turnProgressPayloadV1Schema, valid);
  });

  test("accepts every normalized AgentEvent kind", () => {
    const contents = [
      { kind: "reasoning", text: "t" },
      { kind: "tool", id: "t1", op: "read", target: "main.tsx" },
      { kind: "tool-failed", id: "t1", reason: "target is outside the turn workspace" },
      { kind: "tool-failed", id: "t2", reason: null },
      { kind: "final", text: "done" },
      { kind: "usage", tokens: { inputTokens: 1, outputTokens: 2, contextPercent: null } },
      { kind: "error", message: "boom" },
    ];
    for (const content of contents) {
      expect(turnProgressPayloadV1Schema.safeParse({ ...valid, content }).success).toBe(true);
    }
  });

  test("rejects a tool content missing its correlation id — a step failure could never be matched back", () => {
    expect(
      turnProgressPayloadV1Schema.safeParse({
        ...valid,
        content: { kind: "tool", op: "read", target: "main.tsx" },
      }).success,
    ).toBe(false);
  });

  test("rejects a tool-failed content with an unexpected extra field (strict object)", () => {
    expect(
      turnProgressPayloadV1Schema.safeParse({
        ...valid,
        content: { kind: "tool-failed", id: "t1", message: "boom" },
      }).success,
    ).toBe(false);
  });

  test("rejects an unnormalized progress kind", () => {
    expect(
      turnProgressPayloadV1Schema.safeParse({
        ...valid,
        content: { kind: "vendor-raw", text: "x" },
      }).success,
    ).toBe(false);
  });
});

describe("turnGateRejectedPayloadV1Schema", () => {
  const valid = {
    turnId: uid(),
    attempt: 2,
    retryNumber: 1,
    diagnostics: {
      errors: [
        {
          kind: "type",
          code: "TYPE_ERROR",
          message: "bad type",
          file: null,
          line: null,
          column: null,
          // Widened by task 14 so `runTree`'s per-page attribution can cross the wire —
          // `.nullable()`, never `.optional()`, matching this payload's own convention for
          // every other widened echo of an optional port field.
          blockedPages: null,
        },
      ],
      warnings: [
        {
          kind: "nondeterministic-time",
          message: "setTimeout reads no seeded clock",
          line: null,
          column: null,
          file: null,
          // ADDED (design-agent-feedback-loop repair, Task 5) — the identical `.nullable()`,
          // never `.optional()`, convention `errors[0].blockedPages` above already documents.
          blockedPages: null,
        },
      ],
    },
  };

  test("accepts bounded Gate diagnostics and rejects an unknown key", () => {
    expectStrict(turnGateRejectedPayloadV1Schema, valid);
  });

  test("a NON-null blockedPages list round-trips the strict schema (task-13 review round 4, M-4)", () => {
    // The half `blockedPages: null` above cannot prove: this schema is a `z.strictObject`, so
    // before task 14 widened it the field could not cross the wire AT ALL — a diagnostic
    // carrying one would have been rejected outright, and `toGateErrorDto` silently dropped it
    // first so nothing ever noticed. Slugs are parsed by `pageSlugSchema`, not accepted as
    // free strings, so a malformed attribution is refused here rather than reaching the agent.
    const attributed = {
      ...valid,
      diagnostics: {
        ...valid.diagnostics,
        errors: [{ ...valid.diagnostics.errors[0]!, blockedPages: ["home", "calendar"] }],
      },
    };
    const parsed = turnGateRejectedPayloadV1Schema.safeParse(attributed);
    if (!parsed.success) throw new Error("expected the attributed diagnostic to parse");
    const attributedError = parsed.data.diagnostics.errors[0];
    if (attributedError === undefined) throw new Error("expected one parsed diagnostic");
    expect(attributedError.blockedPages).not.toBeNull();
    expect((attributedError.blockedPages ?? []).map(String)).toEqual(["home", "calendar"]);

    const malformed = {
      ...valid,
      diagnostics: {
        ...valid.diagnostics,
        errors: [{ ...valid.diagnostics.errors[0]!, blockedPages: ["Not-A-Slug"] }],
      },
    };
    expect(turnGateRejectedPayloadV1Schema.safeParse(malformed).success).toBe(false);
  });

  test("requires an explicit null location, never an omitted one", () => {
    const { file: _dropped, ...errorWithoutFile } = valid.diagnostics.errors[0]!;
    const bad = { ...valid, diagnostics: { ...valid.diagnostics, errors: [errorWithoutFile] } };
    expect(turnGateRejectedPayloadV1Schema.safeParse(bad).success).toBe(false);
  });

  test("rejects an error kind outside Gate's fixed FATAL categories", () => {
    const bad = {
      ...valid,
      diagnostics: {
        ...valid.diagnostics,
        errors: [
          {
            kind: "network",
            code: "X",
            message: "y",
            file: null,
            line: null,
            column: null,
            blockedPages: null,
          },
        ],
      },
    };
    expect(turnGateRejectedPayloadV1Schema.safeParse(bad).success).toBe(false);
  });

  test("accepts every one of Gate's five fixed FATAL error kinds (gate/types.ts GateErrorKind)", () => {
    const errorKinds = ["import", "contract", "type", "manifest", "smoke"];
    expect(errorKinds.length).toBe(5);
    for (const kind of errorKinds) {
      const bad = {
        ...valid,
        diagnostics: { ...valid.diagnostics, errors: [{ ...valid.diagnostics.errors[0]!, kind }] },
      };
      expect(turnGateRejectedPayloadV1Schema.safeParse(bad).success).toBe(true);
    }
  });

  test("accepts every one of Gate's eight fixed warning kinds (gate/types.ts GateWarningKind)", () => {
    // Widened by design-tree phase 2 Task 4 from a list of five that (pre-existing gap, fixed in
    // passing here) already omitted `silencing-any` — now the full six original kinds plus the
    // two new whole-tree graph kinds.
    //
    // RENAMED (design-agent-feedback-loop repair, Task 4, 2026-08-09): `unguarded-timer`/
    // `unguarded-randomness` -> `nondeterministic-time`/`nondeterministic-randomness`. The old
    // names promised a guard (an `isExport()` wrapper) this token scan has no scope analysis to
    // ever observe; the new names say only what the scan can see.
    const warningKinds = [
      "dropped-id",
      "unpointed-element",
      "nondeterministic-time",
      "nondeterministic-randomness",
      "unlisted-navigation",
      "silencing-any",
      "import-cycle",
      "dead-module",
    ];
    expect(warningKinds.length).toBe(8);
    for (const kind of warningKinds) {
      const bad = {
        ...valid,
        diagnostics: {
          ...valid.diagnostics,
          warnings: [{ ...valid.diagnostics.warnings[0]!, kind }],
        },
      };
      expect(turnGateRejectedPayloadV1Schema.safeParse(bad).success).toBe(true);
    }
  });

  test("a NON-null `file` on a warning round-trips the strict schema, and a NULL one still does (design-tree phase 2 Task 4)", () => {
    const namedFile = {
      ...valid,
      diagnostics: {
        ...valid.diagnostics,
        warnings: [
          {
            kind: "import-cycle",
            message: "an import cycle: lib/a.ts -> lib/b.ts -> lib/a.ts",
            line: null,
            column: null,
            file: "lib/a.ts",
            blockedPages: null,
          },
        ],
      },
    };
    const parsed = turnGateRejectedPayloadV1Schema.safeParse(namedFile);
    if (!parsed.success) throw new Error("expected the named-file warning to parse");
    expect(parsed.data.diagnostics.warnings[0]?.file).toBe("lib/a.ts");

    const noFile = {
      ...valid,
      diagnostics: { ...valid.diagnostics, warnings: [valid.diagnostics.warnings[0]!] },
    };
    expect(turnGateRejectedPayloadV1Schema.safeParse(noFile).success).toBe(true);
  });

  test("requires an explicit null `file` on a warning, never an omitted one", () => {
    const { file: _dropped, ...warningWithoutFile } = valid.diagnostics.warnings[0]!;
    const bad = {
      ...valid,
      diagnostics: { ...valid.diagnostics, warnings: [warningWithoutFile] },
    };
    expect(turnGateRejectedPayloadV1Schema.safeParse(bad).success).toBe(false);
  });

  test("a NON-null `blockedPages` on a warning round-trips the strict schema (design-agent-feedback-loop repair, Task 5)", () => {
    // Mirrors the error's own M-4 test above: this schema is `z.strictObject`, so before this
    // task widened it a warning carrying `blockedPages` would have been rejected outright.
    // Slugs are parsed by `pageSlugSchema`, not accepted as free strings.
    const attributed = {
      ...valid,
      diagnostics: {
        ...valid.diagnostics,
        warnings: [{ ...valid.diagnostics.warnings[0]!, blockedPages: ["home", "calendar"] }],
      },
    };
    const parsed = turnGateRejectedPayloadV1Schema.safeParse(attributed);
    if (!parsed.success) throw new Error("expected the attributed warning to parse");
    const attributedWarning = parsed.data.diagnostics.warnings[0];
    if (attributedWarning === undefined) throw new Error("expected one parsed warning");
    expect(attributedWarning.blockedPages).not.toBeNull();
    expect((attributedWarning.blockedPages ?? []).map(String)).toEqual(["home", "calendar"]);

    const malformed = {
      ...valid,
      diagnostics: {
        ...valid.diagnostics,
        warnings: [{ ...valid.diagnostics.warnings[0]!, blockedPages: ["Not-A-Slug"] }],
      },
    };
    expect(turnGateRejectedPayloadV1Schema.safeParse(malformed).success).toBe(false);
  });

  test("requires an explicit null `blockedPages` on a warning, never an omitted one", () => {
    const { blockedPages: _dropped, ...warningWithoutBlockedPages } =
      valid.diagnostics.warnings[0]!;
    const bad = {
      ...valid,
      diagnostics: { ...valid.diagnostics, warnings: [warningWithoutBlockedPages] },
    };
    expect(turnGateRejectedPayloadV1Schema.safeParse(bad).success).toBe(false);
  });
});

describe("turnApplyStartedPayloadV1Schema", () => {
  const valid = { turnId: uid(), candidateHash: SHA, affectedPageSlugs: ["dashboard"] };

  test("accepts a valid apply-start and rejects an unknown key", () => {
    expectStrict(turnApplyStartedPayloadV1Schema, valid);
  });
});

describe("turnTerminalPayloadV1Schema (turn.completed/failed/cancelled)", () => {
  const valid = {
    turnId: uid(),
    outcome: "completed",
    changedPages: [{ pageSlug: "dashboard", sourceHash: SHA }],
    warnings: [],
    failure: null,
  };

  test("accepts a completed outcome and rejects an unknown key", () => {
    expectStrict(turnTerminalPayloadV1Schema, valid);
  });

  test("accepts every fixed outcome code", () => {
    for (const outcome of ["completed", "failed", "cancelled", "stale", "interrupted"]) {
      expect(turnTerminalPayloadV1Schema.safeParse({ ...valid, outcome }).success).toBe(true);
    }
  });

  test("rejects an outcome outside the fixed set", () => {
    expect(turnTerminalPayloadV1Schema.safeParse({ ...valid, outcome: "aborted" }).success).toBe(
      false,
    );
  });

  test("requires an explicit null failure, not omission", () => {
    const { failure: _dropped, ...missing } = valid;
    expect(turnTerminalPayloadV1Schema.safeParse(missing).success).toBe(false);
  });

  // WP-8 item 4 ("Generic `turn.failed` — a typed outcome instead of the catch-all") plus its
  // own gate-exhaustion-vs-backend-failure follow-up: `handlers/turn.ts` widened WHICH
  // `failure` DTO it emits (see that file's header, "ONE SUB-CASE WAS TYPED FIRST" /
  // "GATE-EXHAUSTION-VS-BACKEND-FAILURE — CLOSED") rather than the wire shape itself — no new
  // field was added, so there is nothing new to round-trip here. What IS new across both
  // landings: `turn.failed` can now honestly carry a REAL adapter-level code (e.g.
  // `TRANSACTION_RECOVERY_CONFLICT`, propagated verbatim from
  // `TurnTransactionService.terminalize`'s own failure), AND an ordinary `"recorded"`
  // termination's own typed cause (`GATE_RETRY_EXHAUSTED`/`BACKEND_FAILED`/
  // `TURN_DEADLINE_EXCEEDED`) — instead of always the same fabricated `PERSISTENCE_FAILED`.
  // This asserts the closed `OperationalFailureCode` vocabulary already accepted every one of
  // these codes even BEFORE `handlers/turn.ts` could reach them — proving the WIRE FORMAT was
  // never the obstacle to a more precise `turn.failed`, only the missing echo `core/turns`
  // now provides.
  test("accepts every operational-failure code a real termination can plausibly carry, on turn.failed", () => {
    for (const code of [
      "PERSISTENCE_FAILED",
      "TRANSACTION_RECOVERY_CONFLICT",
      "GATE_RETRY_EXHAUSTED",
      "BACKEND_FAILED",
      "TURN_DEADLINE_EXCEEDED",
    ]) {
      const withFailure = {
        ...valid,
        outcome: "failed",
        failure: {
          code,
          retryable: false,
          safeMessage: "the turn ended without committing",
          details: {},
        },
      };
      expect(turnTerminalPayloadV1Schema.safeParse(withFailure).success).toBe(true);
    }
  });
});

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
  };

  test("accepts a valid plan and rejects an unknown key", () => {
    expectStrict(restorePlanReadyPayloadV1Schema, valid);
  });

  test("rejects an index state outside the two facts a ready plan can carry", () => {
    expect(
      restorePlanReadyPayloadV1Schema.safeParse({ ...valid, indexState: "staged" }).success,
    ).toBe(false);
  });

  test("rejects an abbreviated (non-FULL) source commit id", () => {
    expect(
      restorePlanReadyPayloadV1Schema.safeParse({ ...valid, sourceCommitId: "a".repeat(7) })
        .success,
    ).toBe(false);
  });

  test("accepts a full 64-character sha256-object-format commit id", () => {
    expect(
      restorePlanReadyPayloadV1Schema.safeParse({ ...valid, sourceCommitId: SHA }).success,
    ).toBe(true);
  });

  test("rejects a gateAttestationHash that is not a Sha256Hex value", () => {
    expect(
      restorePlanReadyPayloadV1Schema.safeParse({ ...valid, gateAttestationHash: "not-a-hash" })
        .success,
    ).toBe(false);
  });
});

describe("restoreStartedPayloadV1Schema / restoreRecordPendingPayloadV1Schema", () => {
  test("restoreStarted accepts a valid start and rejects an unknown key", () => {
    const valid = {
      restorePlanId: uid(),
      restoreActionId: uid(),
      pageSlug: "dashboard",
      sourceCommitId: "a".repeat(40),
      safeTargetChatDisplay: "Chat #3",
    };
    expectStrict(restoreStartedPayloadV1Schema, valid);
  });

  test("restoreRecordPending accepts a valid record-pending and rejects an unknown key", () => {
    const valid = {
      restoreActionId: uid(),
      pageSlug: "dashboard",
      sourceCommitId: "a".repeat(40),
      safeTargetChatDisplay: "Chat #3",
    };
    expectStrict(restoreRecordPendingPayloadV1Schema, valid);
  });
});

describe("restoreTerminalPayloadV1Schema (restore.completed/failed)", () => {
  const valid = {
    restorePlanId: uid(),
    restoreActionId: uid(),
    pageSlug: "dashboard",
    sourceCommitId: "a".repeat(40),
    phase: "executing",
    failure: null,
  };

  test("accepts a valid terminal restore and rejects an unknown key", () => {
    expectStrict(restoreTerminalPayloadV1Schema, valid);
  });

  test("requires restoreActionId explicit null, never omitted", () => {
    const { restoreActionId: _dropped, ...missing } = valid;
    expect(restoreTerminalPayloadV1Schema.safeParse(missing).success).toBe(false);
    expect(
      restoreTerminalPayloadV1Schema.safeParse({ ...valid, restoreActionId: null }).success,
    ).toBe(true);
  });

  test("rejects a phase outside the active-phase set", () => {
    expect(restoreTerminalPayloadV1Schema.safeParse({ ...valid, phase: "planning" }).success).toBe(
      false,
    );
  });

  test("accepts every one of the three fixed phases (§7.3, KCC:289-291)", () => {
    const phases = ["executing", "record-pending", "recovering"];
    expect(phases.length).toBe(3);
    for (const phase of phases) {
      expect(restoreTerminalPayloadV1Schema.safeParse({ ...valid, phase }).success).toBe(true);
    }
  });
});

describe("commitPlanReadyPayloadV1Schema", () => {
  const valid = {
    commitPlanId: uid(),
    scope: "current-page",
    expectedHead: "a".repeat(40),
    paths: [
      {
        path: ".termcraft/pages/dashboard/index.tsx",
        state: "modified",
        contentHash: "c".repeat(40),
      },
    ],
    messageTemplate: "termcraft: update dashboard",
    detachedHeadWarning: false,
  };

  test("accepts a valid plan and rejects an unknown key", () => {
    expectStrict(commitPlanReadyPayloadV1Schema, valid);
  });

  test("accepts a null content hash for a deleted path", () => {
    const withDelete = {
      ...valid,
      paths: [{ path: "x", state: "deleted", contentHash: null }],
    };
    expect(commitPlanReadyPayloadV1Schema.safeParse(withDelete).success).toBe(true);
  });

  test("rejects a scope outside the closed three-scope union", () => {
    expect(
      commitPlanReadyPayloadV1Schema.safeParse({ ...valid, scope: "everything" }).success,
    ).toBe(false);
  });
});

describe("commitStartedPayloadV1Schema", () => {
  test("accepts a valid start and rejects an unknown key", () => {
    const valid = {
      commitPlanId: uid(),
      operationId: uid(),
      scope: "whole-project",
      selectedPaths: [".termcraft/pages/dashboard/index.tsx"],
    };
    expectStrict(commitStartedPayloadV1Schema, valid);
  });
});

describe("commitTerminalPayloadV1Schema (commit.completed/failed)", () => {
  const valid = {
    commitPlanId: uid(),
    operationId: uid(),
    scope: "infrastructure",
    gitStatus: { repositoryId: "repo-1", head: SHA, sequencerState: "idle", scopes: {} },
    failure: null,
  };

  test("accepts a valid terminal commit and rejects an unknown key", () => {
    expectStrict(commitTerminalPayloadV1Schema, valid);
  });
});

describe("exportStartedPayloadV1Schema", () => {
  test("accepts a valid start and rejects an unknown key", () => {
    const valid = {
      operationId: uid(),
      sourceSnapshotDigest: SHA,
      pageCount: 3,
      renderJobCount: 6,
      destination: "export/2026-07-21T10-00-00Z",
    };
    expectStrict(exportStartedPayloadV1Schema, valid);
  });
});

describe("exportProgressPayloadV1Schema", () => {
  const valid = {
    operationId: uid(),
    phase: "rendering",
    completedJobs: 2,
    totalJobs: 6,
    pageSlug: "dashboard",
    sizeBytes: 1024,
  };

  test("accepts a valid progress tick and rejects an unknown key", () => {
    expectStrict(exportProgressPayloadV1Schema, valid);
  });

  test("accepts explicit null for the nullable page slug and size", () => {
    expect(
      exportProgressPayloadV1Schema.safeParse({ ...valid, pageSlug: null, sizeBytes: null })
        .success,
    ).toBe(true);
  });

  test("rejects a phase outside rendering/publishing", () => {
    expect(exportProgressPayloadV1Schema.safeParse({ ...valid, phase: "preparing" }).success).toBe(
      false,
    );
  });

  // Finding #12, part 2: `EXPORT_PHASES_V1` (the wider, terminal-only tuple) and
  // `EXPORT_PROGRESS_PHASES_V1` (this schema's tuple) used to be the same shared enum, which
  // silently let `export.progress` accept `"idle"` — a phase it never actually emits (`"idle"`
  // only ever appears on a pre-capture `export.failed`, `core/kernel/handlers/
  // preview-export.ts`'s `preCaptureExportFailure`). Now split: `export.progress` REJECTS
  // `"idle"`, while the terminal schema below still ACCEPTS it.
  test('rejects the terminal-only "idle" phase — export.progress never emits it', () => {
    expect(exportProgressPayloadV1Schema.safeParse({ ...valid, phase: "idle" }).success).toBe(
      false,
    );
  });
});

describe("exportTerminalPayloadV1Schema (export.completed/failed)", () => {
  const valid = {
    operationId: uid(),
    phase: "publishing",
    destination: "export/2026-07-21T10-00-00Z",
    generationId: uid(),
    failure: null,
  };

  test("accepts a valid terminal export and rejects an unknown key", () => {
    expectStrict(exportTerminalPayloadV1Schema, valid);
  });

  test("accepts an explicit null generation id", () => {
    expect(exportTerminalPayloadV1Schema.safeParse({ ...valid, generationId: null }).success).toBe(
      true,
    );
  });

  // The widened member (task 12): a pre-capture `export.failed` reports `phase: "idle"` — a
  // real `ExportState` member, not an invented one — for a failure the export machine never
  // left `"idle"` for (`core/kernel/handlers/preview-export.ts`'s `preCaptureExportFailure`).
  test('accepts the widened "idle" phase for a pre-capture export.failed', () => {
    expect(
      exportTerminalPayloadV1Schema.safeParse({
        ...valid,
        phase: "idle",
        generationId: null,
        failure: {
          code: "PERSISTENCE_FAILED",
          retryable: false,
          safeMessage: "listSlugs failed before capture",
          details: {},
        },
      }).success,
    ).toBe(true);
  });
});

describe("migrationPlanReadyPayloadV1Schema", () => {
  const valid = {
    migrationPlanId: uid(),
    selectedFileKinds: ["page-source"],
    rewriteEntries: [
      {
        relativePath: "pages/dashboard/index.tsx",
        fileKind: "page-source",
        beforeHash: "a".repeat(40),
        fromVersion: 1,
        toVersion: 2,
        sizeBytes: 512,
      },
    ],
    backupBytes: 4096,
    requiredFreeBytes: 8192,
    planRevision: "1",
  };

  test("accepts a valid plan and rejects an unknown key", () => {
    expectStrict(migrationPlanReadyPayloadV1Schema, valid);
  });

  test("rejects a non-canonical planRevision", () => {
    expect(
      migrationPlanReadyPayloadV1Schema.safeParse({ ...valid, planRevision: "01" }).success,
    ).toBe(false);
  });
});

describe("migrationStartedPayloadV1Schema", () => {
  test("accepts a valid start (locked to phase backing-up) and rejects an unknown key", () => {
    const valid = {
      migrationPlanId: uid(),
      migrationActionId: uid(),
      selectedFileKinds: ["page-source"],
      phase: "backing-up",
    };
    expectStrict(migrationStartedPayloadV1Schema, valid);
  });

  test("rejects any phase other than backing-up", () => {
    const valid = {
      migrationPlanId: uid(),
      migrationActionId: uid(),
      selectedFileKinds: [],
      phase: "transforming",
    };
    expect(migrationStartedPayloadV1Schema.safeParse(valid).success).toBe(false);
  });
});

describe("migrationProgressPayloadV1Schema", () => {
  const valid = {
    migrationPlanId: uid(),
    migrationActionId: uid(),
    phase: "transforming",
    completedItems: 1,
    totalItems: 4,
    relativePath: "pages/dashboard/index.tsx",
  };

  test("accepts a valid tick and rejects an unknown key", () => {
    expectStrict(migrationProgressPayloadV1Schema, valid);
  });

  test("accepts an explicit null relative path", () => {
    expect(
      migrationProgressPayloadV1Schema.safeParse({ ...valid, relativePath: null }).success,
    ).toBe(true);
  });

  test("accepts every one of the four fixed phases, verbatim (§9, KCC:816)", () => {
    const phases = ["backing-up", "transforming", "publishing", "recovering"];
    expect(phases.length).toBe(4);
    for (const phase of phases) {
      expect(migrationProgressPayloadV1Schema.safeParse({ ...valid, phase }).success).toBe(true);
    }
  });
});

describe("migrationTerminalPayloadV1Schema (migration.completed only)", () => {
  const valid = {
    migrationPlanId: uid(),
    migrationActionId: uid(),
    transactionId: uid(),
    migratedFileCount: 12,
    resultingVersions: { "page-source": 2 },
    recovered: false,
  };

  test("accepts a valid completion and rejects an unknown key", () => {
    expectStrict(migrationTerminalPayloadV1Schema, valid);
  });
});

describe("migrationFailedPayloadV1Schema (discriminated union)", () => {
  test("accepts the all-null planning variant", () => {
    const planning = {
      migrationPlanId: null,
      migrationActionId: null,
      transactionId: null,
      phase: "planning",
      failure: {
        code: "MIGRATION_STALE",
        retryable: true,
        safeMessage: "plan expired",
        details: {},
      },
    };
    expect(migrationFailedPayloadV1Schema.safeParse(planning).success).toBe(true);
    expect(
      migrationFailedPayloadV1Schema.safeParse({ ...planning, unexpectedKey: "x" }).success,
    ).toBe(false);
  });

  test("accepts the post-plan variant with a nullable transactionId", () => {
    const postPlan = {
      migrationPlanId: uid(),
      migrationActionId: uid(),
      transactionId: null,
      phase: "backing-up",
      failure: {
        code: "MIGRATION_BACKUP_FAILED",
        retryable: false,
        safeMessage: "disk full",
        details: {},
      },
    };
    expect(migrationFailedPayloadV1Schema.safeParse(postPlan).success).toBe(true);
  });

  test("rejects the planning variant carrying a non-null id — variants cannot mix", () => {
    const mixed = {
      migrationPlanId: uid(),
      migrationActionId: null,
      transactionId: null,
      phase: "planning",
      failure: { code: "MIGRATION_STALE", retryable: true, safeMessage: "x", details: {} },
    };
    expect(migrationFailedPayloadV1Schema.safeParse(mixed).success).toBe(false);
  });

  test("rejects a phase outside the two variants' closed discriminants", () => {
    const bad = {
      migrationPlanId: uid(),
      migrationActionId: uid(),
      transactionId: null,
      phase: "idle",
      failure: { code: "X", retryable: false, safeMessage: "y", details: {} },
    };
    expect(migrationFailedPayloadV1Schema.safeParse(bad).success).toBe(false);
  });
});

describe("previewSourceChangedPayloadV1Schema", () => {
  test("accepts the current-source variant and rejects an unknown key", () => {
    const valid = {
      previewSessionId: uid(),
      pageSlug: "dashboard",
      source: { kind: "current" },
      sourceHash: SHA,
      hostMode: "process",
    };
    expectStrict(previewSourceChangedPayloadV1Schema, valid);
  });

  test("accepts the historical-source variant with its full commit id", () => {
    const valid = {
      previewSessionId: uid(),
      pageSlug: "dashboard",
      source: { kind: "historical", sourceCommit: "a".repeat(40) },
      sourceHash: SHA,
      hostMode: "process",
    };
    expect(previewSourceChangedPayloadV1Schema.safeParse(valid).success).toBe(true);
  });

  test("rejects a current-source variant carrying a stray sourceCommit", () => {
    const bad = {
      previewSessionId: uid(),
      pageSlug: "dashboard",
      source: { kind: "current", sourceCommit: "x" },
      sourceHash: SHA,
      hostMode: "process",
    };
    expect(previewSourceChangedPayloadV1Schema.safeParse(bad).success).toBe(false);
  });
});

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
  };

  test("accepts a valid session and rejects an unknown key", () => {
    expectStrict(previewSessionReadyPayloadV1Schema, valid);
  });

  test("rejects an interaction mode outside static/interactive", () => {
    expect(
      previewSessionReadyPayloadV1Schema.safeParse({ ...valid, interactionMode: "readonly" })
        .success,
    ).toBe(false);
  });

  test("accepts both fixed interaction modes, verbatim (§10.1, KCC:888)", () => {
    const interactionModes = ["static", "interactive"];
    expect(interactionModes.length).toBe(2);
    for (const interactionMode of interactionModes) {
      expect(
        previewSessionReadyPayloadV1Schema.safeParse({ ...valid, interactionMode }).success,
      ).toBe(true);
    }
  });
});

describe("previewGeometryResultPayloadV1Schema", () => {
  const frameIdentity = { previewSessionId: uid(), nonce: NONCE, sourceHash: SHA, frameSeq: "3" };
  const valid = {
    previewSessionId: uid(),
    frameTokenId: uid(),
    frameIdentity,
    queryKind: "hit",
    result: { kind: "checkHit", hit: null },
    geometryToken: uid(),
  };

  test("accepts a resolving hit with a minted geometry token, and rejects an unknown key", () => {
    expectStrict(previewGeometryResultPayloadV1Schema, valid);
  });

  test("accepts a null geometry token for a non-resolving query", () => {
    expect(
      previewGeometryResultPayloadV1Schema.safeParse({
        ...valid,
        queryKind: "layout",
        geometryToken: null,
      }).success,
    ).toBe(true);
  });

  test("rejects a query kind outside the closed five-member union", () => {
    expect(
      previewGeometryResultPayloadV1Schema.safeParse({ ...valid, queryKind: "click" }).success,
    ).toBe(false);
  });

  test("accepts every one of the five fixed query kinds, verbatim (§10.1, KCC:890)", () => {
    const queryKinds = ["hit", "rect", "describe", "layout", "pin-anchor"];
    expect(queryKinds.length).toBe(5);
    for (const queryKind of queryKinds) {
      expect(previewGeometryResultPayloadV1Schema.safeParse({ ...valid, queryKind }).success).toBe(
        true,
      );
    }
  });
});

describe("geometryQueryResultV1Schema (§4.2's checkHit/rectOf/describe/layoutTree, M21)", () => {
  const rect = { x: 2, y: 3, width: 10, height: 4 };

  test("checkHit: accepts a resolving hit and a null (nothing mounted at the point)", () => {
    expect(
      geometryQueryResultV1Schema.safeParse({ kind: "checkHit", hit: { id: "btn-1" } }).success,
    ).toBe(true);
    expect(geometryQueryResultV1Schema.safeParse({ kind: "checkHit", hit: null }).success).toBe(
      true,
    );
  });

  test("rectOf: accepts a resolved rect and a null (unknown id)", () => {
    expect(geometryQueryResultV1Schema.safeParse({ kind: "rectOf", rect }).success).toBe(true);
    expect(geometryQueryResultV1Schema.safeParse({ kind: "rectOf", rect: null }).success).toBe(
      true,
    );
  });

  test("describe: accepts a resolved element (id + kind only — no label yet) and a null", () => {
    expect(
      geometryQueryResultV1Schema.safeParse({
        kind: "describe",
        element: { id: "btn-1", kind: "BoxRenderable" },
      }).success,
    ).toBe(true);
    expect(geometryQueryResultV1Schema.safeParse({ kind: "describe", element: null }).success).toBe(
      true,
    );
  });

  test("layoutTree: accepts a tree at depth >= 2 (root -> child -> grandchild)", () => {
    const grandchild = { id: "leaf-1", kind: "TextRenderable", box: rect, children: [] };
    const child = { id: "child-1", kind: "BoxRenderable", box: rect, children: [grandchild] };
    const root = { id: "root", kind: "BoxRenderable", box: rect, children: [child] };
    expect(geometryQueryResultV1Schema.safeParse({ kind: "layoutTree", tree: root }).success).toBe(
      true,
    );
  });

  test("layoutTree: rejects a tree whose grandchild is missing its required 'kind'", () => {
    const malformedGrandchild = { id: "leaf-1", box: rect, children: [] };
    const child = {
      id: "child-1",
      kind: "BoxRenderable",
      box: rect,
      children: [malformedGrandchild],
    };
    const root = { id: "root", kind: "BoxRenderable", box: rect, children: [child] };
    expect(geometryQueryResultV1Schema.safeParse({ kind: "layoutTree", tree: root }).success).toBe(
      false,
    );
  });

  test("rejects a kind outside the closed four-member union", () => {
    expect(geometryQueryResultV1Schema.safeParse({ kind: "hit", hit: null }).success).toBe(false);
  });

  test("rejects an unexpected extra field on a variant (strict objects)", () => {
    expect(
      geometryQueryResultV1Schema.safeParse({ kind: "checkHit", hit: null, extra: "x" }).success,
    ).toBe(false);
  });
});

describe("previewBackpressurePayloadV1Schema (preview.backpressured/writable)", () => {
  const valid = {
    previewSessionId: uid(),
    nonce: NONCE,
    queueSize: 200,
    capacity: 256,
    lowWaterMark: 128,
  };

  test("accepts a valid queue state and rejects an unknown key", () => {
    expectStrict(previewBackpressurePayloadV1Schema, valid);
  });
});

describe("previewFailurePayloadV1Schema", () => {
  const valid = {
    previewSessionId: uid(),
    nonce: NONCE,
    pageSlug: "dashboard",
    sourceHash: SHA,
    phase: "starting",
    failure: {
      code: "HOST_START_FAILED",
      retryable: true,
      safeMessage: "host exited",
      details: {},
    },
  };

  test("accepts a valid failure and rejects an unknown key", () => {
    expectStrict(previewFailurePayloadV1Schema, valid);
  });

  test("rejects a phase outside starting/switching/live", () => {
    expect(previewFailurePayloadV1Schema.safeParse({ ...valid, phase: "disabled" }).success).toBe(
      false,
    );
  });

  test("accepts every one of the three fixed phases (§7.6, KCC:365)", () => {
    const phases = ["starting", "switching", "live"];
    expect(phases.length).toBe(3);
    for (const phase of phases) {
      expect(previewFailurePayloadV1Schema.safeParse({ ...valid, phase }).success).toBe(true);
    }
  });
});

describe("previewCircuitOpenedPayloadV1Schema", () => {
  const valid = {
    previewSessionId: uid(),
    pageSlug: "dashboard",
    sourceHash: SHA,
    attempts: 3,
    finalFailure: {
      code: "HOST_CIRCUIT_OPEN",
      retryable: false,
      safeMessage: "budget exhausted",
      details: {},
    },
    retryCapability: { available: false, reasons: [{ code: "OPERATION_BUSY" }] },
  };

  test("accepts a valid circuit-open and rejects an unknown key", () => {
    expectStrict(previewCircuitOpenedPayloadV1Schema, valid);
  });
});

describe("chatChangedPayloadV1Schema", () => {
  const valid = {
    activeChatId: uid(),
    added: [{ chatId: uid(), createdAt: DEADLINE, displayName: "Redesign the dashboard" }],
    updated: [],
    removedChatIds: [],
  };

  test("accepts a valid diff and rejects an unknown key", () => {
    expectStrict(chatChangedPayloadV1Schema, valid);
  });

  test("requires an explicit null displayName before any user record exists, never omission (design §3.9)", () => {
    const withNullName = { ...valid, added: [{ ...valid.added[0]!, displayName: null }] };
    expect(chatChangedPayloadV1Schema.safeParse(withNullName).success).toBe(true);

    const { displayName: _dropped, ...summaryWithoutDisplayName } = valid.added[0]!;
    expect(
      chatChangedPayloadV1Schema.safeParse({ ...valid, added: [summaryWithoutDisplayName] })
        .success,
    ).toBe(false);
  });

  test("rejects a displayName longer than the 80-char DTO bound", () => {
    const tooLong = { ...valid, added: [{ ...valid.added[0]!, displayName: "x".repeat(81) }] };
    expect(chatChangedPayloadV1Schema.safeParse(tooLong).success).toBe(false);
  });
});

describe("chatRecordsPayloadV1Schema (chat.records, WP-10 Task 3)", () => {
  const userRecord = {
    kind: "user",
    recordId: uid(),
    turnId: uid(),
    text: "Add a dark theme toggle",
    selection: null,
    pins: [],
    ts: DEADLINE,
  };

  const agentRecord = {
    kind: "agent",
    recordId: uid(),
    turnId: uid(),
    text: "Done — added a theme toggle.",
    changedPages: ["dashboard"],
    warnings: [],
    ts: DEADLINE,
  };

  const valid = {
    chatId: uid(),
    records: [userRecord, agentRecord],
    prevCursor: null,
    totalRecordCount: 2,
  };

  test("accepts a tail with mixed record kinds and rejects an unknown key", () => {
    expectStrict(chatRecordsPayloadV1Schema, valid);
  });

  test("rejects a payload missing totalRecordCount (chat-scroll spec §6.3)", () => {
    const { totalRecordCount: _dropped, ...withoutTotal } = valid;
    expect(chatRecordsPayloadV1Schema.safeParse(withoutTotal).success).toBe(false);
  });

  test("accepts an empty tail", () => {
    expect(chatRecordsPayloadV1Schema.safeParse({ ...valid, records: [] }).success).toBe(true);
  });

  test("accepts a non-null prevCursor", () => {
    expect(
      chatRecordsPayloadV1Schema.safeParse({
        ...valid,
        prevCursor: { generation: 1, beforeOffset: 512 },
      }).success,
    ).toBe(true);
  });

  test("rejects a wrong-shape record inside the tail", () => {
    const badRecord = { ...userRecord, selection: "not-an-object-or-null" };
    expect(chatRecordsPayloadV1Schema.safeParse({ ...valid, records: [badRecord] }).success).toBe(
      false,
    );
  });

  test("rejects a record whose kind is outside the closed five-member union", () => {
    const badRecord = { ...userRecord, kind: "system:info" };
    expect(chatRecordsPayloadV1Schema.safeParse({ ...valid, records: [badRecord] }).success).toBe(
      false,
    );
  });
});

describe("chat paging payloads (chat-scroll spec §6.2/§6.3)", () => {
  const CHAT_ID = uid();
  const CURSOR = { generation: 3, beforeOffset: 4096 };

  test("chat.records carries the chat's total record count", () => {
    const parsed = eventPayloadV1SchemaByKind["chat.records"].safeParse({
      chatId: CHAT_ID,
      records: [],
      prevCursor: CURSOR,
      totalRecordCount: 250,
    });
    expect(parsed.success).toBe(true);
  });

  test("chat.records rejects a payload without the total", () => {
    const parsed = eventPayloadV1SchemaByKind["chat.records"].safeParse({
      chatId: CHAT_ID,
      records: [],
      prevCursor: null,
    });
    expect(parsed.success).toBe(false);
  });

  test("chat.records.older round-trips a successful page", () => {
    const payload = {
      chatId: CHAT_ID,
      records: [],
      prevCursor: CURSOR,
      totalRecordCount: 250,
      failure: null,
    };
    const parsed = eventPayloadV1SchemaByKind["chat.records.older"].safeParse(payload);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual(payload);
  });

  test("chat.records.older round-trips a failed page, leaving the other fields empty (spec §7)", () => {
    const payload = {
      chatId: CHAT_ID,
      records: [],
      prevCursor: null,
      totalRecordCount: 0,
      failure: {
        code: "PERSISTENCE_FAILED" as const,
        retryable: false,
        safeMessage: "chat page could not be read",
        details: {},
      },
    };
    const parsed = eventPayloadV1SchemaByKind["chat.records.older"].safeParse(payload);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual(payload);
  });

  test("chat.records.older rejects an unexpected key", () => {
    expectStrict(chatRecordsOlderPayloadV1Schema, {
      chatId: CHAT_ID,
      records: [],
      prevCursor: null,
      totalRecordCount: 0,
      failure: null,
    });
  });
});

describe("selectionChangedPayloadV1Schema", () => {
  test("accepts a bound selection", () => {
    const valid = { pageSlug: "dashboard", elementId: "header", sourceHash: SHA };
    expect(selectionChangedPayloadV1Schema.safeParse(valid).success).toBe(true);
    expect(
      selectionChangedPayloadV1Schema.safeParse({ ...valid, unexpectedKey: "x" }).success,
    ).toBe(false);
  });

  test("accepts a bare null payload for no selection", () => {
    expect(selectionChangedPayloadV1Schema.safeParse(null).success).toBe(true);
  });
});

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
  };
  const valid = {
    pageSlug: "dashboard",
    affectedPins: [pin],
    affectedRecordIds: [uid()],
    causeId: uid(),
  };

  test("accepts a valid batch and rejects an unknown key", () => {
    expectStrict(pinsChangedPayloadV1Schema, valid);
  });
});

describe("gitStatusChangedPayloadV1Schema", () => {
  test("accepts a valid projection and rejects an unknown key", () => {
    const valid = { repositoryId: "repo-1", head: SHA, sequencerState: "idle", scopes: {} };
    expectStrict(gitStatusChangedPayloadV1Schema, valid);
  });

  test("accepts a null HEAD for an unborn repository", () => {
    const valid = { repositoryId: "repo-1", head: null, sequencerState: "idle", scopes: {} };
    expect(gitStatusChangedPayloadV1Schema.safeParse(valid).success).toBe(true);
  });
});

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
  };

  test("accepts a valid diff and rejects an unknown key", () => {
    expectStrict(diagnosticsChangedPayloadV1Schema, valid);
  });

  test("rejects a non-canonical generation counter", () => {
    expect(
      diagnosticsChangedPayloadV1Schema.safeParse({ ...valid, generation: "-1" }).success,
    ).toBe(false);
  });
});

/**
 * I3 (project-design-systems P10 final review): the caps this file used to place on
 * `blockedPages`/`reason` are producer-UNBOUNDED — `core/design-systems/model/candidate.ts`'s
 * `toBreakageItem` copies `blockedPages` untruncated, and `core/design-systems/model/sources.ts`'s
 * `listOne` copies `raced.message`/`safeMessage` into `reason` untruncated — so a package that
 * breaks 21+ pages, or a source failure with a long message, used to fail this schema and take
 * the WHOLE event batch down with it (`event-bus.ts`'s `validateBatch` is all-or-nothing). Fixed
 * by dropping the caps to match the sibling precedent already in this file: `turnGateErrorV1Schema`/
 * `turnGateWarningV1Schema`'s own `blockedPages` (~line 880/912) carry no `.max()` either. The
 * `designSystemBreakageDtoV1Schema.message` cap and the preview's `errors`/`warnings` array caps
 * stay — `candidate.ts` truncates/slices to those exact bounds before it ever builds the DTO, so
 * those two are producer-enforced, not producer-unbounded.
 */
describe("designSystem event payloads (I3: unbounded producers vs runtime caps)", () => {
  const SUMMARY = {
    id: "midnight",
    name: "Midnight",
    version: "1.0.0",
    kitApiVersion: 1,
    defaultTheme: "dark",
    defaultThemeTokens: [{ name: "accent", value: "#4cc9f0" }],
    componentNames: ["Button"],
  };

  test("designSystem.previewed publishes with 21+ blocked pages on one breakage item", () => {
    const manyBlockedPages = Array.from({ length: 25 }, (_unused, index) => `page-${index}`);
    const valid = {
      operationId: uid(),
      installId: uid(),
      ref: "local:midnight@1.0.0",
      summary: SUMMARY,
      preview: {
        verdict: "breaks-pages",
        errors: [
          {
            code: "FORBIDDEN_IMPORT",
            message: "shared/module.ts imports a forbidden dependency",
            file: "shared/module.ts",
            blockedPages: manyBlockedPages,
          },
        ],
        warnings: [],
      },
    };
    const parsed = designSystemPreviewedPayloadV1Schema.safeParse(valid);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.preview.errors[0]?.blockedPages.length).toBe(25);
  });

  test("designSystem.listed publishes with a source reason over 400 characters", () => {
    const longReason = "x".repeat(500);
    const valid = {
      operationId: uid(),
      sources: [
        {
          sourceId: "local",
          label: "Local library",
          canPublish: true,
          state: "unavailable",
          systems: [],
          reason: longReason,
        },
      ],
      update: null,
    };
    const parsed = designSystemListedPayloadV1Schema.safeParse(valid);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.sources[0]?.reason).toBe(longReason);
  });
});
