import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
  parseDesignSystemId,
  parseDesignSystemVersion,
  parseSourceId,
} from "entities/design-system-ref";

import {
  LOCAL_SOURCE_ID,
  cacheEntryDir,
  cacheEntryRecordPath,
  cachePackageDir,
  cacheRootDir,
  decodeSourceIdSegment,
  designSystemsRoot,
  encodeSourceIdSegment,
  localLibraryDir,
  localSystemDir,
  sourcesConfigPath,
} from "./layout";

const ROOT = path.join("C:", "Users", "alice", "AppData", "Local", "termcraft");

function systemId(raw: string) {
  const id = parseDesignSystemId(raw);
  if (id instanceof Error) throw id;
  return id;
}
function version(raw: string) {
  const v = parseDesignSystemVersion(raw);
  if (v instanceof Error) throw v;
  return v;
}
function sourceId(raw: string) {
  const s = parseSourceId(raw);
  if (s instanceof Error) throw s;
  return s;
}

describe("the design-system library layout (design §8.2)", () => {
  test("sits under {userStateRoot}/design-systems, beside trust/ and sandboxes/", () => {
    expect(designSystemsRoot(ROOT)).toBe(path.join(ROOT, "design-systems"));
  });

  test("sources.json is at the library root", () => {
    expect(sourcesConfigPath(ROOT)).toBe(path.join(ROOT, "design-systems", "sources.json"));
  });

  test("the designer's own systems live at local/<systemId>/", () => {
    expect(localLibraryDir(ROOT)).toBe(path.join(ROOT, "design-systems", "local"));
    expect(localSystemDir(ROOT, systemId("midnight"))).toBe(
      path.join(ROOT, "design-systems", "local", "midnight"),
    );
  });

  test("a cache entry is keyed by source, system and version", () => {
    expect(cacheRootDir(ROOT)).toBe(path.join(ROOT, "design-systems", "cache"));
    expect(cacheEntryDir(ROOT, LOCAL_SOURCE_ID, systemId("midnight"), version("1.2.0"))).toBe(
      path.join(ROOT, "design-systems", "cache", "local", "midnight@1.2.0"),
    );
  });

  test("the record sits beside the package, never inside the bytes it describes", () => {
    const entry = cacheEntryDir(ROOT, LOCAL_SOURCE_ID, systemId("midnight"), version("1.2.0"));
    expect(cachePackageDir(ROOT, LOCAL_SOURCE_ID, systemId("midnight"), version("1.2.0"))).toBe(
      path.join(entry, "package"),
    );
    expect(
      cacheEntryRecordPath(ROOT, LOCAL_SOURCE_ID, systemId("midnight"), version("1.2.0")),
    ).toBe(path.join(entry, "entry.json"));
  });
});

describe("encodeSourceIdSegment", () => {
  test("a bare source id is its own segment", () => {
    expect(encodeSourceIdSegment(sourceId("local"))).toBe("local");
  });

  test("a locator-bearing source id percent-encodes its colon and slashes", () => {
    expect(encodeSourceIdSegment(sourceId("github:acme/design-systems"))).toBe(
      "github%3Aacme%2Fdesign-systems",
    );
  });

  test("no segment ever contains a path separator or a colon", () => {
    const segment = encodeSourceIdSegment(sourceId("github:acme/design-systems"));
    expect(segment).not.toContain("/");
    expect(segment).not.toContain("\\");
    expect(segment).not.toContain(":");
  });

  test("round-trips through decodeSourceIdSegment", () => {
    for (const raw of ["local", "github:acme/design-systems"]) {
      expect(decodeSourceIdSegment(encodeSourceIdSegment(sourceId(raw)))).toBe(raw as never);
    }
  });

  test("a segment that does not decode to a legal source id is an error, not a guess", () => {
    expect(decodeSourceIdSegment("%%%")).toBeInstanceOf(Error);
    expect(decodeSourceIdSegment("NotASource")).toBeInstanceOf(Error);
  });
});
