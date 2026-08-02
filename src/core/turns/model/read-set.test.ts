import { describe, expect, test } from "bun:test";

import type { StagedTurnReadSetV1 } from "core/ports";
import { type PageSlug, parsePageSlug } from "entities/page";

import { ReadSetTranslationError, toFinalizeReadSet } from "./read-set";

function slug(value: string): PageSlug {
  const parsed = parsePageSlug(value);
  if (parsed instanceof Error) throw parsed;
  return parsed;
}

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

/**
 * `relPath` values below are deliberately generic tree-relative paths, not
 * `pages/<slug>.tsx` shapes — `designFiles` is keyed by relPath directly (no page identity
 * involved at all any more), so a fixture coupling relPath to a page slug would prove
 * nothing about this translation's own contract.
 */
function staged(overrides: Partial<StagedTurnReadSetV1> = {}): StagedTurnReadSetV1 {
  return {
    manifest: { sha256: SHA_A, size: 120 },
    designFiles: [{ relPath: "lib/theme.ts", snapshot: { sha256: SHA_B, size: 400 } }],
    chat: { length: 2048, prefixSha256: SHA_C },
    pins: [{ pageSlug: slug("home"), base: { length: 64, prefixSha256: SHA_A } }],
    ...overrides,
  };
}

describe("toFinalizeReadSet", () => {
  test("translates a populated read set field for field", () => {
    const result = toFinalizeReadSet(staged());
    if (result instanceof Error) throw result;

    expect(result.manifest).toEqual({ state: "file", sha256: SHA_A, size: 120 });
    expect(result.designFiles.get("lib/theme.ts")).toEqual({
      state: "file",
      sha256: SHA_B,
      size: 400,
    });
    expect(result.chat).toEqual({ length: 2048, prefixSha256: SHA_C });
    expect(result.pins.get(slug("home"))).toEqual({ length: 64, prefixSha256: SHA_A });
  });

  test("a null snapshot becomes an explicit absent image, never a dropped entry", () => {
    // The two shapes encode "this file does not exist" differently: staging uses `null`,
    // finalization uses `{state:"absent"}`. Dropping the entry instead would turn "I
    // checked, and it was absent" into "I never checked" — and the final CAS would then
    // silently permit a file that appeared mid-turn.
    const result = toFinalizeReadSet(
      staged({
        manifest: null,
        designFiles: [{ relPath: "lib/theme.ts", snapshot: null }],
      }),
    );
    if (result instanceof Error) throw result;

    expect(result.manifest).toEqual({ state: "absent" });
    expect(result.designFiles.has("lib/theme.ts")).toBe(true);
    expect(result.designFiles.get("lib/theme.ts")).toEqual({ state: "absent" });
  });

  test("is TOTAL over both arrays — every entry survives", () => {
    // A dropped entry silently weakens the CAS: the drifted file is simply never compared.
    const relPaths = ["lib/theme.ts", "screens/landing.tsx", "content/pricing.mdx", "notes.md"];
    const pinPages = ["home", "about", "pricing", "contact"] as const;
    const result = toFinalizeReadSet(
      staged({
        designFiles: relPaths.map((relPath) => ({
          relPath,
          snapshot: { sha256: SHA_B, size: 1 },
        })),
        pins: pinPages.map((p) => ({
          pageSlug: slug(p),
          base: { length: 1, prefixSha256: SHA_C },
        })),
      }),
    );
    if (result instanceof Error) throw result;

    expect(result.designFiles.size).toBe(relPaths.length);
    expect(result.pins.size).toBe(pinPages.length);
    for (const relPath of relPaths) {
      expect(result.designFiles.has(relPath), `file ${relPath} was dropped`).toBe(true);
    }
    for (const p of pinPages) {
      expect(result.pins.has(slug(p)), `pins for ${p} were dropped`).toBe(true);
    }
  });

  test("a duplicate relPath is an ERROR, not a silently collapsed Map entry", () => {
    // This is the hazard of array -> Map: `new Map(pairs)` keeps the LAST duplicate and
    // discards the rest without a sound. If the two entries disagreed, the CAS would
    // silently compare against the wrong image; if they agreed, the input was already
    // malformed. Either way it must surface rather than be normalized away.
    const duplicated = toFinalizeReadSet(
      staged({
        designFiles: [
          { relPath: "lib/theme.ts", snapshot: { sha256: SHA_A, size: 1 } },
          { relPath: "lib/theme.ts", snapshot: { sha256: SHA_B, size: 2 } },
        ],
      }),
    );
    expect(duplicated).toBeInstanceOf(ReadSetTranslationError);
    // Asserting only `toBeInstanceOf` would still pass for the WRONG message (or one naming the
    // wrong label/key) — the message is what actually tells an operator which array and which
    // key collided (task-13 review round 1, Minor M8).
    expect((duplicated as ReadSetTranslationError).message).toBe(
      'cannot translate the staged read set: designFiles lists "lib/theme.ts" more than once',
    );
  });

  test("a duplicate pins slug is an error too", () => {
    const duplicated = toFinalizeReadSet(
      staged({
        pins: [
          { pageSlug: slug("home"), base: { length: 1, prefixSha256: SHA_A } },
          { pageSlug: slug("home"), base: { length: 2, prefixSha256: SHA_B } },
        ],
      }),
    );
    expect(duplicated).toBeInstanceOf(ReadSetTranslationError);
    expect((duplicated as ReadSetTranslationError).message).toBe(
      'cannot translate the staged read set: pins lists "home" more than once',
    );
  });

  test("empty arrays translate to empty maps, not to a missing read set", () => {
    const result = toFinalizeReadSet(staged({ designFiles: [], pins: [] }));
    if (result instanceof Error) throw result;

    expect(result.designFiles.size).toBe(0);
    expect(result.pins.size).toBe(0);
    // The manifest and chat halves are unaffected by empty file/pin sets.
    expect(result.manifest).toEqual({ state: "file", sha256: SHA_A, size: 120 });
    expect(result.chat).toEqual({ length: 2048, prefixSha256: SHA_C });
  });

  test("the translation copies values, so mutating the input afterwards cannot change it", () => {
    // The staged set comes from a port; nothing guarantees the caller stops holding it.
    const files = [{ relPath: "lib/theme.ts", snapshot: { sha256: SHA_B, size: 400 } }];
    const input = staged({ designFiles: files });
    const result = toFinalizeReadSet(input);
    if (result instanceof Error) throw result;

    // Mutate the array the input still references.
    (files as { relPath: string; snapshot: { sha256: string; size: number } | null }[]).push({
      relPath: "screens/landing.tsx",
      snapshot: null,
    });

    expect(result.designFiles.size).toBe(1);
    expect(result.designFiles.has("screens/landing.tsx")).toBe(false);
  });
});
