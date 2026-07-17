// Spike D probe: does `reatomComponent` from @reatom/react drive re-renders
// through OpenTUI's own React reconciler (not react-dom)?
//
// This is throwaway evidence code, not product code. See FINDINGS.md for the
// verdict and the reasoning. Failure is a valid outcome here — this file must
// not be adjusted to force a passing result.

import { atom, action, computed, wrap, withAsync, withConnectHook, context } from "@reatom/core"
import { reatomComponent } from "@reatom/react"
import { testRender } from "@opentui/react/test-utils"
import { flushSync } from "@opentui/react"
import { act } from "react"

const results: Record<string, unknown> = {}

// 1. Plain reactive read: an atom write must reach the frame.
const counter = atom(0, "probe.counter")
const doubled = computed(() => counter() * 2, "probe.doubled")

// 2. withConnectHook: must fire on connect, and its cleanup on disconnect.
let connectFired = 0
let cleanupFired = 0
const watched = atom(0, "probe.watched").extend(
  withConnectHook(() => {
    connectFired++
    return () => {
      cleanupFired++
    }
  }),
)

// 3. withAsync across a real await, re-entering Reatom through wrap.
const loaded = atom("idle", "probe.loaded")
const load = action(async () => {
  await wrap(Promise.resolve())
  loaded.set("done")
  return "done"
}, "probe.load").extend(withAsync())

const Probe = reatomComponent(() => {
  // Read lazily, per the handbook's React rules.
  const n = counter()
  const d = doubled()
  const w = watched()
  const l = loaded()
  return <text>{`n=${n} d=${d} w=${w} l=${l}`}</text>
}, "probe.Probe")

async function main() {
  // Step 7a: are named atoms/computed/actions observable by name at runtime?
  // Probe every surface that could plausibly carry the name: the function's
  // own `.name` (atoms are callable functions), `toString()`, and the
  // `__reatom` meta object the public AtomLike interface exposes.
  results.nameProbe = {
    "counter.name": (counter as unknown as { name: string }).name,
    "counter.toString()": counter.toString(),
    "counter.__reatom keys": Object.keys(counter.__reatom),
    "counter.__reatom JSON": (() => {
      try {
        return JSON.stringify(counter.__reatom)
      } catch (e) {
        return `<unserializable: ${String(e)}>`
      }
    })(),
    "doubled.name": (doubled as unknown as { name: string }).name,
    "load.name": (load as unknown as { name: string }).name,
  }

  // Step 7b: does context.start exist with the documented signature?
  results.contextStartProbe = {
    "typeof context.start": typeof context.start,
    "context.start(() => 1)": context.start(() => 1),
  }

  // Isolation probe: does plain Reatom reactivity (no React, no OpenTUI)
  // notify a subscriber after a microtask tick? This separates "Reatom's own
  // scheduler is broken" from "the React/OpenTUI binding is broken".
  {
    const isolationSeen: number[] = []
    const unsub = doubled.subscribe((v) => isolationSeen.push(v))
    counter.set(5)
    await Promise.resolve() // one microtask, matching _enqueue's Promise.resolve().then(notify)
    await Promise.resolve()
    results.isolationProbe_afterTwoMicrotasks = [...isolationSeen]
    await new Promise((r) => setTimeout(r, 0)) // one macrotask
    results.isolationProbe_afterMacrotask = [...isolationSeen]
    unsub()
    counter.set(0) // reset for the render probe below
  }

  const { renderer, renderOnce, captureCharFrame, flush } = await testRender(<Probe />, {
    width: 40,
    height: 6,
  })

  await renderOnce()
  results.frame0 = captureCharFrame()

  counter.set(1)
  await renderOnce()
  results.frame1_beforeFlush = captureCharFrame() // did n=0 become n=1, before any explicit flush?

  // React's own scheduler may batch the reconciler pass triggered by
  // reatomComponent's setState-based rerender outside of act()'s synchronous
  // flush window (the console printed "not wrapped in act(...)" warnings).
  // Try the harness's own settle primitive first.
  await flush()
  await renderOnce()
  results.frame1_afterFlush = captureCharFrame()

  // Try @opentui/react's own exported `flushSync` (a production API, not a
  // test-only helper) around a second write, in case plain `flush()` only
  // settles the OpenTUI render buffer and not React's own scheduler queue.
  flushSync(() => counter.set(2))
  await renderOnce()
  results.frame1 = captureCharFrame() // did n=0 become n=2 via flushSync wrapping the write?

  // Reatom's own notify is scheduled on a microtask (Promise.resolve().then),
  // which lands AFTER a synchronous flushSync(() => set(...)) callback
  // returns — so the wrap above cannot have forced anything. Try flushSync
  // with an EMPTY callback, called only after the microtask has had a chance
  // to run and call React's setState, to see if that forces the pending
  // update to commit.
  counter.set(3)
  await Promise.resolve()
  await Promise.resolve()
  flushSync(() => {})
  await renderOnce()
  results.frame1_flushSyncAfterMicrotask = captureCharFrame()

  // Last resort diagnostic (test-only React Testing Library utility, not a
  // production API): does wrapping the write in `act()` from 'react' force
  // this specific act-environment (testRender sets
  // IS_REACT_ACT_ENVIRONMENT = true) to actually commit the update? This
  // distinguishes "the test harness suppresses updates outside act()" from
  // "the production reconciler binding is fundamentally broken".
  await act(async () => {
    counter.set(4)
    await Promise.resolve()
    await Promise.resolve()
  })
  await renderOnce()
  results.frame1_actWrapped = captureCharFrame() // THE real verdict

  watched() // force a connection
  results.connectFiredAfterRead = connectFired

  // Apply the act()-wrap lesson learned above to the async action too: its
  // internal `loaded.set("done")` happens after a real `await`, same
  // out-of-band-write shape as the earlier failures.
  let loadReturn: unknown
  await act(async () => {
    loadReturn = await load()
  })
  results.loadReturn = loadReturn
  await renderOnce()
  results.frame2 = captureCharFrame() // did the async action reach the frame?

  await act(async () => {
    renderer.destroy()
    await Promise.resolve()
    await Promise.resolve()
  })
  results.cleanupFired = cleanupFired // did withConnectHook's cleanup run?

  console.log(JSON.stringify(results, null, 2))

  // FINDING: without an explicit exit, the process hangs after main()
  // completes even though renderer.destroy() was called — see FINDINGS.md
  // Step 5/6 notes. Reported as a finding, not silently worked around.
  process.exit(0)
}

main()
