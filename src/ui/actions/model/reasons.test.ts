import { describe, expect, test } from "bun:test";

import { REASON_CODES_V1 } from "core/protocol";

import { reasonLabel } from "./reasons";

describe("reasonLabel", () => {
  test("every reason code maps to a non-empty short label", () => {
    for (const code of REASON_CODES_V1) {
      const label = reasonLabel({ code } as never);
      expect(typeof label).toBe("string");
      expect(label.length).toBeGreaterThan(0);
    }
  });

  test("carries the design-flavoured hint wording", () => {
    expect(reasonLabel({ code: "TURN_RUNNING", turnId: "x" } as never)).toBe("turn running");
    expect(reasonLabel({ code: "PROJECT_UNTRUSTED" })).toBe("read-only");
    expect(reasonLabel({ code: "NO_PAGES" })).toBe("no pages");
    expect(reasonLabel({ code: "GIT_UNAVAILABLE" })).toBe("git off");
    expect(reasonLabel({ code: "CAPABILITY_UNAVAILABLE" })).toBe("unavailable");
  });
});
