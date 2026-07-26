import { describe, expect, spyOn, test } from "bun:test";

import type { AgentInfo } from "agent/types";
import type { ProcessTree } from "infrastructure/process";

import type { HealthProbeReader } from "../types";
import { runHealthProbe } from "./probe";

// No `wait` here deliberately: non-deadline tests below run against the real
// `defaultWait` (20s, never reached), so the deadline-vs-read race is never
// decided by microtask count. Tests that deliberately exercise the deadline
// set `wait: async () => {}` inline instead of relying on this default.
const deps = { abortController: new AbortController(), processTree: null };

describe("runHealthProbe classification", () => {
  test("passes a vendor verdict through unchanged", async () => {
    const verdict = { backendId: "x", health: { status: "ready" as const }, account: null };
    expect(await runHealthProbe("x", async () => verdict, deps)).toEqual(verdict);
  });

  test("a vendor verdict with a mismatched backendId is substituted, logged, and otherwise passed through", async () => {
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const verdict = {
        backendId: "wrong-id",
        health: { status: "ready" as const },
        account: null,
      };
      const info = await runHealthProbe("x", async () => verdict, deps);
      expect(info).toEqual({ backendId: "x", health: { status: "ready" }, account: null });
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  // finding §2.7 (phase-8 Task 15): a clean close with no verdict proves NOTHING — it must not
  // claim an explicit auth failure any more than a deadline timeout may (see the deadline test
  // below). `unhealthy-unconfirmed-exit` is the honest "we could not confirm" bucket.
  test("a clean close with no verdict is unhealthy-unconfirmed-exit, never ready, and reports account: null", async () => {
    const info = await runHealthProbe("x", async () => null, deps);
    expect(info.health).toEqual({ status: "unhealthy-unconfirmed-exit" });
    expect(info.account).toBeNull();
  });

  test("a spawn/ENOENT failure is not-installed, with account: null", async () => {
    const info = await runHealthProbe(
      "x",
      async () => {
        throw new Error("spawn claude ENOENT");
      },
      deps,
    );
    expect(info.health).toEqual({ status: "not-installed" });
    expect(info.account).toBeNull();
  });

  test("any other stream failure is not-logged-in", async () => {
    const info = await runHealthProbe(
      "x",
      async () => {
        throw new Error("socket reset");
      },
      deps,
    );
    expect(info.health).toEqual({ status: "not-logged-in" });
  });

  test("a read that rejects with an abort-flavoured error before any verdict is classified is unhealthy-unconfirmed-exit, never ready, with no account", async () => {
    const info = await runHealthProbe(
      "x",
      async () => {
        throw new DOMException("The operation was aborted.", "AbortError");
      },
      deps,
    );
    expect(info.health).toEqual({ status: "unhealthy-unconfirmed-exit" });
    expect(info.account).toBeNull();
  });

  test("a reader that throws synchronously (not just rejects) does not escape runHealthProbe as a rejection, and still closes the process tree", async () => {
    let closed = 0;
    const tree = {
      close: () => {
        closed += 1;
      },
    } as unknown as ProcessTree;
    const syncThrow = (() => {
      throw new Error("sync boom");
    }) as HealthProbeReader;
    const info = await runHealthProbe("x", syncThrow, { ...deps, processTree: tree });
    expect(info.health).toEqual({ status: "not-logged-in" });
    expect(closed).toBe(1);
  });

  test("closes the process tree on every path", async () => {
    let closed = 0;
    const tree = {
      close: () => {
        closed += 1;
      },
    } as unknown as ProcessTree;
    await runHealthProbe("x", async () => null, { ...deps, processTree: tree });
    await runHealthProbe(
      "x",
      async () => {
        throw new Error("boom");
      },
      { ...deps, processTree: tree },
    );
    expect(closed).toBe(2);
  });
});

// --- The shared classification/close/deadline outcomes are generic to any
// backend, so they are asserted here directly against a fake
// HealthProbeReader with no SDK vocabulary involved. ---

describe("runHealthProbe: process tree close on the remaining paths", () => {
  test("closes the process tree once when a vendor verdict passes through", async () => {
    let closed = 0;
    const tree = {
      close: () => {
        closed += 1;
      },
    } as unknown as ProcessTree;
    const verdict = { backendId: "x", health: { status: "ready" as const }, account: null };
    await runHealthProbe("x", async () => verdict, { ...deps, processTree: tree });
    expect(closed).toBe(1);
  });

  // finding §2.7: a deadline expiry proves NOTHING — least of all that the user is signed out.
  // Reporting `not-logged-in` here is the exact bug that locked the whole application on a
  // slow-but-working CLI after 20s; `unhealthy-unconfirmed-exit` is the honest classification,
  // and Home maps it to an ADVISORY panel that still allows submit.
  test("closes the process tree once when the deadline elapses before the read settles, reporting unhealthy-unconfirmed-exit with no account", async () => {
    let closed = 0;
    const tree = {
      close: () => {
        closed += 1;
      },
    } as unknown as ProcessTree;
    const info = await runHealthProbe(
      "x",
      () => new Promise<AgentInfo | null>(() => {}), // never resolves — models a stalled vendor reader
      { ...deps, wait: async () => {}, deadlineMs: 5, processTree: tree },
    );
    expect(info.health).toEqual({ status: "unhealthy-unconfirmed-exit" });
    expect(info.account).toBeNull();
    expect(closed).toBe(1);
  });
});
