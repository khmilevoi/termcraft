/**
 * An OS-absolute path handed in by the composition root — never a caller-built managed relative
 * path. Declared locally, exactly as `store/trust/types.ts` declares it, so this submodule stays
 * self-contained rather than importing `store/types.ts` (which imports the submodules back).
 */
export type AbsPath = string;

/** Lowercase-hex SHA-256. A package's content hash is one of these (design §8.2). */
export type Sha256Hex = string;
