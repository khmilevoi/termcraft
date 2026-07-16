How a designer runs several conversations over one project: the slash menu in the composer, creating and switching chats, per-chat agent sessions, and the context-usage indicator that prompts starting fresh.

```mermaid
flowchart TD
    composer["Composer (focused by default)"] -- "types / on empty input" --> menu["Slash menu — autocomplete over the action table"]
    menu -- "/new" --> create["create next chat file, mark it active"]
    menu -- "/chats" --> list["chat list popup — derived names, newest first"]
    menu -- "/commit-page · /commit-infra · /commit-all" --> commit["plan selected scope → unchanged confirmation dialog"]
    list -- "Enter on a chat" --> switch["switch active chat"]
    create --> fresh["fresh agent session, no carried context"]
    switch --> resume{"stored session id resumes?"}
    resume -- "yes" --> cont["conversation continues where it left off"]
    resume -- "no (stale, other machine, switched backend)" --> seed["fresh session seeded with that chat's recent records"]
    usage["composer border: context-usage indicator"] -. "prompts the call to start fresh" .-> composer
```

## Walkthrough

1. A chat is only a conversation line: switching swaps the visible history and the agent session and touches nothing else — active page, preview state, selection, and pins stay put. Pages are shared state: each turn's staging is assembled from every page's canonical current `page.tsx` at send time, so changes made from another chat are immediately part of later turns (see `flows/generation-turn.md`). In v1, a Git Restore likewise changes the shared canonical source rather than a chat-local state.
2. The slash menu: typing `/` as the first character of an empty composer (or the Home prompt) opens an autocomplete list rendered from the action table — the same registry that drives hotkeys and status-bar hints. An unavailable command shows dimmed with the hint the status bar would give; a command meaningless on the current screen is hidden. The set is small by design: `/new`, `/chats`, `/export` (MVP), then `/model`, `/commit-page`, `/commit-infra`, and `/commit-all` (v1.0). The three commit commands have no persistent button or mouse twin; each row owns its dirty dot, changed-file count, and clean-scope disabled state. Live view controls stay on keys, while the composer's model chip and the v1 current-design/history segment remain clickable.
3. `/new` creates the next chat file (ids are termcraft-assigned, `c1`, `c2`, …), marks it active, and starts a fresh agent session with no carried context — the context-reset gesture.
4. `/chats` opens the chat list popup: derived names (the first line of each chat's first user record) with timestamps, newest first, the active chat marked; Enter switches.
5. Switching resumes the target chat's stored SDK session id.
   - *Failure:* resume fails (a stale session, another machine, a switched backend) — a fresh session starts silently, seeded with a short excerpt of that chat's recent records.
6. Context usage: an indicator on the composer's border renders token usage the backend reports in its event stream; a backend that reports nothing hides the indicator. termcraft never compacts a conversation itself — starting a new chat is the designer's context management.
7. Commit commands: `/commit-page`, `/commit-infra`, and `/commit-all` all dispatch through the action table to the Kernel's existing scope planner and open the same editable-message/exact-path confirmation dialog. Status refresh changes the dots, counts, and enabled states on their slash-menu rows; no Git status is stored in the chat and no commit is correlated with a prompt.
8. One turn runs at a time per project regardless of chat. Generic system records for errors and cancellations keep their existing behavior and land in the chat that was active when the event occurred. For an explicit v1 Restore, at confirmation the Kernel captures that current chat as `targetChatId`, stores it in the action plan, and binds the unique `restoreActionId` to `targetChatId` as well as the page, full source commit id, and confirmed pre-Restore source hash. Initial append reads and writes only that captured target chat file, even if the UI active chat changes first. The Restore record contains `restoreActionId`, page, and full source commit id, but no redundant `targetChatId`: its containing chat file is its persisted chat identity, and a later Git commit remains unrelated to that chat or prompt. If append becomes ambiguous, `record-pending` retains `targetChatId` in memory and append-only **Retry record** checks and, if needed, appends only that captured chat with the same action id. Chat creation and switching need not be globally blocked by `record-pending`; changing the UI active chat changes neither the target nor the exactly-one result. Thus an acknowledgement in chat A followed by a switch to chat B still produces exactly one Restore record in A and none in B, without repeating Gate or source replacement. After a process restart the in-memory pending action is gone, so v1 offers no Retry unless a future design persists pending actions.
   - *Turn-time command mode:* ordinary message sending, chat creation/switching, export, and model changes stay locked while a turn runs. On an otherwise empty composer `/` still opens the menu; the three commit rows remain enabled according to scope state and the other locked rows show dimmed with their refusal hints.

## Source anchors

- `docs/superpowers/specs/2026-07-16-git-backed-page-history-design.md` — §2 shared canonical page source, §5 `changedPages` chat records, §7 Restore system record and commit independence
- `docs/superpowers/specs/2026-07-13-termcraft-design.md` — §3.9 chats, §3.10 composer commands, §6.2 per-chat sessions, §7.1 chats storage layout
- `design/23-slash-menu.dc.html` — slash menu open and filtered states
- `design/24-chats.dc.html` — chat list popup and the fresh-chat state
