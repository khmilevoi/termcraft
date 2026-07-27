import { describe, expect, test } from "bun:test";

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

describe("UI_RENDERER_CONFIG", () => {
  // HANDOFF Finding 1: OpenTUI's default `consoleMode: "console-overlay"` replaces
  // console.log/info/warn/error/debug with an overlay writer that never calls through, which
  // silently destroys the debug-log tee for the whole interactive run. The host renderer
  // (`host/render/model/renderer.ts`) already disables it; the UI must too.
  test("disables OpenTUI's console overlay so the debug-log tee survives", () => {
    expect(UI_RENDERER_CONFIG.consoleMode).toBe("disabled");
  });

  test("keeps ctrl+c under the app's own control", () => {
    expect(UI_RENDERER_CONFIG.exitOnCtrlC).toBe(false);
  });
});
