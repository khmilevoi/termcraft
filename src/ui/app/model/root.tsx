import { type CliRenderer, createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import * as errore from "errore";

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
    return new UiRootError({ operation: "create root", cause: root });
  }

  const mounted = errore.try(() =>
    root.render(
      <App
        deps={createUiDeps(options.port, { w: renderer.width, h: renderer.height }, options.env)}
      />,
    ),
  );
  if (mounted instanceof Error) {
    renderer.destroy();
    return new UiRootError({ operation: "mount app", cause: mounted });
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
