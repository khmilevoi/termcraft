import { describe, expect, test } from "bun:test";

import {
  InvalidDesignSystemRefError,
  designSystemRefSchema,
  formatDesignSystemRef,
  parseDesignSystemId,
  parseDesignSystemRef,
  parseDesignSystemVersion,
  parseSourceId,
} from "./ref";

describe("parseDesignSystemRef — the two spellings of §8.1", () => {
  test("a bare source id splits at the first colon", () => {
    const ref = parseDesignSystemRef("local:midnight@1.2.0");
    expect(ref).not.toBeInstanceOf(Error);
    expect(ref).toEqual({ sourceId: "local", systemId: "midnight", version: "1.2.0" } as never);
  });

  test("a locator-bearing source id splits at the hash", () => {
    const ref = parseDesignSystemRef("github:acme/design-systems#midnight@1.3.0");
    expect(ref).toEqual({
      sourceId: "github:acme/design-systems",
      systemId: "midnight",
      version: "1.3.0",
    } as never);
  });

  test("the version splits at the LAST @, so a system id may not hide one", () => {
    // "a@b" is not a legal system id, so this must be rejected rather than mis-split.
    expect(parseDesignSystemRef("local:a@b@1.0.0")).toBeInstanceOf(InvalidDesignSystemRefError);
  });
});

describe("formatDesignSystemRef — round trip", () => {
  test("round-trips both canonical spellings byte for byte", () => {
    for (const text of ["local:midnight@1.2.0", "github:acme/design-systems#midnight@1.3.0"]) {
      const ref = parseDesignSystemRef(text);
      expect(ref).not.toBeInstanceOf(Error);
      if (ref instanceof Error) return;
      expect(formatDesignSystemRef(ref)).toBe(text);
    }
  });

  test("normalizes the non-canonical hash spelling of a bare source id", () => {
    const ref = parseDesignSystemRef("local#midnight@1.2.0");
    expect(ref).not.toBeInstanceOf(Error);
    if (ref instanceof Error) return;
    expect(formatDesignSystemRef(ref)).toBe("local:midnight@1.2.0");
  });

  test("parse(format(ref)) is the identical ref", () => {
    const ref = parseDesignSystemRef("github:acme/design-systems#midnight@1.3.0");
    if (ref instanceof Error) throw ref;
    expect(parseDesignSystemRef(formatDesignSystemRef(ref))).toEqual(ref);
  });
});

describe("parseDesignSystemRef — rejections", () => {
  const rejected = [
    "",
    "midnight@1.2.0", // no source
    "local:midnight", // no version
    "local:@1.2.0", // empty system id
    "local:midnight@", // empty version
    "local:midnight@1.2", // not MAJOR.MINOR.PATCH
    "local:midnight@1.2.0-beta.1", // prerelease is out of scope
    "local:Midnight@1.2.0", // uppercase system id
    "local:con@1.2.0", // reserved Windows device name — it is a directory name
    "LOCAL:midnight@1.2.0", // uppercase source id
    "local:midnight@01.2.0", // leading zero
  ];
  for (const text of rejected) {
    test(`rejects ${JSON.stringify(text)}`, () => {
      expect(parseDesignSystemRef(text)).toBeInstanceOf(InvalidDesignSystemRefError);
    });
  }
});

describe("the three component parsers", () => {
  test("a source id may carry a locator after its colon", () => {
    expect(parseSourceId("github:acme/design-systems")).toBe("github:acme/design-systems" as never);
    expect(parseSourceId("local")).toBe("local" as never);
  });

  test("a source id may not carry a second colon, a hash, an @, or a backslash", () => {
    for (const bad of ["a:b:c", "a#b", "a:b@c", "a:b\\c", "nul"]) {
      expect(parseSourceId(bad)).toBeInstanceOf(InvalidDesignSystemRefError);
    }
  });

  test("a system id is a lowercase directory-safe name of at most 32 characters", () => {
    expect(parseDesignSystemId("midnight")).toBe("midnight" as never);
    expect(parseDesignSystemId("a".repeat(32))).toBe("a".repeat(32) as never);
    expect(parseDesignSystemId("a".repeat(33))).toBeInstanceOf(InvalidDesignSystemRefError);
    expect(parseDesignSystemId("-leading")).toBeInstanceOf(InvalidDesignSystemRefError);
  });

  test("a version is exactly MAJOR.MINOR.PATCH", () => {
    expect(parseDesignSystemVersion("0.0.0")).toBe("0.0.0" as never);
    expect(parseDesignSystemVersion("10.20.30")).toBe("10.20.30" as never);
    expect(parseDesignSystemVersion("1.2.0+build")).toBeInstanceOf(InvalidDesignSystemRefError);
  });
});

describe("designSystemRefSchema", () => {
  test("decodes reference TEXT into a parsed ref", () => {
    expect(designSystemRefSchema.parse("local:midnight@1.2.0")).toEqual({
      sourceId: "local",
      systemId: "midnight",
      version: "1.2.0",
    } as never);
  });

  test("fails on an unparseable reference", () => {
    expect(designSystemRefSchema.safeParse("nope").success).toBe(false);
  });
});
