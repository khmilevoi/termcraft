# State in a termcraft page — Reatom v1001

Pages hold state in Reatom, re-exported through `@termcraft/runtime`. This runtime is
**Reatom v1001**. Most Reatom code in the wild is v3, and the two APIs are not compatible.
Read the next section before writing any state at all.

## v1001 vs v3 — the mistakes that pass typecheck and crash at render

**There is no `ctx`.** Not in components, not in actions, not in computeds. Nothing in
this runtime ever hands you a context object, and `@reatom/runtime`'s own `Ctx` type does
not exist here.

**There is no `.spy`.** Reading another atom is a plain call: `count()`.

`reatomComponent(fn)` calls `fn(props)` — the first parameter is **React props**, never a
context. A page that writes `function Page(ctx) { ctx.spy(x) }` typechecks the moment `ctx`
is annotated `any`, then throws `TypeError: ctx.spy is not a function` on the first render.

Never annotate a parameter `any` to silence a type error. If a parameter's type is not
obvious from this file, the call shape itself is wrong — fix the call, not the annotation.

| Wrong (v3 / React habits)                                 | Right (v1001)                           |
| --------------------------------------------------------- | --------------------------------------- |
| `ctx.spy(count)`                                          | `count()`                               |
| `ctx.get(count)`                                          | `count()`                               |
| `count(ctx, 5)` — throws `Can't call atom with arguments` | `count.set(5)`                          |
| `action((ctx, id) => …)`                                  | `action((id) => …, "name")`             |
| `reatomComponent(function Page(ctx) {…})`                 | `reatomComponent(function Page() {…})`  |
| `useState` / `useEffect` / `useMemo`                      | `atom` / `computed` / `withConnectHook` |

## The four primitives

Name every atom, computed and action — the name is what traces and diagnostics show.

    import { atom, computed, action, reatomComponent, Text } from "@termcraft/runtime"

    // read: call it. write: .set(...)
    const countAtom = atom(0, "countAtom")

    // derived, read-only — recomputes when what it reads changes
    const doubled = computed(() => countAtom() * 2, "doubled")

    // a command: a named function that writes
    const bump = action(() => countAtom.set(countAtom() + 1), "bump")

    export default reatomComponent(function Page() {
      return <Text id="count">{`${countAtom()} / ${doubled()}`}</Text>
    }, "Page")

`reatomComponent` re-renders the component whenever an atom or computed it _called during
render_ changes. Nothing else subscribes it — there is no dependency array.

## Where state lives

Declare atoms, computeds and actions at **module scope**, above the component. Never create
an atom inside a component body: the body reruns on every render and would rebuild the atom
each time, discarding its value.

    const selectedIdAtom = atom("green", "selectedIdAtom")     // correct — module scope

    export default reatomComponent(function Page() {
      const selectedId = selectedIdAtom()                       // read
      …
    })

## Writing state

Write with `.set(...)` directly. Do not add an action that only forwards a value into an
atom — `const setSelected = action((v) => selectedIdAtom.set(v))` is pure noise; call
`selectedIdAtom.set(v)` at the call site instead.

Reach for an action when a command means **more than one write**, or when you want the
step named in traces:

    const selectPalette = action((id: string) => {
      selectedIdAtom.set(id)
      lastChangedAtom.set(id)
    }, "selectPalette")

## Event handlers

A handler runs outside the render pass, so it must re-enter the Reatom context before it
touches an atom. Wrap it:

    import { wrap } from "@termcraft/runtime"

    <Tabs
      id="palette-menu"
      tabs={OPTIONS}
      activeId={selectedIdAtom()}
      onSelect={wrap((id: string) => selectedIdAtom.set(id))}
    />

A handler that is only a named action already carries its own context — `onSelect={selectPalette}`
is fine as-is.

Note: the MVP renders pages statically. `onSelect`/`onPress` are accepted and stay inert
until the interactive path lands, so a page must still be correct and complete on its
first, un-clicked render — never rely on a handler having run.

## Derived writable state

When a value must be writable but should reset from another atom, use `withComputed` —
never a manual sync step.

    import { withComputed } from "@termcraft/runtime"

    // the callback receives the atom's CURRENT state and returns its next one, so it can
    // keep what is already there instead of always recomputing
    const draftTitleAtom = atom("", "draftTitleAtom").extend(
      withComputed(() => selectedPageAtom().title),
    )

## Async

Pages are deterministic single renders, so most pages need none of this. When one does:

- **Reading** data: `computed(async () => …, "name").extend(withAsyncData())`, then read
  `.data()`, `.ready()` and `.error()` off it. Never fetch from an effect. `withAsyncData`
  takes an **options object**, not a bare initial value — `withAsyncData({ initState: [] })`.
- **A command** that awaits: `action(async () => …, "name").extend(withAsync())`.
- Cross **every** async boundary with `wrap(...)`: `const rows = await wrap(load())`. An
  atom touched after an unwrapped `await` lands on the wrong context.
- Read every reactive input **before the first `await`**. A read after it never becomes a
  dependency, so the computed silently stops updating.

## Long-lived effects

Anything with a lifetime — a subscription, a listener — belongs to a connection, via
`withConnectHook`, and must return its cleanup:

    import { withConnectHook } from "@termcraft/runtime"

    const feedAtom = atom<string[]>([], "feedAtom").extend(
      withConnectHook(() => {
        const stop = subscribeSomewhere((v) => feedAtom.set(v))
        return () => stop()
      }),
    )

Remember the page rules: no `setTimeout`/`setInterval`/`Math.random` outside animation
guarded by the export flag, and the first frame must be deterministic.

## Checklist before you finish

- No `ctx` parameter anywhere, and no `.spy(`.
- No `any` annotation added to make a type error go away.
- Every atom, computed and action has a name string.
- Atoms are declared at module scope, not inside the component.
- Writes go through `.set(...)`; no action that only forwards one value.
- Handlers that touch atoms are `wrap`ped or are actions.
- Every reactive read in an async body happens before the first `await`.
