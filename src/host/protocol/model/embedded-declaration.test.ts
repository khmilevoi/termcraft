import { describe, expect, test } from "bun:test";

import { validateRuntimeDeclarationBundle } from "./bundle";
import { EMBEDDED_RUNTIME_DECLARATION, SUPPORTED_KIT_API_VERSIONS } from "./embedded-declaration";
import { ProtocolError } from "./errors";

describe("EMBEDDED_RUNTIME_DECLARATION", () => {
  test("passes the protocol's own schema (sorted/duplicate-free arrays, current version included)", () => {
    const result = validateRuntimeDeclarationBundle(EMBEDDED_RUNTIME_DECLARATION);
    expect(result).not.toBeInstanceOf(ProtocolError);
    expect(result).toEqual(EMBEDDED_RUNTIME_DECLARATION);
  });

  test("supportedKitApiVersions contains currentKitApiVersion", () => {
    expect(EMBEDDED_RUNTIME_DECLARATION.supportedKitApiVersions).toEqual([
      ...SUPPORTED_KIT_API_VERSIONS,
    ]);
    expect([...SUPPORTED_KIT_API_VERSIONS]).toContain(
      EMBEDDED_RUNTIME_DECLARATION.currentKitApiVersion,
    );
  });
});
