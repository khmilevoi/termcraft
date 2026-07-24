import { describe, expect, test } from "bun:test";

import { WritePermitInvalidError, assertActivePermit, createWriteMutex } from "./write-mutex";

function fakeMutexDeps(ids: readonly string[]) {
  let at = 0;
  return {
    mintPermitId: () => {
      const id = ids[at];
      if (id === undefined) throw new Error("fakeMutexDeps: ran out of ids");
      at += 1;
      return id;
    },
  };
}

describe("createWriteMutex", () => {
  test("grants the first acquire immediately", async () => {
    const mutex = createWriteMutex(fakeMutexDeps(["p1"]));
    const permit = await mutex.acquire();
    expect(permit.permitId).toBe("p1");
    expect(mutex.isActive(permit)).toBe(true);
  });

  test("is FIFO fair: waiters resolve in exact call order", async () => {
    const mutex = createWriteMutex(fakeMutexDeps(["p1", "p2", "p3"]));
    const order: string[] = [];

    const first = await mutex.acquire();
    order.push("acquired-1");

    const secondPromise = mutex.acquire().then((permit) => {
      order.push("acquired-2");
      return permit;
    });
    const thirdPromise = mutex.acquire().then((permit) => {
      order.push("acquired-3");
      return permit;
    });

    // Neither waiter can have resolved yet — the mutex is still held by `first`.
    expect(order).toEqual(["acquired-1"]);

    mutex.release(first);
    const second = await secondPromise;
    expect(order).toEqual(["acquired-1", "acquired-2"]);
    expect(second.permitId).toBe("p2");

    mutex.release(second);
    const third = await thirdPromise;
    expect(order).toEqual(["acquired-1", "acquired-2", "acquired-3"]);
    expect(third.permitId).toBe("p3");
  });

  test("release invalidates the permit; a stale continuation can no longer write", async () => {
    const mutex = createWriteMutex(fakeMutexDeps(["p1", "p2"]));
    const first = await mutex.acquire();
    mutex.release(first);

    expect(mutex.isActive(first)).toBe(false);
    expect(assertActivePermit(mutex, first)).toBeInstanceOf(WritePermitInvalidError);
  });

  test("a superseded permit (someone else already won the mutex) is denied — stale async writer", async () => {
    const mutex = createWriteMutex(fakeMutexDeps(["p1", "p2"]));
    const first = await mutex.acquire();
    mutex.release(first);
    const second = await mutex.acquire();

    // `first` believes it might still be able to write; the mutex disagrees.
    expect(mutex.isActive(first)).toBe(false);
    expect(mutex.isActive(second)).toBe(true);
    expect(assertActivePermit(mutex, first)).toBeInstanceOf(WritePermitInvalidError);
    expect(assertActivePermit(mutex, second)).toBeNull();
  });

  test("releasing an already-invalidated permit is a no-op — it never drops a later acquirer's lock", async () => {
    const mutex = createWriteMutex(fakeMutexDeps(["p1", "p2"]));
    const first = await mutex.acquire();
    mutex.release(first);
    const second = await mutex.acquire();

    mutex.release(first); // double release of the stale permit
    expect(mutex.isActive(second)).toBe(true); // second's lock survives
  });

  test("releasing an unknown permit before anyone has acquired is a no-op", () => {
    const mutex = createWriteMutex(fakeMutexDeps(["p1"]));
    expect(() => mutex.release({ permitId: "never-issued" })).not.toThrow();
  });

  test("currentPermit() is null when free, the active permit while held, and null again after release", async () => {
    const mutex = createWriteMutex(fakeMutexDeps(["p1", "p2"]));
    expect(mutex.currentPermit()).toBeNull();

    const first = await mutex.acquire();
    expect(mutex.currentPermit()).toEqual(first);

    mutex.release(first);
    expect(mutex.currentPermit()).toBeNull();

    const second = await mutex.acquire();
    expect(mutex.currentPermit()).toEqual(second);
  });

  test("currentPermit() reflects the NEXT holder once a waiter is granted, not the released one", async () => {
    const mutex = createWriteMutex(fakeMutexDeps(["p1", "p2"]));
    const first = await mutex.acquire();
    const secondPromise = mutex.acquire();

    mutex.release(first);
    const second = await secondPromise;
    expect(mutex.currentPermit()).toEqual(second);
    expect(mutex.currentPermit()).not.toEqual(first);
  });

  test("mintWritePermitId (default deps) produces a 128-bit base64url random id, not a UUIDv7", async () => {
    const mutex = createWriteMutex();
    const permit = await mutex.acquire();
    expect(permit.permitId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(Buffer.from(permit.permitId, "base64url").byteLength).toBe(16);
  });
});

describe("store/transaction write-mutex chain", () => {
  test("runs every step in order, threading each result into the next", async () => {
    const mutex = createWriteMutex(fakeMutexDeps(["p1"]));
    const permit = await mutex.acquire();
    const order: string[] = [];

    const outcome = await mutex
      .chain(permit)
      .do(() => {
        order.push("first");
        return 1;
      })
      .do(async (previous) => {
        order.push("second");
        return previous + 1;
      });

    expect(order).toEqual(["first", "second"]);
    expect(outcome.error).toBeNull();
    expect(outcome.result).toBe(2);
  });

  test("a permit released mid-chain stops the NEXT step and reports the permit error", async () => {
    const mutex = createWriteMutex(fakeMutexDeps(["p1", "p2"]));
    const permit = await mutex.acquire();
    const ran: string[] = [];

    const outcome = await mutex
      .chain(permit)
      .do(() => {
        ran.push("first");
        mutex.release(permit); // a concurrent finalizer takes the mutex away
      })
      .do(() => {
        ran.push("second");
      });

    // The step that started under a valid permit still completed; the next one never ran.
    expect(ran).toEqual(["first"]);
    expect(outcome.error).toBeInstanceOf(WritePermitInvalidError);
    expect(outcome.error?.permitId).toBe("p1");
    expect(outcome.result).toBeNull();
  });

  test("once a step reports a stale permit, no remaining step executes", async () => {
    const mutex = createWriteMutex(fakeMutexDeps(["p1"]));
    const permit = await mutex.acquire();
    mutex.release(permit);
    const ran: string[] = [];

    const outcome = await mutex
      .chain(permit)
      .do(() => void ran.push("first"))
      .do(() => void ran.push("second"))
      .do(() => void ran.push("third"));

    expect(ran).toEqual([]);
    expect(outcome.error).toBeInstanceOf(WritePermitInvalidError);
  });

  test("a chain started with an already-stale permit refuses before any step", async () => {
    const mutex = createWriteMutex(fakeMutexDeps(["p1", "p2"]));
    const stale = await mutex.acquire();
    mutex.release(stale);
    await mutex.acquire(); // a newer holder owns the mutex now

    let ran = false;
    const outcome = await mutex.chain(stale).do(() => {
      ran = true;
    });

    expect(ran).toBe(false);
    expect(outcome.error).toBeInstanceOf(WritePermitInvalidError);
    expect(outcome.error?.permitId).toBe("p1");
  });

  test("a domain error travels as a value, not through the permit channel", async () => {
    const mutex = createWriteMutex(fakeMutexDeps(["p1"]));
    const permit = await mutex.acquire();
    const domainFailure = new Error("source_changed");

    const outcome = await mutex
      .chain(permit)
      .do((): Error | number => domainFailure)
      .do((previous) => (previous instanceof Error ? previous : previous + 1));

    // The permit was never stale, so `error` stays null and the domain failure is the result.
    expect(outcome.error).toBeNull();
    expect(outcome.result).toBe(domainFailure);
  });
});
