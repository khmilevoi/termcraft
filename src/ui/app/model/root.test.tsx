import { afterEach, describe, expect, test } from "bun:test";

import { createLogger, resumeConsolePassthrough } from "infrastructure/debug-log";
import type { TeeSink } from "infrastructure/debug-log";
import { createFakeKernel } from "ui/testing";

import type { UiDeps } from "./deps";
import { UI_RENDERER_CONFIG, UiRootError, createUiRoot } from "./root";

describe("createUiRoot", () => {
  test("disposes by unmounting before destroying exactly once", async () => {
    const calls: string[] = [];
    const renderer = { width: 120, height: 36, destroy: () => calls.push("destroy") };
    const root = {
      render: () => calls.push("render"),
      unmount: () => calls.push("unmount"),
    };

    const result = await createUiRoot({
      port: createFakeKernel(),
      adapters: {
        createRenderer: () => Promise.resolve(renderer),
        createRoot: () => root,
      },
    });

    expect(result).not.toBeInstanceOf(Error);
    if (result instanceof Error) throw result;
    result.dispose();
    result.dispose();
    expect(calls).toEqual(["render", "unmount", "destroy"]);
  });

  test("maps renderer creation failures to UiRootError", async () => {
    const cause = new Error("terminal unavailable");
    const result = await createUiRoot({
      port: createFakeKernel(),
      adapters: {
        createRenderer: () => Promise.reject(cause),
        createRoot: () => ({ render: () => undefined, unmount: () => undefined }),
      },
    });

    expect(result).toBeInstanceOf(UiRootError);
    expect(result).toMatchObject({ cause });
  });

  test("destroys the renderer when createRoot throws synchronously", async () => {
    const cause = new Error("root unavailable");
    let destroyed = 0;
    const renderer = {
      width: 120,
      height: 36,
      destroy: () => {
        destroyed++;
      },
    };
    const result = await createUiRoot({
      port: createFakeKernel(),
      adapters: {
        createRenderer: () => Promise.resolve(renderer),
        createRoot: () => {
          throw cause;
        },
      },
    });

    expect(result).toBeInstanceOf(UiRootError);
    if (result instanceof Error === false) throw new Error("expected UiRootError");
    expect(result).toMatchObject({ operation: "create root" });
    expect(result.cause).toBe(cause);
    expect(destroyed).toBe(1);
  });

  test("destroys a renderer when mounting the App fails synchronously", async () => {
    const renderer = { width: 120, height: 36, destroy: () => undefined };
    let destroyed = 0;
    renderer.destroy = () => {
      destroyed++;
    };
    const result = await createUiRoot({
      port: createFakeKernel(),
      adapters: {
        createRenderer: () => Promise.resolve(renderer),
        createRoot: () => ({
          render: () => {
            throw new Error("mount failed");
          },
          unmount: () => undefined,
        }),
      },
    });

    expect(result).toBeInstanceOf(UiRootError);
    expect(destroyed).toBe(1);
  });

  test("the handle can abandon a startup open the composition root never landed", async () => {
    // `not.toThrow()` alone would pass for an empty method body — this asserts the actual
    // observable effect instead (branch review finding 2, 2026-08-02 fix wave): the same
    // technique `run-app.test.ts`'s `abandonRecordingAdapters` uses, capturing the real `deps`
    // off the rendered React element's own props, since `createUiRoot` never returns `deps`
    // itself on the handle.
    let capturedDeps: UiDeps | undefined;
    const result = await createUiRoot({
      port: createFakeKernel(),
      env: { root: ".", workspaceIdentity: "local", projectExists: true },
      adapters: {
        createRenderer: () => Promise.resolve({ width: 120, height: 36, destroy: () => undefined }),
        createRoot: () => ({
          render: (node: unknown) => {
            capturedDeps = (node as { props: { deps: UiDeps } }).props.deps;
          },
          unmount: () => undefined,
        }),
      },
    });

    expect(result).not.toBeInstanceOf(Error);
    if (result instanceof Error) return;
    if (capturedDeps === undefined) throw new Error("expected render() to capture deps");
    // An existing project mounts the Workspace with the startup open still pending
    // (`deps.ts`'s `startupOpenPending = atom(env.projectExists, ...)`, `deriveScreen`'s
    // `startupOpenPending && !openFailed` branch).
    expect(capturedDeps.local.startupOpenPending()).toBe(true);
    expect(capturedDeps.screen()).toBe("workspace");
    const failure = {
      reason: "startup-open-rejected",
      safeMessage: "request rejected (PROJECT_UNTRUSTED)",
    };
    result.abandonStartupOpen(failure);
    // The observable effect: the pending flag clears, the screen falls back to Home, and the
    // reason the handle was handed reaches the atom Home's own failure panel is fed from
    // (branch review finding 2, 2026-08-03) — the handle forwards the value, it does not drop it.
    expect(capturedDeps.local.startupOpenPending()).toBe(false);
    expect(capturedDeps.screen()).toBe("home");
    expect(capturedDeps.local.startupOpenFailure()).toEqual(failure);
    result.dispose();
  });
});

/**
 * The renderer's terminal ownership, observed through a real `log.*` seam rather than a spy on a
 * flag: a `logger.warn` issued while the root is alive must reach the trace sink and never the
 * writer that stands in for the terminal, and the same call after `dispose()` must reach both.
 *
 * `createUiRoot`/`mountRenderRoot` no longer install anything onto `console` (2026-08-10 —
 * `console-tee.ts`'s monkey-patch was replaced by `infrastructure/debug-log`'s `log`/
 * `createLogger`, called directly by app code instead of intercepted). What these tests exercise
 * is the suspend/resume gate itself: `createLogger` builds a `log`-shaped object wired to a fake
 * sink, and `console.warn` is swapped for a recorder standing in for the real terminal — the same
 * module-level `passthrough`/hold-buffer state `mountRenderRoot`'s own `suspendConsolePassthrough`/
 * `resumeConsolePassthrough` calls gate underneath.
 */
describe("createUiRoot terminal ownership", () => {
  const ORIGINAL_WARN = console.warn;

  afterEach(() => {
    console.warn = ORIGINAL_WARN;
    resumeConsolePassthrough();
  });

  function loggerOnto(traced: string[], screen: unknown[]) {
    console.warn = (...args: unknown[]) => screen.push(...args);
    const sink: TeeSink = {
      enabled: () => true,
      trace: (channel, data) => traced.push(`${channel}:${JSON.stringify(data.args)}`),
    };
    return createLogger(sink);
  }

  test("suspends log pass-through while mounted and restores it on dispose", async () => {
    const traced: string[] = [];
    const screen: unknown[] = [];
    const logger = loggerOnto(traced, screen);

    const result = await createUiRoot({
      port: createFakeKernel(),
      adapters: {
        createRenderer: () => Promise.resolve({ width: 120, height: 36, destroy: () => undefined }),
        createRoot: () => ({ render: () => undefined, unmount: () => undefined }),
      },
    });
    if (result instanceof Error) throw result;

    logger.warn("mid-frame");
    expect(screen).toEqual([]);

    result.dispose();
    logger.warn("after teardown");

    expect(screen).toEqual(["after teardown"]);
    expect(traced).toEqual(['console.warn:["mid-frame"]', 'console.warn:["after teardown"]']);
  });

  test("restores pass-through when the renderer never comes up at all", async () => {
    const traced: string[] = [];
    const screen: unknown[] = [];
    const logger = loggerOnto(traced, screen);

    const result = await createUiRoot({
      port: createFakeKernel(),
      adapters: {
        createRenderer: () => Promise.reject(new Error("terminal unavailable")),
        createRoot: () => ({ render: () => undefined, unmount: () => undefined }),
      },
    });

    expect(result).toBeInstanceOf(UiRootError);
    // The suspension straddles `createRenderer` (OpenTUI enters raw mode and the alternate
    // screen INSIDE it), so the failure path has to hand the terminal back before `main.tsx`
    // prints why startup failed.
    logger.warn("startup diagnostic");
    expect(screen).toEqual(["startup diagnostic"]);
  });

  test("resumes pass-through even when teardown itself throws", async () => {
    const traced: string[] = [];
    const screen: unknown[] = [];
    const logger = loggerOnto(traced, screen);

    const result = await createUiRoot({
      port: createFakeKernel(),
      adapters: {
        createRenderer: () =>
          Promise.resolve({
            width: 120,
            height: 36,
            destroy: () => {
              throw new Error("destroy failed");
            },
          }),
        createRoot: () => ({ render: () => undefined, unmount: () => undefined }),
      },
    });
    if (result instanceof Error) throw result;

    expect(() => result.dispose()).toThrow("destroy failed");
    // Correct by construction, not by luck: a throwing `unmount`/`destroy` must not be able to
    // strand the terminal with the gate down, leaving only the panic hook to save it.
    logger.warn("after a failed teardown");
    expect(screen).toEqual(["after a failed teardown"]);
  });

  test("restores pass-through when mounting fails and the renderer is destroyed", async () => {
    const traced: string[] = [];
    const screen: unknown[] = [];
    const logger = loggerOnto(traced, screen);

    const result = await createUiRoot({
      port: createFakeKernel(),
      adapters: {
        createRenderer: () => Promise.resolve({ width: 120, height: 36, destroy: () => undefined }),
        createRoot: () => ({
          render: () => {
            throw new Error("mount failed");
          },
          unmount: () => undefined,
        }),
      },
    });

    expect(result).toBeInstanceOf(UiRootError);
    // The renderer is already destroyed on this branch, so the failure `main.tsx` is about to
    // print must be able to reach the terminal.
    logger.warn("startup diagnostic");
    expect(screen).toEqual(["startup diagnostic"]);
  });
});

describe("UI_RENDERER_CONFIG", () => {
  // HANDOFF Finding 1: OpenTUI's default `consoleMode: "console-overlay"` replaces
  // console.log/info/warn/error/debug with an overlay writer that never calls through, which
  // would blind any app reporting still routed through `console.*`. The host renderer
  // (`host/render/model/renderer.ts`) already disables it; the UI must too.
  //
  // THE OTHER HALF OF THE TRADE (2026-07-28). Turning the overlay off also removes the only
  // thing that was standing between a `console.*` call and the terminal: with `"disabled"`
  // OpenTUI installs no interceptor, `externalOutputMode` resolves to `"passthrough"` under the
  // default alternate screen, and `warn`/`error` go to `stderr` which the renderer never touches
  // — so every warning painted raw text over the live frame. That is why this setting is paired
  // with `suspendConsolePassthrough()` in `createUiRoot` (tested above), and why neither half
  // may be changed without the other.
  test("disables OpenTUI's console overlay so app reporting stays off the live frame", () => {
    expect(UI_RENDERER_CONFIG.consoleMode).toBe("disabled");
  });

  test("keeps ctrl+c under the app's own control", () => {
    expect(UI_RENDERER_CONFIG.exitOnCtrlC).toBe(false);
  });
});
