import { describe, expect, test } from "bun:test";

import type { PageSlug } from "entities/page";

import type { GateError, GateWarning, PageDescriptor } from "../types";
import { isPassing, makeGateResult } from "./gate-result";

const descriptor: PageDescriptor = {
  slug: "dash" as PageSlug,
  meta: { kitApiVersion: 1, title: "Dashboard", minSize: { w: 80, h: 24 }, theme: "dark-default" },
};
const importError: GateError = {
  kind: "import",
  code: "FORBIDDEN_IMPORT",
  message: "import of 'react' is not allowed",
};
const droppedIdWarning: GateWarning = {
  kind: "dropped-id",
  message: "id 'visits' was present last iteration",
};

describe("makeGateResult (§6.3 pass/fail rule)", () => {
  test("a candidate with no fatal errors passes, even with warnings", () => {
    const result = makeGateResult([], [droppedIdWarning], descriptor);
    expect(result.ok).toBe(true);
    expect(isPassing(result)).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.descriptor).toBe(descriptor);
  });

  test("any fatal error fails the candidate", () => {
    const result = makeGateResult([importError], [], descriptor);
    expect(result.ok).toBe(false);
    expect(isPassing(result)).toBe(false);
    expect(result.errors[0]?.code).toBe("FORBIDDEN_IMPORT");
  });

  test("a failed contract carries a null descriptor", () => {
    const result = makeGateResult(
      [{ kind: "contract", code: "NON_STATIC_META", message: "meta is not a literal" }],
      [],
      null,
    );
    expect(result.ok).toBe(false);
    expect(result.descriptor).toBeNull();
  });
});
