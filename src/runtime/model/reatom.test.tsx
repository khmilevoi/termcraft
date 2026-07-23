import { afterEach, describe, expect, test } from "bun:test";

import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";

import { action, atom, computed, reatomComponent, withConnectHook, wrap } from "./reatom";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
});

const lineText = (frame: { rows: { text: string }[][] }, row: number) =>
  (frame.rows[row] ?? []).map((run) => run.text).join("");
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("@termcraft/runtime Reatom facade re-exports", () => {
  test("atom / computed / action re-exports keep Reatom semantics under the facade", () => {
    const count = atom(2, "reatom-facade.count");
    const doubled = computed(() => count() * 2, "reatom-facade.doubled");
    expect(count()).toBe(2);
    expect(doubled()).toBe(4);

    const bump = action(() => count.set(count() + 1), "reatom-facade.bump");
    bump();
    expect(count()).toBe(3);
    expect(doubled()).toBe(6);
  });

  test("wrap is re-exported and callable at an async boundary", async () => {
    const value = await wrap(Promise.resolve("ok"));
    expect(value).toBe("ok");
  });

  test("reatomComponent from the facade renders reactively through the host harness (Spike D path)", async () => {
    const visits = atom(0, "reatom-facade.visits");
    const Visits = reatomComponent(
      () => <text>{`visits=${visits()}`}</text>,
      "reatom-facade.Visits",
    );

    const handle = await createHeadlessRenderer({ w: 16, h: 1 });
    open = handle;
    handle.mount(<Visits />);
    await handle.render();
    expect(lineText(handle.capture(), 0)).toContain("visits=0");

    visits.set(7);
    await tick();
    await handle.render();
    expect(lineText(handle.capture(), 0)).toContain("visits=7");
  });
});

describe("withConnectHook narrowing + cleanup contract (§3.2, §11.1, m1/m2)", () => {
  test("the narrowed callback parameter type rejects a value outside ConnectionHookResult (m1)", () => {
    const resource = atom(0, "reatom-facade.connectHook.narrowing");
    // @ts-expect-error — a plain object is `MaybeUnsubscribe`-shaped under Reatom's
    // raw (pre-m1) signature but is NOT a `ConnectionHookResult`; the facade's
    // narrowed callback type must reject it at compile time.
    resource.extend(withConnectHook(() => ({ notACleanup: true })));
  });

  test("connecting an atom with a withConnectHook cleanup and then disconnecting runs the cleanup exactly once (m2)", async () => {
    let cleanupCalls = 0;
    const resource = atom(0, "reatom-facade.connectHook.resource").extend(
      withConnectHook(() => () => {
        cleanupCalls += 1;
      }),
    );

    // Two overlapping subscribers share ONE connection lifetime (§5.4: "the
    // callback runs when the target receives its FIRST consumer" / "disconnect
    // ... invokes the returned cleanup at most once"), so the cleanup must not
    // fire until the LAST subscriber disconnects, and must fire exactly once
    // then — not once per unsubscribe call.
    const unsubscribeA = resource.subscribe(() => {});
    const unsubscribeB = resource.subscribe(() => {});
    await tick();
    expect(cleanupCalls).toBe(0);

    unsubscribeA();
    await tick();
    expect(cleanupCalls).toBe(0);

    unsubscribeB();
    await tick();
    expect(cleanupCalls).toBe(1);
  });
});
