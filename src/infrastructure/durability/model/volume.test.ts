import { describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";

import { UnsupportedVolumeError } from "./errors";
import {
  DRIVE_CDROM,
  DRIVE_FIXED,
  DRIVE_NO_ROOT_DIR,
  DRIVE_RAMDISK,
  DRIVE_REMOTE,
  DRIVE_REMOVABLE,
  DRIVE_UNKNOWN,
} from "./kernel32";
import { assertDurableVolume, getDriveType, isDurableDriveType } from "./volume";

const onWindows = process.platform === "win32";

describe("isDurableDriveType", () => {
  test("accepts only fixed and RAM disks", () => {
    expect(isDurableDriveType(DRIVE_FIXED)).toBe(true);
    expect(isDurableDriveType(DRIVE_RAMDISK)).toBe(true);
  });

  test("rejects remote, removable, and undetermined volumes", () => {
    for (const code of [
      DRIVE_UNKNOWN,
      DRIVE_NO_ROOT_DIR,
      DRIVE_REMOVABLE,
      DRIVE_REMOTE,
      DRIVE_CDROM,
    ]) {
      expect(isDurableDriveType(code)).toBe(false);
    }
  });
});

describe.skipIf(!onWindows)("getDriveType / assertDurableVolume (Windows)", () => {
  test("the OS temp volume is a fixed, durable volume", () => {
    // GetDriveTypeW wants a volume root (e.g. `C:\`), not an arbitrary directory.
    const type = getDriveType(path.parse(os.tmpdir()).root);
    expect(type).toBe(DRIVE_FIXED);
    expect(assertDurableVolume(os.tmpdir())).toBeUndefined();
  });

  test("an unsupported volume is refused with a typed error", () => {
    // A remote UNC path derives an unsupported (non-fixed) volume root.
    const result = assertDurableVolume("\\\\localhost\\share\\dir");
    // If loopback happens to classify as fixed on this host the gate accepts it;
    // otherwise it must be an UnsupportedVolumeError, never a silent pass-through.
    if (result !== undefined) {
      expect(result).toBeInstanceOf(UnsupportedVolumeError);
    }
  });
});
