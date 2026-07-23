import type { DurabilityError } from "../types";
import type { DurabilityUnavailableError, UnsupportedVolumeError } from "./errors";
import { flushDir } from "./flush-dir";
import { assertDurableVolume } from "./volume";

/**
 * Overrides for `probeDurability`'s two collaborators, injected at this module's own level
 * (independent of any caller's dependency-injection shape) so a test can drive the
 * volume-refused short-circuit and the `ERROR_INVALID_FUNCTION -> DirectoryFlushError` mapping
 * without a real non-durable volume. Both default to the real primitives.
 */
export interface ProbeDurabilityOverrides {
  readonly assertVolume?: (
    anyPath: string,
  ) => UnsupportedVolumeError | DurabilityUnavailableError | undefined;
  readonly flush?: (dirPath: string) => DurabilityError | undefined;
}

/**
 * The store's pre-flight durability check (storage-identity §4, turn-durability §1/§13): the
 * cheap `assertDurableVolume` volume-type gate first, then — only if that passes — a real
 * `flushDir` probe against `dirPath`, which must already exist on the target volume. Returns
 * the existing tagged durability errors (never a new class) or `undefined` on success. Callers
 * run this BEFORE any mutation of the target volume (lease acquire, `mkdirSync`, ...) so a
 * refused volume never sees a partial write.
 */
export function probeDurability(
  dirPath: string,
  overrides: ProbeDurabilityOverrides = {},
): DurabilityError | undefined {
  const assertVolume = overrides.assertVolume ?? assertDurableVolume;
  const flush = overrides.flush ?? flushDir;

  const volumeError = assertVolume(dirPath);
  if (volumeError instanceof Error) return volumeError;

  return flush(dirPath);
}
