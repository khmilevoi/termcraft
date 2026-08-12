import { afterEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Kernel } from "core/kernel";
import type { PreviewFrameV1, PreviewIdentityV1, RunTreeResultV1 } from "core/ports";
import { createFakePreviewSession } from "core/ports/fakes";
import { FrameAckError, PreviewNoLiveSessionError, createFrameTokenLedger } from "core/preview";
import type { UUIDv7 } from "core/protocol";
import { parseDesignSystemId, parseDesignSystemVersion } from "entities/design-system-ref";
import { validManifestObject } from "entities/design-system/model/manifest.fixture";
import { encodePagesManifest } from "entities/design-tree";
import type { PagesManifestV1 } from "entities/design-tree";
import { type PageSlug, parsePageSlug } from "entities/page";
import { resolveCompilerPath } from "gate";
import type { SmokeRenderer, SmokeRequest, SmokeResult } from "gate";
import { systemClock } from "infrastructure/clock";
import { uuidv7 } from "infrastructure/uuid";
import { CURRENT_KIT_API_VERSION } from "runtime";
import { createStore, nodeStoreDeps } from "store";
import type { OpenProject, StoreAdapterDeps } from "store";
import { PROJECT_MANIFEST_FILENAME, WORKSPACE_STATE_FILENAME } from "store/toml";
import type { EventEnvelopeV1, UiEnv } from "ui";

import type { MigrationRequiredV1, ShellWithAgentRegistry } from "../types";
import {
  ShellTeardownError,
  buildDesignSystemDeps,
  buildGateRunner,
  closeShellResources,
  createShell,
  toPreviewSessionHandle,
} from "./create-shell";
import type { ShellDeps, ShellTeardownStep } from "./create-shell";

/** Never actually invoked: constructing a shell never spawns the design host (only a live
 *  `.preview()` call does) — provided defensively so a regression fails loudly instead of
 *  silently touching a real child process. */
const NEVER_SPAWN: ShellDeps["spawn"] = () => {
  throw new Error("spawn must not be called while merely composing a shell");
};

function testShellDeps(scratch: string): ShellDeps {
  return {
    userStateRoot: path.join(scratch, "user-state"),
    execPath: "bun",
    srcRoot: "src/main.tsx",
    spawn: NEVER_SPAWN,
  };
}

const scratchDirs: string[] = [];
function makeScratchDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// --- Gap D fixtures (an existing project opens straight into the Workspace) -------------------

/** The `UiEnv` every `createShell("interactive", ...)` call in this file needs — `projectExists`
 *  is never read by `createShell` itself (only `home-submit`, `ui/app/model/intent.ts`, reads
 *  it), so a placeholder `false` here is harmless regardless of what `root` actually holds. */
function envFor(root: string): UiEnv {
  return { root, workspaceIdentity: root, projectExists: false };
}

/** A brand-new, never-materialized directory — `ensureRootDirectory` (`create-shell.ts`) creates
 *  it, so `store.createProject` is the only path `openOrCreateProject` can take against it. */
async function emptyDir(): Promise<string> {
  const scratch = makeScratchDir("termcraft-shell-gap-d-empty-");
  return path.join(scratch, "project");
}

/** `testShellDeps` against its own fresh scratch root — the Gap D tests don't need to share a
 *  scratch directory with their project root, so this just wraps the existing helper. */
function testDeps(): ShellDeps {
  return testShellDeps(makeScratchDir("termcraft-shell-gap-d-deps-"));
}

/**
 * A real on-disk project whose `design/pages.json` lists one page and whose `chats/`
 * directory does not exist — the CLONE case (fix-bundle spec §2.4/§2.5): `chats/` is
 * git-ignored, so a project checked out from Git carries the authored design tree but zero
 * chats. Spec 2026-08-02 routes this same case on `ShellLaunchV1.existing` alone, not on its
 * own content, so this fixture now only proves `existing` still reports `true` for it. Built by
 * creating a real project through the Store (so `.termcraft/`'s manifest/lease/durability
 * plumbing is genuine, not hand-rolled), then writing `design/pages.json` and its one entry file
 * directly (Task 5 removed `pages` from `ProjectManifest`; `design/pages.json`, inside the
 * authored tree, is the sole page-order authority now) and removing the two paths a clone never
 * carries: `chats/` and `workspace.local.toml` (both hard-local/git-ignored,
 * `store/toml/model/gitignore.ts`) — this is what `git clone` would actually leave behind, not
 * what `createProject` happens to leave behind. The entry's path is deliberately unrelated to
 * its slug (design §3, §7's central rule: nothing computes a page's file from its slug).
 */
async function projectWithPagesAndNoChats(): Promise<string> {
  const scratch = makeScratchDir("termcraft-shell-gap-d-clone-");
  const root = path.join(scratch, "project");
  // `store.createProject`'s own durability pre-flight opens `root` with Win32 `OPEN_EXISTING`
  // (`store/model/factory.ts`), so `root` must already exist — `create-shell.ts`'s own
  // `openOrCreateProject` does this same `mkdirSync` first, via `ensureRootDirectory`, before
  // either store call runs; this helper calls the Store directly, so it does the same here.
  fs.mkdirSync(root, { recursive: true });
  const store = createStore(nodeStoreDeps({ userStateRoot: path.join(scratch, "user-state") }));

  const created = await store.createProject({
    root,
    name: "Clone",
    targetStack: "js-opentui",
    kitApiVersion: CURRENT_KIT_API_VERSION,
  });
  if (created instanceof Error) throw created;
  await created.close();

  const home = parsePageSlug("home");
  if (home instanceof Error) throw home;

  const termcraftDir = path.join(root, ".termcraft");
  const designDir = path.join(termcraftDir, "design");
  const entryRelPath = "screens/home-view.tsx";
  const manifest: PagesManifestV1 = {
    schemaVersion: 1,
    pages: [{ slug: home, entry: entryRelPath }],
    requestedActivePage: null,
  };
  fs.mkdirSync(designDir, { recursive: true });
  fs.writeFileSync(path.join(designDir, "pages.json"), encodePagesManifest(manifest));
  const entryPath = path.join(designDir, ...entryRelPath.split("/"));
  fs.mkdirSync(path.dirname(entryPath), { recursive: true });
  fs.writeFileSync(entryPath, "export default function Home() { return null }\n");

  fs.rmSync(path.join(termcraftDir, "chats"), { recursive: true, force: true });
  fs.rmSync(path.join(termcraftDir, WORKSPACE_STATE_FILENAME), { force: true });

  return root;
}

/** Creates a real project (via the Store, not `createShell`) and closes it, leaving `.termcraft/`
 *  in place for a SECOND `createShell` call to find as `existing: true` — the shared setup both
 *  fix-round-1 chats-branch fixtures below need. */
async function createAndCloseRealProject(prefix: string): Promise<string> {
  const scratch = makeScratchDir(prefix);
  const root = path.join(scratch, "project");
  fs.mkdirSync(root, { recursive: true });
  const store = createStore(nodeStoreDeps({ userStateRoot: path.join(scratch, "user-state") }));
  const created = await store.createProject({
    root,
    name: "Fixture",
    targetStack: "js-opentui",
    kitApiVersion: CURRENT_KIT_API_VERSION,
  });
  if (created instanceof Error) throw created;
  await created.close();
  return root;
}

/**
 * A real on-disk project with zero pages and its auto-minted FIRST CHAT still present —
 * "typed a message, nothing has generated yet" on a relaunch. `createProject` always mints a
 * first chat header, so this is the ordinary state of a project between its first Enter and its
 * first landed page — reachable on real disk with no cleanup beyond closing the first session.
 * Spec 2026-08-02 routes this case on `ShellLaunchV1.existing` alone, so this fixture now only
 * proves `existing` still reports `true` for it, same as any other reopened project.
 */
async function existingProjectWithChatOnly(): Promise<string> {
  return createAndCloseRealProject("termcraft-shell-gap-d-chat-only-");
}

/**
 * A real on-disk EXISTING project with zero pages AND zero chats — "created yesterday, nothing
 * generated yet". Distinct from a genuinely fresh directory (`existing: false`): this project
 * already has a `.termcraft/`, and `store.openProject` succeeds on it — `chats/` is removed after
 * creation to delete the one thing `createProject` always seeds; `design/` is never created by
 * `createProject` in the first place, so it is already absent with no cleanup needed.
 */
async function existingProjectWithNothing(): Promise<string> {
  const root = await createAndCloseRealProject("termcraft-shell-gap-d-empty-existing-");
  fs.rmSync(path.join(root, ".termcraft", "chats"), { recursive: true, force: true });
  return root;
}

async function firstSnapshot(port: {
  subscribe(handler: (envelope: EventEnvelopeV1) => void): Error | (() => void);
}): Promise<Record<string, unknown>> {
  const received: EventEnvelopeV1[] = [];
  const unsubscribe = port.subscribe((envelope) => received.push(envelope));
  if (unsubscribe instanceof Error) throw unsubscribe;
  unsubscribe();
  const snapshot = received[0];
  if (snapshot === undefined) throw new Error("no bootstrap snapshot delivered");
  return snapshot.payload as Record<string, unknown>;
}

/**
 * Narrows a `createShell` result to a full shell. Every fixture in this file (below the
 * dedicated version-1 suite, design-tree §12.1) opens a fresh or format-2 project, so
 * `"needs-migration"` reaching one of them here would be a test-setup bug, not a case to handle
 * gracefully — this throws loudly instead of silently widening every one of this file's existing
 * assertions to tolerate a shell that was never actually composed.
 */
function expectFullShell(
  result: Error | MigrationRequiredV1 | ShellWithAgentRegistry,
): ShellWithAgentRegistry {
  if (result instanceof Error) throw result;
  if ("kind" in result)
    throw new Error(`expected a full shell, got a migration offer for ${result.root}`);
  return result;
}

describe("createShell", () => {
  test("the demo shell seeds a trusted project so the workspace is reachable offline", async () => {
    const shell = expectFullShell(
      await createShell("demo", {
        root: "(demo)",
        workspaceIdentity: "demo",
        projectExists: false,
      }),
    );
    const payload = await firstSnapshot(shell.port);

    expect(shell.mode).toBe("demo");
    expect(payload.projectId).not.toBeNull();
    expect(payload.trust).toBe("trusted");
    expect(payload.capabilities).not.toEqual([]);
    expect(shell.port.preview()).not.toBeNull();
    await shell.close();
  });

  test("closing the demo shell is idempotent and ends its preview stream", async () => {
    const shell = expectFullShell(
      await createShell("demo", {
        root: "(demo)",
        workspaceIdentity: "demo",
        projectExists: false,
      }),
    );
    const handle = shell.port.preview();
    if (handle === null) throw new Error("demo shell must expose a preview handle");

    await shell.close();
    await shell.close();

    const frames = handle.frames[Symbol.asyncIterator]();
    expect((await frames.next()).done).toBe(false);
    expect((await frames.next()).done).toBe(true);
  });

  test("the interactive shell composes a real Kernel, not ui/testing's FakeKernel", async () => {
    const scratch = makeScratchDir("termcraft-shell-real-");
    const root = path.join(scratch, "project");

    const shell = expectFullShell(
      await createShell("interactive", envFor(root), testShellDeps(scratch)),
    );

    expect(shell.mode).toBe("interactive");
    // The one behavioral proof `createFakeKernel()` cannot fake: a malformed raw envelope
    // must fail the real decode pipeline. The fake's `dispatch` echoes an "accepted" result
    // for ANY input, real or not.
    const result = await shell.port.dispatch({});
    expect(result).toBeInstanceOf(Error);

    await shell.close();
  });

  test("the interactive shell opens on Home with the caller's project root", async () => {
    const scratch = makeScratchDir("termcraft-shell-home-");
    const root = path.join(scratch, "project");

    const shell = expectFullShell(
      await createShell(
        "interactive",
        { root, workspaceIdentity: "placeholder", projectExists: false },
        testShellDeps(scratch),
      ),
    );

    expect(shell.env.root).toBe(root);
    // `projectId` is null here NOT because `buildSnapshotPayload` hardcodes it — the §10
    // smoke-closeout fix (`core/kernel/model/kernel.ts`'s own `growableProjectId`) already
    // makes it track the real open project for any subscriber, late or not. It's null because
    // `createShell` only opens the project at the store level and never dispatches the kernel's
    // own `project.open` command, so `growableProjectId` is simply never populated on this
    // bootstrap path. `activePageSlug`/`activeChatId` DO still stay hardcoded `null` in
    // `buildSnapshotPayload` (a separate, still-open gap) — so every bootstrap snapshot opens
    // on Home (`ui/mirror/model/screen.ts`'s `projectId === null` branch) regardless of whether
    // a real project was opened.
    expect((await firstSnapshot(shell.port)).projectId).toBeNull();
    expect(shell.port.preview()).toBeNull();

    await shell.close();
  });

  test("a fresh directory becomes a real on-disk project, and workspaceIdentity is its durable projectId", async () => {
    const scratch = makeScratchDir("termcraft-shell-create-");
    const root = path.join(scratch, "brand-new");

    const shell = expectFullShell(
      await createShell("interactive", envFor(root), testShellDeps(scratch)),
    );

    expect(fs.existsSync(path.join(root, ".termcraft"))).toBe(true);
    expect(shell.env.workspaceIdentity).not.toBe(root);
    expect(shell.env.workspaceIdentity.length).toBeGreaterThan(0);

    await shell.close();
  });

  test("re-opening the same on-disk project reports the same durable workspaceIdentity", async () => {
    const scratch = makeScratchDir("termcraft-shell-reopen-");
    const root = path.join(scratch, "project");

    const first = expectFullShell(
      await createShell("interactive", envFor(root), testShellDeps(scratch)),
    );
    const firstIdentity = first.env.workspaceIdentity;
    await first.close();

    const second = expectFullShell(
      await createShell("interactive", envFor(root), testShellDeps(scratch)),
    );

    expect(second.env.workspaceIdentity).toBe(firstIdentity);
    await second.close();
  });

  test("closing the interactive shell releases the project lease so it can be reopened", async () => {
    const scratch = makeScratchDir("termcraft-shell-close-");
    const root = path.join(scratch, "project");

    const shell = expectFullShell(
      await createShell("interactive", envFor(root), testShellDeps(scratch)),
    );
    await shell.close();
    await shell.close();

    const reopened = expectFullShell(
      await createShell("interactive", envFor(root), testShellDeps(scratch)),
    );
    await reopened.close();
  });

  test("the interactive shell exposes its real agent registry (Task 9 / WP-5's probe seam)", async () => {
    const scratch = makeScratchDir("termcraft-shell-registry-");
    const root = path.join(scratch, "project");

    const shell = expectFullShell(
      await createShell("interactive", envFor(root), testShellDeps(scratch)),
    );

    expect(shell.agentRegistry).not.toBeNull();
    const capabilities = shell.agentRegistry?.list() ?? [];
    expect(capabilities).toHaveLength(1);
    expect(shell.agentRegistry?.get(capabilities[0]?.backendId ?? "")).not.toBeNull();

    await shell.close();
  });

  test("the demo shell exposes no agent registry — there is no real agent to probe offline", async () => {
    const shell = expectFullShell(
      await createShell("demo", {
        root: "(demo)",
        workspaceIdentity: "demo",
        projectExists: false,
      }),
    );

    expect(shell.agentRegistry).toBeNull();

    await shell.close();
  });

  test("the two modes are seeded differently", async () => {
    const scratch = makeScratchDir("termcraft-shell-diff-");
    const root = path.join(scratch, "project");

    const interactive = expectFullShell(
      await createShell("interactive", envFor(root), testShellDeps(scratch)),
    );
    const demo = expectFullShell(
      await createShell("demo", { root: ".", workspaceIdentity: "a", projectExists: false }),
    );

    const interactivePayload = await firstSnapshot(interactive.port);
    const demoPayload = await firstSnapshot(demo.port);
    expect(interactivePayload.projectId).not.toEqual(demoPayload.projectId);

    await interactive.close();
    await demo.close();
  });

  // --- Gap D (fix-bundle spec §2.4): the discriminator `openOrCreateProject` throws away -----
  // --- gets captured on `ShellLaunchV1` instead --------------------------------------------

  test("reports a freshly created directory as a launch with no content", async () => {
    const shell = expectFullShell(
      await createShell("interactive", envFor(await emptyDir()), testDeps()),
    );
    expect(shell.launch).toEqual({ existing: false });
    await shell.close();
  });

  test("reports a clone — pages present, zero chats — as an existing project", async () => {
    const root = await projectWithPagesAndNoChats();
    const shell = expectFullShell(await createShell("interactive", envFor(root), testDeps()));
    expect(shell.launch).toEqual({ existing: true });
    // The SAME fact lands on `UiEnv.projectExists` (`resolveEnvWithProjectIdentity`) — `ui`'s
    // `home-submit` reads it, never `ShellLaunchV1` directly, to pick `project.open` over
    // `project.create`.
    expect(shell.env.projectExists).toBe(true);
    await shell.close();
  });

  // --- content no longer distinguishes the launch (spec 2026-08-02 — one predicate) ----------

  test("an existing project with no pages but its first chat still present also reports existing", async () => {
    const root = await existingProjectWithChatOnly();
    const shell = expectFullShell(await createShell("interactive", envFor(root), testDeps()));
    expect(shell.launch).toEqual({ existing: true });
    await shell.close();
  });

  test("an existing project with no pages and no chats — created yesterday, nothing generated yet — still reports existing", async () => {
    const root = await existingProjectWithNothing();
    const shell = expectFullShell(await createShell("interactive", envFor(root), testDeps()));
    expect(shell.launch).toEqual({ existing: true });
    await shell.close();
  });

  // --- Task 6 (spec 2026-08-02): the retired content probe made no disk calls of its own -------

  /**
   * Proves the startup path no longer probes the project's own content before the Kernel exists.
   * Were the retired `probeProjectContent` still here, it would make a FOURTH read of
   * `project.toml` — the other three stay legitimate and are NOT what this test asserts against:
   * `store.openProject`'s own internal open sequence reads it twice before `create-shell.ts` ever
   * runs (`store/model/factory.ts`'s `migrationsGate`, then its own step 6), and
   * `resolveEnvWithProjectIdentity` reads it again for `workspaceIdentity` (`create-shell.ts`'s
   * own doc comment on that function explains why that read is real and stays) — plus its own
   * chats-listing branch's one real disk round trip on top of the orphan-turn scan's own
   * legitimate one (see the fixture note below for exactly which fixture actually lets that
   * extra call be observed, and which one does not).
   *
   * Neither `Store` nor `ShellDeps` exposes a seam narrow enough to intercept
   * `OpenProject.manifest`/`.chats` directly — the composition root builds its own `Store`
   * internally (`interactiveShell`'s own `createStore(nodeStoreDeps(...))` call) with no
   * injection point for it. Counted per-caller instead, at the one boundary that IS common to
   * every caller regardless: `fs.readFileSync`/`fs.readdirSync` themselves, filtered to this
   * project's own manifest file and `chats/` directory so unrelated reads (the lease, page
   * sources, …) never contaminate the count.
   *
   * `existingProjectWithChatOnly()`, not `...WithNothing()` (branch review finding 2, 2026-08-02
   * fix wave): the retired probe's own chats-listing branch was reachable only when `chats/`
   * exists on disk — `...WithNothing()` deletes that directory outright, so `chatsListCalls`
   * would read 0 whether the probe was removed or merely skipped by its own
   * directory-exists guard, and the assertion could never fail under any behaviour.
   * `...WithChatOnly()` leaves `chats/` and its auto-minted first chat in place, so a
   * reintroduced probe would actually drive the count up — this fixture is what lets a
   * regression here be caught at all.
   *
   * The expected count is 1, not 0 — running against the real fixture (rather than reasoning
   * about it in the abstract) surfaces a call this test's own OLD title got wrong: `chats/` is
   * NOT "never listed". `store/model/factory.ts`'s `scanOrphanTurns` (step 7 of every
   * `openProject`, unconditional, unrelated to the retired probe) calls `safeFs.list("chats")`
   * on every real open — that is this test's one legitimate call. What Task 6 actually removed
   * was a SECOND listing the old content probe made on top of it; a reintroduced probe would
   * drive this count to 2, which is what the fixed assertion below now can catch.
   */
  test("an interactive open makes no content probe — the manifest is read only by the open sequence and workspaceIdentity resolution, and chats/ is listed exactly once by the orphan-turn scan", async () => {
    const root = await existingProjectWithChatOnly();
    const manifestSuffix = path.join(".termcraft", PROJECT_MANIFEST_FILENAME);
    const chatsSuffix = path.join(".termcraft", "chats");

    // Both mock implementations are cast at this one boundary — `Mock<T>.mockImplementation`
    // requires an exact match against `fs.readFileSync`/`readdirSync`'s own overloaded call
    // signatures, which a single pass-through implementation cannot satisfy structurally without
    // widening its own parameter/return types first.
    const originalReadFileSync = fs.readFileSync.bind(fs);
    let manifestReadCalls = 0;
    const readFileSpy = spyOn(fs, "readFileSync").mockImplementation(((
      ...args: unknown[]
    ): unknown => {
      const [target] = args;
      if (typeof target === "string" && target.endsWith(manifestSuffix)) manifestReadCalls += 1;
      return (originalReadFileSync as (...callArgs: unknown[]) => unknown)(...args);
    }) as unknown as typeof fs.readFileSync);

    const originalReaddirSync = fs.readdirSync.bind(fs);
    let chatsListCalls = 0;
    const readdirSpy = spyOn(fs, "readdirSync").mockImplementation(((
      ...args: unknown[]
    ): unknown => {
      const [target] = args;
      if (typeof target === "string" && target.endsWith(chatsSuffix)) chatsListCalls += 1;
      return (originalReaddirSync as (...callArgs: unknown[]) => unknown)(...args);
    }) as unknown as typeof fs.readdirSync);

    const shellResult = await createShell("interactive", envFor(root), testDeps());
    readFileSpy.mockRestore();
    readdirSpy.mockRestore();
    const shell = expectFullShell(shellResult);

    expect(manifestReadCalls).toBe(3);
    expect(chatsListCalls).toBe(1);

    await shell.close();
  });
});

/**
 * project-design-systems §8.2/§8.4 (plan P10 Task 14) — `buildDesignSystemDeps`, exported for
 * the SAME testability reason `buildGateRunner`/`toPreviewSessionHandle` are (see its own doc
 * comment in `create-shell.ts`): `createShell`'s return value exposes no seam onto `kernelDeps`
 * itself, so this suite drives the exact production composition directly against a real,
 * on-disk project and a scratch `userStateRoot`, rather than reimplementing it.
 */
/** A real, on-disk project plus the `StoreAdapterDeps` bundle `buildDesignSystemDeps` takes —
 *  mirrors `store/adapters/test-support.ts`'s `createRealProjectFixture`, which is test-only and
 *  not re-exported from `store`, so this suite builds its own over the SAME real `store` calls
 *  `interactiveShell` itself makes. Caller must `await open.close()` when done. */
async function createRealOpenProject(
  userStateRoot: string,
): Promise<{ readonly open: OpenProject; readonly deps: StoreAdapterDeps }> {
  const projectRoot = makeScratchDir("termcraft-shell-design-project-");
  const store = createStore(nodeStoreDeps({ userStateRoot }));
  const opened = await store.createProject({
    root: projectRoot,
    name: "Design System Fixture",
    targetStack: "generic",
    kitApiVersion: CURRENT_KIT_API_VERSION,
  });
  if (opened instanceof Error) throw opened;
  return { open: opened, deps: { open: opened, uuidv7, clock: systemClock } };
}

describe("buildDesignSystemDeps (design-system composition root, D9)", () => {
  test("the local design-system source is composed with the REAL admission budget", async () => {
    // A source built with `allowAllPackageAdmission` in production would read an unbounded
    // package — this only proves the REAL local source is composed (id/canPublish), not the
    // budget's own enforcement, which `store/adapters/design-system-install.test.ts` and
    // `store/design-systems`' own tests already cover directly.
    const userStateRoot = makeScratchDir("termcraft-shell-design-source-userstate-");
    const { open, deps } = await createRealOpenProject(userStateRoot);
    try {
      const designSystemDeps = await buildDesignSystemDeps(userStateRoot, deps);
      expect(designSystemDeps.designSystemSource.id).toBe("local");
      expect(designSystemDeps.designSystemSource.canPublish).toBe(true);
    } finally {
      await open.close();
    }
  });

  test("the design-system library lives under the SAME userStateRoot as trust and sandboxes", async () => {
    // FIX ROUND 1 (Important): the original version of this test compared `designSystemsRoot(x)`
    // against `path.join(x, "design-systems")` — a pure function checked against its own
    // definition, which would pass even if `buildDesignSystemDeps` were never wired up — plus an
    // `fs.existsSync(.../trust)` check that is true regardless of this task's changes (the
    // implicit project-trust grant already creates it). Neither assertion could fail if the
    // composition were broken. Fixed to observe REAL disk behavior instead: publish an actual
    // package THROUGH the composed `designSystemSource` and confirm the bytes land where §8.2
    // says the library lives — `{userStateRoot}/design-systems/local/<id>/` — for this EXACT
    // `userStateRoot`, never a re-derived path.
    const userStateRoot = makeScratchDir("termcraft-shell-design-userstate-");
    const { open, deps } = await createRealOpenProject(userStateRoot);
    try {
      const designSystemDeps = await buildDesignSystemDeps(userStateRoot, deps);

      const systemId = parseDesignSystemId("midnight");
      if (systemId instanceof Error) throw systemId;
      const version = parseDesignSystemVersion("1.0.0");
      if (version instanceof Error) throw version;
      const manifestBytes = new TextEncoder().encode(
        JSON.stringify({
          ...validManifestObject(),
          id: "midnight",
          version: "1.0.0",
          components: [],
        }),
      );

      const receipt = await designSystemDeps.designSystemSource.publish({
        systemId,
        version,
        files: [{ relPath: "design-system.json", bytes: manifestBytes }],
      });
      if ("code" in receipt) throw new Error(`fixture bug: publish failed: ${receipt.safeMessage}`);

      // If `buildDesignSystemDeps` had ever been wired to a DIFFERENT root than the one this
      // test passed in, this exact path would simply not exist.
      const publishedManifestPath = path.join(
        userStateRoot,
        "design-systems",
        "local",
        "midnight",
        "design-system.json",
      );
      expect(fs.existsSync(publishedManifestPath)).toBe(true);

      // The library and the trust ledger are colocated under the SAME root (§8.2): the implicit
      // project trust grant plus `buildDesignSystemDeps`'s own `local`-source grant (D9) both
      // write through `OpenProject.trust`, built over this identical `userStateRoot`.
      expect(fs.existsSync(path.join(userStateRoot, "trust"))).toBe(true);
    } finally {
      await open.close();
    }
  });

  test("D9: local is granted without a prompt, but the grant is still RECORDED on the ledger", async () => {
    const userStateRoot = makeScratchDir("termcraft-shell-design-grant-userstate-");
    const { open, deps } = await createRealOpenProject(userStateRoot);
    try {
      const designSystemDeps = await buildDesignSystemDeps(userStateRoot, deps);
      // "Granted without a prompt" — no interaction happened above, yet the callback already
      // reports it granted, because `buildDesignSystemDeps` called `grantSource` itself.
      expect(
        await designSystemDeps.designSystemIsGranted(designSystemDeps.designSystemSource),
      ).toBe(true);
      // "Still recorded" — the SAME fact is independently visible through the trust store's own
      // ledger, not just through the closure `buildDesignSystemDeps` handed back.
      const subject = open.trust.buildSourceSubject({
        sourceKind: "local",
        sourceId: designSystemDeps.designSystemSource.id,
        canonicalLocation: path.join(userStateRoot, "design-systems", "local"),
        locationFilesystemIdentity: null,
      });
      expect(await open.trust.isSourceGranted(subject)).toBe(true);
    } finally {
      await open.close();
    }
  });

  test("I1: fetch/publish never share an admission budget — sequential composed calls all stay admissible", async () => {
    // Design-source budget: 512 files, §8.3/§13. Regression scenario (finding I1): a single
    // `createDesignSourceAdmission()` bound into the composition for the shell's LIFETIME would
    // accumulate across every fetch/publish call — the review's own account is ~42 operations
    // before a perfectly valid, in-budget preview is refused. A fresh budget per call (the fix)
    // never accumulates across calls, so this stays admissible no matter how many operations run
    // in one session.
    const userStateRoot = makeScratchDir("termcraft-shell-design-source-budget-userstate-");
    const { open, deps } = await createRealOpenProject(userStateRoot);
    try {
      const designSystemDeps = await buildDesignSystemDeps(userStateRoot, deps);

      const systemId = parseDesignSystemId("midnight");
      if (systemId instanceof Error) throw systemId;
      const version = parseDesignSystemVersion("1.0.0");
      if (version instanceof Error) throw version;

      // 30 files per package — well under the 512-file cap for ONE operation — but 20 fetches of
      // it sum to 600 admitFile calls across the session, past 512. A shared cumulative budget
      // (the bug) refuses partway through; a fresh budget per call (the fix) admits every one.
      const manifestBytes = new TextEncoder().encode(
        JSON.stringify({
          ...validManifestObject(),
          id: "midnight",
          version: "1.0.0",
          components: [],
        }),
      );
      const files = [
        { relPath: "design-system.json", bytes: manifestBytes },
        ...Array.from({ length: 29 }, (_unused, index) => ({
          relPath: `tokens-${index}.ts`,
          bytes: new TextEncoder().encode("export {}\n"),
        })),
      ];

      const receipt = await designSystemDeps.designSystemSource.publish({
        systemId,
        version,
        files,
      });
      if ("code" in receipt) throw new Error(`fixture bug: publish failed: ${receipt.safeMessage}`);

      for (let attempt = 0; attempt < 20; attempt += 1) {
        const fetched = await designSystemDeps.designSystemSource.fetch(receipt.ref);
        if ("code" in fetched) {
          throw new Error(
            `fetch #${attempt} was refused (${fetched.code}: ${fetched.safeMessage}) — the admission budget is being shared across calls`,
          );
        }
      }
    } finally {
      await open.close();
    }
  });
});

/**
 * phase-8 Task 16 — `toPreviewSessionHandle`, exported specifically so this suite can
 * exercise it directly (see its own doc comment in `create-shell.ts`). A real `Kernel`
 * cannot reach a live preview session through `createShell("interactive", ...)` today —
 * `kernel.test.ts`'s own "Kernel.publishFrame / Kernel.acknowledgeDisplay" suite documents
 * why: `core/kernel/model/handlers/project.ts`'s `enablePreviewIfTrusted` now applies
 * `kernel.preview.enable` once trust resolves to `trusted` (fix-bundle Gap A, spec §2.2),
 * but nothing yet dispatches `preview.selectPage`/`selectCurrent` to actually establish a
 * session — the interactive UI doesn't dispatch either kind yet, so the Preview machine
 * advances only as far as `idle`, never `live` (a pre-existing gap, narrower now, still
 * unrelated to this task) — so these tests use a minimal `Kernel` double
 * narrowed to exactly the two methods `toPreviewSessionHandle` calls, backed by a REAL
 * `createFrameTokenLedger()` (the exact production ledger, not a stub): this is enough to
 * prove the composition root's own wiring — no fabricated token, a genuinely minted token
 * round-trips through acknowledgement, and an unknown token is still refused.
 */
describe("toPreviewSessionHandle (frame-token wiring)", () => {
  const IDENTITY: PreviewIdentityV1 = {
    mode: "preview",
    pageSlug: "home",
    sourceHash: "a".repeat(64),
    kitApiVersion: 1,
    sessionId: "fake-session-1",
  };

  /**
   * Fix round 1, Finding 3: the Kernel-minted id `toPreviewSessionHandle` is given as an
   * explicit parameter — deliberately different from `IDENTITY.sessionId` above, so a
   * regression back to reading `session.identity.sessionId` would fail the assertion below
   * rather than pass by coincidence.
   */
  const PREVIEW_SESSION_ID = "0192f6f0-1111-7000-8000-000000000001";

  /**
   * `live` is what `currentPreviewSessionId()` reports, and the fixture lets a test MOVE it:
   * the Kernel mints a fresh id on every start/switch, and since a page switch within one tree
   * revision now reuses one `PreviewSession` (and so one handle), that movement is exactly what
   * the handle's read-through getter has to follow.
   */
  function ledgerBackedKernel(): Pick<
    Kernel,
    "acknowledgeDisplay" | "currentPreviewSessionId" | "publishFrame"
  > & { live: UUIDv7 | null } {
    const ledger = createFrameTokenLedger();
    return {
      live: PREVIEW_SESSION_ID,
      publishFrame: (frame: PreviewFrameV1) =>
        ledger.mint({
          previewSessionId: uuidv7(),
          nonce: "a".repeat(32),
          sourceHash: frame.sourceHash,
          frameSeq: frame.frameSeq,
        }),
      acknowledgeDisplay: (frameToken) => ledger.acknowledge(frameToken),
      currentPreviewSessionId(): UUIDv7 | null {
        return this.live;
      },
    };
  }

  function pushedFrame(): PreviewFrameV1 {
    return {
      sessionId: IDENTITY.sessionId,
      sourceHash: IDENTITY.sourceHash,
      frameSeq: "1",
      width: 80,
      height: 24,
      rows: [],
    };
  }

  test("every yielded frame carries a token the ledger recognises; acknowledging it succeeds, and a never-minted token still fails", async () => {
    const kernel = ledgerBackedKernel();
    const session = createFakePreviewSession(IDENTITY);
    const handle = toPreviewSessionHandle(kernel, session, PREVIEW_SESSION_ID);

    // The handle carries the Kernel-minted id, never the host-internal `session.identity
    // .sessionId` — see this describe block's own comment and `create-shell.ts`'s
    // `toKernelPort` doc comment, "FIX ROUND 1, FINDING 3".
    expect(handle.previewSessionId).toBe(PREVIEW_SESSION_ID);
    expect(handle.previewSessionId).not.toBe(IDENTITY.sessionId);

    session.emitFrame(pushedFrame());
    session.close();

    const iterator = handle.frames[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done === true) throw new Error("expected one frame");
    const uiFrame = first.value;

    // Before acknowledgement the token is only PENDING, not yet the ledger's current one
    // (`frame-token-ledger.ts`'s own §13.3 contract: "unusable before display
    // acknowledgement") — proves the token genuinely came from the ledger's `mint`, not an
    // arbitrary string that happens to look right.
    expect(uiFrame.frameToken).not.toBe("");

    const acked = handle.acknowledgeDisplay(uiFrame.frameToken);
    if (acked instanceof Error) throw acked;
    expect(acked.sourceHash).toBe(IDENTITY.sourceHash);
    expect(acked.frameSeq).toBe("1");

    // That last assertion is what proves the ledger is real rather than a rubber stamp —
    // an unknown/never-minted token must still fail.
    const neverMinted = "0192f6f0-0000-7000-8000-0000000000ff";
    const rejected = handle.acknowledgeDisplay(neverMinted);
    expect(rejected).toBeInstanceOf(FrameAckError);

    const done = await iterator.next();
    expect(done.done).toBe(true);
  });

  // A handle now OUTLIVES the id it was seeded with: a page switch within one `treeRevision`
  // keeps the same `PreviewSession` object (`core/ports/host-supervisor.ts`'s `preview`
  // contract), so `toKernelPort`'s session-keyed cache reuses THIS handle while the Kernel
  // mints a fresh `previewSessionId`. Capturing the id froze it, and
  // `ui/preview/model/interaction.ts`'s `handleGeometryResult` correlation then rejected every
  // geometry result after the first switch — hover, pin and click dead for the rest of the run.
  test("previewSessionId follows the Kernel's live id across a page switch on one session", () => {
    const kernel = ledgerBackedKernel();
    const session = createFakePreviewSession(IDENTITY);
    const handle = toPreviewSessionHandle(kernel, session, PREVIEW_SESSION_ID);
    expect(handle.previewSessionId).toBe(PREVIEW_SESSION_ID);

    const afterSwitch = "0192f6f0-1111-7000-8000-000000000002";
    kernel.live = afterSwitch;
    expect(handle.previewSessionId).toBe(afterSwitch);
  });

  test("previewSessionId falls back to the seeded id rather than widening to null", () => {
    const kernel = ledgerBackedKernel();
    const session = createFakePreviewSession(IDENTITY);
    const handle = toPreviewSessionHandle(kernel, session, PREVIEW_SESSION_ID);

    // A closed session is dropped by `toKernelPort.preview()` itself; this getter must still
    // never report `null` for a field typed `UUIDv7`, nor invent a value.
    kernel.live = null;
    expect(handle.previewSessionId).toBe(PREVIEW_SESSION_ID);
  });

  test("a frame published with no live Kernel session is dropped and logged, never yielded with an invented token", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    const kernel: Pick<Kernel, "acknowledgeDisplay" | "currentPreviewSessionId" | "publishFrame"> =
      {
        publishFrame: () =>
          new PreviewNoLiveSessionError({ reason: "no live session in this fixture" }),
        acknowledgeDisplay: () => new FrameAckError({ reason: "unused in this fixture" }),
        currentPreviewSessionId: () => PREVIEW_SESSION_ID,
      };
    const session = createFakePreviewSession(IDENTITY);
    const handle = toPreviewSessionHandle(kernel, session, PREVIEW_SESSION_ID);

    session.emitFrame(pushedFrame());
    session.close();

    const iterator = handle.frames[Symbol.asyncIterator]();
    const result = await iterator.next();

    // The generator skips straight to completion — no frame with a fabricated token was
    // ever yielded.
    expect(result.done).toBe(true);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});

/**
 * WP-2 / Task 7 acceptance (phase-8 design §WP-2: "the Gate catches a deliberate type error on
 * a fixture page against the real generated declaration, in the shipped configuration") — the
 * composed Gate's type-check stage is genuinely LIVE, not just non-throwing.
 *
 * `AppShell`/`KernelPort` expose no seam to reach the Kernel's own internally-wired
 * `gateRunner` directly: the only way to drive it live is a full `turn.start`, which needs a
 * real or fake agent, and `ShellDeps` (this file's own `ShellDeps`) has no seam to inject one
 * either — the exact same gap `smoke.test.ts`'s own header documents as the reason IT
 * re-composes `KernelDeps` one level below `createShell` instead of calling `createShell`
 * itself. So this suite proves the wiring two ways instead: (1) `createShell("interactive", ...)`
 * itself must still succeed under the real `resolveCompilerPath()` (`create-shell.ts` now
 * returns a `ShellCompositionError` instead of a shell when that resolution fails, so a
 * successful construction here already exercises that guard on the happy path); (2)
 * `runGateOnFixture` below calls `create-shell.ts`'s own EXPORTED `buildGateRunner` — the exact
 * production function `interactiveShell` itself calls to build `kernelDeps.gateRunner` — with a
 * fake `smokeRenderer` so no real host process spawns, and runs a fixture through its `runTree`
 * entry. That makes this test depend on `create-shell.ts`'s real Task 7 wiring, not a
 * reimplementation of it: reverting `buildGateRunner`'s body would fail this test too.
 *
 * `runTree`, not `runPage`, since design-tree phase 2 Task 3 moved the type check into the
 * whole-tree pass — see `runGateOnFixture` below.
 */
describe("createShell + the composed Gate's type-check stage (phase-8 WP-2)", () => {
  /** Always reports a clean render, never spawning a real host process. Mirrors
   *  `smoke.test.ts`'s own `createFakeSmokeRenderer` (this file's sibling suite) — that file's
   *  header documents the same deliberate choice: fake the host/smoke side, keep the
   *  type-check-relevant stages real. Reused here rather than inventing a second staging path.
   *  Doubly moot for the type-error fixture below regardless: `gate/model/gate.ts`'s own
   *  pipeline only reaches the smoke stage when there are zero fatal errors so far, and a
   *  `type`-kind error is fatal — smoke never runs for that fixture either way. */
  function createFakeSmokeRenderer(): SmokeRenderer {
    return {
      render(_request: SmokeRequest): Promise<SmokeResult> {
        return Promise.resolve({ ok: true });
      },
    };
  }

  /** Runs one fixture through `create-shell.ts`'s own exported `buildGateRunner` — the real
   *  production composition, not a local reimplementation — paired with a fake `smokeRenderer`.
   *  Throws on a failed compiler resolution (a fixture-setup failure, not an assertion this test
   *  is making) so a broken install fails loudly instead of the type check silently reporting no
   *  errors.
   *
   *  DRIVES `runTree`, NOT `runPage` (design-tree phase 2 Task 3): the type check moved into the
   *  whole-tree pass, so `runPage` is now structurally incapable of producing the diagnostic this
   *  suite exists to observe. A test left on `runPage` would keep "passing" by never checking
   *  anything — the exact failure mode this suite's own mirror assertion guards against. */
  async function runGateOnFixture(fixture: {
    readonly slug: PageSlug;
    readonly source: string;
  }): Promise<RunTreeResultV1> {
    const tscExePath = resolveCompilerPath();
    if (tscExePath instanceof Error) throw tscExePath;
    const gateRunner = buildGateRunner(tscExePath, createFakeSmokeRenderer());
    const entryRelPath = "pages/home.tsx";
    return gateRunner.runTree({
      files: new Map([[entryRelPath, fixture.source]]),
      treePaths: [entryRelPath],
      pages: [{ slug: fixture.slug, entry: entryRelPath }],
    });
  }

  const HOME_SLUG = "home" as PageSlug;

  /** The same page shape `gate/model/gate.test.ts`'s own `cleanSource` fixture uses — proven
   *  there to pass the full source-only pipeline standalone. */
  const CLEAN_SOURCE = `import { definePage, reatomComponent, Panel, Text } from "@termcraft/runtime"
export const meta = definePage({ kitApiVersion: 1, title: "Home", minSize: { w: 80, h: 24 }, theme: "dark-default" })
export default reatomComponent(() => <Panel id="p"><Text id="t">hello from the composed gate runner</Text></Panel>)
`;

  /** `CLEAN_SOURCE` plus one deliberately type-incompatible top-level statement — the import
   *  scan, page contract, and default export all stay untouched, so only the `typeCheck`
   *  stage's own diagnostic should surface. */
  const TYPE_ERROR_SOURCE = `import { definePage, reatomComponent, Panel, Text } from "@termcraft/runtime"
const n: number = "not a number"
export const meta = definePage({ kitApiVersion: 1, title: "Home", minSize: { w: 80, h: 24 }, theme: "dark-default" })
export default reatomComponent(() => <Panel id="p"><Text id="t">hello from the composed gate runner</Text></Panel>)
`;

  // Two real `typescript/unstable/sync` invocations (one per fixture) plus a full
  // interactive-shell composition against a real on-disk project — observed at ~1.1s locally,
  // but the default 5000ms per-test timeout leaves little margin for a colder cache or a
  // loaded CI box. 30_000ms matches the timeout `gate/model/type-check.test.ts` and
  // `gate/model/tsc-extract.test.ts` already use for real-compiler assertions.
  const TYPE_CHECK_TEST_TIMEOUT_MS = 30_000;

  test(
    "the composed gate runner rejects a page with a type error, and passes a clean page with none",
    async () => {
      const scratch = makeScratchDir("termcraft-shell-gate-");
      const root = path.join(scratch, "project");

      const shell = expectFullShell(
        await createShell("interactive", envFor(root), testShellDeps(scratch)),
      );

      const typed = await runGateOnFixture({ slug: HOME_SLUG, source: TYPE_ERROR_SOURCE });
      expect(typed.errors.some((e) => e.kind === "type")).toBe(true);

      // The mirror assertion: a test that only proves rejection cannot distinguish "the
      // checker works" from "the checker rejects everything".
      const clean = await runGateOnFixture({ slug: HOME_SLUG, source: CLEAN_SOURCE });
      expect(clean.errors.some((e) => e.kind === "type")).toBe(false);

      await shell.close();
    },
    TYPE_CHECK_TEST_TIMEOUT_MS,
  );
});

const scratchRoots: string[] = [];
afterEach(() => {
  while (scratchRoots.length > 0) {
    const root = scratchRoots.pop();
    if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
  }
});

/** A project root holding a one-page version-1 `.termcraft`. */
function seedV1ProjectRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tc-shell-v1-"));
  scratchRoots.push(root);
  const termcraftDir = path.join(root, ".termcraft");
  fs.mkdirSync(termcraftDir);
  fs.writeFileSync(
    path.join(termcraftDir, "project.toml"),
    [
      "format_version = 1",
      'project_id = "019fa002-5f5b-7000-92e3-9931eebd6c52"',
      'name = "clock"',
      'created_at = "2026-07-26T19:58:57.883Z"',
      'target_stack = "js-opentui"',
      'pages = ["dashboard"]',
      "",
    ].join("\n"),
  );
  fs.mkdirSync(path.join(termcraftDir, "pages", "dashboard"), { recursive: true });
  fs.writeFileSync(
    path.join(termcraftDir, "pages", "dashboard", "page.tsx"),
    'export const meta = { title: "dashboard" };\n',
  );
  return { root };
}

describe("createShell on a version-1 project (design-tree §12.1)", () => {
  test("returns the migration offer instead of a fatal composition error", async () => {
    const seeded = seedV1ProjectRoot();
    const outcome = await createShell("interactive", {
      root: seeded.root,
      workspaceIdentity: seeded.root,
      projectExists: true,
    });
    expect(outcome).not.toBeInstanceOf(Error);
    expect(outcome).toMatchObject({ kind: "needs-migration", root: seeded.root });
    if (!("plan" in outcome)) throw new Error("expected a migration offer");
    expect(outcome.plan.pageCount).toBe(1);
  });

  test("the offer writes nothing — the project is untouched", async () => {
    const seeded = seedV1ProjectRoot();
    const before = fs.readdirSync(path.join(seeded.root, ".termcraft")).sort();
    await createShell("interactive", {
      root: seeded.root,
      workspaceIdentity: seeded.root,
      projectExists: true,
    });
    const after = fs.readdirSync(path.join(seeded.root, ".termcraft")).sort();
    // `store.openProject` acquires its lease BEFORE it ever reaches the manifest's
    // `format_version` check (`store/model/factory.ts`'s own launch-sequence order: lease ->
    // ... -> schemas), and the lease store's own contract never deletes the `lock` file a first
    // acquire creates — `store/model/factory.ts`'s `openMigrationReadFs` doc comment says so
    // explicitly, which is exactly why `planMigration` (Task 5) skips its own lease entirely. That
    // is a harmless, permanent side effect of the OPEN ATTEMPT itself, predating this task and
    // unrelated to the migration offer — excluded here so this assertion targets what THIS
    // branch's own code writes, which is nothing.
    expect(after.filter((name) => name !== "lock")).toEqual(before);
  });

  test("a genuinely empty directory still creates a project, unchanged", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tc-fresh-"));
    scratchRoots.push(root);
    const outcome = await createShell("interactive", {
      root,
      workspaceIdentity: root,
      projectExists: false,
    });
    expect(outcome).not.toBeInstanceOf(Error);
    expect("kind" in outcome && outcome.kind === "needs-migration").toBe(false);
    // Windows keeps the project lease's lock file open until `close()` releases it, and the
    // scratch-root cleanup above cannot delete a still-open file — close the composed shell so
    // `afterEach` can clean up (every other fixture in this file already does the same).
    if (!(outcome instanceof Error) && !("kind" in outcome)) await outcome.close();
  });
});

describe("closeShellResources", () => {
  test("kernel.close rejecting still releases the lease, and the failure surfaces only after every step ran", async () => {
    const order: string[] = [];
    const cause = new Error("kernel.close boom");
    const steps: ShellTeardownStep[] = [
      {
        name: "kernel.close",
        run: () => {
          order.push("kernel.close");
          return Promise.reject(cause);
        },
      },
      {
        name: "hostSupervisor.stopAll",
        run: async () => {
          order.push("hostSupervisor.stopAll");
        },
      },
      {
        name: "open.close",
        run: async () => {
          order.push("open.close");
        },
      },
    ];

    const teardown = closeShellResources(steps);

    await expect(teardown).rejects.toBeInstanceOf(ShellTeardownError);
    // The lease-release step (`open.close`) ran even though the first step rejected.
    expect(order).toEqual(["kernel.close", "hostSupervisor.stopAll", "open.close"]);

    const failure = await teardown.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ShellTeardownError);
    expect((failure as ShellTeardownError).step).toBe("kernel.close");
    expect((failure as ShellTeardownError).cause).toBe(cause);
  });

  test("reports only the FIRST failure when multiple steps reject", async () => {
    const firstCause = new Error("kernel.close boom");
    const secondCause = new Error("open.close boom");

    const teardown = closeShellResources([
      { name: "kernel.close", run: () => Promise.reject(firstCause) },
      { name: "hostSupervisor.stopAll", run: () => Promise.resolve() },
      { name: "open.close", run: () => Promise.reject(secondCause) },
    ]);

    const failure = await teardown.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ShellTeardownError);
    expect((failure as ShellTeardownError).step).toBe("kernel.close");
  });

  test("resolves cleanly when every step succeeds", async () => {
    await expect(
      closeShellResources([
        { name: "a", run: () => Promise.resolve() },
        { name: "b", run: () => Promise.resolve() },
      ]),
    ).resolves.toBeUndefined();
  });
});
