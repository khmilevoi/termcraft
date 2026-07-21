import { describe, expect, test } from "bun:test";

import { createFakeProjectWriteCoordinator } from "./project-write";

describe("createFakeProjectWriteCoordinator", () => {
  test("acquire() resolves immediately when the mutex is free", async () => {
    const mutex = createFakeProjectWriteCoordinator();
    const permit = await mutex.acquire();
    expect(mutex.isActive(permit)).toBe(true);
  });

  test("a second acquire() queues until the first holder releases (FIFO-fair exclusion)", async () => {
    const mutex = createFakeProjectWriteCoordinator();
    const first = await mutex.acquire();

    let secondGranted = false;
    const secondPromise = mutex.acquire().then((permit) => {
      secondGranted = true;
      return permit;
    });

    await Promise.resolve();
    expect(secondGranted).toBe(false);
    expect(mutex.isActive(first)).toBe(true);

    mutex.release(first);
    const second = await secondPromise;
    expect(secondGranted).toBe(true);
    expect(mutex.isActive(second)).toBe(true);
    expect(mutex.isActive(first)).toBe(false);
  });

  test("release() is idempotent — releasing a stale permit never drops a later holder's lock", async () => {
    const mutex = createFakeProjectWriteCoordinator();
    const first = await mutex.acquire();
    mutex.release(first);
    const second = await mutex.acquire();

    mutex.release(first); // stale — must be a no-op
    expect(mutex.isActive(second)).toBe(true);
  });

  test("isActive() is false for a permit that was never granted the lock", async () => {
    const mutex = createFakeProjectWriteCoordinator();
    await mutex.acquire();
    expect(mutex.isActive({ permitId: "never-issued" })).toBe(false);
  });

  test("records acquire/release/isActive in exact call order, proving 'acquired before released'", async () => {
    const mutex = createFakeProjectWriteCoordinator();
    const permit = await mutex.acquire();
    mutex.isActive(permit);
    mutex.release(permit);
    expect(mutex.calls.map((c) => c.method)).toEqual([
      "acquire",
      "acquire-granted",
      "isActive",
      "release",
    ]);
  });

  test("a shared FakeCallSequence lets two coordinators interleave into one comparable order", async () => {
    let n = 0;
    const sequence = { next: () => n++ };
    const a = createFakeProjectWriteCoordinator({ sequence });
    const b = createFakeProjectWriteCoordinator({ sequence });
    await a.acquire();
    await b.acquire();
    const aSeq = a.calls[0]?.seq;
    const bSeq = b.calls[0]?.seq;
    expect(aSeq).toBeDefined();
    expect(bSeq).toBeDefined();
    expect(aSeq as number).toBeLessThan(bSeq as number);
  });
});
