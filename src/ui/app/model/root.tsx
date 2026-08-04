import type { HomeAgentHealth, HomeAgentSelection } from "ui/home";
import type { KernelPort } from "ui/kernel";

import { App } from "../ui/App";
import type { UiEnv } from "./deps";
import { createUiDeps } from "./deps";
import { UiRootError, defaultAdapters, mountRenderRoot } from "./render-root";
import type { UiRootAdapters } from "./render-root";

export type { UiRootAdapters, UiRootReactRoot, UiRootRenderer } from "./render-root";
export { UI_RENDERER_CONFIG, UiRootError } from "./render-root";

export interface UiRootOptions {
  readonly port: KernelPort;
  readonly env?: UiEnv;
  readonly adapters?: UiRootAdapters;
  /**
   * The real Home agent-health probe (phase-8 Task 9 / WP-5), built by the composition root
   * from the shell's agent registry (`entrypoint/model/agent-health.ts`'s
   * `createAgentHealthProbe`, wired in `entrypoint/model/run-app.ts`). Optional so every
   * existing `createUiRoot` call keeps compiling — `createUiDeps`'s own fourth parameter
   * already defaults to today's pre-probe placeholder reading when this is omitted.
   */
  readonly agentHealthProbe?: () => Promise<HomeAgentHealth>;
  /**
   * The one shutdown trigger (phase-8 Task 11 / WP-10), forwarded verbatim into
   * `createUiDeps`'s fifth parameter — see `deps.ts`'s `UiDeps.requestExit` for the full
   * reasoning. Optional so every existing `createUiRoot` call keeps compiling; `createUiDeps`'s
   * own default (a no-op) applies when this is omitted.
   */
  readonly requestExit?: () => void;
  /**
   * The synchronous agent/model/effort default (finding §2.7, phase-8 Task 13), resolved off
   * the agent registry by the composition root's `resolveDefaultAgentSelection`
   * (`entrypoint/model/agent-health.ts`) and forwarded verbatim into `createUiDeps`'s sixth
   * parameter. Optional so every existing `createUiRoot` call keeps compiling; `createUiDeps`'s
   * own default (`null`) applies when this is omitted — Home renders the honest empty combo,
   * never an invented identity.
   */
  readonly agentSelection?: HomeAgentSelection;
}

export interface UiRootHandle {
  /** Idempotently tear down the React tree before releasing the terminal renderer. */
  dispose(): void;
}

/**
 * Creates the disposable OpenTUI runtime for a prepared UI Kernel boundary. A thin caller of
 * {@link mountRenderRoot} (design-tree phase 1b Task 8 extracted the renderer/console/React-root
 * dance there so `ui/setup`'s pre-Kernel migration root — which has no `KernelPort` to build
 * `App`'s deps from — can reuse it too).
 */
export async function createUiRoot(options: UiRootOptions): Promise<UiRootError | UiRootHandle> {
  return mountRenderRoot(options.adapters ?? defaultAdapters, (size) => (
    <App
      deps={createUiDeps(
        options.port,
        size,
        options.env,
        options.agentHealthProbe,
        options.requestExit,
        options.agentSelection,
      )}
    />
  ));
}
