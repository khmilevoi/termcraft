import { describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";

import { QuarantineFailedError } from "store/design-systems";
import { JsonlMidFileCorruptionError } from "store/jsonl";
import {
  ChatMutationLockedError,
  SourceChangedError,
  TurnAlreadyTerminalError,
  TurnFinalizeInputError,
  TurnRecordNotFoundError,
} from "store/transaction";

import { toFailureDto } from "./failure";

// Five store tagged errors that used to have no `instanceof` branch in `toFailureDto` and
// therefore fell through to the final "unmapped store error" catch-all (`failure.ts`'s own
// header: "a KNOWN store error must never reach it"). Falling through is invisible in the
// returned `code` alone — the catch-all folds to the SAME `PERSISTENCE_FAILED` a real branch
// would — so every case here asserts the real discriminator: the catch-all's
// `console.warn("store/adapters: unmapped store error folded to PERSISTENCE_FAILED:", ...)`
// must NOT fire for a error this mapper is supposed to recognize.
describe("toFailureDto — known store errors that must not reach the unmapped catch-all", () => {
  test("JsonlMidFileCorruptionError (store/jsonl) maps to PERSISTENCE_FAILED without the catch-all console.warn firing", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const error = new JsonlMidFileCorruptionError({
        path: "chats/chat-1.jsonl",
        offset: 42,
        reason: "invalid JSON",
      });
      const dto = toFailureDto(error);
      expect(dto.code).toBe("PERSISTENCE_FAILED");
      expect(dto.retryable).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("QuarantineFailedError (store/design-systems, M1) maps to PERSISTENCE_FAILED without the catch-all console.warn firing", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      // An ordinary mkdir/write/read-back fault from `admitPackageThroughQuarantine`
      // (`store/design-systems/model/quarantine.ts`) — never a limit refusal, which
      // `store/adapters/design-system-install.ts`'s `quarantineFailureDto` intercepts before
      // `toFailureDto` ever sees this error.
      const error = new QuarantineFailedError({
        stage: "stage",
        path: "design-systems/quarantine/install-1/staging/design/system/tokens.ts",
        reason: "ENOSPC: no space left on device",
      });
      const dto = toFailureDto(error);
      expect(dto.code).toBe("PERSISTENCE_FAILED");
      expect(dto.retryable).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("ChatMutationLockedError (store/transaction) maps to PERSISTENCE_FAILED without the catch-all console.warn firing", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const error = new ChatMutationLockedError({ path: "chats/chat-1.jsonl" });
      const dto = toFailureDto(error);
      expect(dto.code).toBe("PERSISTENCE_FAILED");
      expect(dto.retryable).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("TurnFinalizeInputError (store/transaction) maps to PERSISTENCE_FAILED without the catch-all console.warn firing", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const error = new TurnFinalizeInputError({ reason: "replace op with no bytes" });
      const dto = toFailureDto(error);
      expect(dto.code).toBe("PERSISTENCE_FAILED");
      expect(dto.retryable).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("TurnRecordNotFoundError (store/transaction) maps to PERSISTENCE_FAILED without the catch-all console.warn firing", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const error = new TurnRecordNotFoundError({ turnId: "turn-1", targetChatId: "chat-1" });
      const dto = toFailureDto(error);
      expect(dto.code).toBe("PERSISTENCE_FAILED");
      expect(dto.retryable).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("TurnAlreadyTerminalError (store/transaction) — documented idempotent no-op — maps to PERSISTENCE_FAILED without the catch-all console.warn firing", () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const error = new TurnAlreadyTerminalError({ turnId: "turn-1", targetChatId: "chat-1" });
      const dto = toFailureDto(error);
      expect(dto.code).toBe("PERSISTENCE_FAILED");
      expect(dto.retryable).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

/**
 * `SourceChangedError.part`'s two vocabularies (assigned during task-14 review round 1). The
 * drift landed in `ffd1429`: `wrappers.ts` moved from `` `canonical:${slug}` `` to
 * `` `design:${treeRelPath}` `` and this mapper was never updated, so EVERY CAS drift on a
 * tree file — a normal, expected failure — lost its detail AND printed a `console.warn` the
 * file's own header forbids on an ordinary path. Nothing covered it: before these tests
 * `failure.test.ts` never mentioned `SourceChangedError` at all.
 */
describe("toFailureDto — SourceChangedError's design-tree part vocabulary", () => {
  test('a tree-file drift maps to part:"page" with the TREE-RELATIVE PATH, and warns about nothing', () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const dto = toFailureDto(new SourceChangedError({ part: "design:screens/landing/main.tsx" }));
      expect(dto.code).toBe("APPLY_SOURCE_CHANGED");
      // `relPath`, NOT `slug`: `design:` carries a path, and `design/pages.json` binds slugs to
      // paths in a direction this mapper cannot invert. Writing a path into a field named
      // `slug` is the trap a naive `startsWith("design:")` fix would have fallen into.
      expect(dto.details).toEqual({ part: "page", relPath: "screens/landing/main.tsx" });
      // The real discriminator for "this branch was actually taken": the fallback warns.
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('a manifest drift still maps to part:"manifest" with no extra detail', () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const dto = toFailureDto(new SourceChangedError({ part: "manifest" }));
      expect(dto.details).toEqual({ part: "manifest" });
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('an UNRECOGNIZED part still falls back to part:"page" AND warns — the guard is not merely widened', () => {
    // The companion that keeps the fix honest: matching `design:` must not turn the fallback
    // into dead code. A future third vocabulary must still be loud rather than silent.
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const dto = toFailureDto(new SourceChangedError({ part: "canonical:home" }));
      expect(dto.details).toEqual({ part: "page" });
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("every part `store/transaction` actually constructs is recognized", () => {
    // Pins the mapper against its one producer rather than against a remembered list — this is
    // the check whose absence let `ffd1429` drift unnoticed.
    const source = fs.readFileSync("src/store/transaction/model/wrappers.ts", "utf8");
    const constructed = [
      ...source.matchAll(/new SourceChangedError\(\{ part: ([`"])([^`"$]*)/g),
    ].map((m) => m[2] ?? "");
    // Both shapes appear: a COMPLETE literal (`"manifest"`) and a PREFIX before an
    // interpolation (`` `design:${treeRelPath}` ``). A prefix needs a sample value appended;
    // a complete literal must be used verbatim, or the test manufactures an input its own
    // producer never builds.
    const parts = constructed.map((p) => (p.endsWith(":") ? `${p}screens/landing/main.tsx` : p));
    expect(parts).toEqual(expect.arrayContaining(["manifest"]));
    expect(parts.some((p) => p.startsWith("design:"))).toBe(true);
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const part of parts) toFailureDto(new SourceChangedError({ part }));
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
