import { afterEach, describe, expect, test } from "bun:test";

import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";

import { registerRenderableTags } from "./renderable-tags";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
});

describe("renderable tag registration (spec §6.1)", () => {
  test("registerRenderableTags is idempotent", () => {
    registerRenderableTags();
    registerRenderableTags();
    expect(registerRenderableTags()).toBeUndefined();
  });

  test("each registered tag mounts its real OpenTUI renderable", async () => {
    registerRenderableTags();
    const handle = await createHeadlessRenderer({ w: 20, h: 6 });
    open = handle;
    handle.mount(
      <box id="root">
        <slider id="probe-slider" orientation="horizontal" width={10} height={1} />
        <scroll-bar id="probe-scrollbar" orientation="vertical" width={1} height={4} />
        <text-table id="probe-table" width={10} height={1} />
        <frame-buffer id="probe-framebuffer" width={4} height={1} />
      </box>,
    );
    await handle.render();
    expect(handle.renderError()).toBeNull();
    // `describe(id).kind` is the mounted renderable's real constructor name
    // (`host/render/model/geometry.ts`), so this fails if `extend()` never ran — an
    // unregistered tag throws `Unknown component type` out of the reconciler instead.
    expect(handle.describe("probe-slider")?.kind).toContain("SliderRenderable");
    expect(handle.describe("probe-scrollbar")?.kind).toContain("ScrollBarRenderable");
    expect(handle.describe("probe-table")?.kind).toContain("TextTableRenderable");
    expect(handle.describe("probe-framebuffer")?.kind).toContain("FrameBufferRenderable");
  });

  test("the module augmentation restores real prop checking on an extended tag", () => {
    // WITHOUT `renderable-tags.augmentation.d.ts`, `OpenTUIComponents`' string index
    // signature makes EVERY extended tag type-check with `any` props (spec §6.1), and this
    // `@ts-expect-error` would itself become an error ("unused '@ts-expect-error'
    // directive") under `bun x tsc --noEmit`. `orientation` is REQUIRED on SliderRenderable.
    // @ts-expect-error — `orientation` is required; the augmentation is what makes that visible.
    const rejected = <slider id="unchecked" width={4} height={1} />;
    expect(rejected).toBeDefined();
  });
});
