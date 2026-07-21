/**
 * The `core/versions` module's shared type surface.
 *
 * Today the module has exactly one deliverable — the Tier-C "deferred family" decision
 * (`docs/superpowers/plans/2026-07-21-mvp-phase-6-core.md` Decision D1) — and its whole
 * public vocabulary (`DEFERRED_CAPABILITY_KINDS`, `isDeferredCapabilityKind`,
 * `deferredCapabilityReason`) is expressed entirely in terms of `core/protocol`'s own
 * `CommandKindV1` and `UnavailableReason`. There is no module-local type to declare yet
 * without inventing one this module does not need. This file exists so `core/versions`
 * keeps the project's `module/{types.ts,index.ts}` shape (see the repo's CLAUDE.md "Code
 * style" section) rather than being the one module that silently drops it; the next thing
 * `core/versions` grows (see the roadmap's `turns/`, `export/`, `chats/` folder list) is
 * expected to add real shared types here.
 */
export {}
