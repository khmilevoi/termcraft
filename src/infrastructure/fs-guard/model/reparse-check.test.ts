import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { FileAttributesError } from "./errors";
import { isReparsePoint } from "./reparse-check";

const onWindows = process.platform === "win32";

describe.skipIf(!onWindows)("isReparsePoint (Windows)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "termcraft-reparse-"));

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("a plain directory is not a reparse point", () => {
    const dir = path.join(root, "plain");
    fs.mkdirSync(dir);
    expect(isReparsePoint(dir)).toBe(false);
  });

  test("a junction is detected as a reparse point", () => {
    const target = path.join(root, "target");
    fs.mkdirSync(target);
    const link = path.join(root, "junction");
    // `junction` type does not require elevation on Windows (Spike F).
    fs.symlinkSync(target, link, "junction");
    expect(isReparsePoint(link)).toBe(true);
  });

  test("a missing path returns a typed attribute error", () => {
    const result = isReparsePoint(path.join(root, "nope"));
    expect(result).toBeInstanceOf(FileAttributesError);
  });
});
