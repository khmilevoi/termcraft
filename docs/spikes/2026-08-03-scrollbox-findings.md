# `<scrollbox>` probe — findings

Date: 2026-08-03
Probe: `src/ui/workspace/ui/scrollbox-probe.test.tsx`
Question set: `docs/superpowers/specs/2026-08-02-chat-scroll-design.md` §9

1. Renders through `createHeadlessRenderer`, content reaches `capture()`: yes
2. Content taller than the viewport is clipped, not overdrawn: yes
3. `stickyStart: "bottom"` holds the newest content and disengages on manual scroll: yes
4. The scrollbar can be suppressed without artifacts: yes
5. **A prepend above the current position: the widget does not hold position.**

Answer 5 is what `Workspace.tsx`'s paging trigger branches on — see the plan's Task 12, which
already has a coded fallback (`pendingAnchor`/`restoreAnchor`) for exactly this answer.

## A methodology bug in the first draft of this probe, and why it mattered

The first draft of tests 3 and 5 simulated "new data arrived" by calling `handle.mount()` a
**second time** with a new `<Probe rows={...} />` element. That produced two alarming, wrong
readings: test 3 appeared to fail deterministically (sticky-bottom re-snapping to the newest
row even though the user had manually scrolled to the top), and test 5 appeared to show
prepended content never rendering at all — `scrollHeight`/`content.height` frozen, and
`capture()` painting the exact same stale text regardless of `scrollTo()` target.

Both readings were artifacts of the test's own update mechanism, not of `<scrollbox>`. Calling
`handle.mount()` again routes through `@opentui/react`'s root-replace path
(`root.render(newElement)` called from *outside* React). `Workspace.tsx` never does this — a
Reatom-subscribed hook re-renders the *same* mounted tree when `chat.records`/
`chat.records.older` arrive, which is a normal React update, not a root replace.

A direct diagnostic (reading `box.content.getChildren().length`, `box.content.height`, and
`handle.layoutTree()` — the resolved Yoga tree, independent of `ScrollBoxRenderable`'s own
bookkeeping) showed that after a second `handle.mount()`, the *actual* Yoga layout and the
*actual* painted frame are both correct (all rows present, correct heights), but
`ScrollBoxRenderable.scrollHeight`/`.content.height` stay stuck at their pre-update value. That
staleness is what produced both false readings, reproducibly, 100% of the time. The same two
scenarios driven through the *same mounted tree's own* `useState` (`StatefulProbe` in the probe
file) — matching how `Workspace.tsx` actually updates — show neither symptom, deterministically
across repeated runs (5/5, then a further 14/15 with the file's final form; the one exception
was the pre-existing, unrelated "the scrollbox ref never resolved" flake `CLAUDE.md` already
documents under "OpenTUI render tests flake under load").

**Consequence:** the feature is viable on `<scrollbox>` as designed. Neither Task 7's merge nor
Tasks 10-12's rendering need the §9 fallback (a self-implemented row-window). Answer 5 is the
same "does not hold position" outcome the plan's Task 12 already designed a fallback for — no
plan amendment needed there either.

One residual note for whoever next touches this widget under a headless renderer: a same-tree
`useState` update needs **two** consecutive `await handle.render()` calls to fully settle
`scrollHeight` (`recalculateBarProps()`'s effects lag one `render()` behind the state update
when the update originates outside a React event handler, e.g. directly from test code). A
single `render()` after such an update under-reports `scrollHeight`/`content.height`. Every
`mirror.apply()`-driven test elsewhere in this plan updates through Reatom's own binding, not a
bare `useState` call from test code, so this exact lag has not been observed to apply there —
noted here only in case a future widget-level test hits the same shape.
