import { afterEach, describe, expect, test } from "bun:test";

import { installConsoleTee, resumeConsolePassthrough } from "infrastructure/debug-log";
import type { TeeSink } from "infrastructure/debug-log";
import { createFakeKernel } from "ui/testing";

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
});

/**
 * The renderer's terminal ownership, observed through the REAL tee rather than a spy on a flag:
 * a `console.warn` issued while the root is alive must reach the trace sink and never the writer
 * that stands in for the terminal, and the same call after `dispose()` must reach both.
 *
 * `createUiRoot` calls `installConsoleTee()` with the DEFAULT sink, which is disabled under
 * `bun test` (`infrastructure/debug-log/model/sink.ts`'s test-runner exclusion), so that call is
 * a no-op here and the tee these tests pre-install with an enabled fake sink stays in place —
 * which is precisely the arrangement a real run has.
 */
describe("createUiRoot terminal ownership", () => {
  // All five, not just `warn`: `installConsoleTee` wraps every method it covers, so restoring
  // only the one this suite asserts on would leave four live wrappers holding these tests'
  // recorder closures for the rest of the runner process.
  const ORIGINALS = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  } as const;

  afterEach(() => {
    Object.assign(console, ORIGINALS);
    resumeConsolePassthrough();
  });

  function teeInto(traced: string[], screen: unknown[]): void {
    console.warn = (...args: unknown[]) => screen.push(...args);
    const sink: TeeSink = {
      enabled: () => true,
      trace: (channel, data) => traced.push(`${channel}:${JSON.stringify(data.args)}`),
    };
    installConsoleTee(sink);
  }

  test("suspends console pass-through while mounted and restores it on dispose", async () => {
    const traced: string[] = [];
    const screen: unknown[] = [];
    teeInto(traced, screen);

    const result = await createUiRoot({
      port: createFakeKernel(),
      adapters: {
        createRenderer: () => Promise.resolve({ width: 120, height: 36, destroy: () => undefined }),
        createRoot: () => ({ render: () => undefined, unmount: () => undefined }),
      },
    });
    if (result instanceof Error) throw result;

    console.warn("mid-frame");
    expect(screen).toEqual([]);

    result.dispose();
    console.warn("after teardown");

    expect(screen).toEqual(["after teardown"]);
    expect(traced).toEqual(['console.warn:["mid-frame"]', 'console.warn:["after teardown"]']);
  });

  test("restores pass-through when mounting fails and the renderer is destroyed", async () => {
    const traced: string[] = [];
    const screen: unknown[] = [];
    teeInto(traced, screen);

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
    console.warn("startup diagnostic");
    expect(screen).toEqual(["startup diagnostic"]);
  });
});

describe("UI_RENDERER_CONFIG", () => {
  // HANDOFF Finding 1: OpenTUI's default `consoleMode: "console-overlay"` replaces
  // console.log/info/warn/error/debug with an overlay writer that never calls through, which
  // silently destroys the debug-log tee for the whole interactive run. The host renderer
  // (`host/render/model/renderer.ts`) already disables it; the UI must too.
  //
  // THE OTHER HALF OF THE TRADE (2026-07-28). Turning the overlay off also removes the only
  // thing that was standing between a `console.*` call and the terminal: with `"disabled"`
  // OpenTUI installs no interceptor, `externalOutputMode` resolves to `"passthrough"` under the
  // default alternate screen, and `warn`/`error` go to `stderr` which the renderer never touches
  // — so every warning painted raw text over the live frame. That is why this setting is paired
  // with `suspendConsolePassthrough()` in `createUiRoot` (tested above), and why neither half
  // may be changed without the other.
  test("disables OpenTUI's console overlay so the debug-log tee survives", () => {
    expect(UI_RENDERER_CONFIG.consoleMode).toBe("disabled");
  });

  test("keeps ctrl+c under the app's own control", () => {
    expect(UI_RENDERER_CONFIG.exitOnCtrlC).toBe(false);
  });
});
