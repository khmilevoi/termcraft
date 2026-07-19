import type {
  DirectoryFlushError,
  DurabilityUnavailableError,
  DurableWriteError,
  UnsupportedVolumeError,
} from "./model/errors"

/**
 * Any failure the durability primitives can return — a `_tag`-discriminated union
 * for callers that propagate a single error type. The ProjectStore transaction
 * engine narrows on `instanceof` / `_tag` to classify a durability failure.
 */
export type DurabilityError =
  | DurabilityUnavailableError
  | DirectoryFlushError
  | UnsupportedVolumeError
  | DurableWriteError
