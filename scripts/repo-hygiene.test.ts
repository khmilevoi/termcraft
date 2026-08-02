import { describe, expect, test } from "bun:test";

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
  test("no tracked TypeScript source contains a raw NUL byte", async () => {
    const listed = Bun.spawnSync(["git", "ls-files", "*.ts", "*.tsx"], { stdout: "pipe" });
    expect(listed.exitCode).toBe(0);

    const paths = listed.stdout
      .toString()
      .split("\n")
      .filter((line) => line.length > 0);
    expect(paths.length).toBeGreaterThan(100);

    const offenders: string[] = [];
    for (const path of paths) {
      const bytes = await Bun.file(path).bytes();
      if (bytes.includes(0)) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  }, 120_000); // measured ~70s for a sequential Bun.file().bytes() scan of ~950 files on
  // Windows (vs. ~200ms via a sync read of the same files) — this is Bun's per-file async
  // open overhead on this platform, not a hang; the default 5s bun:test timeout is too
  // short here regardless of the NUL fix below.
});
