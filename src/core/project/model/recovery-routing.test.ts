import { describe, expect, test } from "bun:test";

import { context } from "@reatom/core";

import {
  reatomExportStateMachine,
  reatomMigrationStateMachine,
  reatomProjectStateMachine,
  reatomRestoreStateMachine,
} from "core/machines";

import { type RecoveryRoutingMachines, routeProjectRecovery } from "./recovery-routing";

/**
 * KCC §12.7 (lines 1189-1195) / §7.1's own `beginRecovery` row: "routes exactly one
 * intended Restore, ExportPublish, or Migration journal from that domain's `idle` state
 * to `recovering`... Journals with no intent are discarded and cannot enter recovery."
 */

function machines(): RecoveryRoutingMachines {
  return {
    project: reatomProjectStateMachine(),
    restore: reatomRestoreStateMachine(),
    exportMachine: reatomExportStateMachine(),
    migration: reatomMigrationStateMachine(),
  };
}

describe("routeProjectRecovery", () => {
  test("no intended journal: discarded — project stays in opening, no domain machine moves", () => {
    context.start(() => {
      const m = machines();
      m.project.apply("beginOpen");

      const outcome = routeProjectRecovery(m, null);

      expect(outcome).toEqual({ kind: "no-intent" });
      expect(m.project.phase()).toBe("opening");
      expect(m.restore.phase()).toBe("idle");
      expect(m.exportMachine.phase()).toBe("idle");
      expect(m.migration.phase()).toBe("idle");
    });
  });

  test("an intended Restore journal routes project + restore to recovering, and only restore", () => {
    context.start(() => {
      const m = machines();
      m.project.apply("beginOpen");

      const outcome = routeProjectRecovery(m, "restore");

      expect(outcome).toEqual({ kind: "routed", domain: "restore" });
      expect(m.project.phase()).toBe("recovering");
      expect(m.restore.phase()).toBe("recovering");
      expect(m.exportMachine.phase()).toBe("idle");
      expect(m.migration.phase()).toBe("idle");
    });
  });

  test("an intended Export journal routes project + export to recovering, and only export", () => {
    context.start(() => {
      const m = machines();
      m.project.apply("beginOpen");

      const outcome = routeProjectRecovery(m, "export");

      expect(outcome).toEqual({ kind: "routed", domain: "export" });
      expect(m.project.phase()).toBe("recovering");
      expect(m.exportMachine.phase()).toBe("recovering");
      expect(m.restore.phase()).toBe("idle");
      expect(m.migration.phase()).toBe("idle");
    });
  });

  test("an intended Migration journal routes project + migration to recovering, and only migration", () => {
    context.start(() => {
      const m = machines();
      m.project.apply("beginOpen");

      const outcome = routeProjectRecovery(m, "migration");

      expect(outcome).toEqual({ kind: "routed", domain: "migration" });
      expect(m.project.phase()).toBe("recovering");
      expect(m.migration.phase()).toBe("recovering");
      expect(m.restore.phase()).toBe("idle");
      expect(m.exportMachine.phase()).toBe("idle");
    });
  });

  test("project not in opening: beginRecovery is illegal and no domain machine is touched", () => {
    context.start(() => {
      const m = machines(); // project starts "closed" — beginRecovery is only legal from "opening"

      const outcome = routeProjectRecovery(m, "migration");

      expect(outcome).toEqual({ kind: "illegal", code: "PROJECT_NOT_READY" });
      expect(m.project.phase()).toBe("closed");
      expect(m.migration.phase()).toBe("idle");
    });
  });
});
