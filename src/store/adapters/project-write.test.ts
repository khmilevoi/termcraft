import { afterEach, describe, expect, test } from "bun:test";

import { createFakeProjectWriteCoordinator } from "core/ports/fakes";

import { createProjectWriteAdapter } from "./project-write";
import { cleanupScratchRoots, createRealProjectFixture } from "./test-support";

afterEach(cleanupScratchRoots);

describe("createProjectWriteAdapter — contract test (fake vs. real)", () => {
  test("acquire() resolves immediately when the mutex is free, on both the fake and the real adapter", async () => {
    const fake = createFakeProjectWriteCoordinator();
    const fakePermit = await fake.acquire();
    expect(fake.isActive(fakePermit)).toBe(true);

    const { open } = await createRealProjectFixture();
    try {
      const adapter = createProjectWriteAdapter({ mutex: open.writeMutex });
      const permit = await adapter.acquire();
      expect(adapter.isActive(permit)).toBe(true);
      adapter.release(permit);
    } finally {
      await open.close();
    }
  });

  test("a second acquire() queues until the first holder releases (FIFO-fair exclusion), on the real mutex", async () => {
    const { open } = await createRealProjectFixture();
    try {
      const adapter = createProjectWriteAdapter({ mutex: open.writeMutex });
      const first = await adapter.acquire();

      let secondGranted = false;
      const secondPromise = adapter.acquire().then((permit) => {
        secondGranted = true;
        return permit;
      });

      await Promise.resolve();
      expect(secondGranted).toBe(false);
      expect(adapter.isActive(first)).toBe(true);

      adapter.release(first);
      const second = await secondPromise;
      expect(secondGranted).toBe(true);
      expect(adapter.isActive(second)).toBe(true);
      expect(adapter.isActive(first)).toBe(false);
      adapter.release(second);
    } finally {
      await open.close();
    }
  });

  test("release() is idempotent — releasing a stale permit never drops a later holder's lock", async () => {
    const { open } = await createRealProjectFixture();
    try {
      const adapter = createProjectWriteAdapter({ mutex: open.writeMutex });
      const first = await adapter.acquire();
      adapter.release(first);
      const second = await adapter.acquire();

      adapter.release(first); // stale — must be a no-op
      expect(adapter.isActive(second)).toBe(true);
      adapter.release(second);
    } finally {
      await open.close();
    }
  });

  test("the adapter's mutex is the SAME instance the engine's own named methods acquire against internally", async () => {
    const { open } = await createRealProjectFixture();
    try {
      const adapter = createProjectWriteAdapter({ mutex: open.writeMutex });
      const permit = await adapter.acquire();

      // While the adapter holds the mutex, a concurrent named `TransactionEngine` call must
      // queue behind it rather than proceeding — proof the two share one exclusion primitive.
      let engineCallResolved = false;
      const engineCall = open.transactions
        .setActiveChat({
          transactionId: "01950000-0000-7000-8000-000000000000",
          actionId: "01950000-0000-7000-8000-000000000001",
          activeChatId: null,
          createdAt: "2026-07-24T00:00:00.000Z",
        })
        .then((result) => {
          engineCallResolved = true;
          return result;
        });

      await Promise.resolve();
      expect(engineCallResolved).toBe(false);

      adapter.release(permit);
      const result = await engineCall;
      expect(result instanceof Error).toBe(false);
    } finally {
      await open.close();
    }
  });
});
