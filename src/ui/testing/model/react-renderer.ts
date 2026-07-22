import { createRequire } from "node:module";

import type { TestRendererOptions, TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";

type ReactAct = <T>(effect: () => T | Promise<T>) => Promise<T>;
const { act: reactAct } = createRequire(import.meta.url)("react") as { readonly act: ReactAct };

export interface ReactTestRenderer extends TestRendererSetup {
  /** Runs a state-changing test action inside React's canonical update boundary. */
  readonly act: (effect: () => unknown | Promise<unknown>) => Promise<void>;
  /** Destroys the OpenTUI renderer; `testRender` unmounts the React root from its hook. */
  readonly destroy: () => Promise<void>;
}

/**
 * Canonical test-only React/OpenTUI renderer boundary.
 *
 * `testRender` owns the React root and act environment; `renderOnce`/`waitForFrame`
 * remain the authoritative OpenTUI frame controls.
 */
export async function createReactTestRenderer(
  node: Parameters<typeof testRender>[0],
  options: TestRendererOptions,
): Promise<ReactTestRenderer> {
  const setup = await reactAct(async () => testRender(node, options));
  await reactAct(async () => {
    await setup.renderOnce();
  });

  return {
    ...setup,
    renderOnce: async () => {
      await reactAct(async () => setup.renderOnce());
    },
    flush: async (options) => {
      await reactAct(async () => setup.flush(options));
    },
    waitFor: async (predicate, options) => {
      await reactAct(async () => setup.waitFor(predicate, options));
    },
    waitForFrame: async (predicate, options) => {
      const frames: string[] = [];
      await reactAct(async () => {
        frames.push(await setup.waitForFrame(predicate, options));
      });
      return frames[0] ?? setup.captureCharFrame();
    },
    waitForVisualIdle: async (options) => {
      await reactAct(async () => setup.waitForVisualIdle(options));
    },
    act: async (effect) => {
      await reactAct(async () => {
        await effect();
        await setup.renderOnce();
      });
    },
    destroy: async () => {
      await reactAct(async () => setup.renderer.destroy());
    },
  };
}
