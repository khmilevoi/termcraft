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

  test("the theme capability id is FIXED, and names no project's theme (design-systems §4.6)", () => {
    expect(EMBEDDED_RUNTIME_DECLARATION.publicCapabilityIds).toEqual([
      "theme:project-design-system",
    ]);
  });

  test("no capability id embeds the compiled seed theme's name", () => {
    // The handshake is a BINARY-integrity check between the Gate and the host (runtime-api §7.2). A
    // project's theme names are not part of the binary's identity, and putting them there would make
    // every project mismatch every other one.
    for (const id of EMBEDDED_RUNTIME_DECLARATION.publicCapabilityIds)
      expect(id).not.toContain("dark-default");
  });
});
