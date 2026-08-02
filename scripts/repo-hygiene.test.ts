import { describe, expect, test } from "bun:test";
import fs from "node:fs";

/**
 * A raw NUL in a tracked source makes `grep`/ripgrep classify the file as BINARY: they print
 * "Binary file … matches" instead of the matching lines. Every review, audit and codemod sweep
 * in this repository is grep-driven, so such a file is silently invisible to all of them —
 * which is how two of them survived a seventeen-task plan. Pinned as a test rather than a
 * lint rule because oxlint has no such rule and because the failure mode is about tooling
 * that reads the repository, not about the code's own semantics.
 *
 * `grep -qP '\x00'` does NOT detect this reliably (measured: it reported zero files while two
 * demonstrably had them). Counting the bytes is what works.
 */
describe("repository hygiene", () => {
  test("no tracked TypeScript source contains a raw NUL byte", () => {
    const listed = Bun.spawnSync(["git", "ls-files", "*.ts", "*.tsx"], { stdout: "pipe" });
    expect(listed.exitCode).toBe(0);

    const paths = listed.stdout
      .toString()
      .split("\n")
      .filter((line) => line.length > 0);
    expect(paths.length).toBeGreaterThan(100);

    const offenders: string[] = [];
    for (const path of paths) {
      const bytes = fs.readFileSync(path);
      if (bytes.includes(0)) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });
});
