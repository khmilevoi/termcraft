import type { Clock } from "infrastructure/clock";

/**
 * An OS-absolute path handed in by the composition root — never a caller-built managed relative
 * path. Declared locally, exactly as `store/trust/types.ts` declares it, so this submodule stays
 * self-contained rather than importing `store/types.ts` (which imports the submodules back).
 */
export type AbsPath = string;

/** Lowercase-hex SHA-256. A package's content hash is one of these (design §8.2). */
export type Sha256Hex = string;

/**
 * One file of a design-system package, at a `/`-separated path relative to the package root.
 * Field-for-field identical to `core/ports`' `PackageFileV1`, redrawn here so this module owns
 * its own vocabulary — the same relationship `TrustSubject` has with `TrustSubjectV1`.
 */
export interface PackageFile {
  readonly relPath: string;
  readonly bytes: Uint8Array;
}

/** One entry of a directory listing. Symlinks are reported, never followed (design §13's no-follow rule). */
export interface DirEntry {
  readonly name: string;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
}

/**
 * The impure boundary this module needs, injected so tests can drive enumeration, read failure,
 * and durable-write failure against fixtures — and so §11's "`list` never opens a `.tsx`" is an
 * OBSERVABLE property rather than a code-reading exercise. `nodeDesignSystemFsDeps` is the
 * production wiring; the shape mirrors `store/trust`'s `TrustFsDeps`.
 *
 * `null` means "absent", which is an ordinary answer here — an empty library and an unfetched
 * cache are both normal — and is deliberately distinct from an `Error`, which is a fault.
 */
export interface DesignSystemFsDeps {
  readonly listDir: (absDir: AbsPath) => readonly DirEntry[] | null | Error;
  readonly statFile: (absPath: AbsPath) => { readonly size: number } | null | Error;
  readonly readFile: (absPath: AbsPath) => Uint8Array | null | Error;
  readonly mkdirAll: (absDir: AbsPath) => Error | undefined;
  readonly durableWrite: (absPath: AbsPath, bytes: Uint8Array) => Error | undefined;
  /** Recursive; a directory that is already gone is success, not a fault. */
  readonly removeDir: (absDir: AbsPath) => Error | undefined;
  readonly renameDir: (from: AbsPath, to: AbsPath) => Error | undefined;
}

/**
 * The budget applied while a package is materialized (design §8.3: safe-fs limits sit between
 * `fetch` and the candidate; §13 names `store/safe-fs/model/limits.ts` as the limits applied at
 * the fetch boundary).
 *
 * P3 DOES NOT WIRE A REAL BUDGET — P10 does, by handing in an adapter over
 * `createLimitBudget("candidate")` with `namespace: "design-source"` filled in. The field on
 * `LocalDesignSystemSourceDeps` is REQUIRED and has no default precisely so P10 cannot forget:
 * an unbudgeted `fetch` does not compile. `allowAllPackageAdmission` is for tests.
 *
 * The shape is narrower than `LimitBudget` on purpose — it carries no namespace — so this module
 * needs no dependency on `store/safe-fs`.
 */
export interface PackageAdmission {
  /** The pre-allocation check, against the size the directory entry claims. */
  admitFile(input: {
    readonly relPath: string;
    readonly declaredSize: number;
    readonly depth: number;
  }): Error | null;
  /** The post-read check, against the bytes that actually arrived. */
  observeBytes(input: { readonly relPath: string; readonly bytesRead: number }): Error | null;
}

/** One token of a theme, in declaration order — the store-side twin of `DesignSystemTokenSwatchV1`. */
export interface TokenSwatch {
  readonly name: string;
  readonly value: string;
}

/**
 * What a picker needs about a candidate that is not installed and has never been through the
 * Gate (design §8.1). The store-side twin of `core/ports`' `DesignSystemSummaryV1`,
 * field-for-field identical.
 */
export interface DesignSystemSummary {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly kitApiVersion: number;
  readonly defaultTheme: string;
  readonly defaultThemeTokens: readonly TokenSwatch[];
  readonly componentNames: readonly string[];
}

/**
 * Everything the local design-system source needs; every impure boundary is injected, the same
 * way `TrustStoreDeps` injects the trust ledger's.
 *
 * `admission` is REQUIRED and has no default (design §8.3, §13): P10 hands in a budget over
 * `store/safe-fs`'s `createLimitBudget` at the fetch boundary, and a required field is what
 * makes forgetting it a compile error rather than an unbounded read.
 */
export interface LocalDesignSystemSourceDeps {
  /** The OS per-user termcraft state root that owns the design-system library (design §8.2). */
  readonly userStateRoot: AbsPath;
  readonly fs: DesignSystemFsDeps;
  readonly admission: PackageAdmission;
  readonly clock: Clock;
}
