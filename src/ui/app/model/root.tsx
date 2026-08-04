import type { AgentHealth } from "ui/agent-health";
import type { HomeAgentSelection } from "ui/home";
import type { KernelPort } from "ui/kernel";
import type { ProjectOpenFailure } from "ui/mirror";

import { App } from "../ui/App";
import type { UiDeps, UiEnv } from "./deps";
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
  readonly agentHealthProbe?: () => Promise<AgentHealth>;
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
  /**
   * "The startup `project.open` will never land, and this is why" (spec 2026-08-02).
   * `entrypoint/model/run-app.ts` calls this on both failure branches of its own startup dispatch;
   * without it the Workspace shell that `deriveScreen` mounted on `UiEnv.projectExists` never
   * resolves to anything. The `failure` it carries is what the resulting Home actually SHOWS —
   * `UiDeps.abandonStartupOpen` stores it in `UiLocalState.startupOpenFailure`, which `App.tsx`
   * composes into Home's `openFailure` prop (branch review finding 2, 2026-08-03). It is a
   * `ProjectOpenFailure` by SHAPE only: this path never reaches the Kernel's own `blockOpen`, so
   * nothing here is ever folded into `ProjectMirror.openFailure`.
   */
  abandonStartupOpen(failure: ProjectOpenFailure): void;
}

/**
 * Creates the disposable OpenTUI runtime for a prepared UI Kernel boundary. A thin caller of
 * {@link mountRenderRoot} (design-tree phase 1b Task 8 extracted the renderer/console/React-root
 * dance there so `ui/setup`'s pre-Kernel migration root — which has no `KernelPort` to build
 * `App`'s deps from — can reuse it too).
 */
export async function createUiRoot(options: UiRootOptions): Promise<UiRootError | UiRootHandle> {
  // Hoisted out of the JSX below so the returned handle can reach it — `runApp` needs
  // `abandonStartupOpen` after this function has already returned. `mountRenderRoot`'s own
  // `render` callback always runs synchronously, before it can resolve without an error, so
  // `deps` is genuinely assigned by the time the `undefined` check below is reached.
  let deps: UiDeps | undefined;
  const mounted = await mountRenderRoot(options.adapters ?? defaultAdapters, (size) => {
    deps = createUiDeps(
      options.port,
      size,
      options.env,
      options.agentHealthProbe,
      options.requestExit,
      options.agentSelection,
    );
    return <App deps={deps} />;
  });
  if (mounted instanceof Error) return mounted;
  if (deps === undefined) {
    // Unreachable: `mountRenderRoot` only resolves without an error after synchronously
    // invoking the `render` callback above, which always assigns `deps` first — kept explicit
    // per this project's "never silently assume success" rule.
    return new UiRootError({
      operation: "mount app",
      cause: new Error("render callback never ran despite a successful mount"),
    });
  }
  const resolvedDeps = deps;
  return {
    dispose: mounted.dispose,
    abandonStartupOpen(failure: ProjectOpenFailure): void {
      resolvedDeps.abandonStartupOpen(failure);
    },
  };
}
