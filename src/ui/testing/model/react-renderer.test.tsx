import { afterEach, describe, expect, test } from "bun:test";

import { atom } from "@reatom/core";
import { reatomComponent } from "@reatom/react";

import { type ReactTestRenderer, createReactTestRenderer } from "ui/testing";

let open: ReactTestRenderer | null = null;
afterEach(async () => {
  await open?.destroy();
  open = null;
});

describe("React test renderer", () => {
  test("uses act and the OpenTUI frame wait for reactive updates", async () => {
    const label = atom("before", "ui.testing.reactRenderer.label");
    const View = reatomComponent(() => <text>{label()}</text>, "ui.testing.reactRenderer.View");
    const renderer = await createReactTestRenderer(<View />, { width: 12, height: 1 });
    open = renderer;

    expect(await renderer.waitForFrame((frame) => frame.includes("before"))).toContain("before");

    await renderer.act(() => label.set("after"));

    expect(await renderer.waitForFrame((frame) => frame.includes("after"))).toContain("after");
  });
});
