/**
 * This binary's own version string, stamped into every migration backup manifest
 * (`BackupManifest.termcraftVersion`, storage-identity §12) so a restore knows which install wrote
 * the copy.
 *
 * A LITERAL, not a `package.json` read: `bun build --compile` produces a single binary with no
 * `package.json` beside it, so reading one at runtime would work in the repo and fail in the
 * shipped product. `model/version.test.ts` pins this literal against `package.json`'s own field,
 * which is what stops the two from drifting.
 */
export const TERMCRAFT_VERSION = "0.1.0";
