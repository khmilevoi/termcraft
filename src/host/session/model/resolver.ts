import * as jsxDevRuntime from "@opentui/react/jsx-dev-runtime";
import * as jsxRuntime from "@opentui/react/jsx-runtime";
import { plugin } from "bun";

import * as runtime from "runtime";

let registered = false;

/**
 * Register the `Bun.plugin` runtime resolver (Spike A / runtime-api §3.1). It
 * serves THREE specifiers so a real JSX page loads inside the compiled binary,
 * where the page's own directory has no `node_modules`:
 *   - `@termcraft/runtime`   → the embedded facade;
 *   - `react/jsx-runtime`    → React's production JSX helpers (via OpenTUI's
 *                              re-export), what the transform emits under
 *                              `NODE_ENV=production`;
 *   - `react/jsx-dev-runtime`→ React's development JSX helpers, the default the
 *                              transform emits otherwise.
 * Both helper subpaths are registered UNCONDITIONALLY: the mode is only reliably
 * detectable via `Bun.env.NODE_ENV`, while `process.env.NODE_ENV` dot access is
 * inlined to `"development"` in the compiled binary and lies forever — branching
 * on it breaks every page from an env var the host never sees.
 *
 * The resolver FAILS OPEN: it does not check the allowlist. A page that reached
 * it with an explicit `react/jsx-runtime` import would resolve and run — the
 * allowlist is enforced only by the import rescan (`scanPageImports`, before the
 * dynamic import) and the Gate's source scan (phase 3). Idempotent: a repeat call
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
    },
  });
}
