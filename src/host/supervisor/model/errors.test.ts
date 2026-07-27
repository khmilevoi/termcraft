import { describe, expect, test } from "bun:test";

import { SupervisorError, osFailureReason } from "./errors";

describe("SupervisorError", () => {
  test("carries a stable code and interpolates the reason", () => {
    const err = new SupervisorError({ code: "SPAWN_FAILED", reason: "uv_spawn ENOENT" });
    expect(err).toBeInstanceOf(Error);
    expect(err._tag).toBe("SupervisorError");
    expect(err.code).toBe("SPAWN_FAILED");
    expect(err.reason).toBe("uv_spawn ENOENT");
    expect(err.message).toBe("Supervisor failure [SPAWN_FAILED]: uv_spawn ENOENT");
  });

  test("preserves a cause chain", () => {
    const root = new Error("boom");
    const err = new SupervisorError({
      code: "TRANSPORT_ERROR",
      reason: "stdout read failed",
      cause: root,
    });
    expect(err.cause).toBe(root);
  });
});

describe("osFailureReason (§13)", () => {
  /** What `fs.mkdtempSync` actually throws when the temp directory is not writable. */
  const libuvError = () =>
    Object.assign(
      new Error(
        "EACCES: permission denied, mkdtemp 'C:\\Users\\someone\\AppData\\Local\\Temp\\termcraft-host-XXXXXX'",
      ),
      { code: "EACCES", syscall: "mkdtemp", errno: -4092, path: "C:\\Users\\someone\\AppData" },
    );

  test("reports the structured code and syscall, never the message", () => {
    expect(osFailureReason(libuvError())).toBe("EACCES (mkdtemp)");
  });

  test("carries no absolute path — the whole reason this exists", () => {
    const reason = osFailureReason(libuvError());
    expect(reason).not.toContain("C:\\");
    expect(reason).not.toContain("Temp");
    expect(reason).not.toContain("someone");
  });

  test("falls back to the code alone when there is no syscall", () => {
    expect(osFailureReason(Object.assign(new Error("nope"), { code: "ENOENT" }))).toBe("ENOENT");
  });

  test("names no detail at all when the throw carries no structured code", () => {
    // Free-form text is the case a scrubber would have to guess at. It is refused instead:
    // the untouched original stays on the SupervisorError's `cause`, which the debug log
    // records and the §13 diagnostic sink never reads.
    expect(
      osFailureReason(new Error("Executable not found in $PATH: /usr/local/bin/termcraft")),
    ).toBe("an unrecognized system error");
    expect(osFailureReason("a bare string")).toBe("an unrecognized system error");
    expect(osFailureReason(undefined)).toBe("an unrecognized system error");
  });
});
