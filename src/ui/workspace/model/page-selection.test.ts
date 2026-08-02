import { describe, expect, test } from "bun:test";

import type { PageDescriptorV1 } from "core/protocol";
import { uuidv7 } from "infrastructure/uuid";
import { createUiDeps } from "ui/app";
import { TEST_SHA, createFakeKernel, event, snapshot } from "ui/testing";

import { selectPage } from "./page-selection";

const ready = (slug: string, title: string): PageDescriptorV1 => ({
  status: "ready",
  pageSlug: slug,
  entry: `pages/${slug}.tsx`,
  sourceHash: TEST_SHA,
  title,
  minSize: { w: 80, h: 24 },
  theme: "dark-default",
  kitApiVersion: 1,
});

function openedProject(activePageSlug: string | null) {
  const kernel = createFakeKernel();
  const deps = createUiDeps(kernel, { w: 120, h: 36 });
  deps.mirror.apply(
    snapshot({
      projectId: uuidv7(),
      activePageSlug,
      activeChatId: uuidv7(),
      trust: "trusted",
      pageDescriptors: [ready("main", "Main"), ready("settings", "Settings")],
    }),
  );
  return { kernel, deps };
}

const dispatchedKinds = (kernel: { dispatched: readonly unknown[] }): string[] =>
  kernel.dispatched.map((raw) => (raw as { kind: string }).kind);

describe("selectPage", () => {
  test("moves the effective active page to the requested slug", () => {
    const { deps } = openedProject("main");
    selectPage(deps, "settings");
    expect(deps.activePageSlug()).toBe("settings");
  });

  test("leaves the Kernel's own active slug alone — the override is UI-local", () => {
    const { deps } = openedProject("main");
    selectPage(deps, "settings");
    expect(deps.mirror.project().activePageSlug).toBe("main");
  });

  test("clears a selection made on the page being left (§3.2)", () => {
    const { kernel, deps } = openedProject("main");
    deps.mirror.apply(
      event("selection.changed", {
        pageSlug: "main",
        elementId: "gauge-cpu",
        sourceHash: TEST_SHA,
      }),
    );
    selectPage(deps, "settings");
    expect(dispatchedKinds(kernel)).toEqual(["selection.clear"]);
  });

  test("does not dispatch selection.clear when nothing is selected", () => {
    const { kernel, deps } = openedProject("main");
    selectPage(deps, "settings");
    expect(dispatchedKinds(kernel)).toEqual([]);
  });

  test("is a no-op for the page already active", () => {
    const { kernel, deps } = openedProject("main");
    deps.mirror.apply(
      event("selection.changed", {
        pageSlug: "main",
        elementId: "gauge-cpu",
        sourceHash: TEST_SHA,
      }),
    );
    selectPage(deps, "main");
    expect(deps.activePageSlug()).toBe("main");
    expect(dispatchedKinds(kernel)).toEqual([]);
  });

  test("refuses a slug no descriptor carries", () => {
    const { deps } = openedProject("main");
    selectPage(deps, "ghost");
    expect(deps.activePageSlug()).toBe("main");
  });
});
