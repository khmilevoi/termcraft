// The facade-owned JSX helper surface (runtime-api §3.2). Authored pages compile
// their JSX against @termcraft/runtime rather than naming react/jsx-runtime
// directly (§3.3 keeps the private react/@opentui identities out of authored
// source). These re-export OpenTUI's JSX runtime (which itself wraps
// react/jsx-runtime) so the runtime owns the classic + automatic JSX factories.
//
// NOTE: wiring `jsxImportSource: "@termcraft/runtime"` end-to-end — a package
// `exports` map for `@termcraft/runtime/jsx-runtime` + the host resolver/Gate
// registering that specifier — is the phase-3 (Gate) + phase-8 (bundle) job; the
// 2C host resolver currently registers `react/jsx-runtime` directly. This module
// is the facade-side surface those steps point at.
export { Fragment, jsx, jsxs } from "@opentui/react/jsx-runtime";
export { jsxDEV } from "@opentui/react/jsx-dev-runtime";
