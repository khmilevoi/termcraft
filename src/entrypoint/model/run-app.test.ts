import { describe, expect, spyOn, test } from "bun:test";

import { createFakeAgentBackend, createFakeAgentRegistry } from "core/ports/fakes";
import { uuidv7 } from "infrastructure/uuid";
import type { UiRootAdapters } from "ui";
import { createFakeKernel, event } from "ui/testing";

import type { ProcessBoundary, RunningApp, ShellWithAgentRegistry, ShutdownSignal } from "../types";
import type { ProcessExit } from "./process-boundary";
import { AppStartupError, runApp } from "./run-app";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function recordingAdapters(calls: string[], overrides: Partial<UiRootAdapters> = {}) {
  const adapters: UiRootAdapters = {
    createRenderer: () =>
      Promise.resolve({ width: 120, height: 36, destroy: () => calls.push("destroy") }),
    createRoot: () => ({
      render: () => calls.push("render"),
      unmount: () => calls.push("unmount"),
    }),
    ...overrides,
  };
  return adapters;
}

/**
 * Captures the `requestExit` callback `runApp` passes into `createUiRoot` (Task 11 / WP-10) by
 * inspecting the rendered React element's own props — `createRoot(renderer).render(node)` here
 * receives exactly the plain `{ type: App, props: { deps, ... } }` element `<App deps={...} />`
 * evaluates to (this suite's `createRoot` double never actually mounts it), so `node`'s `deps`
 * prop IS the real `UiDeps` `createUiDeps` built from `runApp`'s own `requestExit` closure —
 * the only way to reach that closure from outside `runApp`, which exposes only `close`/`closed`
 * on `RunningApp` by design.
 */
function capturingAdapters(calls: string[]): {
  adapters: UiRootAdapters;
  requestExit: () => (() => void) | undefined;
} {
  let requestExit: (() => void) | undefined;
  const adapters = recordingAdapters(calls, {
    createRoot: () => ({
      render: (node: unknown) => {
        calls.push("render");
        requestExit = (node as { props: { deps: { requestExit: () => void } } }).props.deps
          .requestExit;
      },
      unmount: () => calls.push("unmount"),
    }),
  });
  return { adapters, requestExit: () => requestExit };
}

/**
 * Captures the SAME `UiDeps.abandonStartupOpen` action `createUiRoot`'s returned `UiRootHandle`
 * closes over (Task 4) — reached the same way `capturingAdapters` above reaches `requestExit`,
 * off the rendered element's own `props.deps`, since `createUiRoot` itself is real here (only its
 * `adapters` are injectable) and there is no other seam to observe `root.abandonStartupOpen()`
 * being called. The captured action is replaced with a spy that still calls through, so a test
 * can assert whether `runApp`'s Gap D dispatch actually invoked it, on which branch, and how many
 * times — without this double, an `UiRootHandle`'s `abandonStartupOpen()` call is otherwise
 * unobservable from outside `runApp`.
 */
function abandonCapturingAdapters(calls: string[]): {
  adapters: UiRootAdapters;
  abandoned: () => readonly string[];
} {
  const abandoned: string[] = [];
  const adapters = recordingAdapters(calls, {
    createRoot: () => ({
      render: (node: unknown) => {
        calls.push("render");
        const deps = (node as { props: { deps: { abandonStartupOpen: () => void } } }).props.deps;
        const original = deps.abandonStartupOpen;
        deps.abandonStartupOpen = () => {
          abandoned.push("abandonStartupOpen");
          original();
        };
      },
      unmount: () => calls.push("unmount"),
    }),
  });
  return { adapters, abandoned: () => abandoned };
}

/** `agentRegistry` defaults to `null` — the same "no live registry" shape `create-shell.ts`'s
 *  `demoShell` returns — so every pre-existing test in this file (none of which cares about
 *  Task 9's health probe) keeps constructing the same fixture it always did. `port` defaults to
 *  a fresh `createFakeKernel()` (an idle turn model) — tests that need a running turn override it.
 *  `launch` (Gap D) defaults to a fresh directory's `{ existing: false, hasContent: false }` —
 *  the same "no startup dispatch" shape every pre-existing test in this file already assumes, so
 *  only the tests that care about the startup `project.open` dispatch need to override it. */
function fakeShell(
  calls: string[],
  agentRegistry: ShellWithAgentRegistry["agentRegistry"] = null,
  port: ShellWithAgentRegistry["port"] = createFakeKernel(),
  launch: ShellWithAgentRegistry["launch"] = { existing: false, hasContent: false },
): ShellWithAgentRegistry {
  return {
    mode: "demo",
    port,
    env: { root: "(demo)", workspaceIdentity: "demo", projectExists: false },
    agentRegistry,
    launch,
    close: () => {
      calls.push("shell-close");
      return Promise.resolve();
    },
  };
}

function fakeBoundary(): ProcessBoundary & {
  fire(signal: ShutdownSignal): void;
  readonly fatals: readonly { message: string; cause: unknown }[];
} {
  const handlers = new Map<ShutdownSignal, () => void>();
  const fatals: { message: string; cause: unknown }[] = [];
  return {
    onSignal: (signal, handler) => handlers.set(signal, handler),
    reportFatal: (message, cause) => fatals.push({ message, cause }),
    fire: (signal) => handlers.get(signal)?.(),
    fatals,
  };
}

/** A `ProcessExit` double recording every call instead of ending the test runner. */
function fakeExit(calls: string[]): ProcessExit {
  return (code) => calls.push(`exit:${code}`);
}

describe("runApp", () => {
  test("mounts the shell and closes the UI root before the shell, exactly once", async () => {
    const calls: string[] = [];
    const app = await runApp({
      shell: fakeShell(calls),
      adapters: recordingAdapters(calls),
      process: fakeBoundary(),
    });

    expect(app).not.toBeInstanceOf(Error);
    if (app instanceof Error) throw app;
    expect(calls).toEqual(["render"]);

    await app.close();
    await app.close();
    await app.closed;
    expect(calls).toEqual(["render", "unmount", "destroy", "shell-close"]);
  });

  test("releases the shell when the UI root fails to start", async () => {
    const calls: string[] = [];
    const cause = new Error("terminal unavailable");
    const app = await runApp({
      shell: fakeShell(calls),
      adapters: recordingAdapters(calls, { createRenderer: () => Promise.reject(cause) }),
      process: fakeBoundary(),
    });

    expect(app).toBeInstanceOf(AppStartupError);
    expect(calls).toEqual(["shell-close"]);
  });

  test("both shutdown signals run the one idempotent close path", async () => {
    const calls: string[] = [];
    const boundary = fakeBoundary();
    const app = await runApp({
      shell: fakeShell(calls),
      adapters: recordingAdapters(calls),
      process: boundary,
    });
    if (app instanceof Error) throw app;

    boundary.fire("SIGINT");
    boundary.fire("SIGTERM");
    await app.closed;

    expect(calls).toEqual(["render", "unmount", "destroy", "shell-close"]);
  });

  test("a shell that fails to close is reported, not swallowed, and still resolves", async () => {
    const calls: string[] = [];
    const boundary = fakeBoundary();
    const cause = new Error("shell teardown failed");
    const app = await runApp({
      shell: { ...fakeShell(calls), close: () => Promise.reject(cause) },
      adapters: recordingAdapters(calls),
      process: boundary,
    });
    if (app instanceof Error) throw app;

    await app.close();
    await app.closed;
    expect(boundary.fatals).toHaveLength(1);
    expect(boundary.fatals[0]?.cause).toBeInstanceOf(Error);
  });

  describe("the Task 9 / WP-5 agent-health probe wiring", () => {
    test("a shell with a live agent registry actually probes the backend's health at startup", async () => {
      const calls: string[] = [];
      const backend = createFakeAgentBackend();
      const registry = createFakeAgentRegistry([backend]);
      const app = await runApp({
        shell: fakeShell(calls, registry),
        adapters: recordingAdapters(calls),
        process: fakeBoundary(),
      });
      if (app instanceof Error) throw app;

      // `resolveAgentHealthProbe` builds the probe from the registry's sole backend and
      // `createUiDeps` fires it once, fire-and-forget, the moment the UI root is constructed
      // (`ui/app/model/deps.ts`'s own `void refreshAgentHealth()`) — proving `runApp` actually
      // wired the real probe through, not merely that it compiled.
      await tick();
      expect(backend.calls.some((call) => call.method === "healthCheck")).toBe(true);

      await app.close();
    });

    test("a shell with no live agent registry (demo mode) probes nothing — the default placeholder stands", async () => {
      const calls: string[] = [];
      const app = await runApp({
        shell: fakeShell(calls, null),
        adapters: recordingAdapters(calls),
        process: fakeBoundary(),
      });
      if (app instanceof Error) throw app;

      // Nothing to assert a call ON here (there is no backend) — the absence of a thrown/
      // rejected startup is itself the proof `resolveAgentHealthProbe(null)` degraded to
      // `undefined` cleanly, leaving `createUiDeps`'s own default probe in place.
      await tick();

      await app.close();
    });
  });

  describe("the Task 13 / finding §2.7 synchronous agent selection wiring", () => {
    /**
     * Captures `deps.local.agentSelection` off the rendered React element's own props — the
     * SAME technique `capturingAdapters` above uses for `requestExit`: `createRoot(renderer)
     * .render(node)` here receives exactly the plain `{ type: App, props: { deps, ... } }`
     * element `<App deps={...} />` evaluates to, so `node`'s `deps` prop IS the real `UiDeps`
     * `createUiDeps` built from `runApp`'s own `resolveDefaultAgentSelection` call — proving the
     * value actually reached `createUiDeps`'s sixth parameter, not merely that `runApp` compiled.
     */
    function selectionCapturingAdapters(calls: string[]): {
      adapters: UiRootAdapters;
      selection: () => unknown;
    } {
      let selection: unknown;
      const adapters = recordingAdapters(calls, {
        createRoot: () => ({
          render: (node: unknown) => {
            calls.push("render");
            selection = (
              node as { props: { deps: { local: { agentSelection: () => unknown } } } }
            ).props.deps.local.agentSelection();
          },
          unmount: () => calls.push("unmount"),
        }),
      });
      return { adapters, selection: () => selection };
    }

    test("a shell with a live agent registry seeds Home's combo with the registry's declared default, synchronously", async () => {
      const calls: string[] = [];
      const backend = createFakeAgentBackend();
      const registry = createFakeAgentRegistry([backend]);
      const { adapters, selection } = selectionCapturingAdapters(calls);
      const app = await runApp({
        shell: fakeShell(calls, registry),
        adapters,
        process: fakeBoundary(),
      });
      if (app instanceof Error) throw app;

      // Read synchronously, with NO `await tick()` — the whole point of finding §2.7 is that
      // this fact is available before any probe (or any other async work) settles.
      expect(selection()).toEqual({ agent: "fake-backend", model: "fake-model", effort: "medium" });

      await app.close();
    });

    test("a shell with no live agent registry (demo mode) seeds null — the honest absence, never a fabricated identity", async () => {
      const calls: string[] = [];
      const { adapters, selection } = selectionCapturingAdapters(calls);
      const app = await runApp({
        shell: fakeShell(calls, null),
        adapters,
        process: fakeBoundary(),
      });
      if (app instanceof Error) throw app;

      expect(selection()).toBeNull();

      await app.close();
    });
  });

  describe("the Gap D startup dispatch (an existing project opens straight into the Workspace)", () => {
    test("dispatches project.open at startup for a project that holds content", async () => {
      const calls: string[] = [];
      const kernel = createFakeKernel();
      const app = await runApp({
        shell: fakeShell(calls, null, kernel, { existing: true, hasContent: true }),
        adapters: recordingAdapters(calls),
        process: fakeBoundary(),
      });
      if (app instanceof Error) throw app;

      const dispatchedKinds = kernel.dispatched.map((raw) => (raw as { kind: string }).kind);
      expect(dispatchedKinds).toContain("project.open");

      await app.close();
    });

    test("dispatches nothing at startup for a fresh directory — Home owns that Enter", async () => {
      const calls: string[] = [];
      const kernel = createFakeKernel();
      const app = await runApp({
        shell: fakeShell(calls, null, kernel, { existing: false, hasContent: false }),
        adapters: recordingAdapters(calls),
        process: fakeBoundary(),
      });
      if (app instanceof Error) throw app;

      expect(kernel.dispatched).toEqual([]);

      await app.close();
    });

    // WORKSPACE-FIRST LAUNCH (2026-08-02): the test this replaced — "an existing project reported
    // as empty (existing but no content) also dispatches nothing" — asserted the OLD `hasContent`-
    // gated behaviour for exactly this shell shape. `deriveScreen` (Task 3) now routes every
    // `existing` project to the Workspace regardless of content, so the startup dispatch has to
    // read the same fact: routing on `existing` while dispatching on `hasContent` would strand an
    // existing-but-empty project in a Workspace that never opens. This test is that old test's
    // deliberate inversion, not a new, unrelated case.
    test("an existing project with no content dispatches project.open — routing and dispatch share one predicate", async () => {
      const calls: string[] = [];
      const kernel = createFakeKernel();
      const app = await runApp({
        shell: fakeShell(calls, null, kernel, { existing: true, hasContent: false }),
        adapters: recordingAdapters(calls),
        process: fakeBoundary(),
      });
      expect(app).not.toBeInstanceOf(Error);
      expect(
        kernel.dispatched.filter(
          (raw) =>
            typeof raw === "object" && raw !== null && "kind" in raw && raw.kind === "project.open",
        ),
      ).toHaveLength(1);
      await (app as RunningApp).close();
    });

    test("a fresh directory dispatches nothing", async () => {
      const calls: string[] = [];
      const kernel = createFakeKernel();
      const app = await runApp({
        shell: fakeShell(calls, null, kernel, { existing: false, hasContent: false }),
        adapters: recordingAdapters(calls),
        process: fakeBoundary(),
      });
      expect(app).not.toBeInstanceOf(Error);
      expect(
        kernel.dispatched.filter(
          (raw) =>
            typeof raw === "object" && raw !== null && "kind" in raw && raw.kind === "project.open",
        ),
      ).toHaveLength(0);
      await (app as RunningApp).close();
    });

    test("a rejected startup project.open is logged, not swallowed or thrown", async () => {
      const calls: string[] = [];
      const kernel = createFakeKernel();
      kernel.setDispatchResult({
        protocolVersion: 1,
        commandId: "cmd-1" as never,
        status: "rejected",
        currentRevision: "0",
        code: "PROJECT_UNTRUSTED",
        reasons: [{ code: "PROJECT_UNTRUSTED" }],
      });
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      const app = await runApp({
        shell: fakeShell(calls, null, kernel, { existing: true, hasContent: true }),
        adapters: recordingAdapters(calls),
        process: fakeBoundary(),
      });
      if (app instanceof Error) throw app;

      // ASSERTED AFTER close(), NOT BEFORE (2026-07-28). The guarantee this test names — the
      // rejection is reported, never swallowed — is unchanged; WHEN it reaches `console.error`'s
      // underlying writer is not. This dispatch happens while the renderer owns the terminal, so
      // `infrastructure/debug-log`'s pass-through gate is engaged: with a trace sink the line
      // goes straight to the file, and without one (which is every `bun test` process) it waits
      // in the bounded hold buffer until `dispose()` hands the terminal back. Asserting before
      // `close()` would now be asserting that a startup diagnostic is painted raw over a live
      // frame, which is the defect that gate exists to prevent.
      await app.close();

      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    // TASK 4: A FAILED STARTUP DISPATCH NOW HAS A REAL SURFACE. Both branches below — a
    // dispatcher.dispatch REJECTION and a dispatch that itself throws — must call the returned
    // `UiRootHandle.abandonStartupOpen()` exactly once, on top of the `console.error` the test
    // above already covers. `createFakeKernel` has no option to force `port.dispatch` itself to
    // reject (only `setDispatchResult`, which supplies the RESOLVED `CommandResultV1`), so the
    // "dispatch throws" branch below drives it directly with a `dispatch` override — the
    // alternative the brief names when the fake cannot be made to reject.
    test("a rejected startup dispatch abandons the pending open so the UI drops back to Home", async () => {
      const calls: string[] = [];
      const kernel = createFakeKernel();
      kernel.setDispatchResult({
        protocolVersion: 1,
        commandId: "cmd-1" as never,
        status: "rejected",
        currentRevision: "0",
        code: "CAPABILITY_UNAVAILABLE",
        reasons: [{ code: "CAPABILITY_UNAVAILABLE" }],
      });
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      const { adapters, abandoned } = abandonCapturingAdapters(calls);
      const app = await runApp({
        shell: fakeShell(calls, null, kernel, { existing: true, hasContent: true }),
        adapters,
        process: fakeBoundary(),
      });
      expect(app).not.toBeInstanceOf(Error);
      expect(abandoned()).toEqual(["abandonStartupOpen"]);
      await (app as RunningApp).close();
      errorSpy.mockRestore();
    });

    test("a startup dispatch that throws also abandons the pending open", async () => {
      const calls: string[] = [];
      const kernel = createFakeKernel();
      const throwingPort = {
        ...kernel,
        dispatch: () => Promise.reject(new Error("kernel port closed")),
      };
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      const { adapters, abandoned } = abandonCapturingAdapters(calls);
      const app = await runApp({
        shell: fakeShell(calls, null, throwingPort, { existing: true, hasContent: true }),
        adapters,
        process: fakeBoundary(),
      });
      expect(app).not.toBeInstanceOf(Error);
      expect(abandoned()).toEqual(["abandonStartupOpen"]);
      await (app as RunningApp).close();
      errorSpy.mockRestore();
    });

    test("a successful startup open never abandons the pending flag", async () => {
      const calls: string[] = [];
      const kernel = createFakeKernel();
      const { adapters, abandoned } = abandonCapturingAdapters(calls);
      const app = await runApp({
        shell: fakeShell(calls, null, kernel, { existing: true, hasContent: true }),
        adapters,
        process: fakeBoundary(),
      });
      expect(app).not.toBeInstanceOf(Error);
      expect(abandoned()).toEqual([]);
      await (app as RunningApp).close();
    });
  });

  describe("the Task 11 / WP-10 exit path", () => {
    test("UiDeps.requestExit is bound to the SAME close() the signal handlers use — one shutdown path, not a second", async () => {
      const calls: string[] = [];
      const { adapters, requestExit } = capturingAdapters(calls);
      const app = await runApp({ shell: fakeShell(calls), adapters, process: fakeBoundary() });
      if (app instanceof Error) throw app;

      expect(typeof requestExit()).toBe("function");
      requestExit()?.();
      await app.closed;

      expect(calls).toEqual(["render", "unmount", "destroy", "shell-close"]);
    });

    test("a forced exit runs AFTER shell.close() resolves, never instead of it", async () => {
      const order: string[] = [];
      const boundary = fakeBoundary();
      const shell = fakeShell(order);
      const app = await runApp({
        shell,
        adapters: recordingAdapters(order),
        process: boundary,
        exit: fakeExit(order),
      });
      if (app instanceof Error) throw app;

      await app.close();
      await app.closed;

      expect(order).toEqual(["render", "unmount", "destroy", "shell-close", "exit:0"]);
    });

    test("exit defaults to a no-op — an omitted exit option never ends the test runner", async () => {
      const calls: string[] = [];
      const app = await runApp({
        shell: fakeShell(calls),
        adapters: recordingAdapters(calls),
        process: fakeBoundary(),
      });
      if (app instanceof Error) throw app;

      await expect(app.close()).resolves.toBeUndefined();
      expect(calls).toEqual(["render", "unmount", "destroy", "shell-close"]);
    });

    test("a running turn is cancelled and its confirmed terminal event awaited BEFORE the shell is released", async () => {
      const order: string[] = [];
      const turnId = uuidv7();
      const kernel = createFakeKernel({
        snapshot: {
          models: {
            project: { phase: "closed", trust: null },
            turn: { phase: "running", activeTurnId: turnId, commitIntentRecorded: false },
            restore: { phase: "idle" },
            commit: { phase: "idle" },
            export: { phase: "idle" },
            preview: { phase: "disabled", sourceKind: null },
            migration: { phase: "idle" },
          },
        },
      });
      const shell = fakeShell(order, null, kernel);
      const app = await runApp({
        shell,
        adapters: recordingAdapters(order),
        process: fakeBoundary(),
      });
      if (app instanceof Error) throw app;

      const closePromise = app.close();
      await tick();

      // `turn.cancel` was dispatched, but the shell has NOT been released yet — `close()` is
      // waiting for the Kernel's own confirmation.
      const dispatchedKinds = kernel.dispatched.map((raw) => (raw as { kind: string }).kind);
      expect(dispatchedKinds).toEqual(["turn.cancel"]);
      expect(order).not.toContain("shell-close");

      kernel.emit(
        event("turn.cancelled", {
          turnId,
          outcome: "cancelled",
          changedPages: [],
          warnings: [],
          failure: null,
        }),
      );
      await closePromise;

      expect(order).toContain("shell-close");
      expect(order.indexOf("shell-close")).toBeGreaterThan(-1);
    });

    test("no turn running: close() releases the shell immediately, dispatching nothing", async () => {
      const calls: string[] = [];
      const kernel = createFakeKernel(); // default snapshot: turn.phase "idle"
      const app = await runApp({
        shell: fakeShell(calls, null, kernel),
        adapters: recordingAdapters(calls),
        process: fakeBoundary(),
      });
      if (app instanceof Error) throw app;

      await app.close();
      await app.closed;

      expect(kernel.dispatched).toHaveLength(0);
      expect(calls).toEqual(["render", "unmount", "destroy", "shell-close"]);
    });
  });
});
