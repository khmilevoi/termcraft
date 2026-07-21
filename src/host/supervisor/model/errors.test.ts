import { describe, expect, test } from "bun:test";

import { SupervisorError } from "./errors";

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
