import { createRequire } from "node:module";

import { createElement } from "@opentui/react";

/**
 * WHY THIS EXISTS (defect fix, 2026-07-27).
 *
 * `@opentui/react`'s `createRoot` mounts every tree inside its OWN `ErrorBoundary`
 * (`chunk-hjtp6jv9.js:585`) and passes `console.error` for the reconciler's three error
 * channels (`onUncaughtError`/`onCaughtError`/`onRecoverableError`, `chunk-hjtp6jv9.js:562`).
 * `createRoot(renderer)` takes no options, so neither of those is configurable from here.
 * The consequence: a page component that THROWS never propagates out of `root.render(...)` —
 * the paint succeeds, the captured frame carries OpenTUI's red stack trace, and every caller
 * that only asks "did a frame come back" concludes the page rendered fine. That is exactly
 * how a page whose `Page(ctx)` called `ctx.spy(...)` (a Reatom v3 API this project's v1001
 * runtime does not have) passed the gate's smoke stage and was committed.
 *
 * Mounting this boundary INSIDE OpenTUI's own is what makes the throw observable: React
 * routes an error to the NEAREST enclosing boundary, so this one handles it and OpenTUI's
 * outer boundary never trips. It renders `null` on failure rather than a message — the frame
 * is not the reporting channel here; {@link RenderErrorSink.taken} is.
 */

/**
 * `Component`, reached the way `ui/testing/model/react-renderer.ts` already reaches React's
 * `act`: this project installs no `@types/react`, and `@opentui/react` re-exports exactly one
 * React value (`createElement`, `node_modules/@opentui/react/src/index.d.ts:8`) — so a plain
 * `import { Component } from "react"` is a TS7016 implicit-any error.
 *
 * MEASURED, NOT ASSUMED: adding `@types/react@19` to fix it properly surfaces eight errors in
 * existing `runtime/ui/*.tsx` and `runtime/model/jsx.test.tsx`, which pass `unknown` children
 * through JSX that only typechecks while the JSX namespace stays unresolved. Making React
 * genuinely typed is a real piece of work; it is not this fix's to do.
 *
 * Asserted to a CONCRETE (non-generic) constructor type rather than `any`: that is what lets
 * `class … extends ReactComponent` below be fully checked — `props` and `state` are typed on
 * every use, and an error boundary needs no other member of the base class.
 */
const ReactComponent = createRequire(import.meta.url)("react").Component as new (
  props: CaptureProps,
) => { props: CaptureProps; state: CaptureState };

/** The mutable slot a mounted tree's first render error lands in. One per mount. */
export interface RenderErrorSink {
  /** The error the mounted tree threw while rendering, or `null` when it rendered cleanly. */
  taken: Error | null;
}

/** A fresh, empty sink — one per `mount()` call, so a re-mount starts from a clean slate. */
export function createRenderErrorSink(): RenderErrorSink {
  return { taken: null };
}

/**
 * Everything React can throw reaches a boundary as `unknown`. Preserve a real `Error`
 * as-is (its `message`/`stack` are what a gate diagnostic quotes) and wrap anything else
 * rather than inventing a message for it.
 */
function toError(thrown: unknown): Error {
  if (thrown instanceof Error) return thrown;
  return new Error(`page render threw a non-Error value: ${String(thrown)}`);
}

interface CaptureProps {
  readonly sink: RenderErrorSink;
  /** Typed `unknown` because a React element has no nameable type here — see {@link ReactComponent}. */
  readonly children: unknown;
}

interface CaptureState {
  readonly failed: boolean;
}

/**
 * Records the FIRST error only: React re-renders the boundary after `getDerivedStateFromError`,
 * and a subsequent failure while already `failed` would otherwise overwrite the original cause
 * with a downstream symptom.
 */
class RenderErrorCapture extends ReactComponent {
  override state: CaptureState = { failed: false };

  static getDerivedStateFromError(): CaptureState {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    if (this.props.sink.taken === null) this.props.sink.taken = toError(error);
  }

  render(): unknown {
    return this.state.failed ? null : this.props.children;
  }
}

/** Wrap a tree so any error it throws while rendering lands in `sink` instead of vanishing. */
export function withRenderErrorCapture(node: unknown, sink: RenderErrorSink): unknown {
  return createElement(RenderErrorCapture as never, { sink } as never, node as never);
}
