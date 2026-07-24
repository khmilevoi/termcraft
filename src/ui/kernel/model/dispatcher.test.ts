import { describe, expect, test } from "bun:test";

import type { CommandResultV1 } from "core/protocol";
import { isCanonicalUuidv7, uuidv7 } from "infrastructure/uuid";

import { KernelDispatchError, createDispatcher } from "./dispatcher";

/** A minimal recording port double: captures the raw envelope, returns a canned result. */
function recordingPort(result: Promise<Error | CommandResultV1>) {
  const seen: unknown[] = [];
  return {
    seen,
    dispatch(raw: unknown): Promise<Error | CommandResultV1> {
      seen.push(raw);
      return result;
    },
  };
}

const accepted = (): CommandResultV1 => ({
  protocolVersion: 1,
  commandId: uuidv7() as CommandResultV1["commandId"],
  status: "accepted",
  acceptedRevision: "7",
  resultingRevision: "8",
  disposition: "completed",
});

describe("createDispatcher (phase-7 plan D4)", () => {
  test("builds a well-formed raw CommandEnvelopeV1 and forwards it to the port", async () => {
    const port = recordingPort(Promise.resolve(accepted()));
    const dispatcher = createDispatcher({ port, revision: () => "42" });

    await dispatcher.dispatch("turn.start", { text: "make a dashboard" });

    expect(port.seen).toHaveLength(1);
    const raw = port.seen[0] as Record<string, unknown>;
    expect(raw.protocolVersion).toBe(1);
    expect(typeof raw.commandId).toBe("string");
    expect(isCanonicalUuidv7(raw.commandId as string)).toBe(true);
    expect(raw.expectedRevision).toBe("42");
    expect(raw.kind).toBe("turn.start");
    expect(raw.payload).toEqual({ text: "make a dashboard" });
  });

  test("mints a fresh commandId per intent", async () => {
    const port = recordingPort(Promise.resolve(accepted()));
    const dispatcher = createDispatcher({ port, revision: () => "1" });

    await dispatcher.dispatch("chat.create", {});
    await dispatcher.dispatch("chat.create", {});

    const [a, b] = port.seen as Record<string, unknown>[];
    expect(a?.commandId).not.toBe(b?.commandId);
  });

  test("reads the revision fresh on each dispatch", async () => {
    let rev = "3";
    const port = recordingPort(Promise.resolve(accepted()));
    const dispatcher = createDispatcher({ port, revision: () => rev });

    await dispatcher.dispatch("chat.create", {});
    rev = "9";
    await dispatcher.dispatch("chat.create", {});

    const [a, b] = port.seen as Record<string, unknown>[];
    expect(a?.expectedRevision).toBe("3");
    expect(b?.expectedRevision).toBe("9");
  });

  test("returns a rejected result unchanged (a rejection is a value, not an error)", async () => {
    const rejected: CommandResultV1 = {
      protocolVersion: 1,
      commandId: uuidv7() as CommandResultV1["commandId"],
      status: "rejected",
      currentRevision: "5",
      code: "TURN_RUNNING",
      reasons: [{ code: "TURN_RUNNING", turnId: uuidv7() as never }],
    };
    const port = recordingPort(Promise.resolve(rejected));
    const dispatcher = createDispatcher({ port, revision: () => "5" });

    const result = await dispatcher.dispatch("export.start", {});
    expect(result).toBe(rejected);
  });

  test("wraps a thrown port rejection into KernelDispatchError with its cause", async () => {
    const boom = new Error("adapter exploded");
    const port = recordingPort(Promise.reject(boom));
    const dispatcher = createDispatcher({ port, revision: () => "1" });

    const result = await dispatcher.dispatch("chat.create", {});
    expect(result).toBeInstanceOf(KernelDispatchError);
    expect((result as KernelDispatchError).cause).toBe(boom);
  });
});
