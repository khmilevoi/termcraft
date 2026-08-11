import { type CliRenderer, createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import type { JSX } from "@opentui/react/jsx-runtime";
import * as errore from "errore";

import {
  installThirdPartyConsoleBridge,
  resumeConsolePassthrough,
  suspendConsolePassthrough,
  uninstallThirdPartyConsoleBridge,
} from "infrastructure/debug-log";

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
 * `console.*` method with an overlay writer that does NOT call through. The app's own reporting
 * goes through `infrastructure/debug-log`'s `log.*` (`model/logger.ts`), not `console.*`, so an
 * overlay override cannot blind it — but the app never shows OpenTUI's overlay either way, so
 * nothing is lost by turning it off, and `host/render/model/renderer.ts` already makes exactly
 * this choice for the same reason.
 *
 * THE OTHER HALF OF THAT TRADE (2026-07-28, narrowed 2026-08-10). With `"disabled"` OpenTUI
 * installs no interceptor at all: the renderer's `stdout` defaults to `process.stdout`, the
 * default `screenMode` (`"alternate-screen"`) resolves `externalOutputMode` to `"passthrough"` —
 * which leaves `stdout.write` untouched — and `console.warn`/`console.error` go to `stderr`,
 * which the renderer never touches under any mode. A screenshot of a real run once showed a
 * `preview-export` warning cutting through a panel this way. The app's own code no longer risks
 * that — every call site reports through `log.*`, which `suspendConsolePassthrough()` below
 * gates — but a DIRECT `console.*` call (a dependency's, or OpenTUI's own internals mid-setup)
 * is no longer intercepted at all now that nothing monkey-patches `console` globally, and would
 * still tear the frame if one fired inside the suspended window. Accepted: the app's own
 * reporting is what actually fires routinely here, and is fully covered.
 *
 * The rejected alternative is OpenTUI's own sanctioned stdout sink, `externalOutputMode:
 * "capture-stdout"` — it is validated to require `screenMode: "split-footer"`, i.e. the app
 * would render into a footer strip with scrollback above it instead of owning the screen, which
 * is not the design; and it captures `stdout` only, so `warn`/`error` would still tear the frame.
 */
export const UI_RENDERER_CONFIG = {
  exitOnCtrlC: false,
  consoleMode: "disabled",
  // FOCUS IS DRIVEN DECLARATIVELY, SO THE RENDERER MUST NOT DRIVE IT TOO (focus-scoped-hotkeys
  // §7, branch B, path 1). `dispatchMouseEvent` otherwise walks up from the hit target on every
  // left click and focuses the first `focusable` ancestor it finds (`@opentui/core`
  // `dispatchMouseEvent`, `chunk-bun-tkm837n2.js:8885-8897`), which routes through
  // `focusRenderable` and BLURS whatever held focus (`:7392-7405`). `@opentui/react`'s reconciler
  // applies the `focused` prop only when the prop CHANGES, so a blur that React did not cause is
  // never undone — the caret vanishes and keystrokes stop reaching the editor until the user Tabs
  // away and back. Confirmed empirically: a left click on the chat's own `<scrollbox
  // id="ws-chat-scroll">` (itself `focusable` by default, `ScrollBoxRenderable`) fired
  // `focused_renderable` naming that scrollbox as `next` and the composer's editor as `previous`,
  // and `App.test.tsx`'s characterization test went from failing to passing once this line was
  // added. The shell decides focus from `ui.local.focus` alone; `ui/workspace/ui/Workspace.tsx`'s
  // own mouse handlers write that atom, which is the supported way to reach the same behaviour.
  autoFocus: false,
} as const;

export const defaultAdapters: UiRootAdapters = {
  createRenderer: () => createCliRenderer(UI_RENDERER_CONFIG),
  createRoot: (renderer) => createRoot(renderer as CliRenderer),
};

/**
 * The renderer/console/React-root dance every OpenTUI surface in this app performs, extracted so a
 * second surface reuses it instead of copying it. Extracted by design-tree phase 1b Task 8 for
 * `ui/setup`'s pre-Kernel migration root — the migrate offer is drawn before any Kernel exists
 * (design §12.1), so it cannot go through `createUiRoot`, which is built around `KernelPort`.
 *
 * Every comment on the console-passthrough gating and `UI_RENDERER_CONFIG` moved with the code;
 * see them below — they are decisions, not style.
 */
export async function mountRenderRoot(
  adapters: UiRootAdapters,
  render: (size: { readonly w: number; readonly h: number }) => JSX.Element,
): Promise<UiRootError | { dispose(): void }> {
  // Terminal ownership begins INSIDE `createCliRenderer`, not after it: `setupTerminal()` enters
  // raw mode, mouse tracking and the alternate screen before the promise resolves. So the
  // suspension has to straddle the await rather than follow it — every path out of it below
  // resumes. See `UI_RENDERER_CONFIG`'s doc comment for why `consoleMode: "disabled"` makes this
  // necessary at all, and `infrastructure/debug-log`'s `suspendConsolePassthrough` for where a
  // line goes while it is engaged.
  installThirdPartyConsoleBridge();
  suspendConsolePassthrough();
  const renderer = await adapters
    .createRenderer()
    .catch((cause) => new UiRootError({ operation: "create renderer", cause }));
  if (renderer instanceof Error) {
    resumeConsolePassthrough();
    uninstallThirdPartyConsoleBridge();
    return renderer;
  }

  const root = errore.try(() => adapters.createRoot(renderer));
  if (root instanceof Error) {
    // `finally`, not a following statement: a throwing `destroy()` must not be able to strand
    // the terminal with the gate down and leave only the panic hook to save it. Same shape on
    // every release path below.
    try {
      renderer.destroy();
    } finally {
      resumeConsolePassthrough();
      uninstallThirdPartyConsoleBridge();
    }
    return new UiRootError({ operation: "create root", cause: root.cause ?? root });
  }

  const mounted = errore.try(() => root.render(render({ w: renderer.width, h: renderer.height })));
  if (mounted instanceof Error) {
    try {
      renderer.destroy();
    } finally {
      resumeConsolePassthrough();
      uninstallThirdPartyConsoleBridge();
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
        uninstallThirdPartyConsoleBridge();
      }
    },
  };
}
