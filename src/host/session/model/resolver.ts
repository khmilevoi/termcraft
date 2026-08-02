import * as jsxDevRuntime from "@opentui/react/jsx-dev-runtime";
import * as jsxRuntime from "@opentui/react/jsx-runtime";
import { plugin } from "bun";

import * as runtime from "runtime";

let registered = false;

/**
 * Register the `Bun.plugin` runtime resolver (Spike A / runtime-api §3.1). It
 * serves FIVE specifiers so a real JSX page loads from a directory that has no
 * `node_modules` of its own — the compiled binary's case, and equally the user's
 * project, where `.termcraft/design/` is just a directory on their disk:
 *   - `@termcraft/runtime`   → the embedded facade;
 *   - `react/jsx-runtime`    → React's production JSX helpers (via OpenTUI's
 *                              re-export), what the transform emits under
 *                              `NODE_ENV=production`;
 *   - `react/jsx-dev-runtime`→ React's development JSX helpers, the default the
 *                              transform emits otherwise;
 *   - `@opentui/react/jsx-runtime` and `@opentui/react/jsx-dev-runtime` → the SAME
 *                              two helper modules under the names the transform
 *                              actually emits in this repository.
 *
 * WHY THE `@opentui/react` PAIR EXISTS (defect found by task 15's own tests, and it
 * was live before this task). `tsconfig.json` sets `jsxImportSource:
 * "@opentui/react"`, so Bun's LOADER rewrites every JSX page's helper import to
 * `@opentui/react/jsx-dev-runtime` — not `react/jsx-dev-runtime`, which is only what
 * `Bun.Transpiler`'s own default reports to the import SCAN. Resolution of that
 * specifier starts at the importing file's directory, so a page living anywhere
 * outside this repository's own `node_modules` failed to link with `Cannot find
 * module '@opentui/react/jsx-dev-runtime'`. Every fixture this file's tests loaded
 * sat inside the repo, so nothing caught it; a real project's
 * `<projectRoot>/.termcraft/design/pages/*.tsx` is exactly the case that does not.
 * Measured before and after with `await import()` on a tree written outside the repo.
 *
 * All four helper subpaths are registered UNCONDITIONALLY: the mode is only reliably
 * detectable via `Bun.env.NODE_ENV`, while `process.env.NODE_ENV` dot access is
 * inlined to `"development"` in the compiled binary and lies forever — branching
 * on it breaks every page from an env var the host never sees.
 *
 * The resolver FAILS OPEN: it does not check the allowlist. A page that reached
 * it with an explicit `react/jsx-runtime` import would resolve and run — the
 * allowlist is enforced only by the import rescan (`scanClosureImports`, before the
 * dynamic import) and the Gate's source scan. Idempotent: a repeat call
 * is a no-op, because `Bun.plugin` has process-global effect.
 */
export function registerRuntimeResolver(): void {
  if (registered) return;
  registered = true;
  plugin({
    name: "termcraft-runtime-resolver",
    setup(build) {
      build.module("@termcraft/runtime", () => ({
        exports: runtime as Record<string, unknown>,
        loader: "object",
      }));
      build.module("react/jsx-runtime", () => ({
        exports: jsxRuntime as Record<string, unknown>,
        loader: "object",
      }));
      build.module("react/jsx-dev-runtime", () => ({
        exports: jsxDevRuntime as Record<string, unknown>,
        loader: "object",
      }));
      build.module("@opentui/react/jsx-runtime", () => ({
        exports: jsxRuntime as Record<string, unknown>,
        loader: "object",
      }));
      build.module("@opentui/react/jsx-dev-runtime", () => ({
        exports: jsxDevRuntime as Record<string, unknown>,
        loader: "object",
      }));
    },
  });
}
