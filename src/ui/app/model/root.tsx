import { type CliRenderer, createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import * as errore from "errore";

import {
  installConsoleTee,
  resumeConsolePassthrough,
  suspendConsolePassthrough,
} from "infrastructure/debug-log";
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

/**
 * The interactive renderer's config. Exported so it is assertable — the `consoleMode` line is a
 * diagnostics-critical decision, not a style preference.
 *
 * `consoleMode: "disabled"` (HANDOFF Finding 1, 2026-07-27): OpenTUI's default
 * `"console-overlay"` calls `overrideConsoleMethods` at construction, replacing every
 * `console.*` method with an overlay writer that does NOT call through — which discards the
 * debug-log tee installed back in `main.tsx` and blinds the entire interactive run. The app
 * never shows OpenTUI's overlay, so nothing is lost by turning it off, and
 * `host/render/model/renderer.ts` already makes exactly this choice for the same reason.
 *
 * THE OTHER HALF OF THAT TRADE (2026-07-28). The overlay writer was also the only thing keeping
 * a `console.*` call off the screen. With `"disabled"` OpenTUI installs no interceptor at all:
 * the renderer's `stdout` defaults to `process.stdout`, the default `screenMode`
 * (`"alternate-screen"`) resolves `externalOutputMode` to `"passthrough"` — which leaves
 * `stdout.write` untouched — and `console.warn`/`console.error` go to `stderr`, which the
 * renderer never touches under any mode. So every warning the UI and Kernel emit wrote raw text
 * straight over the live frame; a screenshot of a real run showed a `preview-export` warning
 * cutting through a panel. That is why this setting is inseparable from the
 * `suspendConsolePassthrough()` call below: `"disabled"` keeps the trace alive, the suspension
 * keeps this app's `console.*` traffic off the frame, and neither half is correct without the
 * other. (Only `console.*` — a direct `process.stderr.write` or the runtime's own uncaught
 * printer still reaches the screen; see `suspendConsolePassthrough`'s own doc comment.)
 *
 * The rejected alternative is OpenTUI's own sanctioned stdout sink, `externalOutputMode:
 * "capture-stdout"` — it is validated to require `screenMode: "split-footer"`, i.e. the app
 * would render into a footer strip with scrollback above it instead of owning the screen, which
 * is not the design; and it captures `stdout` only, so `warn`/`error` would still tear the frame.
 */
export const UI_RENDERER_CONFIG = { exitOnCtrlC: false, consoleMode: "disabled" } as const;

const defaultAdapters: UiRootAdapters = {
  createRenderer: () => createCliRenderer(UI_RENDERER_CONFIG),
  createRoot: (renderer) => createRoot(renderer as CliRenderer),
};

/** Creates the disposable OpenTUI runtime for a prepared UI Kernel boundary. */
export async function createUiRoot(options: UiRootOptions): Promise<UiRootError | UiRootHandle> {
  const adapters = options.adapters ?? defaultAdapters;
  // Ensures the gate `suspendConsolePassthrough` below relies on actually exists. `main.tsx`
  // installs the tee at startup, but `demo.tsx` does not, and this function must not depend on
  // which root reached it. Idempotent by wrapper identity, so this costs nothing when the tee is
  // already in place.
  installConsoleTee();
  // Terminal ownership begins INSIDE `createCliRenderer`, not after it: `setupTerminal()` enters
  // raw mode, mouse tracking and the alternate screen before the promise resolves, and OpenTUI
  // can `console.error` from its own partially-set-up-renderer teardown in there. So the
  // suspension has to straddle the await rather than follow it — every path out of it below
  // resumes. See `UI_RENDERER_CONFIG`'s doc comment for why `consoleMode: "disabled"` makes this
  // necessary at all, and `infrastructure/debug-log`'s `suspendConsolePassthrough` for where a
  // line goes while it is engaged.
  suspendConsolePassthrough();
  const renderer = await adapters
    .createRenderer()
    .catch((cause) => new UiRootError({ operation: "create renderer", cause }));
  if (renderer instanceof Error) {
    resumeConsolePassthrough();
    return renderer;
  }
  // Belt to `UI_RENDERER_CONFIG`'s braces: any renderer construction — including an injected
  // adapter, or a future OpenTUI version that re-overrides console outside `consoleMode` — gets
  // the tee put back over whatever it left behind. A no-op when nothing replaced it.
  installConsoleTee();

  const root = errore.try(() => adapters.createRoot(renderer));
  if (root instanceof Error) {
    // `finally`, not a following statement: a throwing `destroy()` must not be able to strand
    // the terminal with the gate down and leave only the panic hook to save it. Same shape on
    // every release path below.
    try {
      renderer.destroy();
    } finally {
      resumeConsolePassthrough();
    }
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
    try {
      renderer.destroy();
    } finally {
      resumeConsolePassthrough();
    }
    return new UiRootError({ operation: "mount app", cause: mounted.cause ?? mounted });
  }

  let disposed = false;
  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      try {
        root.unmount();
        renderer.destroy();
      } finally {
        // The terminal is the operator's again: anything printed from here on — `runApp`'s own
        // shutdown reporting, `main.tsx`'s fatal branch — belongs on the screen, not only in the
        // trace file. In `finally` so a throwing `unmount`/`destroy` cannot skip it.
        resumeConsolePassthrough();
      }
    },
  };
}
