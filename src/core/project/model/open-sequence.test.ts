import { describe, expect, test } from "bun:test";

import { context, wrap } from "@reatom/core";

import {
  reatomExportStateMachine,
  reatomMigrationStateMachine,
  reatomProjectStateMachine,
  reatomRestoreStateMachine,
} from "core/machines";
import type { ProjectStore } from "core/ports";
import {
  createFakeChatStore,
  createFakeDesignStore,
  createFakeDesignStoreForPages,
  createFakeExportPublish,
  createFakePinStore,
  createFakeProjectStore,
  createFakeRecoveryService,
  createFakeTrustGate,
} from "core/ports/fakes";
import type { FailureDtoV1 } from "core/protocol";
import { parsePageSlug } from "entities/page";
import type { PageSlug } from "entities/page";

import { type OpenSequenceDeps, runOpenSequence } from "./open-sequence";
import type { RecoveryRoutingMachines } from "./recovery-routing";

/**
 * TD §12's ordered startup sequence end to end, against 6D's fakes only. ORDER IS THE
 * CONTRACT: every failure test asserts the run log stops exactly at the failing step —
 * no later step's fake records a call, and the project machine lands in `blocked` (never
 * silently in some other phase).
 *
 * EVERY test body — machine construction, the run, AND its assertions — lives inside ONE
 * `context.start(async () => {...})` call (the reatom binding rule's "isolated tests
 * inside context.start"), and `runOpenSequence(deps)`'s own call is wrapped with `wrap(...)`
 * (the same rule's "async boundaries: use `wrap` for promises... that touch Reatom").
 * `reatomProjectStateMachine()` et al. create real atoms driven by `.apply()` calls deep
 * inside `runOpenSequence`; crossing an UNWRAPPED `await` — even one still textually
 * inside the same `context.start` callback — resumes outside the context that wrote them,
 * so a plain `await runOpenSequence(deps)` reads back a phase stuck at the machine's
 * INITIAL value instead of what the run actually did (verified against a minimal repro
 * before writing this comment; `open-sequence.ts`'s own header explains the same fact
 * from the implementation side).
 */

function slug(value: string): PageSlug {
  const parsed = parsePageSlug(value);
  if (parsed instanceof Error) throw parsed;
  return parsed;
}

const FAILURE: FailureDtoV1 = {
  code: "PERSISTENCE_FAILED",
  retryable: false,
  safeMessage: "boom",
  details: {},
};

function machines(): RecoveryRoutingMachines {
  return {
    project: reatomProjectStateMachine(),
    restore: reatomRestoreStateMachine(),
    exportMachine: reatomExportStateMachine(),
    migration: reatomMigrationStateMachine(),
  };
}

/** A deps set that runs the WHOLE sequence to a clean `opened` result; each test spreads its own overrides on top. */
function baseDeps(
  log: string[],
  store: ProjectStore,
  m: RecoveryRoutingMachines,
): OpenSequenceDeps {
  return {
    mode: "create",
    projectId: "fake-project-1",
    git: null,
    openProjectStore: async () => {
      log.push("open-project-store");
      return store;
    },
    readJournalFormat: async () => {
      log.push("journal-format");
      return undefined;
    },
    recovery: createFakeRecoveryService(),
    findIntendedRecoveryDomain: async () => {
      log.push("recovery-routing");
      return null;
    },
    recoverPendingMigrations: async () => {
      log.push("migrations-gate");
      return undefined;
    },
    validateSchemas: async () => {
      log.push("schema-validation");
      return undefined;
    },
    designReader: createFakeDesignStoreForPages({ pages: [] }),
    pinReader: createFakePinStore(),
    chatReader: createFakeChatStore(),
    exportPublish: createFakeExportPublish(),
    trustGate: createFakeTrustGate(),
    promptTrustDecision: async () => "grant",
    machines: m,
  };
}

describe("runOpenSequence — step ordering", () => {
  test("closed | beginOpen is illegal from a non-closed project: returns illegal, no step runs", async () => {
    await context.start(async () => {
      const log: string[] = [];
      const store = createFakeProjectStore({ root: "/fake" });
      const m = machines();
      const deps = baseDeps(log, store, m);
      m.project.apply("beginOpen"); // already "opening" before the sequence starts

      const outcome = await wrap(runOpenSequence(deps));

      expect(outcome).toEqual({ kind: "illegal", code: "PROJECT_NOT_READY" });
      expect(log).toEqual([]);
    });
  });

  test("step 1-2 (lease/fs) failure blocks before journal-format ever runs", async () => {
    await context.start(async () => {
      const log: string[] = [];
      const store = createFakeProjectStore({ root: "/fake" });
      const m = machines();
      const deps: OpenSequenceDeps = {
        ...baseDeps(log, store, m),
        openProjectStore: async () => {
          log.push("open-project-store");
          return FAILURE;
        },
      };

      const outcome = await wrap(runOpenSequence(deps));

      expect(outcome).toEqual({ kind: "blocked", step: "open-project-store", failure: FAILURE });
      expect(log).toEqual(["open-project-store"]);
      expect(m.project.phase()).toBe("blocked");
    });
  });

  test("step 3 (journal format) failure blocks before transaction-recovery ever runs", async () => {
    await context.start(async () => {
      const log: string[] = [];
      const store = createFakeProjectStore({ root: "/fake" });
      const m = machines();
      const deps: OpenSequenceDeps = {
        ...baseDeps(log, store, m),
        readJournalFormat: async () => {
          log.push("journal-format");
          return FAILURE;
        },
      };

      const outcome = await wrap(runOpenSequence(deps));

      expect(outcome).toEqual({ kind: "blocked", step: "journal-format", failure: FAILURE });
      expect(log).toEqual(["open-project-store", "journal-format"]);
      expect(m.project.phase()).toBe("blocked");
    });
  });

  test("step 4 (transaction recovery) conflict blocks before recovery-routing ever runs", async () => {
    await context.start(async () => {
      const log: string[] = [];
      const store = createFakeProjectStore({ root: "/fake" });
      const m = machines();
      const recovery = createFakeRecoveryService();
      recovery.scriptRecoverOutcome({ ok: false, transactionId: "tx-1", error: FAILURE });
      const deps: OpenSequenceDeps = { ...baseDeps(log, store, m), recovery };

      const outcome = await wrap(runOpenSequence(deps));

      expect(outcome).toEqual({ kind: "blocked", step: "transaction-recovery", failure: FAILURE });
      expect(log).toEqual(["open-project-store", "journal-format"]);
      expect(recovery.calls.map((c) => c.method)).toEqual(["recover"]);
      expect(m.project.phase()).toBe("blocked");
    });
  });

  test("step 5 (recovery-routing discovery) failure blocks before migrations-gate ever runs", async () => {
    await context.start(async () => {
      const log: string[] = [];
      const store = createFakeProjectStore({ root: "/fake" });
      const m = machines();
      const deps: OpenSequenceDeps = {
        ...baseDeps(log, store, m),
        findIntendedRecoveryDomain: async () => {
          log.push("recovery-routing");
          return FAILURE;
        },
      };

      const outcome = await wrap(runOpenSequence(deps));

      expect(outcome).toEqual({ kind: "blocked", step: "recovery-routing", failure: FAILURE });
      expect(log).toEqual(["open-project-store", "journal-format", "recovery-routing"]);
      expect(m.project.phase()).toBe("blocked");
    });
  });

  test("an intended recovery journal stops the sequence at 'recovering' — migrations-gate never runs (KCC §7.7: post-intent recovery runs before trust)", async () => {
    await context.start(async () => {
      const log: string[] = [];
      const store = createFakeProjectStore({ root: "/fake" });
      const m = machines();
      const deps: OpenSequenceDeps = {
        ...baseDeps(log, store, m),
        findIntendedRecoveryDomain: async () => {
          log.push("recovery-routing");
          return "migration";
        },
      };

      const outcome = await wrap(runOpenSequence(deps));

      expect(outcome).toEqual({ kind: "recovering", domain: "migration" });
      expect(log).toEqual(["open-project-store", "journal-format", "recovery-routing"]);
      expect(m.project.phase()).toBe("recovering");
      expect(m.migration.phase()).toBe("recovering");
    });
  });

  test("step 6 (migrations gate) failure blocks before schema-validation ever runs", async () => {
    await context.start(async () => {
      const log: string[] = [];
      const store = createFakeProjectStore({ root: "/fake" });
      const m = machines();
      const deps: OpenSequenceDeps = {
        ...baseDeps(log, store, m),
        recoverPendingMigrations: async () => {
          log.push("migrations-gate");
          return FAILURE;
        },
      };

      const outcome = await wrap(runOpenSequence(deps));

      expect(outcome).toEqual({ kind: "blocked", step: "migrations-gate", failure: FAILURE });
      expect(log).toEqual([
        "open-project-store",
        "journal-format",
        "recovery-routing",
        "migrations-gate",
      ]);
    });
  });

  test("step 7 (schema validation) failure blocks before the orphan-turn scan ever runs", async () => {
    await context.start(async () => {
      const log: string[] = [];
      const store = createFakeProjectStore({ root: "/fake" });
      const m = machines();
      const recovery = createFakeRecoveryService();
      const deps: OpenSequenceDeps = {
        ...baseDeps(log, store, m),
        recovery,
        validateSchemas: async () => {
          log.push("schema-validation");
          return FAILURE;
        },
      };

      const outcome = await wrap(runOpenSequence(deps));

      expect(outcome).toEqual({ kind: "blocked", step: "schema-validation", failure: FAILURE });
      expect(log).toEqual([
        "open-project-store",
        "journal-format",
        "recovery-routing",
        "migrations-gate",
        "schema-validation",
      ]);
      expect(recovery.calls.map((c) => c.method)).toEqual(["recover"]); // scanOrphanTurns never reached
    });
  });

  test("step 8 (orphan-turn scan) port failure blocks before content-validation ever runs", async () => {
    await context.start(async () => {
      const log: string[] = [];
      const store = createFakeProjectStore({ root: "/fake" });
      const m = machines();
      const recovery = createFakeRecoveryService();
      recovery.failNext("scanOrphanTurns", FAILURE);
      const designReader = createFakeDesignStoreForPages({ pages: [] });
      const deps: OpenSequenceDeps = { ...baseDeps(log, store, m), recovery, designReader };

      const outcome = await wrap(runOpenSequence(deps));

      expect(outcome).toEqual({ kind: "blocked", step: "orphan-turn-scan", failure: FAILURE });
      expect(designReader.calls).toEqual([]); // content-validation never reached
    });
  });

  test("step 8 chat_corrupt blocks before content-validation ever runs", async () => {
    await context.start(async () => {
      const log: string[] = [];
      const store = createFakeProjectStore({ root: "/fake" });
      const m = machines();
      const recovery = createFakeRecoveryService({
        orphans: [{ chatId: "chat-a", turnId: "turn-1", terminalized: false }],
      });
      const designReader = createFakeDesignStoreForPages({ pages: [] });
      const deps: OpenSequenceDeps = { ...baseDeps(log, store, m), recovery, designReader };

      const outcome = await wrap(runOpenSequence(deps));

      if (outcome.kind !== "blocked") throw new Error(`expected blocked, got ${outcome.kind}`);
      expect(outcome.step).toBe("orphan-turn-scan");
      expect(designReader.calls).toEqual([]); // content-validation never reached
      expect(m.project.phase()).toBe("blocked");
    });
  });

  test("step 9 (content validation: a listed page unreadable) blocks before trust is ever resolved", async () => {
    await context.start(async () => {
      const log: string[] = [];
      // The page list this test needs comes from `design/pages.json` below, not the
      // portable manifest (`ProjectManifestV1` carries no `pages` field as of format_version
      // 2) — `store`'s own manifest content is irrelevant to this test.
      const store = createFakeProjectStore({ root: "/fake" });
      const m = machines();
      // A manifest entry with NO tree file seeded for it: the entry resolves, the
      // `readTreeFile` of it does not — which is the content-validation failure this test is
      // about, now expressed through the manifest instead of a slug-derived path.
      const designReader = createFakeDesignStore({
        manifest: {
          schemaVersion: 1,
          pages: [{ slug: slug("home"), entry: "screens/landing/main.tsx" }],
          requestedActivePage: null,
        },
      });
      const trustGate = createFakeTrustGate();
      const deps: OpenSequenceDeps = { ...baseDeps(log, store, m), designReader, trustGate };

      const outcome = await wrap(runOpenSequence(deps));

      if (outcome.kind !== "blocked") throw new Error(`expected blocked, got ${outcome.kind}`);
      expect(outcome.step).toBe("content-validation");
      expect(trustGate.calls).toEqual([]); // trust step never reached
    });
  });

  test("step 9 (content validation: a corrupt export pointer, TD §12 step 9) blocks before trust is ever resolved", async () => {
    await context.start(async () => {
      const log: string[] = [];
      const store = createFakeProjectStore({ root: "/fake" });
      const m = machines();
      const exportPublish = createFakeExportPublish();
      exportPublish.failNextRead(FAILURE);
      const trustGate = createFakeTrustGate();
      const deps: OpenSequenceDeps = { ...baseDeps(log, store, m), exportPublish, trustGate };

      const outcome = await wrap(runOpenSequence(deps));

      if (outcome.kind !== "blocked") throw new Error(`expected blocked, got ${outcome.kind}`);
      expect(outcome.step).toBe("content-validation");
      expect(outcome.failure).toEqual(FAILURE);
      expect(trustGate.calls).toEqual([]); // trust step never reached
    });
  });

  test("step 9: a null export pointer (no export published yet) never blocks — absent is valid", async () => {
    await context.start(async () => {
      const log: string[] = [];
      const store = createFakeProjectStore({ root: "/fake" });
      const m = machines();
      const exportPublish = createFakeExportPublish(); // readPointer() defaults to null
      const deps: OpenSequenceDeps = { ...baseDeps(log, store, m), exportPublish };

      const outcome = await wrap(runOpenSequence(deps));

      expect(outcome).toEqual({ kind: "opened", store, trust: "trusted" });
    });
  });

  test("happy path with nothing to recover: opened, trusted, every step ran in order", async () => {
    await context.start(async () => {
      const log: string[] = [];
      const store = createFakeProjectStore({ root: "/fake" });
      const m = machines();
      const deps = baseDeps(log, store, m);

      const outcome = await wrap(runOpenSequence(deps));

      expect(outcome).toEqual({ kind: "opened", store, trust: "trusted" });
      expect(log).toEqual([
        "open-project-store",
        "journal-format",
        "recovery-routing",
        "migrations-gate",
        "schema-validation",
      ]);
      expect(m.project.phase()).toBe("ready");
    });
  });
});

describe("runOpenSequence — trust (KCC §7.1/§12.8)", () => {
  test("project.create implicitly grants trust and never prompts", async () => {
    await context.start(async () => {
      const log: string[] = [];
      const store = createFakeProjectStore({ root: "/fake" });
      const m = machines();
      const trustGate = createFakeTrustGate();
      let prompted = false;
      const deps: OpenSequenceDeps = {
        ...baseDeps(log, store, m),
        mode: "create",
        trustGate,
        promptTrustDecision: async () => {
          prompted = true;
          return "grant";
        },
      };

      const outcome = await wrap(runOpenSequence(deps));

      expect(outcome).toEqual({ kind: "opened", store, trust: "trusted" });
      expect(prompted).toBe(false);
      expect(trustGate.calls.map((c) => c.method)).toEqual(["buildSubject", "grant"]);
    });
  });

  test("project.open with a prior grant skips the prompt entirely", async () => {
    await context.start(async () => {
      const log: string[] = [];
      const store = createFakeProjectStore({ root: "/fake" });
      const m = machines();
      const trustGate = createFakeTrustGate();
      let prompted = false;
      const projectId = "fake-project-1";
      // Pre-grant the exact subject this run will build.
      const subject = await trustGate.buildSubject(store.root, projectId, null);
      if ("code" in subject) throw new Error("unexpected failure");
      await trustGate.grant(subject);

      const deps: OpenSequenceDeps = {
        ...baseDeps(log, store, m),
        mode: "open",
        projectId,
        trustGate,
        promptTrustDecision: async () => {
          prompted = true;
          return "grant";
        },
      };

      const outcome = await wrap(runOpenSequence(deps));

      expect(outcome).toEqual({ kind: "opened", store, trust: "trusted" });
      expect(prompted).toBe(false);
    });
  });

  test("project.open with no prior grant prompts, and an explicit refusal ends 'opened' with untrusted-read-only — never calling grant", async () => {
    await context.start(async () => {
      const log: string[] = [];
      const store = createFakeProjectStore({ root: "/fake" });
      const m = machines();
      const trustGate = createFakeTrustGate();
      const deps: OpenSequenceDeps = {
        ...baseDeps(log, store, m),
        mode: "open",
        trustGate,
        promptTrustDecision: async () => "refuse",
      };

      const outcome = await wrap(runOpenSequence(deps));

      expect(outcome).toEqual({ kind: "opened", store, trust: "untrusted-read-only" });
      expect(m.project.phase()).toBe("ready");
      // KCC §12.8's negative: refusal never calls TrustGate.grant, and this module's own
      // Deps type names no Gate/HostSupervisor/migration-transform dependency, and its one
      // export dependency is READ-ONLY (`readPointer`, never `publish`) — a refusal path
      // cannot start what it was never given a reference to, or write access it was never
      // granted.
      expect(trustGate.calls.map((c) => c.method)).toEqual(["buildSubject", "isGranted"]);
    });
  });

  test("project.open with no prior grant and an explicit grant durably records it", async () => {
    await context.start(async () => {
      const log: string[] = [];
      const store = createFakeProjectStore({ root: "/fake" });
      const m = machines();
      const trustGate = createFakeTrustGate();
      const deps: OpenSequenceDeps = {
        ...baseDeps(log, store, m),
        mode: "open",
        trustGate,
        promptTrustDecision: async () => "grant",
      };

      const outcome = await wrap(runOpenSequence(deps));

      expect(outcome).toEqual({ kind: "opened", store, trust: "trusted" });
      expect(trustGate.calls.map((c) => c.method)).toEqual(["buildSubject", "isGranted", "grant"]);
    });
  });
});
