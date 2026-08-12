import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  designSystemMigrationSeed,
  formatOneMigrationSeed,
  migrationRefactorSeed,
} from "agent/prompt";
import type { SpawnFn } from "host/supervisor";
import type { UiRootAdapters } from "ui";

import type { AppShell, ProcessBoundary } from "../types";
import { bootstrap } from "./bootstrap";
import type { ShellDeps } from "./create-shell";

function silentBoundary(): ProcessBoundary {
  return { onSignal: () => undefined, reportFatal: () => undefined };
}

function recordingAdapters(calls: string[]): UiRootAdapters {
  return {
    createRenderer: () => {
      calls.push("renderer");
      return Promise.resolve({ width: 120, height: 36, destroy: () => calls.push("destroy") });
    },
    createRoot: () => ({
      render: () => calls.push("render"),
      unmount: () => calls.push("unmount"),
    }),
  };
}

const NEVER_SPAWN: ShellDeps["spawn"] = () => {
  throw new Error("spawn must not be called while merely composing a shell");
};

const scratchDirs: string[] = [];
function makeScratchDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

function shellDepsFor(scratch: string): ShellDeps {
  return {
    userStateRoot: path.join(scratch, "user-state"),
    execPath: "bun",
    srcRoot: "src/main.tsx",
    spawn: NEVER_SPAWN,
  };
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("bootstrap", () => {
  test("demo mode starts the UI against the in-memory shell", async () => {
    const calls: string[] = [];
    const app = await bootstrap("demo", {
      argv: [],
      cwd: () => "C:/projects/site",
      adapters: recordingAdapters(calls),
      process: silentBoundary(),
    });

    expect(app).not.toBeInstanceOf(Error);
    if (app instanceof Error) throw app;
    expect(calls).toEqual(["renderer", "render"]);
    await app.close();
  });

  test("interactive mode composes the real Kernel and starts the UI against it", async () => {
    const scratch = makeScratchDir("termcraft-bootstrap-");
    const calls: string[] = [];
    const app = await bootstrap("interactive", {
      argv: [],
      cwd: () => scratch,
      adapters: recordingAdapters(calls),
      process: silentBoundary(),
      shell: shellDepsFor(scratch),
    });

    expect(app).not.toBeInstanceOf(Error);
    if (app instanceof Error) throw app;
    expect(calls).toEqual(["renderer", "render"]);
    expect(fs.existsSync(path.join(scratch, ".termcraft"))).toBe(true);
    await app.close();
  });

  test("interactive mode with a target argument opens the shell on the resolved project root", async () => {
    const scratch = makeScratchDir("termcraft-bootstrap-target-");
    const calls: string[] = [];
    const app = await bootstrap("interactive", {
      argv: ["site"],
      cwd: () => scratch,
      adapters: recordingAdapters(calls),
      process: silentBoundary(),
      shell: shellDepsFor(scratch),
    });

    expect(app).not.toBeInstanceOf(Error);
    if (app instanceof Error) throw app;
    expect(calls).toEqual(["renderer", "render"]);
    expect(app.shell.env.root).toBe(path.resolve(scratch, "site"));
    await app.close();
  });

  test("interactive mode defaults the project root to the working directory", async () => {
    const scratch = makeScratchDir("termcraft-bootstrap-default-");
    const app = await bootstrap("interactive", {
      argv: [],
      cwd: () => scratch,
      adapters: recordingAdapters([]),
      process: silentBoundary(),
      shell: shellDepsFor(scratch),
    });

    if (app instanceof Error) throw app;
    expect(app.shell.env.root).toBe(path.resolve(scratch));
    await app.close();
  });

  test("an ordinary launch seeds nothing (design-systems §9)", async () => {
    const scratch = makeScratchDir("termcraft-bootstrap-no-seed-");
    const app = await bootstrap("interactive", {
      argv: [],
      cwd: () => scratch,
      adapters: recordingAdapters([]),
      process: silentBoundary(),
      shell: shellDepsFor(scratch),
    });

    if (app instanceof Error) throw app;
    if (!shellHasSeedFields(app.shell)) throw new Error("expected a shell with seed fields");
    expect(app.shell.seedComposerText).toBe(null);
    expect(app.shell.seedTurnText).toBe(null);
    await app.close();
  });
});

// --- design-systems §9: the code-migration prompt is a seeded composer draft, never an
// automatic turn ------------------------------------------------------------------------

/** The same committed format-1 fixture `store/model/migration-fixture.test.ts` reads — a real
 *  "clock" project with two pages, nothing hand-rolled for this suite. */
const FORMAT_V1_FIXTURE = path.join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "test-fixtures",
  "format-v1-project",
);

/** A fresh scratch root whose `.termcraft` is a real, on-disk format-1 project — the ONLY way
 *  to drive `bootstrap`'s migration branch end to end, rather than faking `createShell`'s return
 *  (which `bootstrap.ts` never takes as a seam). */
function seedFormatV1Root(): string {
  const root = makeScratchDir("termcraft-bootstrap-migrate-");
  fs.cpSync(FORMAT_V1_FIXTURE, path.join(root, ".termcraft"), { recursive: true });
  fs.rmSync(path.join(root, ".termcraft", "README.md"));
  return root;
}

/**
 * A `SpawnFn` returning a fresh, never-exiting fake child every call (the same shape
 * `host/supervisor/model/supervisor.test.ts`'s own `trackingSpawn` uses) — NOT `NEVER_SPAWN`.
 * The migrated project below is reopened as EXISTING, so `run-app.ts`'s Gap D startup dispatch
 * (`project.open`) really runs and the Kernel's `beginOpen` handler really tries to spawn a host
 * preview child; `NEVER_SPAWN`'s throw drives the host supervisor's real-clock backoff/retry loop
 * for several seconds before the test times out. A working stub child that just never becomes
 * "ready" lets that background operation fail cleanly (`REAP_TIMEOUT_MS`, `session.ts`) instead.
 */
function stubHostSpawn(): SpawnFn {
  return () => ({
    stdin: { write: () => undefined, flush: () => undefined, end: () => undefined },
    stdout: (async function* () {})(),
    stderr: (async function* () {})(),
    exited: new Promise<number>(() => undefined), // never exits on its own — reaped by timeout
    exitCode: null,
    signalCode: null,
    kill() {
      return undefined;
    },
  });
}

function shellDepsForExistingLaunch(scratch: string): ShellDeps {
  return { ...shellDepsFor(scratch), spawn: stubHostSpawn() };
}

/**
 * A hand-built format-2 `.termcraft` root — the multi-file design tree already in place,
 * `design/system/` absent so the migration has something to seed. Mirrors
 * `store/model/migration-fixture.test.ts`'s own `seedFormatTwoProject` byte-for-byte rather than
 * importing it: importing a `*.test.ts` module re-registers its `describe`/`test` blocks under
 * THIS file's run too, which is not a seam this suite should reach through.
 */
function seedFormatTwoRoot(slugs: readonly string[] = ["dashboard"]): string {
  const root = makeScratchDir("termcraft-bootstrap-migrate-v2-");
  const termcraftDir = path.join(root, ".termcraft");
  fs.mkdirSync(path.join(termcraftDir, "design", "pages"), { recursive: true });
  fs.writeFileSync(
    path.join(termcraftDir, "project.toml"),
    [
      "format_version = 2",
      'project_id = "019fa002-5f5b-7000-92e3-9931eebd6c54"',
      'name = "seeded-v2-bootstrap"',
      'created_at = "2026-07-26T19:58:57.883Z"',
      'target_stack = "js-opentui"',
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(termcraftDir, "design", "pages.json"),
    JSON.stringify({
      schemaVersion: 1,
      pages: slugs.map((slug) => ({ slug, entry: `pages/${slug}.tsx` })),
    }),
  );
  for (const slug of slugs) {
    fs.writeFileSync(
      path.join(termcraftDir, "design", "pages", `${slug}.tsx`),
      `export const meta = { title: "${slug}" };\n`,
    );
  }
  return root;
}

/** Real host composition, backup and reopen against the fixture take real wall-clock time
 *  (including the ~1s host-reap timeout above) — longer than bun's 5s default. */
const MIGRATION_TEST_TIMEOUT_MS = 30_000;

/** Narrows a rendered element's `unknown` node to the migration dialog's own `onChoice` shape —
 *  the same technique `run-migration.test.ts`'s `answeringAdapters` uses, expressed as a type
 *  guard so no `as` cast is needed at the call site. */
function isMigrationChoiceNode(
  node: unknown,
): node is { props: { onChoice: (picked: "migrate" | "later") => void } } {
  if (typeof node !== "object" || node === null) return false;
  if (!("props" in node)) return false;
  const { props } = node;
  if (typeof props !== "object" || props === null) return false;
  if (!("onChoice" in props)) return false;
  return typeof props.onChoice === "function";
}

/** Narrows a rendered element's `unknown` node to the real `App`'s own `deps.local.composer`
 *  read — the same technique `run-app.test.ts`'s `capturingAdapters` uses for `requestExit`,
 *  expressed as a type guard so no `as` cast is needed at the call site. */
function isAppComposerNode(
  node: unknown,
): node is { props: { deps: { local: { composer: () => string } } } } {
  if (typeof node !== "object" || node === null) return false;
  if (!("props" in node)) return false;
  const { props } = node;
  if (typeof props !== "object" || props === null) return false;
  if (!("deps" in props)) return false;
  const { deps } = props;
  if (typeof deps !== "object" || deps === null) return false;
  if (!("local" in deps)) return false;
  const { local } = deps;
  if (typeof local !== "object" || local === null) return false;
  if (!("composer" in local)) return false;
  return typeof local.composer === "function";
}

/**
 * Adapters that drive BOTH renders `bootstrap`'s migration path produces with the SAME
 * `deps.adapters` value: `runMigrationPrompt`'s dialog (answered "migrate" the instant it
 * renders, exactly as `run-migration.test.ts`'s `answeringAdapters` does) and, afterwards,
 * `runApp`'s real `App` mount, off which the composer's seeded text is captured — proving the
 * seed reached `createUiDeps`'s seventh parameter through `run-app.ts`'s spread-omit, not merely
 * that `ShellWithAgentRegistry.seedComposerText` itself was set.
 */
function migrateThenCaptureComposer(): {
  adapters: UiRootAdapters;
  composerText: () => string | null;
} {
  let composerText: string | null = null;
  const adapters: UiRootAdapters = {
    createRenderer: () => Promise.resolve({ width: 120, height: 36, destroy: () => undefined }),
    createRoot: () => ({
      render: (node: unknown) => {
        if (isMigrationChoiceNode(node)) {
          node.props.onChoice("migrate");
          return;
        }
        if (isAppComposerNode(node)) composerText = node.props.deps.local.composer();
      },
      unmount: () => undefined,
    }),
  };
  return { adapters, composerText: () => composerText };
}

/** Narrows the bare `AppShell` a `RunningApp` exposes to the wider `ShellWithAgentRegistry`
 *  shape this suite needs, without an `as` cast — every production shell actually carries both
 *  fields; only the static `RunningApp.shell: AppShell` type is narrower. */
function shellHasSeedFields(
  shell: AppShell,
): shell is AppShell & { seedComposerText: string | null; seedTurnText: string | null } {
  return "seedComposerText" in shell && "seedTurnText" in shell;
}

describe("bootstrap migrates a format-1 project (design-systems §9)", () => {
  test(
    "pre-fills the composer with the design-system seed and starts no turn",
    async () => {
      const root = seedFormatV1Root();
      const driven = migrateThenCaptureComposer();
      const app = await bootstrap("interactive", {
        argv: [],
        cwd: () => root,
        adapters: driven.adapters,
        process: silentBoundary(),
        shell: shellDepsForExistingLaunch(root),
      });

      if (app instanceof Error) throw app;
      if (!shellHasSeedFields(app.shell)) throw new Error("expected a shell with seed fields");
      // "The turn never runs automatically — the migration dialog's confirmation covers the
      // mechanical file changes, not spending agent tokens."
      expect(app.shell.seedTurnText).toBe(null);
      expect(app.shell.seedComposerText).toContain("color={t.");
      // Proves the seed actually reached the mounted App's composer atom (`run-app.ts`'s
      // spread-omit into `createUiRoot`, `deps.ts`'s seventh `createUiDeps` parameter) — not
      // only that the shell field was set.
      expect(driven.composerText()).toBe(app.shell.seedComposerText);
      await app.close();
    },
    MIGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "a format-1 origin also carries the shared-module refactor instruction, bridged not just concatenated",
    async () => {
      const root = seedFormatV1Root();
      const driven = migrateThenCaptureComposer();
      const app = await bootstrap("interactive", {
        argv: [],
        cwd: () => root,
        adapters: driven.adapters,
        process: silentBoundary(),
        shell: shellDepsForExistingLaunch(root),
      });

      if (app instanceof Error) throw app;
      if (!shellHasSeedFields(app.shell)) throw new Error("expected a shell with seed fields");
      // The fixture's own `project.toml` lists exactly two pages (`dashboard`, `calendar`).
      expect(app.shell.seedComposerText).toContain(migrationRefactorSeed({ pageCount: 2 }));
      // `bootstrap.ts` joins the two seeds through `formatOneMigrationSeed`, not a bare
      // concatenation — end to end, the real seeded draft must be exactly that function's output,
      // bridge sentence included (review finding 2: the two seeds contradict each other unjoined).
      expect(app.shell.seedComposerText).toBe(formatOneMigrationSeed({ pageCount: 2 }));
      expect(app.shell.seedComposerText).toContain("as ONE move");
      await app.close();
    },
    MIGRATION_TEST_TIMEOUT_MS,
  );
});

// Review finding 2 (P4 final fix wave): every project on disk today is format 2, so this is the
// branch nearly every real user hits — yet before this test it was the ONLY untested one of the
// two `bootstrap.ts:86-89` seed branches.
describe("bootstrap migrates a format-2 project (design-systems §9)", () => {
  test(
    "pre-fills the composer with ONLY the design-system seed — no format-1 bridge text",
    async () => {
      const root = seedFormatTwoRoot();
      const driven = migrateThenCaptureComposer();
      const app = await bootstrap("interactive", {
        argv: [],
        cwd: () => root,
        adapters: driven.adapters,
        process: silentBoundary(),
        shell: shellDepsForExistingLaunch(root),
      });

      if (app instanceof Error) throw app;
      if (!shellHasSeedFields(app.shell)) throw new Error("expected a shell with seed fields");
      expect(app.shell.seedTurnText).toBe(null);
      // The fixture's own `design/pages.json` lists exactly one page (`dashboard`). A format-2
      // origin never carries `formatOneMigrationSeed`'s refactor track or bridge sentence
      // (`bootstrap.ts`'s `fromVersion === 1` branch) — it already has the multi-file tree, so
      // only the design-system rewrite applies.
      expect(app.shell.seedComposerText).toBe(designSystemMigrationSeed({ pageCount: 1 }));
      expect(app.shell.seedComposerText).not.toContain("as ONE move");
      expect(app.shell.seedComposerText).not.toContain(
        "Do the sharing above and the design-system rewrite below",
      );
      expect(driven.composerText()).toBe(app.shell.seedComposerText);
      await app.close();
    },
    MIGRATION_TEST_TIMEOUT_MS,
  );
});
