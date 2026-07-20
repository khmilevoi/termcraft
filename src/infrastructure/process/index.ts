export type { ProcessTree, ProcessTreeFactory } from "./types"
export { ProcessTreeError } from "./types"
export { createJobObjectTree } from "./model/job-object"

/**
 * finding [3] (nit, decided): `createFakeProcessTree` is a deterministic test
 * double, re-exported from this module's PRODUCTION public entry point —
 * and therefore compiled into the `bun build --compile` binary — on purpose.
 * The alternative (a separate testing-only entry point) was considered and
 * rejected: CLAUDE.md's alias rule means `agent/`'s cross-module tests can
 * only reach this module through `infrastructure/process`, its one public
 * boundary; a second entry point would need its own alias, which either
 * duplicates the module's public surface or forces tests back onto a
 * relative import that climbs out of `agent/` — exactly what the alias rule
 * forbids. Shipping one extra unused export in the compiled binary is a far
 * smaller cost than either of those.
 *
 * LOUD WARNING for anyone wiring a composition root: `createFakeProcessTree`
 * satisfies `ProcessTreeFactory`/`ClaudeBackendDeps.processTreeFactory` with
 * NO CAST — nothing at the type level stops it from being passed to
 * `createClaudeBackend`/`createProductionClaudeBackend` by mistake. A fake
 * tree reports confirmed exits for processes it never actually owns, so that
 * mistake would make the §6.5 exit-confirmation ladder lie: `cancel()` would
 * resolve `{ kind: "cancelled", exitConfirmed: true }` while the real CLI
 * process tree keeps running. NEVER pass this to a production
 * `processTreeFactory`. Import it only from `*.test.ts` files.
 */
export { createFakeProcessTree } from "./model/job-object"
