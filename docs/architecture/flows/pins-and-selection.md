The mouse never edits the design — it annotates it. This document covers element selection (context for the next message) and pin comments (notes anchored to elements), including what happens when the element under a pin disappears.

```mermaid
stateDiagram-v2
    state "Current design\n(pin mutations enabled)" as CurrentDesign
    state "Historical snapshot\n(overlay only)" as Historical
    [*] --> CurrentDesign
    CurrentDesign --> CurrentDesign: create pin -> Open
    CurrentDesign --> CurrentDesign: include resolving Open pin -> Sent
    CurrentDesign --> CurrentDesign: successful apply / status change -> Resolved
    CurrentDesign --> CurrentDesign: reopen / status change -> Open
    CurrentDesign --> Historical: select historical commit
    Historical --> CurrentDesign: return; pin mutations re-enabled
    note right of Historical
        Existing current pins may render as overlays only.
        No pin creation, reopening, or status-change
        transition is available in this state.
    end note
    note left of CurrentDesign
        A pin whose anchor does not resolve in the
        current render shows as "not visible" in the
        pin list; never auto-deleted, never sent.
    end note
```

## Walkthrough

1. Hover, in static mode, highlights element boundaries through the current `PreviewSession`; the supervisor answers hit-grid queries with element id, rectangle, and full incarnation-local frame identity `(previewSessionId, nonce, sourceHash, frameSeq)`. The Kernel converts a right-click hit into a bounded opaque `geometryToken` that also binds page slug, element id, and fractional coordinates. Stale replies are ignored.
2. Left click selects the deepest element under the cursor; a chip like `gauge "CPU Usage"` (component kind + label, reported by the host) attaches to the composer; `Esc` deselects.
3. Selection is stored as (page, element id); the rectangle is re-queried from the host every frame. On a historical snapshot, its overlay is shown only while that id resolves in the historical render; a missing historical id suppresses the overlay without clearing the selection. Switching page tabs clears the selection. Send is disabled while browsing history, and after returning to Current design the chip is included in the prompt only if the id resolves against the active page's canonical current source at send time.
4. Right click, in static or interactive mode against Current design, drops a pin: a mini input opens over a dimmed preview. `pin.create` sends the Kernel-issued `geometryToken` plus text; the Kernel accepts it only while the token still names the displayed Current source and frame. A stale token is rejected and geometry is queried again. The pin anchors to the token's (element id, fractional position inside the element's rect) and renders clamped inside that rect — pins stay proportionally placed as the element resizes.
5. Pin records persist in the page's append-only comments log. Creation and each open/resolved transition are separate UUIDv7 records for the stable `pinId`; old lines are never rewritten. The resulting `pins.changed` event returns complete affected-pin DTOs, including the newly minted `pinId`, so later status commands never infer identity from list order.
6. Lifecycle: against Current design, open pins whose anchors resolve at send time are sent with the next message; successful `TurnTransaction` appends resolved events only for sent pins whose page is present in non-empty `changedPages`, in the same recoverable commit as page/chat changes. An empty design diff leaves them open. The designer can append a reopen event later; UI never persists status itself.
7. Historical overlays and mutation lock: the diagram's **Current design** state is the guard for every transition that creates a pin, reopens one, or changes lifecycle status. Existing current pins are drawn on a historical snapshot only when their element ids resolve in that historical render, using the stored fractional position in the historical element rectangle. The **Historical snapshot** state is overlay-only and has no pin-lifecycle mutation transition; creating pins, reopening resolved pins, and changing any pin status remain disabled until returning to **Current design** re-enables them. Browsing history never restores pin data and never changes pin records or their open/resolved statuses; Restore also leaves them untouched.
8. Failure branch (unresolved pins): a pin is drawn exactly when its anchor resolves in the host's current render; otherwise it stays in the chat panel's pin list marked "not visible in the current render (hidden or removed)" — no claim about source history, since the design's own state can hide and reveal elements: a pin inside a closed dialog reappears when the dialog opens. Unresolved pins are never auto-deleted and, when Current design is active, are skipped when sending to the agent.
9. History scope: pin-only commits change pin storage rather than a page's canonical `page.tsx`, so they never select or create entries in that page's path-limited history.
10. Scope note: selection and pins are mouse-only in v1.0; keyboard element navigation is backlog.

## Source anchors

- `docs/superpowers/specs/2026-07-16-git-backed-page-history-design.md` — historical overlay resolution, pin/status preservation during browse and Restore, canonical-source send behavior, and exclusion of pin-only commits from page history
- `docs/superpowers/specs/2026-07-13-termcraft-design.md` — §3.2 mouse selection and pin comments, §4.2 host hit and rect queries, §6.2 send-time inclusion, §7.1 comments record schema
- `docs/superpowers/specs/2026-07-16-production-storage-identity-design.md` — UUID pin-event records
- `docs/superpowers/specs/2026-07-16-host-supervision-protocol-design.md` — frame-sequenced geometry queries
- `design/07-selection-hover.dc.html` — hover and selection states
- `design/08-pin-comments.dc.html` — pin placement and pin list
