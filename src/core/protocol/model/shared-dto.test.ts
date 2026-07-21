import { describe, expect, test } from "bun:test";

import { uuidv7 } from "infrastructure/uuid";

import {
  diagnosticDtoV1Schema,
  frameIdentityV1Schema,
  pageDescriptorChangeV1Schema,
  pageDescriptorV1Schema,
  pageRemovePlanV1Schema,
  pinDtoV1Schema,
} from "./shared-dto";

const SHA = "a".repeat(64);
const OTHER_SHA = "b".repeat(64);
const NONCE = "c".repeat(32);

describe("frameIdentityV1Schema", () => {
  const valid = {
    previewSessionId: uuidv7(),
    nonce: NONCE,
    sourceHash: SHA,
    frameSeq: "7",
  };

  test("accepts the complete four-part identity", () => {
    expect(frameIdentityV1Schema.safeParse(valid).success).toBe(true);
  });

  test("rejects an unknown key", () => {
    expect(frameIdentityV1Schema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
  });

  test("rejects a partial identity — no comparison is valid without all four parts", () => {
    const { nonce: _dropped, ...withoutNonce } = valid;
    expect(frameIdentityV1Schema.safeParse(withoutNonce).success).toBe(false);
  });

  test("rejects a non-canonical frameSeq", () => {
    expect(frameIdentityV1Schema.safeParse({ ...valid, frameSeq: "07" }).success).toBe(false);
    expect(frameIdentityV1Schema.safeParse({ ...valid, frameSeq: 7 }).success).toBe(false);
  });

  test("rejects a 64-char hash in the nonce slot", () => {
    expect(frameIdentityV1Schema.safeParse({ ...valid, nonce: SHA }).success).toBe(false);
  });
});

describe("pageRemovePlanV1Schema", () => {
  const valid = {
    pageRemovePlanId: uuidv7(),
    pageSlug: "dashboard",
    sourceHash: SHA,
    orderedPageSlugs: ["dashboard", "settings"],
    pageOrderHash: OTHER_SHA,
    activePageSlug: "dashboard",
    fallbackPageSlug: null,
    planRevision: "12",
  };

  test("accepts the complete plan", () => {
    expect(pageRemovePlanV1Schema.safeParse(valid).success).toBe(true);
  });

  test("requires nullable fields to be explicit null, never omitted", () => {
    const { activePageSlug: _a, ...missingActive } = valid;
    expect(pageRemovePlanV1Schema.safeParse(missingActive).success).toBe(false);
    expect(pageRemovePlanV1Schema.safeParse({ ...valid, activePageSlug: null }).success).toBe(true);
  });

  test("rejects an unknown key", () => {
    expect(pageRemovePlanV1Schema.safeParse({ ...valid, acknowledged: true }).success).toBe(false);
  });

  test("rejects an invalid slug anywhere in the ordered list", () => {
    expect(
      pageRemovePlanV1Schema.safeParse({ ...valid, orderedPageSlugs: ["dashboard", "NOPE"] })
        .success,
    ).toBe(false);
  });
});

describe("pageDescriptorV1Schema", () => {
  test("accepts a ready descriptor", () => {
    const ready = {
      status: "ready",
      pageSlug: "dashboard",
      sourceHash: SHA,
      title: "Dashboard",
      minSize: { w: 80, h: 24 },
      theme: "dark-default",
      kitApiVersion: 1,
    };
    expect(pageDescriptorV1Schema.safeParse(ready).success).toBe(true);
  });

  test("accepts an invalid descriptor carrying a bounded safe error", () => {
    const invalid = {
      status: "invalid",
      pageSlug: "dashboard",
      sourceHash: SHA,
      error: { code: "GATE_FAILED", safeMessage: "page contract violated" },
    };
    expect(pageDescriptorV1Schema.safeParse(invalid).success).toBe(true);
  });

  test("rejects a ready descriptor missing its meta fields", () => {
    const partial = { status: "ready", pageSlug: "dashboard", sourceHash: SHA };
    expect(pageDescriptorV1Schema.safeParse(partial).success).toBe(false);
  });

  test("rejects an invalid descriptor that also carries ready-only fields", () => {
    const mixed = {
      status: "invalid",
      pageSlug: "dashboard",
      sourceHash: SHA,
      error: { code: "X", safeMessage: "y" },
      title: "Dashboard",
    };
    expect(pageDescriptorV1Schema.safeParse(mixed).success).toBe(false);
  });
});

describe("pageDescriptorChangeV1Schema", () => {
  test("accepts each change kind with its explicit before/after binding", () => {
    for (const kind of ["added", "updated", "removed", "reordered"]) {
      const change = {
        pageSlug: "dashboard",
        kind,
        beforeSourceHash: kind === "added" ? null : SHA,
        afterSourceHash: kind === "removed" ? null : OTHER_SHA,
      };
      expect(pageDescriptorChangeV1Schema.safeParse(change).success).toBe(true);
    }
  });

  test("rejects an omitted hash binding — nullable means explicit null", () => {
    const change = { pageSlug: "dashboard", kind: "updated", afterSourceHash: OTHER_SHA };
    expect(pageDescriptorChangeV1Schema.safeParse(change).success).toBe(false);
  });

  test("rejects an unknown change kind", () => {
    const change = {
      pageSlug: "dashboard",
      kind: "renamed",
      beforeSourceHash: SHA,
      afterSourceHash: OTHER_SHA,
    };
    expect(pageDescriptorChangeV1Schema.safeParse(change).success).toBe(false);
  });
});

describe("pinDtoV1Schema", () => {
  const valid = {
    pinId: uuidv7(),
    pageSlug: "dashboard",
    elementId: "header",
    fx: 0.5,
    fy: 0.25,
    text: "tighten this",
    status: "open",
    createdRecordId: uuidv7(),
    latestRecordId: uuidv7(),
    updatedAt: "2026-07-21T10:00:00Z",
  };

  test("accepts the complete pin", () => {
    expect(pinDtoV1Schema.safeParse(valid).success).toBe(true);
  });

  test("constrains fractions to the closed unit interval", () => {
    expect(pinDtoV1Schema.safeParse({ ...valid, fx: 1 }).success).toBe(true);
    expect(pinDtoV1Schema.safeParse({ ...valid, fx: 0 }).success).toBe(true);
    expect(pinDtoV1Schema.safeParse({ ...valid, fx: 1.0001 }).success).toBe(false);
    expect(pinDtoV1Schema.safeParse({ ...valid, fy: -0.1 }).success).toBe(false);
  });

  test("rejects a non-finite fraction", () => {
    expect(pinDtoV1Schema.safeParse({ ...valid, fx: Number.NaN }).success).toBe(false);
    expect(pinDtoV1Schema.safeParse({ ...valid, fy: Number.POSITIVE_INFINITY }).success).toBe(
      false,
    );
  });

  test("rejects an unknown status", () => {
    expect(pinDtoV1Schema.safeParse({ ...valid, status: "archived" }).success).toBe(false);
  });

  test("requires an RFC3339 UTC timestamp", () => {
    expect(pinDtoV1Schema.safeParse({ ...valid, updatedAt: "2026-07-21" }).success).toBe(false);
  });
});

describe("diagnosticDtoV1Schema", () => {
  const valid = {
    diagnosticId: uuidv7(),
    scope: "turn",
    severity: "warning",
    code: "UNGUARDED_TIMER",
    safeMessage: "timer is not guarded by the export flag",
  };

  test("accepts a diagnostic without the optional page binding", () => {
    expect(diagnosticDtoV1Schema.safeParse(valid).success).toBe(true);
  });

  test("accepts the optional page/source binding", () => {
    const bound = { ...valid, pageSlug: "dashboard", sourceHash: SHA };
    expect(diagnosticDtoV1Schema.safeParse(bound).success).toBe(true);
  });

  test("rejects an unknown scope or severity", () => {
    expect(diagnosticDtoV1Schema.safeParse({ ...valid, scope: "network" }).success).toBe(false);
    expect(diagnosticDtoV1Schema.safeParse({ ...valid, severity: "fatal" }).success).toBe(false);
  });

  test("rejects an unknown key — no native error may ride along", () => {
    expect(diagnosticDtoV1Schema.safeParse({ ...valid, stack: "at foo()" }).success).toBe(false);
  });
});
