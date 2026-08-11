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
