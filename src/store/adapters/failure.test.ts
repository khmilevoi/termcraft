import { describe, expect, spyOn, test } from "bun:test";

import { JsonlMidFileCorruptionError } from "store/jsonl";
import {
  ChatMutationLockedError,
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
