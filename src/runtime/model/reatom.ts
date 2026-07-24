// Reatom v1001 core re-exported under the @termcraft/runtime facade (runtime-api
// §3.2/§3.3). Authored pages import these from "@termcraft/runtime" and never name
// the private @reatom/* module path; Reatom defines the runtime's reactive semantics.
// The strict scrub of private paths from the shipped page-authoring .d.ts environment
// rides with the phase-8 bundle; here the values/types re-export under the facade.
import { withConnectHook as withConnectHookRaw } from "@reatom/core";
import type { AtomLike, Ext } from "@reatom/core";

export {
  atom,
  computed,
  action,
  wrap,
  withAsync,
  withAsyncData,
  withComputed,
  withAbort,
} from "@reatom/core";
export { reatomComponent } from "@reatom/react";

// Public facade types needed to type page models (§3.2). `AtomLike`/`Ext` are
// Reatom's own public model types; re-exporting them under the facade keeps page
// models typeable without an authored `@reatom/*` import.
export type { Atom, Action, Computed, AtomLike, Ext } from "@reatom/core";

/** A connection-scoped cleanup returned from `withConnectHook` (§3.2). */
export type ConnectionCleanup = () => void;

/**
 * The narrowed facade return contract for a `withConnectHook` callback (§3.2): only
 * no cleanup or exactly one cleanup function, synchronously or asynchronously. It
 * deliberately does not expose Reatom's private subscription object types.
 */
export type ConnectionHookResult = void | ConnectionCleanup | Promise<void | ConnectionCleanup>;

/**
 * `withConnectHook` narrowed to the facade's `ConnectionHookResult` (§3.2, m1).
 * Reatom's real signature (`node_modules/@reatom/core/dist/index.d.ts:1222`) types
 * the callback's return as `MaybeUnsubscribe`:
 *
 *   type MaybeUnsubscribe = void | Exclude<{}, Fn> | Unsubscribe | { unsubscribe: Unsubscribe }
 *
 * — a much wider type than the facade wants to publish: it admits almost any
 * non-null return value, not just "no cleanup or one cleanup function". This
 * thin wrapper narrows only the PUBLIC callback parameter type; every
 * `ConnectionHookResult` value is already assignable to `MaybeUnsubscribe` (`void`
 * matches `void` directly, a `ConnectionCleanup` function matches `Unsubscribe`,
 * and a `Promise` matches the permissive `Exclude<{}, Fn>` arm), so TypeScript's
 * covariant function-return check lets `cb` forward straight into the real
 * `withConnectHook` below with no cast.
 */
export function withConnectHook<Target extends AtomLike>(
  cb: (target: Target) => ConnectionHookResult,
): Ext<Target> {
  return withConnectHookRaw(cb);
}
