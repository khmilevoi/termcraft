One generation turn: from the designer pressing Enter to validated page-source changes on disk. Covers the staging directory the agent works in, how its edits are confined, the validation Gate with retries, and how changed pages replace their canonical sources.

```mermaid
sequenceDiagram
    actor U as Designer
    participant UI as UI shell
    participant K as Kernel
    participant G as Agent gateway
    participant C as Agent CLI
    participant V as Gate
    participant S as Project store

    U->>UI: message + selection + open pins
    UI->>K: send-message command
    K->>K: assemble staging (canonical sources, manifest slice, kit reference)
    K->>S: append user record to active chat
    K->>G: start turn (staging path, prompt, model · effort)
    G->>C: SDK run, confined to staging
    C-->>G: vendor event stream
    G-->>K: normalized AgentEvents (reasoning, tool, usage)
    K-->>UI: ephemeral status into chat (spinner, tool steps, reasoning ticker)
    C->>C: reads and edits staging files directly
    C-->>G: run ends
    K->>V: diff staging vs snapshot → validate
    loop while invalid and retries remain (max 3 retries)
        K->>G: errors appended to the conversation
        C->>C: fixes staging files
        C-->>G: run ends
        K->>V: re-validate the diff
    end
    alt valid
        K->>K: acquire project-write mutex for final apply
        K->>S: replace changed page.tsx sources, update manifest
        K->>S: append agent record with changedPages and warnings
        K->>S: persist sent-pin resolution in comments.jsonl
        K->>K: release project-write mutex
        K-->>UI: page, source, and pin-state change events
        UI->>UI: refresh displayed overlays/state, respawn preview host
    else invalid after retry budget
        K->>S: append error record to active chat
        K->>K: clear staging
        K-->>UI: emit turn failure; no apply
    end
```

## Walkthrough

1. Send: the message goes out with the selection chip (only if its element id resolves in the active page's current design at send time) and open pins whose anchors resolve. The turn's context — canonical sources, active page, selection, and pins — is snapshotted into staging at send time, so switching tabs mid-turn does not change what the agent sees. Details: `flows/pins-and-selection.md`.
2. Staging: machine-local scratch at a stable per-project path, cleared and repopulated at the start of every turn. Each `.termcraft/pages/<slug>/page.tsx` canonical source is exposed to the agent as a flat `pages/<slug>.tsx` staging copy, alongside `pages.json` (the manifest slice: ordered slugs and the active page) and the kit reference (docs plus type declarations). The path is stable across turns and restarts so that resumed agent sessions' file references stay valid — and the Codex sandbox's writable root stays a configuration constant. The prompt carries the designer role, design-code rules, the project manifest (page list with cached titles), outstanding warnings (Gate and host-reported), selection, pins, answer-style guidance (final message short, light markdown), and the user message. There is no read protocol or prefetch policy: the agent reads whatever staging files it wants with its own tools.
3. Confinement: each backend uses its native mechanism to keep the agent inside staging — Codex's workspace-write sandbox rooted there (network restricted by default), Claude Code's permission rules with a per-tool-call veto callback. Confinement is defense-in-depth; correctness rests on the Gate accepting only what landed in staging and validated.
4. The backend contract is mechanism-blind: a backend's only obligation is to stream events and leave the turn's proposed changes in staging by run end. Agents with native file tools edit staging directly; a future backend whose agent cannot do that fulfills the same contract by writing the model's structured full-file output into staging itself — the Kernel, diff, Gate, and apply are identical either way.
5. While the turn runs: the backend normalizes its vendor SDK events into the `AgentEvent` stream — `reasoning` chunks, `tool` steps (op + target), `final`, `usage`, `error`; unmapped vendor events are dropped, and any event resets the 120-second silence watchdog. The UI renders these as an ephemeral block in chat, never persisted: a spinner line, tool steps accumulating beneath it (`✓` done, `▸` current), and one to three faint lines holding only the latest reasoning chunk — a ticker, not a log. Gate retries add a Kernel-emitted `✗ … retry N/3` line. When the turn ends the block collapses into the persisted agent record: the final message rendered in markdown-lite (bold, italic, inline code, bullet lists; everything else flattens to plain text) plus one `✓ <page> updated` line per slug in `changedPages`. Typing the next message and switching page tabs are allowed, but sending stays disabled; Restore, export, the agent · model · effort picker, and chat creation and switching are locked, each refusal hinted in the status bar. The v1 commit controls remain usable throughout the turn: only an actual scoped commit and the short final apply serialize through the project-write mutex, never the agent run or Gate retries. The composer's context-usage indicator updates from `usage` events; a backend that reports nothing hides the indicator.
6. Page management is file management: a new `pages/<slug>.tsx` staging file adds a page and becomes `.termcraft/pages/<slug>/page.tsx` on apply; deleting one unlists the page and removes its canonical source; reordering or switching the active page is a `pages.json` edit; retitling is editing the page's own `meta.title`. Slugs must match the slug mask, avoid Windows device names, and never rename an existing page identity. In a Git repository, deleting a page does not erase its committed path history, and recreating the slug resurrects the same identity.
7. The Gate, when the run ends, validates the staging diff: manifest-slice checks (parse, slug mask, permutation, active page exists); per changed page the import allowlist (only the kit, React, and OpenTUI), a TypeScript check against the embedded types, the page contract (`meta` as a static literal plus a default-export component), and a smoke render — a disposable design host mounts the page once at its minimum size, surfacing import errors, render crashes, and duplicate ids visible in that render before anything is applied. Lints come back as warnings, not errors: dropped ids that selection or open pins reference, pointable raw elements without ids, timers or randomness outside the export-flag guard, navigation to unlisted pages.
8. Failure branch: still invalid after the initial attempt plus 3 retries — the Kernel appends an honest error to the active chat as a system record, clears staging, emits turn failure, and performs no apply; no canonical source is changed by the turn.
9. Failure branch: cancellation, whether by `Esc` or 120 seconds of stream silence — the SDK run is aborted, a system record is written to chat, staging is cleared, and the canceled turn changes no canonical source.
10. Failure branch: session resume fails (a stale session, another machine, or a switched backend) — termcraft silently starts a fresh session seeded with a short excerpt of that chat's recent records. Each chat has its own SDK session (a machine-local chat → session id map); switching chats resumes the target chat's session. Switching agent or model starts a fresh session for the active chat; other chats' stored ids simply fail resume later and take the same fallback.
11. Apply: only after validation succeeds, the Kernel acquires the project-write mutex and maps every changed staging page to its one canonical `.termcraft/pages/<slug>/page.tsx`. Each changed canonical source is written through a temporary file plus rename; manifest-slice edits update the project manifest, and evaluated page metadata (title and minimum size) is re-cached there. The Kernel also asks the Project store to append the agent record with `changedPages` and Gate warnings and to persist resolution of the pins sent with that successfully applied message in the page's `comments.jsonl`, all before releasing the mutex. Page, manifest, chat, and pin per-file writes therefore serialize, but they are not one crash-safe transaction: a crash during this multi-file apply can leave a partially applied turn until a separate Turn Transaction design exists. An empty diff is valid — a purely conversational turn changes no page source and records `"changedPages":[]`. After the mutex is released, the UI only refreshes its displayed page, source, and pin overlays/state and respawns the preview host; it does not persist pin status. The UI shell switches the active page only when the agent changed it in `pages.json`; adding a page alone does not switch. Apply completion also refreshes Git status on the canonical source selected after apply.

## Source anchors

- `docs/superpowers/specs/2026-07-16-git-backed-page-history-design.md` — §2 canonical page sources and explicit Git controls, §5 generation and `changedPages`, §8 commit/apply mutex behavior, §11 MVP and v1 acceptance criteria
- `docs/superpowers/specs/2026-07-13-termcraft-design.md` — §6.1 backend abstraction, the `AgentEvent` taxonomy and per-backend normalization, and confinement, §6.2 staging and the turn protocol, §6.3 the Gate, §3.2 turn-time locks and streaming-status presentation (ephemeral block, reasoning ticker, markdown-lite), §3.9 chats and context usage, §5.8 design-code rules, §9 cancel, hang, and sandbox-degradation handling
- `design/03-workspace-generating.dc.html` — streaming status presentation
- `design/12-errors-edge-states.dc.html` — error presentation in chat
