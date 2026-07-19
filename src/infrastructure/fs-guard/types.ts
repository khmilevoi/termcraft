import type { FileAttributesError, FsGuardUnavailableError, FsIdentityError } from "./model/errors"

/**
 * Any failure the fs-guard primitives can return — a `_tag`-discriminated union for
 * callers that propagate a single error type. `SafeProjectFs` narrows a reparse-check
 * failure; `store/trust` narrows an identity-read failure.
 */
export type FsGuardError = FsGuardUnavailableError | FileAttributesError | FsIdentityError
