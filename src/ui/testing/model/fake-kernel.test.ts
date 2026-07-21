import { describe, expect, test } from "bun:test";

import type { EventEnvelopeV1 } from "ui/kernel";

import { event } from "./events";
import { createFakeKernel } from "./fake-kernel";

describe("createFakeKernel", () => {
  test("delivers a kernel.snapshot synchronously on subscribe, before returning", () => {
    const kernel = createFakeKernel({ snapshot: { activePageSlug: "main" } });
    const seen: EventEnvelopeV1[] = [];
    const unsubscribe = kernel.subscribe((envelope) => seen.push(envelope));

    expect(seen).toHaveLength(1);
    const snap = seen[0];
    if (snap === undefined) throw new Error("expected a snapshot envelope");
    expect(snap.kind).toBe("kernel.snapshot");
    expect((snap.payload as { activePageSlug: string }).activePageSlug).toBe("main");
    expect(typeof unsubscribe).toBe("function");
  });

  test("emit reaches every current subscriber", () => {
    const kernel = createFakeKernel();
    const a: string[] = [];
    const b: string[] = [];
    kernel.subscribe((e) => a.push(e.kind));
    kernel.subscribe((e) => b.push(e.kind));

    kernel.emit(event("selection.changed", null));

    expect(a).toEqual(["kernel.snapshot", "selection.changed"]);
    expect(b).toEqual(["kernel.snapshot", "selection.changed"]);
  });

  test("unsubscribe stops delivery and drops the subscriber count", () => {
    const kernel = createFakeKernel();
    const seen: string[] = [];
    const unsubscribe = kernel.subscribe((e) => seen.push(e.kind));
    expect(kernel.subscriberCount()).toBe(1);

    (unsubscribe as () => void)();
    expect(kernel.subscriberCount()).toBe(0);
    kernel.emit(event("selection.changed", null));
    expect(seen).toEqual(["kernel.snapshot"]);
  });

  test("dispatch records the raw envelope and resolves to the canned result", async () => {
    const kernel = createFakeKernel();
    const result = await kernel.dispatch({ kind: "chat.create", commandId: "cid" });
    expect(kernel.dispatched).toHaveLength(1);
    expect(result).toMatchObject({ status: "accepted", disposition: "completed" });
  });

  test("setDispatchResult overrides the resolved result", async () => {
    const kernel = createFakeKernel();
    kernel.setDispatchResult(new Error("nope"));
    const result = await kernel.dispatch({ kind: "export.start" });
    expect(result).toBeInstanceOf(Error);
  });
});
