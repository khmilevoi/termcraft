import { describe, expect, test } from "bun:test";

import { CURRENT_KIT_API_VERSION, definePage } from "./define-page";

describe("definePage", () => {
  test("returns the static meta unchanged", () => {
    const meta = definePage({
      kitApiVersion: 1,
      title: "Dashboard",
      minSize: { w: 80, h: 24 },
      theme: "dark-default",
    });
    expect(meta).toEqual({
      kitApiVersion: 1,
      title: "Dashboard",
      minSize: { w: 80, h: 24 },
      theme: "dark-default",
    });
  });

  test("CURRENT_KIT_API_VERSION is the first shipped contract", () => {
    expect(CURRENT_KIT_API_VERSION).toBe(1);
  });
});
