import * as errore from "errore";

import {
  DESIGN_SYSTEM_MANIFEST_RELPATH,
  decodeDesignSystemManifest,
  designSystemComponentRelPath,
  findUnresolvedComponents,
} from "entities/design-system";
import type {
  DesignSystemManifestInvalidError,
  DesignSystemManifestV1,
} from "entities/design-system";
import { parsesJsx } from "entities/design-tree";
import { log } from "infrastructure/debug-log";

import type { GateError } from "../types";
import { scanNamedExports } from "./exports-scan";
import { SUPPORTED_KIT_API_VERSIONS } from "./page-contract";

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
 * Every fatal here carries NO `blockedPages` (decision D6): a manifest-level fault names no
 * page, and attributing it to every page would be a fabricated claim.
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
