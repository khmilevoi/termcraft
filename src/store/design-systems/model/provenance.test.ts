import { expect, test } from "bun:test";

import { parseDesignSystemRef } from "entities/design-system-ref";

import {
  DESIGN_SYSTEM_PROVENANCE_FILENAME,
  DESIGN_SYSTEM_PROVENANCE_SCHEMA_VERSION,
  DesignSystemProvenanceInvalidError,
  decodeDesignSystemProvenance,
  encodeDesignSystemProvenance,
} from "./provenance";

const REF = parseDesignSystemRef("local:midnight@1.2.0");
const HASH = "a".repeat(64);

function record() {
  if (REF instanceof Error) throw REF;
  return {
    schemaVersion: DESIGN_SYSTEM_PROVENANCE_SCHEMA_VERSION,
    ref: REF,
    contentHash: HASH,
    installedAt: "2026-08-12T10:00:00.000Z",
  } as const;
}

test("the file sits at the top of `.termcraft/`, never inside `design/`", () => {
  expect(DESIGN_SYSTEM_PROVENANCE_FILENAME).toBe("design-system-source.json");
  expect(DESIGN_SYSTEM_PROVENANCE_FILENAME).not.toContain("/");
});

test("round-trips through encode/decode", () => {
  const decoded = decodeDesignSystemProvenance(encodeDesignSystemProvenance(record()));
  expect(decoded).toEqual(record());
});

test("the reference is stored as its canonical `source:system@version` text", () => {
  const text = new TextDecoder().decode(encodeDesignSystemProvenance(record()));
  expect(JSON.parse(text) as unknown).toMatchObject({ ref: "local:midnight@1.2.0" });
});

test("a newer schemaVersion is rejected, never silently accepted", () => {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ ...record(), ref: "local:midnight@1.2.0", schemaVersion: 2 }),
  );
  expect(decodeDesignSystemProvenance(bytes)).toBeInstanceOf(DesignSystemProvenanceInvalidError);
});

test("an unparseable reference is rejected", () => {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ ...record(), ref: "not a reference", schemaVersion: 1 }),
  );
  expect(decodeDesignSystemProvenance(bytes)).toBeInstanceOf(DesignSystemProvenanceInvalidError);
});

test("an unknown key is rejected (strictObject)", () => {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ ...record(), ref: "local:midnight@1.2.0", installedBy: "someone" }),
  );
  expect(decodeDesignSystemProvenance(bytes)).toBeInstanceOf(DesignSystemProvenanceInvalidError);
});

test("a non-hex content hash is rejected", () => {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ ...record(), ref: "local:midnight@1.2.0", contentHash: "zz" }),
  );
  expect(decodeDesignSystemProvenance(bytes)).toBeInstanceOf(DesignSystemProvenanceInvalidError);
});
