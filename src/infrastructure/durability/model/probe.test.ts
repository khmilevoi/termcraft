import { describe, expect, test } from "bun:test";
import os from "node:os";

import { DirectoryFlushError, DurabilityUnavailableError, UnsupportedVolumeError } from "./errors";
import { probeDurability } from "./probe";

const onWindows = process.platform === "win32";

// `probeDurability` composes the cheap volume-type gate (`assertDurableVolume`) with a real
// `flushDir` probe (Spike G, `docs/spikes/07-durability-primitive/FINDINGS.md`) into the single
// pre-flight check the store needs before mutating a project's volume. Both collaborators are
// injected here (the seam this module owns, independent of any platform gate) so the
// `ERROR_INVALID_FUNCTION -> DirectoryFlushError` mapping and the volume-refused short-circuit
// are exercised cross-platform, without a real non-durable volume.

describe("probeDurability", () => {
  test("returns undefined when both the volume gate and the flush probe are clean", () => {
    const result = probeDurability("C:\\fake\\dir", {
      assertVolume: () => undefined,
      flush: () => undefined,
    });
    expect(result).toBeUndefined();
  });

  test("returns the flush probe's DirectoryFlushError when the volume gate passes but the real flush fails (Win32 ERROR_INVALID_FUNCTION on a volume with no write-through)", () => {
    const flushError = new DirectoryFlushError({ path: "C:\\fake\\dir", lastError: 1 });
    const result = probeDurability("C:\\fake\\dir", {
      assertVolume: () => undefined,
      flush: () => flushError,
    });
    expect(result).toBe(flushError);
  });

  test("short-circuits on an unsupported volume before the flush probe ever runs", () => {
    const volumeError = new UnsupportedVolumeError({
      path: "\\\\remote\\share",
      driveType: "DRIVE_REMOTE",
    });
    let flushCalled = false;
    const result = probeDurability("\\\\remote\\share", {
      assertVolume: () => volumeError,
      flush: () => {
        flushCalled = true;
        return undefined;
      },
    });
    expect(result).toBe(volumeError);
    expect(flushCalled).toBe(false);
  });

  test("propagates a DurabilityUnavailableError from the volume gate without calling flush", () => {
    const unavailable = new DurabilityUnavailableError({ reason: "ffi load failed" });
    let flushCalled = false;
    const result = probeDurability("C:\\fake\\dir", {
      assertVolume: () => unavailable,
      flush: () => {
        flushCalled = true;
        return undefined;
      },
    });
    expect(result).toBe(unavailable);
    expect(flushCalled).toBe(false);
  });

  test.skipIf(!onWindows)(
    "uses the real assertDurableVolume/flushDir primitives when no overrides are given",
    () => {
      // The OS temp directory is a real, existing, durable directory — proves the default
      // parameters wire to the real primitives rather than requiring a caller to always inject
      // something.
      expect(probeDurability(os.tmpdir())).toBeUndefined();
    },
  );
});
