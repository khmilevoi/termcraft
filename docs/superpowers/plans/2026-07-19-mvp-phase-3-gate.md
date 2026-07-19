# Phase 3 — `gate/` Implementation Plan

> **For agentic workers:** Load `/reatom` and `/errore` before touching code
> (CLAUDE.md mandate). TDD each task with a HOSTILE-fixture suite; keep `bun test`
> + `bun x tsc --noEmit` green after every task. Design values (none here — the
> gate is non-visual) come from spec, not invention (CLAUDE.md design rule).

**Goal:** Build `src/gate/` — the validation gate that decides whether an
agent-produced immutable candidate page is safe to make canonical. Per the roadmap
phase 3, master §6.3, runtime-api §3.1/§4/§7.3, and Spike C. The gate is the sole
authority for: TypeScript type validity, the static-import allowlist, the page
contract, manifest-slice consistency, a smoke render, and the non-fatal warning
lints. A candidate passes only if every fatal check passes; warnings never reject.

**Architecture:** `gate/` is a core-consumed adapter (code-structure.md): it
declares its host-facing port (`SmokeRenderer`, implemented by `host/`) in its own
`ports/`, exposes `GateResult` (consumed by `core` + agent feedback), and is
injected by the composition root. It never imports `host`/`core` directly. Every
impure boundary — the tsc subprocess, the filesystem read of the candidate, the
smoke render — is injected so the whole gate is testable against fakes + a hostile
fixture corpus.

**Tech Stack (de-risked this session):** TypeScript 7.0.2 exposes the parsing +
checking surface the gate needs as UNSTABLE subpath exports (confirmed present in
the installed package):
- **`typescript/unstable/ast`** — the AST surface for the AUTHORITATIVE import scan
  + page-contract read: exports `SyntaxKind`, `ScriptKind`, `ScriptTarget`,
  `createScanner`, `forEachChild`-family, and the full `isImportDeclaration`/
  `isCallExpression`/`isExportDeclaration`/… type-guard set. This is what lets the
  gate (unlike the host's `Bun.Transpiler.scanImports`) distinguish an author-written
  `require("react")` from a transform-generated helper and catch type-only edges +
  re-exports + dynamic imports precisely (§3.1). **OPEN: confirm the parse entry
  point** (createSourceFile equivalent) in `typescript/unstable/ast` — probe first.
- **`typescript/unstable/sync`** — the synchronous program/diagnostics API for the
  type check (Spike C: union `getGlobalDiagnostics()`, dedupe on
  `(code, fileName, pos)`, distinguish a compiler crash from a clean pass).
- **Spike C** (`docs/spikes/03-tsc-in-binary`): tsc is a per-platform native
  executable extracted once to `%LOCALAPPDATA%/termcraft/tsc-<version>/` + spawned;
  `lib: ["esnext"]` pinned. **OPEN: re-verify the extraction+spawn path on this tree.**

## Global constraints

- **errore mandatory**; the gate returns a `GateResult` value, never throws for a
  validation failure. `errore.try`/raw-try only at the tsc-spawn + fs boundaries
  (Spike C trap: Bun build/transpile errors are non-Error → raw try/catch IIFE).
- **Reatom**: the gate is a pure/async validation pipeline — non-Reatom (like the
  host adapter). No atoms.
- **The import allowlist is enforced in exactly one KIND of place — source scans**
  (runtime-api §3.1): the Gate's AST scan is AUTHORITATIVE; the host repeats a
  scan (already built, 2C `source-mount.ts`); the resolver fails open. The gate's
  scan must catch EVERY module edge: value + type-only imports, `export … from`
  re-exports, side-effect imports, `import(...)` dynamic imports, CJS `require`,
  and any `@termcraft/runtime/*` subpath — only a static `import … from
  "@termcraft/runtime"` (bare root) is legal.
- **Static `meta`** (runtime-api §4): a direct `definePage({...})` call whose single
  argument is an object literal with literal `kitApiVersion`/`title`/`minSize.w`/
  `minSize.h`/`theme` — no spreads/vars/getters/computed keys/conditionals/calls.
  Read from the AST WITHOUT executing the page.
- **Warnings never reject** (master §6.3): dropped ids across iterations, unpointed
  raw elements, unguarded timers/randomness, navigation to unlisted pages — the
  Gate reminds, not rejects.
- **Green gates** + a hostile-fixture suite per fatal check.

## File structure

```
gate/
  ports/
    smoke-renderer.ts     the SmokeRenderer port (host implements it)
  model/
    tsc-extract.ts        Spike C: extract tsc-<version> to the per-user dir + spawn seam
    type-check.ts         typescript/unstable/sync diagnostics (union global, dedupe, crash-vs-clean)
    import-scan.ts        typescript/unstable/ast AUTHORITATIVE allowlist scan (§3.1)
    page-contract.ts      static meta literal + default reatomComponent export + kitApiVersion (§4)
    manifest.ts           pages.json manifest-slice checks
    smoke.ts              drive the SmokeRenderer port; map a one-shot result → GateResult
    lints.ts              the non-fatal warning lints (dropped-id/unpointed/unguarded/unlisted-nav)
    gate.ts               the pipeline: import-scan → contract → type-check → manifest → smoke → lints → GateResult
  types.ts                GateResult, GateError, GateWarning, PageDescriptor
  index.ts
```

## Tasks (TDD, dependency-ordered)

- **T0 — probe** (throwaway): confirm `typescript/unstable/ast` parse entry point +
  a minimal walk that finds import/require/dynamic-import/re-export nodes on a
  fixture; confirm `typescript/unstable/sync` returns diagnostics for a broken
  page; re-verify the Spike C tsc extraction+spawn path. Record findings; delete.
- **T1 — `types.ts` GateResult contract** (this commit): `GateResult`/`GateError`/
  `GateWarning`/`PageDescriptor`. Pure. (LANDED — see below.)
- **T2 — `import-scan.ts`** on `typescript/unstable/ast`: the authoritative allowlist.
  Hostile fixtures: dynamic-import-of-runtime, re-export-from-runtime, type-only
  foreign import, side-effect import, CJS require, `@termcraft/runtime/jsx-runtime`
  subpath, a clean page → each rejected/accepted correctly.
- **T3 — `page-contract.ts`**: static-meta AST read + default-export-is-reatomComponent
  + supported-integer kitApiVersion. Hostile fixtures: computed meta field, spread
  meta, missing default export, unsupported kitApiVersion.
- **T4 — `tsc-extract.ts` + `type-check.ts`**: Spike C extraction+spawn + the
  `typescript/unstable/sync` diagnostics (union global, dedupe (code,file,pos),
  crash-vs-clean). Fixtures: a type error, a clean page, a simulated compiler crash.
- **T5 — `manifest.ts`**: pages.json manifest-slice validation (slugs/order/active).
  (Gated on the storage-identity pages.json schema — coordinate with phase 4.)
- **T6 — `ports/smoke-renderer.ts` + `smoke.ts`**: the SmokeRenderer port + driving
  it (host implements via the 2D-4 one-shot smoke session), mapping the one-shot
  result → GateResult. Fixture: a design-render failure → typed gate failure.
- **T7 — `lints.ts` + `gate.ts` pipeline**: the warning lints + the full pipeline
  ordering (fatal checks short-circuit; warnings always collected). Whole-gate
  hostile-fixture suite + a happy-path smoke.

## Deferred / cross-phase

- The tsc assets embedding + build-time lib cross-check (`askedButNotEmbedded === []`)
  is phase-8. Phase 3 extracts from a provided asset dir (injected).
- pages.json schema authority is the storage-identity spec (phase 4); T5 consumes it.
- The SmokeRenderer is IMPLEMENTED by host (2D-4 one-shot smoke session exists);
  phase 3 declares the port + phase 6 injects the host impl.
