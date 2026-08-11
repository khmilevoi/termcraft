import { describe, expect, test } from "bun:test";
import crypto from "node:crypto";

import type { PackageFile } from "../types";
import {
  DESIGN_SYSTEM_PACKAGE_V1_PREFIX,
  DuplicatePackageFileError,
  designSystemContentHash,
  encodeDesignSystemPackageV1,
  normalizePackageRelPath,
} from "./content-hash";

const utf8 = (text: string) => new TextEncoder().encode(text);

const PACKAGE: readonly PackageFile[] = [
  { relPath: "design-system.json", bytes: utf8('{"id":"midnight"}') },
  { relPath: "components/Button.tsx", bytes: utf8("export const Button = () => null\n") },
  { relPath: "tokens.ts", bytes: utf8("export {}\n") },
];

/** Pinned in Step 5 by running this file once and copying the printed digest. */
const MIDNIGHT_CONTENT_HASH = "b6aa8e7a7e0ad1ead9ddd9dde8a4bf724d74fd260e7ff592c5401d82726b3cc8";

function hashOf(files: readonly PackageFile[]) {
  const hash = designSystemContentHash(files);
  if (hash instanceof Error) throw hash;
  return hash;
}

describe("designSystemContentHash", () => {
  test("is a lowercase-hex sha256", () => {
    expect(hashOf(PACKAGE)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("is the sha256 of the complete encoded byte string", () => {
    const encoded = encodeDesignSystemPackageV1(PACKAGE);
    if (encoded instanceof Error) throw encoded;
    expect(crypto.createHash("sha256").update(encoded).digest("hex")).toBe(hashOf(PACKAGE));
  });

  test("starts with the ASCII prefix plus exactly one NUL byte, then the file count", () => {
    const encoded = encodeDesignSystemPackageV1(PACKAGE);
    if (encoded instanceof Error) throw encoded;
    const buf = Buffer.from(encoded);
    const prefix = Buffer.from(DESIGN_SYSTEM_PACKAGE_V1_PREFIX, "utf8");
    expect(buf.subarray(0, prefix.length).toString("utf8")).toBe(
      "termcraft-design-system-package-v1",
    );
    expect(buf[prefix.length]).toBe(0x00);
    expect(buf.readUInt32BE(prefix.length + 1)).toBe(3);
  });

  test("does not depend on the order the files were walked in", () => {
    expect(hashOf([...PACKAGE].reverse())).toBe(hashOf(PACKAGE));
  });

  test("changes when one byte of one file changes", () => {
    const mutated = PACKAGE.map((file) =>
      file.relPath === "tokens.ts" ? { ...file, bytes: utf8("export {} \n") } : file,
    );
    expect(hashOf(mutated)).not.toBe(hashOf(PACKAGE));
  });

  test("changes when a file is renamed but its bytes are not", () => {
    const renamed = PACKAGE.map((file) =>
      file.relPath === "tokens.ts" ? { ...file, relPath: "token.ts" } : file,
    );
    expect(hashOf(renamed)).not.toBe(hashOf(PACKAGE));
  });

  test("changes when a file is added or removed", () => {
    expect(hashOf(PACKAGE.slice(0, 2))).not.toBe(hashOf(PACKAGE));
  });

  test("an empty package still hashes, and differs from every non-empty one", () => {
    expect(hashOf([])).toMatch(/^[0-9a-f]{64}$/);
    expect(hashOf([])).not.toBe(hashOf(PACKAGE));
  });

  test("two spellings of one path are a duplicate, not a silently-dropped file", () => {
    expect(
      designSystemContentHash([
        { relPath: "tokens.ts", bytes: utf8("a") },
        { relPath: "./tokens.ts", bytes: utf8("b") },
      ]),
    ).toBeInstanceOf(DuplicatePackageFileError);
  });

  test("is stable across calls and across the pinned vector", () => {
    expect(hashOf(PACKAGE)).toBe(hashOf(PACKAGE));
    expect(hashOf(PACKAGE)).toBe(MIDNIGHT_CONTENT_HASH);
  });
});

describe("normalizePackageRelPath", () => {
  test("uses forward separators, drops a leading ./ and any surrounding separators", () => {
    expect(normalizePackageRelPath("components\\Button.tsx")).toBe("components/Button.tsx");
    expect(normalizePackageRelPath("./tokens.ts")).toBe("tokens.ts");
    expect(normalizePackageRelPath("/tokens.ts")).toBe("tokens.ts");
  });

  test("normalizes to NFC so two spellings of one filename hash alike", () => {
    const nfc = "prö.ts";
    expect(normalizePackageRelPath(nfc.normalize("NFD"))).toBe(nfc);
  });
});
