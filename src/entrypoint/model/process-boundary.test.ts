import { describe, expect, test } from "bun:test";

import type { ShutdownSignal } from "../types";
import { createProcessBoundary } from "./process-boundary";

describe("createProcessBoundary", () => {
  test("registers each shutdown signal once on the target process", () => {
    const registered: ShutdownSignal[] = [];
    const boundary = createProcessBoundary({
      once: (signal) => registered.push(signal),
    });

    boundary.onSignal("SIGINT", () => undefined);
    boundary.onSignal("SIGTERM", () => undefined);

    expect(registered).toEqual(["SIGINT", "SIGTERM"]);
  });

  test("forwards the registered handler to the caller's callback", () => {
    const captured: (() => void)[] = [];
    const boundary = createProcessBoundary({
      once: (_signal, handler) => captured.push(handler),
    });

    let fired = 0;
    boundary.onSignal("SIGINT", () => fired++);
    captured[0]?.();

    expect(fired).toBe(1);
  });
});
