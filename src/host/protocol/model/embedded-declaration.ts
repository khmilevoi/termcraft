import { CURRENT_KIT_API_VERSION, DEFAULT_THEME_ID } from "runtime";

import type { RuntimeDeclarationBundleV1 } from "../types";

/**
 * The explicit set of kit API integers this binary accepts (runtime-api-compatibility-design
 * §7.1: "The set is explicit rather than inferred from semver or assumed contiguous"). This is
 * a hand-maintained literal, deliberately NOT `[CURRENT_KIT_API_VERSION]` — deriving it from the
 * current version would silently narrow to one entry the moment a compatibility adapter needs an
 * older integer to stay supported alongside a newer `currentKitApiVersion`. Widen this array by
 * hand when that day comes; MVP supports exactly one version today.
 */
export const SUPPORTED_KIT_API_VERSIONS: readonly number[] = [1];

/**
 * This binary's own embedded runtime-API identity (host-supervision §5.1, §7.1) — ONE constant
 * shared by both sides of the exact-equality handshake check
 * (`host/supervisor/model/handshake.ts`'s `declarationsEqual`): `src/main.tsx`'s `_host` branch
 * reads it today, and `HostSupervisorDeps.runtimeDeclaration` (WP-4) will read the identical
 * value, so the two can never diverge into a retyped copy and a runtime `RUNTIME_INTEGRITY_MISMATCH`.
 *
 * Home: `host/protocol` owns the `RuntimeDeclarationBundleV1` type and its validator
 * (`bundle.ts`); `runtime` owns the semantics this bundle describes (`CURRENT_KIT_API_VERSION`,
 * `DEFAULT_THEME_ID`) — this file is the one place that is allowed to import both, because it
 * lives inside `host` (already an established `host` → `runtime` import direction, see
 * `host/session/model/resolver.ts`), while `runtime` itself stays the leaf
 * `docs/architecture/code-structure.md` item 10 requires (it never imports this type back).
 *
 * `publicCapabilityIds` carries only the MVP theme capability; it MUST stay sorted and
 * duplicate-free (`bundle.ts`'s `runtimeDeclarationBundleSchema`, `src/host/protocol/model/bundle.ts:31`,
 * enforces this — `embedded-declaration.test.ts` runs the real validator over this exact
 * constant). Widening the capability set is a later phase's job, not this seam's.
 */
export const EMBEDDED_RUNTIME_DECLARATION: RuntimeDeclarationBundleV1 = {
  module: "@termcraft/runtime",
  currentKitApiVersion: CURRENT_KIT_API_VERSION,
  // Spread into a fresh mutable array: `RuntimeDeclarationBundleV1.supportedKitApiVersions` is
  // `number[]` (protocol/types.ts), while `SUPPORTED_KIT_API_VERSIONS` above is exported
  // `readonly` so nothing downstream can mutate the shared source-of-truth literal.
  supportedKitApiVersions: [...SUPPORTED_KIT_API_VERSIONS],
  publicCapabilityIds: [`theme:${DEFAULT_THEME_ID}`],
};
