import * as errore from "errore";

import {
  DESIGN_SYSTEM_DIRNAME,
  DESIGN_SYSTEM_MANIFEST_RELPATH,
  decodeDesignSystemManifest,
  designSystemComponentRelPath,
  findUnresolvedComponents,
  isInsideDesignSystem,
} from "entities/design-system";
import type {
  DesignSystemManifestInvalidError,
  DesignSystemManifestV1,
} from "entities/design-system";
import { isCodeFile, parsesJsx, resolveDesignSpecifier } from "entities/design-tree";
import type { PageEntryV1 } from "entities/design-tree";
import { log } from "infrastructure/debug-log";

import type { GateError } from "../types";
import { scanNamedExports } from "./exports-scan";
import { hasTreePath } from "./gate";
import { SUPPORTED_KIT_API_VERSIONS, checkPageContract } from "./page-contract";
import { scanModuleEdges } from "./tree-scan";

/** What the design-system slice check needs: the tree's full file inventory (design-systems §5, §7). */
export interface DesignSystemScanInput {
  /** Every tree file's text, keyed tree-relative — `runTree`'s own `files`. */
  readonly files: ReadonlyMap<string, string>;
  /** Every tree-relative path the staged tree holds — `runTree`'s own `treePaths`. */
  readonly treePaths: readonly string[];
}

/** The design-system slice check's outcome: every manifest-level fatal, plus what the closure
 *  walk (Task 5) and the page `meta.theme` check (Task 6) need from a decoded manifest. */
export interface DesignSystemScanResultV1 {
  readonly errors: readonly GateError[];
  /** The decoded manifest, or `null` when the tree declares none, it did not decode, or it
   *  targets a kit API version this binary does not support (in which case downstream checks —
   *  the closure roots, the containment scan, the `meta.theme` check — never ran either). */
  readonly manifest: DesignSystemManifestV1 | null;
  /** True when the tree NAMES a design system this pass could not fully verify — the
   *  dead-module suppression signal (decision D8). False when the tree declares none. */
  readonly unverified: boolean;
  /** TREE-relative module paths of every declared component that RESOLVES — the additional
   *  closure roots (spec §7). Empty when there is no manifest. */
  readonly componentRoots: readonly string[];
}

/** The empty result for a tree that declares no design system at all (decision D8) — one
 *  shared instance, since every field is readonly and never mutated by a caller. */
const NO_DESIGN_SYSTEM: DesignSystemScanResultV1 = {
  errors: [],
  manifest: null,
  unverified: false,
  componentRoots: [],
};

/**
 * `system/design-system.json`'s own component export check could not read a resolved
 * component's source to the end — `scanNamedExports` shares the recursive-descent JSX reader
 * that can throw (see `gate/model/lexer.ts:454`'s `./jsx` reader, wrapped in `errore.try` for
 * its residual `RangeError`, and `gate/model/gate.ts:189`'s identical boundary). Mirrors
 * `gate/adapters/gate-runner.ts`'s `DeterminismLintUnreadableError`.
 */
class DesignSystemExportScanUnreadableError extends errore.createTaggedError({
  name: "DesignSystemExportScanUnreadableError",
  message: 'the design-system component-export check could not read "$file" to the end',
}) {}

/**
 * A `system/` file's own edges could not be read to the end — `scanModuleEdges` shares the
 * recursive-descent JSX reader that can throw (see `gate/model/lexer.ts:454`'s `./jsx` reader).
 * Mirrors `gate/adapters/gate-runner.ts`'s `readClosureEdges` treatment of the identical call:
 * the file's own edges are unknowable, not empty, so {@link scanSystemContainment} skips it
 * rather than reporting anything about its (unread) imports.
 */
class DesignSystemEdgeScanUnreadableError extends errore.createTaggedError({
  name: "DesignSystemEdgeScanUnreadableError",
  message: 'the system/ containment scan could not read "$file" to the end',
}) {}

/**
 * A page's own contract could not be read to the end while {@link checkPageThemes} re-parsed it
 * for `meta.theme` — `checkPageContract` shares the recursive-descent JSX reader that can throw
 * (see `gate/model/lexer.ts:454`'s `./jsx` reader). Mirrors `gate/adapters/gate-runner.ts`'s
 * `extractPageMeta` boundary around the identical call: the page's own contract stage already
 * carries its own diagnostic for an unreadable source, so this check simply yields no theme
 * diagnostic for it (decision D7).
 */
class PageThemeContractUnreadableError extends errore.createTaggedError({
  name: "PageThemeContractUnreadableError",
  message: 'checkPageThemes could not read "$file" to the end',
}) {}

/** A manifest-level fatal (design-systems §7): `file` is the manifest itself, mirroring
 *  `gate/model/manifest.ts`'s own `manifestError`. */
function manifestError(code: string, message: string): GateError {
  return { kind: "manifest", code, message, file: DESIGN_SYSTEM_MANIFEST_RELPATH };
}

/** A component-scoped fatal: `file` is overridden to the COMPONENT's own module path, because
 *  the broken thing is that module, not the manifest that named it. */
function componentError(code: string, message: string, relPath: string): GateError {
  return { kind: "manifest", code, message, file: relPath };
}

/** Maps a decode-time rejection onto one fatal `GateError`, reusing the decoder's own code —
 *  mirrors `gate/model/manifest.ts`'s own `fromDecodeError`. */
function fromDecodeError(error: DesignSystemManifestInvalidError): GateError {
  return manifestError(String(error.code), error.message);
}

/**
 * True when the tree declares a design system at all — the transitional gate (decision D8):
 * every design-system Gate check activates if and only if `system/design-system.json` is
 * present in the tree. A tree without it is judged exactly as it is judged today, with no new
 * diagnostic of any kind. `checkDesignSystemSlice` calls this as its own first line, so this
 * one function is the transitional rule's single, testable implementation — later plans (P4's
 * scaffold, P10's install) bind to it instead of re-spelling the path.
 */
export function hasDesignSystem(treePaths: readonly string[]): boolean {
  return treePaths.includes(DESIGN_SYSTEM_MANIFEST_RELPATH);
}

/**
 * The design-system slice check (design-systems §5, §7): `system/design-system.json` decodes —
 * schema, the core token roles, theme token-name parity, and `defaultTheme` membership are
 * `decodeDesignSystemManifest`'s own job, NOT re-implemented here — `kitApiVersion` names a
 * supported kit (decision D2, checked against `page-contract.ts`'s own
 * `SUPPORTED_KIT_API_VERSIONS` rather than a second list), and every declared component resolves
 * to a real file in the tree (`findUnresolvedComponents`, also not re-implemented here) and
 * exports the binding it names (`gate/model/exports-scan.ts`'s `scanNamedExports`). This
 * function only composes those and maps their outcomes onto `GateError`s; it holds no
 * validation rule of its own.
 *
 * FAIL-FAST ON THE MANIFEST, THEN FAN OUT. A manifest present in `treePaths` with no source text
 * reports exactly one `DESIGN_SYSTEM_SOURCE_MISSING` fatal (mirrors `CLOSURE_SOURCE_MISSING`'s
 * honesty rule: an unread manifest is not an absent one). A manifest that does not decode
 * reports exactly ONE fatal — `decodeDesignSystemManifest` itself stops at the first problem —
 * and `manifest: null`. An unsupported `kitApiVersion` also reports exactly one fatal, skips
 * every component check, and ALSO returns `manifest: null` — even though the manifest itself
 * decoded — because "this binary cannot even target this kit" is the same class of "we are not
 * reading this system" as a decode failure, and Task 6's `runTree` wiring branches on
 * `manifest === null` to suppress the containment scan and the `meta.theme` check the identical
 * way: a system built for another runtime API says so once, rather than once per component it
 * happens to declare AND once per page whose theme it never validated. Only a decoded manifest
 * whose `kitApiVersion` is supported reaches the component-resolution and export checks, which
 * fan out — every
 * unresolved entry and every resolved-but-export-missing module gets its own independent fatal
 * (spec §7); they never short-circuit each other, because they are independent facts about
 * independent files.
 *
 * THIS FUNCTION ITSELF attributes every fatal it returns to NO page (decision D6): a
 * manifest-level fault names no page, and this function attributing it to every page would be a
 * fabricated claim. That is the whole of D6's guarantee — a manifest fatal that no page's proven
 * closure reaches always comes back with `blockedPages` ABSENT — and it is what this function
 * alone controls.
 *
 * `blockedPages` CAN still end up populated later, though, and that is correct, not a breach of
 * D6. `gate-runner.ts`'s `runTree` pipes this function's `errors` through
 * `attributeToReachingPages`, which — for EVERY whole-tree diagnostic, not specially for this
 * one — adds `blockedPages` whenever the diagnostic's `file` sits inside a page's own PROVEN
 * closure (`gate-runner.ts:212`'s `attributeToReachingPages`, `gate-runner.ts:182-193`'s doc for
 * the defect that motivated widening attribution to "reaches", not only "broke at"). A manifest a
 * page's closure genuinely imports — `pages/dash.tsx` importing `system/tokens.ts` importing
 * `./design-system.json`, spec §4.3's own arrangement for the typed token accessor — makes that
 * page truly blocked by the manifest fault, so attributing the fatal to it there is an honest
 * statement, not a fabricated one; it is simply made by `runTree`, one layer up, from a fact this
 * function does not have (which pages import which files). Pinned in
 * `gate-runner.test.ts`'s design-system describe block, alongside the D6 case this function does
 * control: a manifest fatal no page's closure reaches still comes back with `blockedPages`
 * absent.
 *
 * `unverified` is true whenever `errors.length > 0` — i.e. exactly "the tree names a design
 * system and this pass could not fully verify it" — and false only when the tree declares none
 * or every check on a decoded manifest passed clean.
 */
export function checkDesignSystemSlice(input: DesignSystemScanInput): DesignSystemScanResultV1 {
  if (!hasDesignSystem(input.treePaths)) return NO_DESIGN_SYSTEM;

  const manifestText = input.files.get(DESIGN_SYSTEM_MANIFEST_RELPATH);
  if (manifestText === undefined) {
    return {
      errors: [
        manifestError(
          "DESIGN_SYSTEM_SOURCE_MISSING",
          `${DESIGN_SYSTEM_MANIFEST_RELPATH} is present in the tree but its source text was not provided`,
        ),
      ],
      manifest: null,
      unverified: true,
      componentRoots: [],
    };
  }

  const manifest = decodeDesignSystemManifest(manifestText);
  if (manifest instanceof Error)
    return {
      errors: [fromDecodeError(manifest)],
      manifest: null,
      unverified: true,
      componentRoots: [],
    };

  if (!SUPPORTED_KIT_API_VERSIONS.has(manifest.kitApiVersion)) {
    const supported = [...SUPPORTED_KIT_API_VERSIONS].join(", ");
    // `manifest: null`, not the decoded value — Task 6's `runTree` wiring branches on
    // `manifest === null` to skip `scanSystemContainment`/`checkPageThemes` entirely, exactly
    // as it already does for a manifest that failed to decode: reporting a containment or
    // theme fatal for a system this binary cannot even target would report the wrong fix.
    return {
      errors: [
        manifestError(
          "UNSUPPORTED_KIT_API",
          `kitApiVersion ${manifest.kitApiVersion} is not supported (this binary accepts ${supported})`,
        ),
      ],
      manifest: null,
      unverified: true,
      componentRoots: [],
    };
  }

  const present = new Set(input.treePaths);
  // Keyed by the component's own TREE-relative path, not by object reference: a Set built from
  // `findUnresolvedComponents`'s result happens to hold the SAME array elements today (it
  // `.filter()`s `manifest.components`), but keying membership on that incidental identity
  // would make the `DESIGN_SYSTEM_COMPONENT_UNRESOLVED` fatal silently disappear the moment that
  // implementation changed to `.map()` or similar — a fail-open regression with nothing here to
  // catch it. `designSystemComponentRelPath` is the entity's own function, reused rather than
  // re-derived, so this can never read a path differently than `findUnresolvedComponents` did.
  const unresolved = new Set(
    findUnresolvedComponents({ manifest, has: (relPath) => present.has(relPath) }).map(
      designSystemComponentRelPath,
    ),
  );

  const errors: GateError[] = [];
  const componentRoots: string[] = [];

  for (const component of manifest.components) {
    const relPath = designSystemComponentRelPath(component);

    if (unresolved.has(relPath)) {
      errors.push(
        componentError(
          "DESIGN_SYSTEM_COMPONENT_UNRESOLVED",
          `component "${component.name}"'s module "${relPath}" does not resolve to a file in the design tree`,
          relPath,
        ),
      );
      continue;
    }
    componentRoots.push(relPath);

    const source = input.files.get(relPath);
    if (source === undefined) continue; // the flat allowlist scan already reports this file's own absence

    const scanned = errore.try({
      try: () => scanNamedExports(source, parsesJsx(relPath)),
      catch: (cause) => new DesignSystemExportScanUnreadableError({ file: relPath, cause }),
    });
    if (scanned instanceof Error) {
      // `scanned.message` alone cannot always be attributed to `relPath`: the THROWN arm's
      // `DesignSystemExportScanUnreadableError` carries `$file` in its own template, but the
      // RETURNED `SourceStreamTruncatedError` (`lexer.ts:463`, `"...: $reason"`) names no file
      // at all — so `relPath` is included explicitly rather than assumed to be in the message.
      log.warn(
        `gate/model/design-system: could not verify "${relPath}"'s export "${component.export}" — ${scanned.message} — the flat allowlist scan already carries this file's own UNSCANNABLE_SOURCE fatal, so no export-missing diagnostic is manufactured for it`,
      );
      continue;
    }
    if (!scanned.exhaustive) continue; // a non-exhaustive scan must never manufacture a missing-binding fatal

    if (!scanned.names.has(component.export)) {
      errors.push(
        componentError(
          "DESIGN_SYSTEM_COMPONENT_EXPORT_MISSING",
          `component "${component.name}"'s module "${relPath}" does not export "${component.export}"`,
          relPath,
        ),
      );
    }
  }

  return { errors, manifest, unverified: errors.length > 0, componentRoots };
}

/**
 * Every import inside `system/` that leaves `system/` (design-systems §5.1). `@termcraft/runtime`
 * is allowed — it resolves to `kind: "runtime"` and leaves the tree by design; a sibling inside
 * the folder is allowed; `../lib/time` and `../pages/…` are not.
 *
 * ITS OWN PASS, NOT A RIDE ON THE CLOSURE WALK (decision D1 — read that before touching this
 * function). Spec §5.1 reads as if this check belongs inside the existing closure walk
 * (`entities/design-tree/model/closure.ts`, driven from `gate/adapters/gate-runner.ts`). Taken
 * literally, a containment violation would come back from `resolveClosure` as a
 * `SpecifierRejectedError` and land in `walkPageClosure`'s `edge-rejected` blocker — whose `own`
 * diagnostic is SUPPRESSED whenever `context.scannedInFull(from)` is true. That suppression is
 * correct for every rejection code the flat allowlist scan already reports through the identical
 * `resolveDesignSpecifier` — reporting it a second time from the closure walk would be a
 * duplicate. It would be FALSE for containment: the flat scan knows nothing about `system/`, so
 * routing the fatal through the closure walk would let the suppression eat it and the violation
 * would silently vanish. Second reason: the closure walk only reaches files SOME page's entry
 * walks to, and "the folder is self-contained" is a property of the WHOLE folder, not of
 * whichever slice of it happens to be reachable from a page this turn. So containment gets its
 * own pass here, over EVERY code file under `system/`, walked or not.
 *
 * NOT A SECOND READING OF THE IMPORT GRAPH. This pass uses the SAME `scanModuleEdges` (the raw
 * specifier reader) and the SAME `resolveDesignSpecifier` (the resolver) that the closure walk
 * and the flat allowlist scan both already use — so the three passes can never disagree about
 * what one file's imports actually are; only what they DO with that agreement differs.
 *
 * A REJECTED specifier is skipped (not re-reported): the flat allowlist scan already carries that
 * exact rejection, resolved through the identical function, naming the identical file — a second
 * diagnostic for one fact would be noise, not a new finding.
 */
export function scanSystemContainment(input: DesignSystemScanInput): readonly GateError[] {
  const has = hasTreePath(input.treePaths);
  const errors: GateError[] = [];

  for (const relPath of [...input.files.keys()].sort()) {
    if (!isInsideDesignSystem(relPath) || !isCodeFile(relPath)) continue;

    const source = input.files.get(relPath)!; // a key drawn from `input.files` itself
    const edges = errore.try({
      try: () => scanModuleEdges(source, parsesJsx(relPath)),
      catch: (cause) => new DesignSystemEdgeScanUnreadableError({ file: relPath, cause }),
    });
    if (edges instanceof Error) {
      // Swallowed deliberately (errore rule 21 still requires a trace): the flat allowlist scan
      // already reads this exact file with the identical `scanModuleEdges` call and carries its
      // own UNSCANNABLE_SOURCE fatal for it, so manufacturing a second diagnostic here for the
      // same unreadable file would be noise, not a new finding.
      log.warn(
        `gate/model/design-system: could not verify "${relPath}"'s system/ containment — ${edges.message} — the flat allowlist scan already carries this file's own UNSCANNABLE_SOURCE fatal`,
      );
      continue;
    }

    for (const specifier of edges) {
      const resolved = resolveDesignSpecifier({ from: relPath, specifier, has });
      // A REJECTED specifier is the flat allowlist scan's own diagnostic, reported through the
      // identical `resolveDesignSpecifier` — repeating it here would be a second diagnostic for
      // one fact. A `"runtime"` resolution (`@termcraft/runtime`) is allowed by §5.1 outright.
      if (resolved instanceof Error || resolved.kind !== "file") continue;
      if (isInsideDesignSystem(resolved.relPath)) continue;

      errors.push({
        kind: "import",
        code: "SYSTEM_IMPORT_ESCAPES",
        message: `"${specifier}" resolves to "${resolved.relPath}", outside "${DESIGN_SYSTEM_DIRNAME}/" — a design system must be self-contained so it can be copied whole; move what it needs inside the folder`,
        file: relPath,
      });
    }
  }

  return errors;
}

/**
 * Every page's declared `meta.theme` names a theme the manifest actually declares (design-systems
 * §7). Only runs from `runTree` when `checkDesignSystemSlice` returned a DECODED manifest — see
 * that function's own doc and `runTree`'s ordering comment for why.
 *
 * THE CONTRACT IS PARSED A SECOND TIME HERE (decision D7), and that is deliberate rather than an
 * oversight. `runTree` holds `pages` and `files` but no `meta` — the per-page contract stage
 * (`gate/adapters/gate-runner.ts`'s `extractPageMeta`) runs separately, keyed by slug, and this
 * whole-tree pass never sees its output. The alternative would widen the `GateRunner` port so
 * `runPage` passes the declared theme set through to this pass, but that changes `core/ports` and
 * every caller of it, for the sake of one string comparison. The cost of re-parsing instead is one
 * extra token scan per PAGE ENTRY (not per tree file) — the measured whole-tree budget is 2.3 MB
 * across 128 files in 453 ms (`core/turns/model/validation.ts`'s own `files` doc), so a handful of
 * entry re-scans is noise next to that. The call is wrapped in `errore.try` exactly the way
 * `extractPageMeta` wraps the identical `checkPageContract` call
 * (`gate/adapters/gate-runner.ts:1225-1228`): an unreadable source (thrown past
 * `checkPageContract`'s own return type, or a returned `SourceStreamTruncatedError`) yields no
 * theme diagnostic here, because that page already carries its own contract fatal from the
 * per-page stage.
 *
 * `meta.theme` stays REQUIRED in this plan (decision D5). This check's SEMANTICS are already
 * correct for an absent theme either way: it fires ONLY when a page's parsed `meta` carries a
 * NON-EMPTY `theme` string that names no declared theme, so an absent or empty theme simply skips
 * it. That does not mean the day another plan makes `PageMeta.theme` optional this function needs
 * no edit at all — under `strict: true`, `theme.length` on a possibly-`undefined` field would stop
 * compiling — only that no BEHAVIOR change would be needed, just the type-narrowing to reach it.
 */
export function checkPageThemes(input: {
  readonly manifest: DesignSystemManifestV1;
  readonly pages: readonly PageEntryV1[];
  readonly files: ReadonlyMap<string, string>;
}): readonly GateError[] {
  const declared = Object.keys(input.manifest.themes).sort();
  const errors: GateError[] = [];

  for (const page of input.pages) {
    const source = input.files.get(page.entry);
    if (source === undefined) continue; // this pass was given no text for it — not this check's business

    const contract = errore.try({
      try: () => checkPageContract(source, parsesJsx(page.entry)),
      catch: (cause) => new PageThemeContractUnreadableError({ file: page.entry, cause }),
    });
    // Both error arms — the THROWN case wrapped above, and the RETURNED `SourceStreamTruncatedError`
    // — collapse to one skip: the page's own contract stage already reports this file's fatal, so
    // no SECOND diagnostic is manufactured here (decision D7). errore rule 21 still requires a
    // trace for a swallowed error, matching `checkDesignSystemSlice`'s and
    // `scanSystemContainment`'s identical boundaries just above in this file.
    if (contract instanceof Error) {
      log.warn(
        `gate/model/design-system: could not verify "${page.entry}"'s meta.theme — ${contract.message} — the page's own contract stage already carries this file's own fatal, so no theme diagnostic is manufactured for it`,
      );
      continue;
    }
    if (contract.meta === null) continue;

    const theme = contract.meta.theme;
    if (theme.length === 0) continue;
    // `Object.hasOwn`, not `in`: `manifest.themes` is a plain object built off a `z.record`, so
    // it still carries `Object.prototype` — `"constructor" in themes` is TRUE even when no theme
    // named "constructor" is declared, which would silently wave through a page pinned to an
    // inherited key instead of reporting `UNDECLARED_PAGE_THEME` (fix round 1, Important 2).
    if (Object.hasOwn(input.manifest.themes, theme)) continue;

    errors.push({
      kind: "manifest",
      code: "UNDECLARED_PAGE_THEME",
      message: `page "${page.entry}" declares theme "${theme}", which the design system does not declare — declared themes: ${declared.join(", ")}`,
      file: page.entry,
      blockedPages: [page.slug],
    });
  }

  return errors;
}
