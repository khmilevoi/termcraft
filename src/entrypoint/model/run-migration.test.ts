import { describe, expect, test } from "bun:test";

import type { MigrationOutcomeV1, MigrationPlanV1, Store } from "store";
import type { UiRootAdapters } from "ui";

import { MigrationDeclinedError, runMigrationPrompt } from "./run-migration";

const PLAN: MigrationPlanV1 = {
  migrationPlanId: "019fb111-0000-7000-8000-000000000001",
  fromVersion: 1,
  toVersion: 3,
  projectId: "019fa002-5f5b-7000-92e3-9931eebd6c52",
  moves: [],
  pageCount: 2,
  pinLogCount: 0,
  seedsDesignSystem: true,
  backupsDir: "C:\\state\\backups\\019fa002",
};

const OUTCOME: MigrationOutcomeV1 = {
  migrationPlanId: PLAN.migrationPlanId,
  migrationActionId: "019fb111-0000-7000-8000-000000000002",
  backupDir: "C:\\state\\backups\\019fa002\\019fb111",
};

/** A store whose only wired method is `migrateProject`; anything else is a loud refusal. */
function fakeStore(migrate: () => Promise<Error | MigrationOutcomeV1>): Store {
  return {
    openProject: async () => new Error("openProject is not wired in this fake"),
    createProject: async () => new Error("createProject is not wired in this fake"),
    planMigration: async () => new Error("planMigration is not wired in this fake"),
    migrateProject: migrate,
  };
}

/**
 * Adapters that never mount, and answer the offer with `choice` as soon as it is rendered.
 *
 * The same technique `run-app.test.ts`'s `capturingAdapters` already uses: this suite's
 * `createRoot` double receives the plain `{ type, props }` element `<MigrationSurface … />`
 * evaluates to and never mounts it, so `props.onChoice` IS the resolver `createMigrationRoot`
 * closed over — the only way to answer the dialog without a real terminal. Which KEY maps to
 * which choice is not tested here; that is `migrationChoiceForKey`'s own pure test in `ui/setup`.
 */
function answeringAdapters(choice: "migrate" | "later") {
  const calls: string[] = [];
  const adapters: UiRootAdapters = {
    createRenderer: () =>
      Promise.resolve({ width: 120, height: 36, destroy: () => calls.push("destroy") }),
    createRoot: () => ({
      render: (node: unknown) => {
        calls.push("render");
        (node as { props: { onChoice: (picked: "migrate" | "later") => void } }).props.onChoice(
          choice,
        );
      },
      unmount: () => calls.push("unmount"),
    }),
  };
  return { adapters, destroyed: () => calls.includes("destroy") };
}

describe("runMigrationPrompt (design-tree §12.1's two keys)", () => {
  test("'later' declines, writes nothing, and never calls migrateProject", async () => {
    let called = 0;
    const driven = answeringAdapters("later");
    const outcome = await runMigrationPrompt({
      required: { kind: "needs-migration", root: "C:\\p", plan: PLAN },
      kitApiVersion: 1,
      store: fakeStore(async () => {
        called += 1;
        return OUTCOME;
      }),
      adapters: driven.adapters,
    });
    expect(outcome).toBeInstanceOf(MigrationDeclinedError);
    expect((outcome as MigrationDeclinedError).message).toContain("C:\\p");
    expect(called).toBe(0);
  });

  test("'migrate' runs the migration and returns its outcome", async () => {
    const driven = answeringAdapters("migrate");
    const outcome = await runMigrationPrompt({
      required: { kind: "needs-migration", root: "C:\\p", plan: PLAN },
      kitApiVersion: 1,
      store: fakeStore(async () => OUTCOME),
      adapters: driven.adapters,
    });
    expect(outcome).toEqual(OUTCOME);
  });

  test("a failing migration returns its error, not a declination", async () => {
    const failure = new Error("backup verification failed");
    const driven = answeringAdapters("migrate");
    const outcome = await runMigrationPrompt({
      required: { kind: "needs-migration", root: "C:\\p", plan: PLAN },
      kitApiVersion: 1,
      store: fakeStore(async () => failure),
      adapters: driven.adapters,
    });
    expect(outcome).toBe(failure);
    expect(outcome).not.toBeInstanceOf(MigrationDeclinedError);
  });

  test("the terminal is released on the declined path", async () => {
    const driven = answeringAdapters("later");
    await runMigrationPrompt({
      required: { kind: "needs-migration", root: "C:\\p", plan: PLAN },
      kitApiVersion: 1,
      store: fakeStore(async () => OUTCOME),
      adapters: driven.adapters,
    });
    expect(driven.destroyed()).toBe(true);
  });

  test("the terminal is released even when the migration fails", async () => {
    const driven = answeringAdapters("migrate");
    await runMigrationPrompt({
      required: { kind: "needs-migration", root: "C:\\p", plan: PLAN },
      kitApiVersion: 1,
      store: fakeStore(async () => new Error("boom")),
      adapters: driven.adapters,
    });
    expect(driven.destroyed()).toBe(true);
  });
});
