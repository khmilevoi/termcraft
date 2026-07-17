# Spike D — Reatom v1001 through OpenTUI's React reconciler

**Question:** Does `reatomComponent` from `@reatom/react@1001.0.0` drive re-renders
through **OpenTUI's** React reconciler — not `react-dom` — inside a
`bun build --compile` binary on Windows; and do `wrap`, `withAsync`, and
`withConnectHook` behave there as the vendored v1001 handbook describes?

**Verdict: YES-WITH-FALLBACK**

**Provider:** `@reatom/react@1001.0.0` exports `reatomComponent` (confirmed:
`grep -c "declare let reatomComponent" node_modules/@reatom/react/dist/index.d.ts` → `1`).
`@reatom/core@1001.1.0` does not export it (`grep -c` → `0`).

**Root package.json delta:**

The root manifest has none of these today and must gain all five runtime
dependencies. `react-dom` must **not** be added — see the peer-dependency
finding below.

```json
{
  "dependencies": {
    "@reatom/core": "1001.1.0",
    "@reatom/react": "1001.0.0",
    "@opentui/core": "0.4.5",
    "@opentui/react": "0.4.5",
    "react": "19.2.7"
  }
}
```

---

## Step 1: Scaffold and install

```
bun add @reatom/core@1001.1.0 @reatom/react@1001.0.0 @opentui/core@0.4.5 @opentui/react@0.4.5 react@19.2.7
```

Resolved from `bun.lock` (fresh install, `rm -rf node_modules bun.lock && bun install`):

```
+ @types/bun@1.3.14
+ @opentui/core@0.4.5
+ @opentui/react@0.4.5
+ @reatom/core@1001.1.0
+ @reatom/react@1001.0.0
+ react@19.2.7
+ typescript@5.9.3 (v7.0.2 available)

29 packages installed [2.02s]
```

**No peer-dependency warning was printed by `bun install`, contradicting Known
fact #2's prediction that a `react-dom` warning would appear.** Bun 1.3.14
simply does not surface unmet-peer warnings on `bun install`/`bun add` the way
npm does. The underlying fact Known fact #2 was based on is still true —
confirmed independently from the package manifests:

- `node_modules/@reatom/react/package.json` -> `"peerDependencies": { "react": ">=18.2.0", "react-dom": ">=18.2.0", "@reatom/core": "^1001.0.0" }`
- `node_modules/@opentui/react/package.json` -> `"peerDependencies": { "react": ">=19.2.0", "react-devtools-core": "^7.0.1", "ws": "^8.18.0" }` — **no `react-dom` here at all.**

`react-dom` was never installed for this spike, and no run (bare `bun run`,
compiled `--compile` binary, or the extra production-path diagnostic below)
ever threw or logged anything mentioning `react-dom`. The peer entry on
`@reatom/react` is confirmed spurious for this stack, same shape as the Round 1
finding it was expected to match.

## Step 2: Confirm the provider

```
grep -c "declare let reatomComponent" node_modules/@reatom/react/dist/index.d.ts  ->  1
grep -c "declare let reatomComponent" node_modules/@reatom/core/dist/index.d.ts   ->  0
```

Matches Known fact #1 exactly.

## Step 3: OpenTUI's real React entry point

The brief's guessed path (`node_modules/@opentui/react/dist/*.d.ts`) does not
exist — the package has no `dist/` directory. Its real layout, per
`package.json`: `"types": "./src/index.d.ts"`, `"module": "./index.js"`. The
`.d.ts` files live under `src/`.

Exported surface (`src/index.d.ts` re-exports, plus the two relevant leaf files):

```ts
// src/index.d.ts
export * from "./components/index.js";     // baseComponents incl. `text`, `box`, ...
export * from "./components/app.js";       // AppContext, useAppContext
export * from "./hooks/index.js";          // useKeyboard, useFocus, useBlur, ...
export * from "./plugins/slot.js";
export * from "./reconciler/renderer.js";  // createRoot, createPortal, flushSync
export * from "./time-to-first-draw.js";
export * from "./types/components.js";
export { createElement } from "react";

// src/reconciler/renderer.d.ts -- THE real mount API
export declare function createRoot(renderer: CliRenderer): Root;
export type Root = { render: (node: ReactNode) => void; unmount: () => void };
export { createPortal, flushSync };

// src/test-utils.d.ts -- exported at "@opentui/react/test-utils"
export declare function testRender(
  node: ReactNode,
  testRendererOptions: TestRendererOptions,
): Promise<import("@opentui/core/testing").TestRendererSetup>;

// src/components/index.d.ts -- the intrinsic catalogue (`<text>` IS real)
export declare const baseComponents: {
  box: typeof BoxRenderable; text: typeof TextRenderable; code: typeof CodeRenderable;
  diff: typeof DiffRenderable; markdown: typeof MarkdownRenderable; input: typeof InputRenderable;
  select: typeof SelectRenderable; textarea: typeof TextareaRenderable; scrollbox: typeof ScrollBoxRenderable;
  "ascii-font": ...; "tab-select": ...; "line-number": ...; span: ...; br: ...; b: ...; strong: ...;
  i: ...; em: ...; u: ...; a: ...;
};
```

`@opentui/react/test-utils`'s `testRender` is not a guess-worthy convenience —
reading its compiled JS shows it is a thin, *official* fusion of exactly the
two things Round 1 and this spike both need:

```js
// node_modules/@opentui/react/test-utils.js (as installed)
async function testRender(node, testRendererOptions) {
  let root = null;
  setIsReactActEnvironment(true);
  const testSetup = await createTestRenderer({
    ...testRendererOptions,
    onDestroy() {
      act(() => { if (root) { root.unmount(); root = null; } });
      testRendererOptions.onDestroy?.();
      setIsReactActEnvironment(false);
    },
  });
  root = createRoot(testSetup.renderer);
  act(() => { if (root) root.render(node); });
  return testSetup;
}
```

This confirms `createTestRenderer` (Round 1's proven harness) and
`@opentui/react`'s real mount API (`createRoot`) are meant to be used together
exactly this way, and that `IS_REACT_ACT_ENVIRONMENT` is turned on for the
whole lifetime of a `testRender`-mounted tree — this is the root cause behind
the central finding below.

## Step 4 + 5: The probe, run under `bun run`

`src/main.tsx` mounts `<Probe />` via `testRender` (per Step 3) into a
`createTestRenderer({ width: 40, height: 6 })` instance, then drives:
plain atom write -> `withConnectHook` -> `withAsync` action across a real
`await`. `<text>` from Step 3 is the real intrinsic element; the brief's guess
was correct.

**First run, exactly as scripted in the brief (`counter.set(1)`, plain `await renderOnce()`):**

```
frame0: "n=0 d=0 w=0 l=idle ..."
frame1: "n=0 d=0 w=0 l=idle ..."      <- UNCHANGED. counter.set(1) did not reach the frame.
connectFired: 1
loadReturn: "done"
frame2: "n=0 d=0 w=0 l=idle ..."      <- UNCHANGED. withAsync's result did not reach the frame either.
cleanupFired: 0
```

Console also printed, three times over the run:

```
An update to probe.Probe inside a test was not wrapped in act(...).
When testing, code that causes React state updates should be wrapped into act(...):
act(() => { /* fire events that update state */ });
/* assert on the output */
This ensures that you're testing the behavior the user would see in the browser.
Learn more at https://react.dev/link/wrap-tests-with-act
```

Taken at face value this is a **NO**: the write never reached the frame. But the
`act(...)` warning is a strong hint that this is a scheduling artifact of the
*test* harness, not proof the reconciler binding is broken — Round 1's proven
harness turns on React's act-environment for the whole tree (see Step 3), and
that changes how pending updates are allowed to flush. The brief's own
instruction not to "work around a failure to make the probe pass" was read as:
report the failure, then investigate *why*, rather than silently patching the
probe to hide it. What follows is that investigation, kept in the committed
probe rather than thrown away, because the "why" changes the verdict.

### Isolating the cause

1. **Is Reatom's own reactivity broken?** No. A bare `doubled.subscribe(cb)`
   (no React, no OpenTUI) sees `[0, 10]` — the correct doubled value — within
   two microtask ticks of `counter.set(5)`. Reatom's scheduler
   (`_enqueue` in `@reatom/core/dist/index.js`) confirms this is by design: it
   defers subscriber notification with a single `Promise.resolve().then(...)`.

2. **Does `flush()` (the harness's own settle primitive) help?** No —
   `frame1_afterFlush` is still `"n=0 ..."`.

3. **Does `@opentui/react`'s own exported `flushSync` help, wrapped around the
   write itself?** No — `flushSync(() => counter.set(2))` still leaves
   `frame1` at `"n=0 ..."`. This is explained by finding #1: `counter.set`
   only *schedules* Reatom's notify on a microtask; the actual
   `rerender()` (React `setState`) call happens after `flushSync`'s
   synchronous callback has already returned, so there is nothing pending for
   `flushSync` to force through yet.

4. **Does `flushSync` help if called *after* the microtask has run (so
   `setState` has already fired)?** Still no —
   `frame1_flushSyncAfterMicrotask` is still `"n=0 ..."`.

5. **Root-cause confirmation via temporary diagnostic instrumentation**
   (console.error added to a local `node_modules` copy — never committed,
   `node_modules` is gitignored — then reverted): `reatomComponent`'s internal
   `rerender()` call (`@reatom/core`'s `reatomAbstractRender`, which is
   literally React's `useState` setter) **was being called correctly every
   time**, 4 times matching the 4 writes. But the component's own render
   function was invoked by React **exactly once — at initial mount, never
   again** for any of the four writes. The Reatom-to-React bridge is firing;
   OpenTUI's reconciler is not processing the resulting update in this
   specific test-harness mode.

6. **Does wrapping the write in `act()` from `'react'` (not exported by
   `@opentui/react` — a React Testing Library-style utility) fix it?**
   **Yes.** `frame1_actWrapped` = `"n=4 d=8 w=0 l=idle ..."`. The diagnostic
   instrumentation confirms the outer render function fires again inside
   `act()`, exactly the pattern React's own act-environment machinery expects.

7. **Is this specific to the headless *test* harness, or does the real
   production mount path have the same problem?** This is the question that
   actually decides the verdict, so it got its own file:
   `src/prod-path-check.tsx`, which mounts through `createCliRenderer` +
   `@opentui/react`'s `createRoot` directly — bypassing `createTestRenderer`/
   `testRender` entirely, so `IS_REACT_ACT_ENVIRONMENT` is never set. Result,
   **with no `act()` anywhere**:

   ```
   initial: "n=0 ..."
   after set(1) + intermediateRender+idle (no act): "n=1 ..."
   after set(2) + 50ms wait + intermediateRender+idle: "n=2 ..."
   ```

   The write reached the frame immediately, automatically, with no `act()`
   and no `flushSync`. **The reconciler binding itself is correct.** The
   failure above is entirely an artifact of `IS_REACT_ACT_ENVIRONMENT` being
   turned on by `createTestRenderer`/`testRender` — Round 1's proven harness —
   combined with Reatom's updates being scheduled from outside a
   React-originated call, which is exactly the shape every kernel-driven
   state change will have in production.

### Final full JSON, `bun run src/main.tsx` (after the probe was extended
with the investigation above; identical between `bun run` and the compiled
binary — see Step 6):

```json
{
  "nameProbe": {
    "counter.name": "probe.counter",
    "counter.toString()": "[Atom probe.counter]",
    "counter.__reatom keys": ["reactive", "middlewares", "pipeline", "processing", "linking", "onConnect"],
    "counter.__reatom JSON": "{\"reactive\":true,\"middlewares\":[null,null,null],\"processing\":0,\"linking\":false}",
    "doubled.name": "probe.doubled",
    "load.name": "probe.load"
  },
  "contextStartProbe": {
    "typeof context.start": "function",
    "context.start(() => 1)": 1
  },
  "isolationProbe_afterTwoMicrotasks": [0, 10],
  "isolationProbe_afterMacrotask": [0, 10],
  "frame0": "n=0 d=0 w=0 l=idle                      \n                                        \n                                        \n                                        \n                                        \n                                        \n",
  "frame1_beforeFlush": "n=0 d=0 w=0 l=idle                      \n                                        \n                                        \n                                        \n                                        \n                                        \n",
  "frame1_afterFlush": "n=0 d=0 w=0 l=idle                      \n                                        \n                                        \n                                        \n                                        \n                                        \n",
  "frame1": "n=0 d=0 w=0 l=idle                      \n                                        \n                                        \n                                        \n                                        \n                                        \n",
  "frame1_flushSyncAfterMicrotask": "n=0 d=0 w=0 l=idle                      \n                                        \n                                        \n                                        \n                                        \n                                        \n",
  "frame1_actWrapped": "n=4 d=8 w=0 l=idle                      \n                                        \n                                        \n                                        \n                                        \n                                        \n",
  "connectFiredAfterRead": 1,
  "loadReturn": "done",
  "frame2": "n=4 d=8 w=0 l=done                      \n                                        \n                                        \n                                        \n                                        \n                                        \n",
  "cleanupFired": 1
}
```

(Console also prints the same three `act(...)` warnings shown above — expected,
since parts of the probe deliberately drive un-acted writes to demonstrate the
failure before demonstrating the fix.)

Answering the brief's Step 5 questions directly:

- Did `frame1` differ from `frame0`, in the version of the probe run exactly
  as the brief scripted it (no `act`, no `flushSync`)? **No.** Wrapped in
  `act()`, yes: `n=0` -> `n=4`.
- Did `frame2` show `l=done`? **Yes**, once the same `act()` wrap was applied
  to the async action.
- Did `connectFired` reach 1? **Yes.** Did `cleanupFired` reach 1 after
  `destroy()`? **Yes** — but only once `renderer.destroy()` was itself given
  two microtask ticks inside `act()` for Reatom's disconnect notification to
  land; a bare synchronous `renderer.destroy()` with no ticks left
  `cleanupFired` at 0.
- Did any error mention `react-dom`? **No**, in any of the four run
  configurations (`bun run` x 2 files, compiled `--compile` x 2 files).

## Step 6: Compile it

```
bun build --compile src/main.tsx --outfile probe.exe
 [532ms]  bundle  41 modules
 [880ms] compile  probe.exe

./probe.exe
```

Output was **byte-for-byte identical** to the `bun run` output above, including
all three `act(...)` console warnings and the final JSON block (every field,
including `frame1_actWrapped` and `cleanupFired`). Same result for the
production-path diagnostic:

```
bun build --compile src/prod-path-check.tsx --outfile prod-path-check.exe
./prod-path-check.exe
initial: "n=0                                     "
after set(1) + intermediateRender+idle (no act): "n=1                                     "
after set(2) + 50ms wait + intermediateRender+idle: "n=2                                     "
```

Identical to its `bun run` counterpart. `--compile` changes nothing about this
question; the earlier act-environment finding and its resolution both survive
compilation unchanged. (Compiled `.exe` files were not committed — the source
that produces them is.)

### An unrelated but real finding: the process hangs without an explicit exit

The very first `bun run src/main.tsx` (before `process.exit(0)` was added) ran
to completion — all `console.log` output, including the final JSON, was
printed — but the `bun.exe` process never returned control to the shell. It
was confirmed still alive via `tasklist`/`Get-Process` several minutes later
and had to be killed manually. This happened *after* `renderer.destroy()` had
already been called. Adding an explicit `process.exit(0)` after the final
`console.log` fixed it for every subsequent run, `bun run` and compiled alike.
Round 1 established that headless rendering survives `--compile`; it did not
establish that a headless-rendering **process terminates cleanly** on its own,
and this spike found a case where it does not once `@reatom/react` and
`testRender`'s act-environment machinery are in the mix. Any production code
that runs a Reatom+OpenTUI test-mode render pass to completion and expects the
process to exit on its own should not assume that; a kernel process meant to
stay alive and interactive is unaffected, but a CLI-style one-shot render or a
test runner's child process needs to check this.

## Step 7: Trace names and `context.start`

**Trace names.** `AtomMeta` (the type behind `atom.__reatom`) does **not**
carry a `name` field in the public `.d.ts` — its documented shape is
`{ reactive, middlewares, onConnect }` only, confirmed at runtime:
`Object.keys(counter.__reatom)` -> `["reactive", "middlewares", "pipeline", "processing", "linking", "onConnect"]`,
no `name` key anywhere in it. Names ARE observable at runtime, but through a
different surface: atoms are themselves named JS functions, so the name given
to `atom(0, "probe.counter")` is readable as the ordinary function property
`counter.name === "probe.counter"`, and `counter.toString()` returns
`"[Atom probe.counter]"`. Both were confirmed to survive `bun build --compile`
unchanged (identical values in the compiled binary's JSON output) — Bun's
compiler does not appear to mangle these particular function names. This is
good news for kernel-command-contract-design.md §6's tracing requirement: the
hierarchical names ARE inspectable at runtime via `.name`/`.toString()`, just
not via the typed `__reatom` meta object the way one might first guess.

**`context.start`.** Exists exactly as documented, `interface ContextAtom`
(`node_modules/@reatom/core/dist/index.d.ts:3431-3478`):

```ts
interface ContextAtom extends AtomLike<RootState, [], RootFrame> {
  start<T>(cb: () => T): T;
  start(): RootFrame;
  reset(): void;
}
```

Confirmed callable at runtime: `typeof context.start === "function"`,
`context.start(() => 1) === 1`. kernel-command-contract-design.md §6's test
story ("isolated tests use `context.start`") rests on real, installed API.

## Plain-language summary

`reatomComponent` **does** drive re-renders through OpenTUI's own
react-reconciler-based renderer, not through `react-dom` (which is never
imported, confirmed across every run) — this was proven directly by mounting
through the real production API (`createCliRenderer` + `@opentui/react`'s
`createRoot`), where a plain `atom.set()` reached the rendered frame
immediately with no special handling, in both `bun run` and a compiled
`--compile` binary on Windows. `wrap`, `withAsync`, and `withConnectHook` all
behaved as documented once given a correctly-flushed render pass. The
`-WITH-FALLBACK` in the verdict is for two things a spec author needs to know
about, not for the core adapter question: first, Round 1's proven headless
test harness (`createTestRenderer` via `@opentui/react/test-utils`'s
`testRender`) puts React into "act environment" mode, and in that mode
Reatom-originated writes (which are always async, scheduled off a microtask,
never inside a React event handler) sit un-flushed forever unless the test
code wraps them in `act()` from `'react'` — neither the harness's own
`flush()` nor `@opentui/react`'s exported `flushSync` is a substitute. Anyone
writing automated tests against `reatomComponent`-based OpenTUI screens (which
kernel-command-contract-design.md §6 requires) needs to know this and needs to
import `act` themselves; nothing in either spec currently says so. Second,
a Reatom+OpenTUI process that finishes its work does not exit on its own even
after `renderer.destroy()` — an explicit `process.exit()` is required, which
matters for anything shaped like a one-shot render or a test runner rather
than a long-lived interactive kernel.
