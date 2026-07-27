import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";
import { action, atom, computed, reatomComponent, withComputed, wrap } from "runtime";

import { buildRuntimeDocs } from "./runtime-docs";

const GUIDE_PATH = path.resolve(import.meta.dir, "reatom-guide.md");
const GUIDE = fs.readFileSync(GUIDE_PATH, "utf8");

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
});

const lineText = (frame: { rows: { text: string }[][] }, row: number) =>
  (frame.rows[row] ?? []).map((run) => run.text).join("");

describe("REATOM.md is staged into every turn workspace", () => {
  test("buildRuntimeDocs lists it, and the source file it points at exists", () => {
    const doc = buildRuntimeDocs().find((d) => d.relPath === "REATOM.md");
    expect(doc).toBeDefined();
    expect(fs.existsSync(doc!.sourcePath)).toBe(true);
  });
});

/**
 * A guide the authoring agent cannot verify from inside the fence is only as good as its
 * last proofread — and the document it replaces (`RUNTIME.md`'s palette list) is proof that
 * prose drifts. These execute the guide's own idioms against the real facade, so a Reatom
 * upgrade that changes any of them fails here instead of in a generated page.
 */
describe("the idioms REATOM.md teaches, run against the real @termcraft/runtime facade", () => {
  test("read by calling, write with .set — no ctx anywhere", () => {
    const countAtom = atom(0, "countAtom");
    expect(countAtom()).toBe(0);
    countAtom.set(5);
    expect(countAtom()).toBe(5);
  });

  test("computed derives from a plain call and tracks its dependency", () => {
    const countAtom = atom(2, "countAtom");
    const doubled = computed(() => countAtom() * 2, "doubled");
    expect(doubled()).toBe(4);
    countAtom.set(3);
    expect(doubled()).toBe(6);
  });

  // Two writes, copied from the guide's own `selectPalette` (reatom-guide.md's "Writing
  // state"): a one-write action would be the pass-through the guide calls "pure noise" and
  // RTM-S01 forbids — an example that contradicts the document it is here to validate.
  test("an action takes its own parameters — never a leading context", () => {
    const selectedIdAtom = atom("green", "selectedIdAtom");
    const lastChangedAtom = atom("", "lastChangedAtom");
    const selectPalette = action((id: string) => {
      selectedIdAtom.set(id);
      lastChangedAtom.set(id);
    }, "selectPalette");

    selectPalette("red");
    expect(selectedIdAtom()).toBe("red");
    expect(lastChangedAtom()).toBe("red");
  });

  test("withComputed derives a writable atom from another one", () => {
    const sourceAtom = atom("a", "sourceAtom");
    const draftAtom = atom("", "draftAtom").extend(withComputed(() => sourceAtom()));
    expect(draftAtom()).toBe("a");
    sourceAtom.set("b");
    expect(draftAtom()).toBe("b");
  });

  test("wrap turns a handler into one that may touch atoms", () => {
    const selectedIdAtom = atom("green", "selectedIdAtom");
    const onSelect = wrap((id: string) => selectedIdAtom.set(id));
    onSelect("amber");
    expect(selectedIdAtom()).toBe("amber");
  });

  test("reatomComponent's callback receives props, and a module-scope atom drives the render", async () => {
    const labelAtom = atom("first", "labelAtom");
    // Declared with a props parameter on purpose: the guide's central claim is that this
    // position is React props, NOT a Reatom context. `spy` here would be `undefined`.
    const Page = reatomComponent(function Page(props: { readonly suffix?: string }) {
      expect("spy" in props).toBe(false);
      return <text>{`${labelAtom()}${props.suffix ?? ""}`}</text>;
    }, "Page");

    const handle = await createHeadlessRenderer({ w: 24, h: 1 });
    open = handle;
    handle.mount(<Page suffix="!" />);
    await handle.render();
    expect(handle.renderError()).toBeNull();
    expect(lineText(handle.capture(), 0)).toContain("first!");
  });
});

/**
 * The guide's two prohibitions, asserted as behaviour rather than as prose. If a future
 * Reatom brings `ctx`/`.spy` back, or stops throwing on a call-with-arguments, these fail
 * and the guide must be revisited — rather than silently teaching something untrue.
 */
describe("the v3 idioms REATOM.md forbids really are unavailable", () => {
  test("`.spy` exists nowhere on an atom", () => {
    const countAtom = atom(0, "countAtom");
    expect((countAtom as unknown as { spy?: unknown }).spy).toBeUndefined();
  });

  test("calling an atom with arguments throws instead of writing", () => {
    const countAtom = atom(0, "countAtom");
    expect(() => (countAtom as unknown as (...a: unknown[]) => unknown)({}, 5)).toThrow();
    expect(countAtom()).toBe(0);
  });
});

describe("REATOM.md states the version trap explicitly", () => {
  test("it names v1001 and rules out both `ctx` and `.spy` by name", () => {
    expect(GUIDE).toContain("v1001");
    expect(GUIDE).toContain("There is no `ctx`");
    expect(GUIDE).toContain("There is no `.spy`");
  });

  test("it forbids the `any` annotation that turns a caught error into a crash", () => {
    expect(GUIDE).toContain("Never annotate a parameter `any` to silence a type error");
  });
});
