import { type CliRenderer, createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import * as errore from "errore";

import type { HomeAgentHealth, HomeAgentSelection } from "ui/home";
import type { KernelPort } from "ui/kernel";

import { App } from "../ui/App";
import type { UiEnv } from "./deps";
import { createUiDeps } from "./deps";

export interface UiRootRenderer {
  readonly width: number;
  readonly height: number;
  destroy(): void;
}

export interface UiRootReactRoot {
  render(node: unknown): void;
  unmount(): void;
}

/** Injectable OpenTUI boundary: tests supply recording doubles, production uses the defaults. */
export interface UiRootAdapters {
  createRenderer(): Promise<UiRootRenderer>;
  createRoot(renderer: UiRootRenderer): UiRootReactRoot;
}

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

export class UiRootError extends errore.createTaggedError({
  name: "UiRootError",
  message: "UI root failed during $operation",
}) {}

const defaultAdapters: UiRootAdapters = {
  createRenderer: () => createCliRenderer({ exitOnCtrlC: false }),
  createRoot: (renderer) => createRoot(renderer as CliRenderer),
};

/** Creates the disposable OpenTUI runtime for a prepared UI Kernel boundary. */
export async function createUiRoot(options: UiRootOptions): Promise<UiRootError | UiRootHandle> {
  const adapters = options.adapters ?? defaultAdapters;
  const renderer = await adapters
    .createRenderer()
    .catch((cause) => new UiRootError({ operation: "create renderer", cause }));
  if (renderer instanceof Error) return renderer;

  const root = errore.try(() => adapters.createRoot(renderer));
  if (root instanceof Error) {
    renderer.destroy();
    return new UiRootError({ operation: "create root", cause: root.cause ?? root });
  }

  const mounted = errore.try(() =>
    root.render(
      <App
        deps={createUiDeps(
          options.port,
          { w: renderer.width, h: renderer.height },
          options.env,
          options.agentHealthProbe,
          options.requestExit,
          options.agentSelection,
        )}
      />,
    ),
  );
  if (mounted instanceof Error) {
    renderer.destroy();
    return new UiRootError({ operation: "mount app", cause: mounted.cause ?? mounted });
  }

  let disposed = false;
  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      root.unmount();
      renderer.destroy();
    },
  };
}
