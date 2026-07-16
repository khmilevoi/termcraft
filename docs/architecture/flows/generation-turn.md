One generation turn: from the designer pressing Enter to validated page-source changes on disk. Covers the staging directory the agent works in, how its edits are confined, the validation Gate with retries, and how changed pages replace their canonical sources.

```mermaid
sequenceDiagram
    actor U as Designer
    participant UI as UI shell
    participant K as Kernel
    participant G as Agent gateway
    participant C as Agent CLI
    participant F as SafeProjectFs
    participant V as Gate
    participant S as Project store

    U->>UI: message + selection + open pins
    UI->>K: send-message command
    K->>K: allocate turnId, absolute deadline, unique workspace
    K->>S: admission TurnTransaction: append user record + capture read set
    K->>G: start fenced run (workspace cwd, prompt, model · effort)
    G->>C: SDK run, confined to this turn workspace
    C-->>G: vendor event stream
    G-->>K: normalized AgentEvents (reasoning, tool, usage)
    K-->>UI: ephemeral status into chat (spinner, tool steps, reasoning ticker)
    C->>C: reads and edits staging files directly
    C-->>G: run ends
    G-->>K: confirmed process-tree exit
    K->>F: copy allowed files while validating paths
    F-->>K: immutable candidate + inventory + hashes
    K->>V: diff candidate vs send snapshot → validate
    loop while invalid and retries remain (max 3 retries)
        K->>G: errors appended to the conversation
        K->>G: start retry with fresh attempt + leaseNonce
        G->>C: SDK retry in same turn workspace after prior exit
        C->>C: fixes the invalid candidate source
        C-->>G: run ends
        K->>F: freeze replacement immutable candidate
        K->>V: re-validate the diff
    end
    alt valid
        K->>K: acquire project-write mutex for final apply
        K->>S: prepare immutable payloads and plan
        K->>S: CAS current hashes against transaction preconditions
        K->>S: write durable commit-intent
        K->>S: idempotently roll forward pages, portable order, local state, chat, pins
        K->>S: mark committed
        K->>K: release project-write mutex
        K-->>UI: result + new revision/capabilities
        UI->>UI: refresh overlays and PreviewSession
    else invalid after retry budget
        K->>S: terminalization TurnTransaction to captured target chat
        K->>K: retire unique workspace for quarantine/GC
        K-->>UI: emit turn failure; no apply
    end
```

## Walkthrough

1. Send: command acceptance mints `turnId` and starts the absolute deadline. The
   message goes out with the selection chip (only if its element id resolves in the
   active page's Current design at send time) and open pins whose anchors resolve.
   Under the project-write mutex, an admission `TurnTransaction` first appends the
   user record to the captured `targetChatId`; the complete source, portable
   manifest, chat, and comments CAS read set is then snapshotted into the unique
   workspace. Local tab/preview/selection values are snapshot context, not freshness
   preconditions. Tab
   switching later does not change this context. Details:
   `flows/pins-and-selection.md`.
2. Staging: a stable machine-local sandbox parent contains a unique `turns/<turnId>/workspace/` for every turn; no later turn clears or reuses it. Each canonical `page.tsx` is exposed as `pages/<slug>.tsx`, alongside `pages.json` and the `@termcraft/runtime` reference/types. The backend receives this workspace directory as cwd and only writable root. Resume is used only when the backend can rebind the session to it; otherwise a fresh session is seeded from chat. The prompt carries source-derived metadata, current diagnostics independent of active chat, selection, pins, style guidance, and the message. All pages remain materialized until benchmarks justify an on-demand protocol.
3. Confinement and freezing: Codex receives workspace-write rooted at the turn work; Claude receives that cwd plus file-tool permission checks and no Bash/web. Every attempt is fenced by `{turnId, attempt, leaseNonce}`. After confirmed process-tree exit, `SafeProjectFs` rejects traversal, links, ambiguous Windows paths, non-regular files, and configured limits while copying allowed bytes into an agent-inaccessible immutable candidate. The Gate never reads the writable workspace.
4. The backend contract is mechanism-blind: a backend's only obligation is to stream events and leave the turn's proposed changes in staging by run end. Agents with native file tools edit staging directly; a future backend whose agent cannot do that fulfills the same contract by writing the model's structured full-file output into staging itself — the Kernel, diff, Gate, and apply are identical either way.
5. While the turn runs: normalized events are accepted only from the active fence. Any event resets the 120-second silence timeout but cannot reset the 30-minute default absolute deadline shared by the initial attempt and retries. The UI renders the same bounded ephemeral status block. Ordinary Send remains disabled, while local slash-command mode keeps `/commit-page`, `/commit-infra`, and `/commit-all` available according to Kernel capability; other turn-locked rows remain dimmed. Actual scoped commit and final apply serialize through the project-write mutex. Git hooks may change `.termcraft/`, so final apply later compare-and-swaps its preconditions instead of overwriting drift.
6. Page management is file management: a new `pages/<slug>.tsx` staging file adds a page and becomes `.termcraft/pages/<slug>/page.tsx` on apply; deleting one unlists the page and removes its canonical source; portable reordering or an optional local `requestedActivePage` is a `pages.json` edit; retitling edits the page's own `meta.title`. Slugs must match the slug mask, avoid Windows device names, and never rename an existing page identity. In a Git repository, deleting a page does not erase its committed path history, and recreating the slug resurrects the same identity.
7. The Gate validates the immutable candidate: manifest-slice syntax/order/slugs; the single `@termcraft/runtime` import surface; TypeScript against embedded runtime types; static meta including supported `kitApiVersion`; default `reatomComponent`; and a disposable supervisor-owned smoke host. Lints remain warnings for dropped ids, pointable low-level elements without ids, unguarded time/randomness, and navigation to unlisted pages. Semantic checks are distinct from `SafeProjectFs` path/object safety.
8. Failure branch: still invalid after the initial attempt plus 3 retries — the Kernel appends an honest error to captured `targetChatId` through a terminalization `TurnTransaction`, retires the unique workspace for bounded quarantine or garbage collection, emits turn failure, and performs no canonical-source change.
9. Failure branch: cancellation by `Esc`, silence, or absolute deadline transitions through graceful abort then hard process-tree kill. A new turn cannot start until exit is confirmed; inability to confirm makes the backend unhealthy. Before commit intent, cancellation records the terminal outcome and changes no canonical source. After commit intent, cancellation is disabled and recovery must finish roll-forward.
10. Failure branch: session resume requires the chat UUID, opaque backend session scope, exact record-count/prefix-hash checkpoint, and workspace rebinding capability. Any mismatch starts a fresh session seeded with a bounded recent-chat excerpt. Other local session entries remain inert until their own checks pass.
11. Apply: under the project-write mutex, `TurnTransaction` first prepares
    immutable payloads for changed canonical pages, portable page-order changes,
    any requested local active-page effect composed from current local state, the
    agent record, and append-only pin status events, and writes the durable plan.
    Under the same write permit the Kernel then verifies every old source,
    portable manifest, chat, and comments precondition from the send snapshot,
    and only with current preconditions writes the durable commit intent.
    After durable commit intent, writes are idempotent and roll-forward-only; a
    committed marker completes the transaction. Startup recovers pending intent
    before Workspace. Unexpected hashes enter recovery conflict without overwrite.
    Page metadata is extracted from source into a rebuildable local cache, never
    copied into `project.toml`. An empty diff records `"changedPages":[]`. UI only
    reflects the resulting revision and opens the new `PreviewSession`.

## Source anchors

- `docs/superpowers/specs/2026-07-16-git-backed-page-history-design.md` — §2 canonical page sources and explicit Git controls, §5 generation and `changedPages`, §8 commit/apply mutex behavior, §11 MVP and v1 acceptance criteria
- `docs/superpowers/specs/2026-07-13-termcraft-design.md` — §6.1 backend abstraction, the `AgentEvent` taxonomy and per-backend normalization, and confinement, §6.2 staging and the turn protocol, §6.3 the Gate, §3.2 turn-time locks and streaming-status presentation (ephemeral block, reasoning ticker, markdown-lite), §3.9 chats and context usage, §5.8 design-code rules, §9 cancel, hang, and sandbox-degradation handling
- `docs/superpowers/specs/2026-07-16-turn-durability-staging-design.md` — per-turn workspace, fencing, immutable candidate, compare-and-swap, recovery, and fault injection
- `docs/superpowers/specs/2026-07-16-kernel-command-contract-design.md` — capabilities, turn-state guards, revisions, and typed results
- `docs/superpowers/specs/2026-07-16-runtime-api-compatibility-design.md` — runtime-only Gate and page contract
- `design/03-workspace-generating.dc.html` — streaming status presentation
- `design/12-errors-edge-states.dc.html` — error presentation in chat
