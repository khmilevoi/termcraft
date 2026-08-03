import { describe, expect, spyOn, test } from "bun:test";

import { createFakeAgentBackend, createFakeAgentRegistry } from "core/ports/fakes";
import { uuidv7 } from "infrastructure/uuid";
import type { ProjectOpenFailure, UiRootAdapters } from "ui";
import { createFakeKernel, event } from "ui/testing";

import type { ProcessBoundary, ShellWithAgentRegistry, ShutdownSignal } from "../types";
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
 * Captures `deps.abandonStartupOpen` off the rendered React element's own props — the SAME
 * technique `capturingAdapters` above uses for `requestExit` — then replaces it with a
 * recording wrapper that still calls through. `runApp` never touches `deps` directly for this:
 * it goes through the real `UiRootHandle.abandonStartupOpen()` (`ui/app/model/root.tsx`), whose
 * body reads `deps.abandonStartupOpen` off this SAME `deps` object AT CALL TIME — so replacing
 * the property here, before that call ever happens, intercepts it without inventing a second
 * seam on `UiRootAdapters` or `fakeShell`.
 *
 * `failures` records the `ProjectOpenFailure` each call carries, not merely that a call happened
 * (branch review finding 2, 2026-08-03): the argument IS the fix — it is what reaches
 * `UiLocalState.startupOpenFailure` and, through `App.tsx`'s compose, `HomeOpenFailurePanel` — so
 * a branch that abandoned the open with an empty or wrong reason would still satisfy the bare
 * `calls.toContain("abandonStartupOpen")` assertion these tests used to make on their own.
 */
function abandonRecordingAdapters(
  calls: string[],
  failures: ProjectOpenFailure[] = [],
): UiRootAdapters {
  return recordingAdapters(calls, {
    createRoot: () => ({
      render: (node: unknown) => {
        calls.push("render");
        const deps = (
          node as { props: { deps: { abandonStartupOpen: (failure: ProjectOpenFailure) => void } } }
        ).props.deps;
        const original = deps.abandonStartupOpen;
        deps.abandonStartupOpen = (failure: ProjectOpenFailure) => {
          calls.push("abandonStartupOpen");
          failures.push(failure);
          original(failure);
        };
      },
      unmount: () => calls.push("unmount"),
    }),
  });
}

/** `agentRegistry` defaults to `null` — the same "no live registry" shape `create-shell.ts`'s
 *  `demoShell` returns — so every pre-existing test in this file (none of which cares about
 *  Task 9's health probe) keeps constructing the same fixture it always did. `port` defaults to
 *  a fresh `createFakeKernel()` (an idle turn model) — tests that need a running turn override it.
 *  `launch` (Gap D) defaults to a fresh directory's `{ existing: false }` — the same
 *  "no startup dispatch" shape every pre-existing test in this file already assumes, so only the
 *  tests that care about the startup `project.open` dispatch need to override it. */
function fakeShell(
  calls: string[],
  agentRegistry: ShellWithAgentRegistry["agentRegistry"] = null,
  port: ShellWithAgentRegistry["port"] = createFakeKernel(),
  launch: ShellWithAgentRegistry["launch"] = { existing: false },
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

  describe("the Task 9 / WP-5 Home health probe wiring", () => {
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

  describe("the Gap D startup dispatch (an existing project with content opens straight into the Workspace)", () => {
    test("dispatches project.open at startup for a project that holds content", async () => {
      const calls: string[] = [];
      const kernel = createFakeKernel();
      const app = await runApp({
        shell: fakeShell(calls, null, kernel, { existing: true }),
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
        shell: fakeShell(calls, null, kernel, { existing: false }),
        adapters: recordingAdapters(calls),
        process: fakeBoundary(),
      });
      if (app instanceof Error) throw app;

      expect(kernel.dispatched).toEqual([]);

      await app.close();
    });

    test("an existing but empty project still dispatches the startup project.open", async () => {
      // Spec 2026-08-02: `existing` is the ONLY routing predicate now (Task 6 retired the old
      // second `hasContent` predicate entirely). `deriveScreen` mounts the Workspace off the SAME
      // `existing` fact, so an existing-but-empty project must dispatch here too — this fixture
      // is the same `{ existing: true }` shape as "dispatches project.open at startup for a
      // project that holds content" above; the two tests are kept distinct because the point
      // being proved is different — dispatch happens for ANY existing project, content or not.
      const calls: string[] = [];
      const kernel = createFakeKernel();
      const app = await runApp({
        shell: fakeShell(calls, null, kernel, { existing: true }),
        adapters: recordingAdapters(calls),
        process: fakeBoundary(),
      });
      if (app instanceof Error) throw app;

      const dispatchedKinds = kernel.dispatched.map((raw) => (raw as { kind: string }).kind);
      expect(dispatchedKinds).toContain("project.open");

      await app.close();
    });

    test("a failed startup dispatch abandons the open so the shell does not sit empty", async () => {
      const calls: string[] = [];
      const failures: ProjectOpenFailure[] = [];
      const kernel = createFakeKernel();
      kernel.setDispatchResult(new Error("dispatch exploded"));
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      const app = await runApp({
        shell: fakeShell(calls, null, kernel, { existing: true }),
        adapters: abandonRecordingAdapters(calls, failures),
        process: fakeBoundary(),
      });
      if (app instanceof Error) throw app;

      // Neither `finishOpen` nor `blockOpen` will ever arrive for a dispatch that never reached
      // the Kernel — `abandonStartupOpen` is the only thing that can end the Workspace's opening
      // state, so its absence would leave the shell empty forever.
      expect(calls).toContain("abandonStartupOpen");
      // And it must carry the reason, not just end the state (branch review finding 2,
      // 2026-08-03). `safeMessage` is the dispatch error's own message verbatim — the only
      // account of this failure that exists, since no Kernel `FailureDtoV1` was ever produced.
      expect(failures).toEqual([
        { reason: "startup-open-dispatch-failed", safeMessage: "dispatch exploded" },
      ]);

      await app.close();
      errorSpy.mockRestore();
    });

    test("a rejected startup dispatch abandons it too", async () => {
      const calls: string[] = [];
      const failures: ProjectOpenFailure[] = [];
      const kernel = createFakeKernel();
      kernel.setDispatchResult({
        protocolVersion: 1,
        commandId: "cmd-2" as never,
        status: "rejected",
        currentRevision: "0",
        code: "PROJECT_UNTRUSTED",
        reasons: [{ code: "PROJECT_UNTRUSTED" }],
      });
      const errorSpy = spyOn(console, "error").mockImplementation(() => {});
      const app = await runApp({
        shell: fakeShell(calls, null, kernel, { existing: true }),
        adapters: abandonRecordingAdapters(calls, failures),
        process: fakeBoundary(),
      });
      if (app instanceof Error) throw app;

      // Same shape as the thrown/failed case above, but the port answered with a `rejected`
      // `CommandResultV1` instead of an `Error` — a separate code path in `run-app.ts` that must
      // abandon the open too, not only the `instanceof Error` branch.
      expect(calls).toContain("abandonStartupOpen");
      // A DIFFERENT `reason` slug and a `safeMessage` built from the Kernel's own guard code —
      // the two branches must stay distinguishable on screen, since one dispatch never reached
      // the Kernel and this one reached it and was refused.
      expect(failures).toEqual([
        { reason: "startup-open-rejected", safeMessage: "request rejected (PROJECT_UNTRUSTED)" },
      ]);

      await app.close();
      errorSpy.mockRestore();
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
        shell: fakeShell(calls, null, kernel, { existing: true }),
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
