import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";

import type { StyledRun } from "host/protocol";
import { createHeadlessRenderer } from "host/render/model/renderer";
import type { RenderHandle } from "host/render/types";

import { Fragment, jsx, jsxDEV, jsxs } from "./jsx";

let open: RenderHandle | null = null;
afterEach(() => {
  open?.destroy();
  open = null;
});

const lineText = (frame: { rows: StyledRun[][] }, row: number) =>
  (frame.rows[row] ?? []).map((run) => run.text).join("");

describe("facade JSX helper surface (§3.2)", () => {
  test("jsx / jsxs / jsxDEV / Fragment are the facade's own callable/value re-exports", () => {
    expect(typeof jsx).toBe("function");
    expect(typeof jsxs).toBe("function");
    expect(typeof jsxDEV).toBe("function");
    expect(Fragment).toBeDefined();
  });

  test("an element built with js(x) renders through the host harness", async () => {
    const handle = await createHeadlessRenderer({ w: 10, h: 1 });
    open = handle;
    // jsx(type, config[, key]) — the automatic-runtime factory the compiler calls.
    handle.mount(jsx("text", { children: "hi jsx" }));
    await handle.render();
    expect(lineText(handle.capture(), 0)).toContain("hi jsx");
  });
});

/**
 * The §3.1 JSX helper contract, exercised against the transform's real output
 * (runtime-api §11.1) rather than a stand-in (m3). Read against `./jsx.ts`'s own
 * header: this facade module re-exports OpenTUI's JSX runtime, which itself
 * re-exports React 19's own `jsx-runtime`/`jsx-dev-runtime` unchanged.
 */
describe("facade JSX helper contract (§3.1, m3)", () => {
  test("`key` is positional — the third argument — and absent from `props` (§3.1)", () => {
    const el = jsx("text", { children: "a" }, "row-1");
    expect(el.key).toBe("row-1");
    // Own-ENUMERABLE keys, not `"key" in props`: React's development build defines
    // a non-enumerable dev-only warning getter named `key` on `props` (to catch
    // authors who read `props.key` directly) that would make an `in` check pass
    // for the wrong reason — an implementation detail of the dev build, not the
    // §3.1 contract. Reading `el.props.key` itself is avoided too: it would
    // invoke that same dev-only getter and print a console.error warning.
    expect(Object.keys(el.props)).not.toContain("key");
  });

  test("jsx and jsxs share one (type, props, key) signature, with children in props.children for both (§3.1)", () => {
    // Single-child root, built with `jsx`.
    const single = jsx("text", { children: "solo" }, "single-key");
    expect(single.key).toBe("single-key");
    expect(single.props.children).toBe("solo");

    // Multi-child (static array) root, built with `jsxs` — "jsxs signals only
    // that the child list is static", not a distinct props shape.
    const multiple = jsxs("text", { children: ["a", "b"] }, "multi-key");
    expect(multiple.key).toBe("multi-key");
    expect(multiple.props.children).toEqual(["a", "b"]);
  });

  test("Fragment is an exported value used as a `type` argument, never a callable helper (§3.1)", () => {
    expect(typeof Fragment).not.toBe("function");
    const el = jsx(Fragment, { children: jsx("text", { children: "wrapped" }) });
    expect(el.type).toBe(Fragment);
  });

  test("a Fragment-rooted element renders its child through the host harness", async () => {
    const handle = await createHeadlessRenderer({ w: 12, h: 1 });
    open = handle;
    handle.mount(jsx(Fragment, { children: jsx("text", { children: "hi frag" }) }));
    await handle.render();
    expect(lineText(handle.capture(), 0)).toContain("hi frag");
  });

  const repoRoot = path.resolve(import.meta.dir, "../../..");
  const facadeModulePath = "./src/runtime/model/jsx.ts";

  /**
   * Spawns a real `bun` child that imports the facade's OWN `./jsx.ts` under the
   * given `NODE_ENV` and reports the shape of its exports — the only way to
   * observe the dev/prod split for real: `react/jsx-runtime.js` /
   * `jsx-dev-runtime.js` branch on `process.env.NODE_ENV` (read by dot access,
   * §3.1's own documented trap) at MODULE LOAD time, so a single already-loaded
   * test process can't flip it after the fact.
   */
  async function jsxHelperShape(nodeEnv: string): Promise<{ jsxDEV: string; jsxIsJsxs: boolean }> {
    const script = [
      `const facade = await import(${JSON.stringify(facadeModulePath)});`,
      `process.stdout.write(JSON.stringify({ jsxDEV: typeof facade.jsxDEV, jsxIsJsxs: facade.jsx === facade.jsxs }));`,
    ].join("\n");
    const child = Bun.spawn({
      cmd: [process.execPath, "-e", script],
      cwd: repoRoot,
      env: { ...process.env, NODE_ENV: nodeEnv },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0) throw new Error(`jsxHelperShape(${nodeEnv}) exited ${exitCode}: ${stderr}`);
    return JSON.parse(stdout) as { jsxDEV: string; jsxIsJsxs: boolean };
  }

  test("development builds emit a callable jsxDEV distinct from jsx/jsxs; production builds fold jsx/jsxs into one helper and drop jsxDEV (§3.1)", async () => {
    const dev = await jsxHelperShape("development");
    expect(dev.jsxDEV).toBe("function");
    expect(dev.jsxIsJsxs).toBe(false);

    const prod = await jsxHelperShape("production");
    expect(prod.jsxDEV).toBe("undefined");
    expect(prod.jsxIsJsxs).toBe(true);
  });
});
