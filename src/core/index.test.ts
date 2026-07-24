import { describe, expect, test } from "bun:test";

import * as core from "core";

/**
 * kernel-assembly WP-1 Task 10 (B1, m6) — `core/index.ts`'s public surface: `createKernel`
 * plus the boundary types `core/types.ts` re-exports, and nothing else (the file's own
 * header: "public entry: createKernel, the boundary types, and nothing else"). `ui`'s own
 * `grep -rn "from \"core"` (Task 10 Step 1) is the source of truth for exactly which
 * types below must round-trip through this one barrel.
 *
 * `Object.keys(core)` only ever sees RUNTIME (value) exports — `export type { ... }` is
 * erased entirely under `verbatimModuleSyntax`, so a type-only member never appears as an
 * own property here. That gives an exact, closed assertion for the value half of the
 * surface (`createKernel`/`REASON_CODES_V1`/`primaryReason`); the type half is proven
 * separately below, by using each name in an actual type position (a missing one fails
 * `tsc` with "has no exported member", not silently).
 */
describe("core's public entry (Task 10)", () => {
  test("exports exactly createKernel + the two protocol value re-exports at runtime — nothing internal leaks", () => {
    expect(Object.keys(core).sort()).toEqual(["REASON_CODES_V1", "createKernel", "primaryReason"]);
  });

  test("createKernel is a function", () => {
    expect(typeof core.createKernel).toBe("function");
  });

  test("REASON_CODES_V1/primaryReason are core/protocol's own values, re-exported verbatim", () => {
    expect(Array.isArray(core.REASON_CODES_V1)).toBe(true);
    expect(core.REASON_CODES_V1.length).toBeGreaterThan(0);
    expect(typeof core.primaryReason).toBe("function");
  });

  test("every boundary type ui imports today type-checks through core's own barrel (compile-time only)", () => {
    // Never invoked at runtime — the assertion under test is that this function's own
    // signature type-checks at all. `core.<Name>` references each type through the
    // namespace import above; a name core/index.ts fails to re-export makes this whole
    // file fail `tsc --noEmit` ("has no exported member ..."), not merely this one test.
    function typeCheck(
      _commandKind: core.CommandKindV1,
      _commandPayload: core.CommandPayloadByKindV1["project.open"],
      _commandResult: core.CommandResultV1,
      _unavailableReason: core.UnavailableReason,
      _eventKind: core.EventKindV1,
      _eventPayload: core.EventPayloadByKindV1["kernel.snapshot"],
      _failureDto: core.FailureDtoV1,
      _frameIdentity: core.FrameIdentityV1,
      _frameToken: core.FrameTokenV1,
      _geometryToken: core.GeometryTokenV1,
      _pageDescriptor: core.PageDescriptorV1,
      _pinDto: core.PinDtoV1,
      _sha256Hex: core.Sha256Hex,
      _uint64String: core.UInt64String,
      _uuidv7: core.UUIDv7,
      _colorV1: core.ColorV1,
      _previewFrame: core.PreviewFrameV1,
      _previewGeometryResult: core.PreviewGeometryQueryResultV1,
      _previewSession: core.PreviewSession,
      _styledRun: core.StyledRunV1,
      _eventCorrelation: core.EventCorrelationV1,
      _eventEnvelope: core.EventEnvelopeV1,
      _kernelDeps: core.KernelDeps,
    ): void {}
    expect(typeof typeCheck).toBe("function");
  });

  test("Kernel (the composed object type) does not leak through core's top-level barrel", () => {
    // Never invoked — the assertion under test is that the line below FAILS TO COMPILE.
    // `Kernel` is `core/kernel/index.ts`'s own export (Task 10's file list names it there,
    // alongside `createKernel`/`KernelDeps`), never part of the top-level boundary
    // `core/index.ts` re-exports ("createKernel, the boundary types, and nothing else").
    const reachLeakedKernel = (): void => {
      // @ts-expect-error — `Kernel` must not be a member of the top-level `core` barrel.
      type _Leaked = core.Kernel;
    };
    expect(typeof reachLeakedKernel).toBe("function");
  });

  test("an internal handler-registry type does not leak through core's top-level barrel", () => {
    // Never invoked — same compile-time-only proof as above. `HandlerContext`
    // (`core/kernel/model/handlers/types.ts`) is the family-implementer contract, never a
    // public export of any barrel this task creates.
    const reachLeakedHandlerContext = (): void => {
      // @ts-expect-error — `HandlerContext` must not be a member of the top-level `core` barrel.
      type _Leaked = core.HandlerContext;
    };
    expect(typeof reachLeakedHandlerContext).toBe("function");
  });
});
