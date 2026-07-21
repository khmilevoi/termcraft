import { describe, expect, test } from "bun:test";

import { validatePublicLimits, validateRuntimeDeclarationBundle } from "./bundle";
import { ProtocolError } from "./errors";
import type { JsonValue } from "./strict-json";

const bundle: JsonValue = {
  module: "@termcraft/runtime",
  currentKitApiVersion: 1,
  supportedKitApiVersions: [1],
  publicCapabilityIds: ["nav", "theme:dark-default"],
};

const limits: JsonValue = {
  controlPayloadBytes: 262144,
  framePayloadBytes: 16777216,
  maxFrameWidth: 2048,
  maxFrameHeight: 2048,
  maxFrameCells: 262144,
};

describe("validateRuntimeDeclarationBundle", () => {
  test("accepts a canonical bundle", () => {
    expect(validateRuntimeDeclarationBundle(bundle)).toEqual({
      module: "@termcraft/runtime",
      currentKitApiVersion: 1,
      supportedKitApiVersions: [1],
      publicCapabilityIds: ["nav", "theme:dark-default"],
    });
  });

  test("rejects a wrong module literal", () => {
    expect(validateRuntimeDeclarationBundle({ ...bundle, module: "@other/x" })).toBeInstanceOf(
      ProtocolError,
    );
  });

  test("rejects an unknown field", () => {
    expect(validateRuntimeDeclarationBundle({ ...bundle, extra: 1 })).toBeInstanceOf(ProtocolError);
  });

  test("rejects a missing field", () => {
    const { publicCapabilityIds: _omit, ...rest } = bundle as Record<string, JsonValue>;
    expect(validateRuntimeDeclarationBundle(rest)).toBeInstanceOf(ProtocolError);
  });

  test("rejects a supported set that omits the current version", () => {
    expect(
      validateRuntimeDeclarationBundle({
        ...bundle,
        currentKitApiVersion: 2,
        supportedKitApiVersions: [1],
      }),
    ).toBeInstanceOf(ProtocolError);
  });

  test("rejects an unsorted supported set", () => {
    expect(
      validateRuntimeDeclarationBundle({
        ...bundle,
        currentKitApiVersion: 2,
        supportedKitApiVersions: [2, 1],
      }),
    ).toBeInstanceOf(ProtocolError);
  });

  test("rejects a duplicate in the supported set", () => {
    expect(
      validateRuntimeDeclarationBundle({ ...bundle, supportedKitApiVersions: [1, 1] }),
    ).toBeInstanceOf(ProtocolError);
  });

  test("rejects a non-positive kit version", () => {
    expect(
      validateRuntimeDeclarationBundle({
        ...bundle,
        currentKitApiVersion: 0,
        supportedKitApiVersions: [0],
      }),
    ).toBeInstanceOf(ProtocolError);
  });

  test("rejects unsorted capability ids", () => {
    expect(
      validateRuntimeDeclarationBundle({
        ...bundle,
        publicCapabilityIds: ["theme:dark-default", "nav"],
      }),
    ).toBeInstanceOf(ProtocolError);
  });

  test("rejects an empty capability id", () => {
    expect(
      validateRuntimeDeclarationBundle({ ...bundle, publicCapabilityIds: [""] }),
    ).toBeInstanceOf(ProtocolError);
  });
});

describe("validatePublicLimits", () => {
  test("accepts limits at exactly the hard caps", () => {
    expect(validatePublicLimits(limits)).toEqual({
      controlPayloadBytes: 262144,
      framePayloadBytes: 16777216,
      maxFrameWidth: 2048,
      maxFrameHeight: 2048,
      maxFrameCells: 262144,
    });
  });

  test("rejects a control cap above the protocol hard limit", () => {
    expect(validatePublicLimits({ ...limits, controlPayloadBytes: 262145 })).toBeInstanceOf(
      ProtocolError,
    );
  });

  test("rejects a non-positive dimension", () => {
    expect(validatePublicLimits({ ...limits, maxFrameWidth: 0 })).toBeInstanceOf(ProtocolError);
  });

  test("rejects a non-integer field", () => {
    expect(validatePublicLimits({ ...limits, maxFrameCells: 1.5 })).toBeInstanceOf(ProtocolError);
  });
});
