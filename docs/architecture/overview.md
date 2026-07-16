termcraft is a terminal application for designing other terminal applications. A designer describes an interface in plain language; a locally installed AI agent writes real design code against termcraft's design system; termcraft executes that code in an isolated preview and iterates through chat. This document shows the system's context: who uses it, which external programs it drives, and where its data lives.

```mermaid
flowchart LR
    designer(["Designer at a terminal"])
    coder(["Implementing coding agent"])
    subgraph machine["Designer's machine"]
        termcraft["termcraft — single compiled binary (shell + design host + embedded kit)"]
        codexcli["Codex CLI (local, user's own auth)"]
        claudecli["Claude Code CLI (second backend, later)"]
        gitcli["Git CLI (local, optional)"]
        staging["staging directory — scratch, per turn"]
        folder[".termcraft/ — project folder"]
    end
    repo[("Target project repository (optional)")]

    designer -- "prompts · mouse · hotkeys" --> termcraft
    termcraft -- "turns via official TS SDKs" --> codexcli
    termcraft -.-> claudecli
    codexcli -- "edits design code, sandboxed" --> staging
    termcraft -- "diff + validation gate" --> staging
    termcraft -- "per-file replacement<br/>via temp + rename" --> folder
    folder -. "may live inside" .-> repo
    termcraft -- "v1 history · confirmed<br/>scoped commits" --> gitcli
    gitcli -- "reads and writes the<br/>target repository" --> repo
    termcraft -- "export: prompt + design sources +<br/>snapshots + layout trees" --> coder
```

## Walkthrough

1. The designer launches termcraft from within the target project's working directory. termcraft looks for a `.termcraft/` project folder there; that folder sits next to the code it describes. Git is optional: the project retains generation, preview, pins, chat, and export without a repository, while committing `.termcraft/` alongside application code lets design history travel with the codebase.
2. Design requests are sent to a locally installed agent CLI driven through its vendor's official TypeScript SDK — termcraft holds no API keys of its own and simply uses whatever authentication the CLI already has configured. The Codex CLI is the first supported backend; the Claude Code CLI is planned as a second backend behind the same abstraction, adopted later if its terms permit headless embedding.
3. The agent writes design code — components composed from termcraft's embedded design kit — by editing files directly in a scratch staging directory, confined there by the CLI's own sandbox where the platform provides one. When the turn ends, termcraft diffs the staging directory and validates the changes (types, import allowlist, a smoke render) before anything is stored; rejection by the agent or Gate, or interruption before apply begins, changes no canonical source. The gate, not the sandbox, is what correctness rests on.
4. Accepted changes render live in the terminal preview. Each persisted file is replaced through a temporary file plus rename, but page, manifest, chat, and pin writes for one turn are not one crash-safe transaction: a crash during apply can leave a partially applied turn until a separate Turn Transaction design exists. The design code executes only inside an isolated design-host subprocess — never in the shell — and only in projects the user has explicitly trusted on this machine. Trust is required because the project contains executable design code regardless of whether the folder arrived through Git, a copy, a sync tool, or any other route. The designer iterates through chat messages, mouse selection of preview elements, and pin comments anchored to specific elements, never by editing the rendered output directly.
5. Failure branch: if the agent CLI is missing or not logged in, a background health check performed at startup — and repeated before each send — surfaces the problem in the status bar. Attempting to send a message while unhealthy then fails with a clear error and install instructions rather than silently hanging.
6. In v1 only, termcraft can ask the installed Git CLI for read-only page history and can create a commit after the user confirms an exact `.termcraft/` scope. Restore replaces one canonical page source without moving `HEAD` or changing the index; termcraft never commits automatically. These controls are unavailable when Git or a containing repository is unavailable.
7. The final deliverable is an export package — an implementation prompt, deterministic text snapshots at several terminal sizes, resolved layout trees, and the exact canonical design sources currently on disk, including uncommitted changes — handed off to a separate implementing coding agent that builds the real application. termcraft itself never emits implementation code for the target stack; its only output toward implementation is this package.
8. Several non-goals bound this context: there is no manual drag/resize (WYSIWYG) editing of designs, since all content changes flow through the agent; termcraft in v1.0 runs as a single-user, single-instance tool with no daemon or multi-client mode; and each project folder holds exactly one project, so separate tools or design experiments live in separate folders or Git branches rather than one shared workspace.

## Source anchors

- `docs/superpowers/specs/2026-07-13-termcraft-design.md` — §1 overview, §2 non-goals, §3.1 launch and trust, §4 architecture, §6.1 backend abstraction, §6.2 turn protocol
- `docs/superpowers/specs/2026-07-16-git-backed-page-history-design.md` — governing MVP/v1 split, optional Git integration, canonical page sources, history, Restore, and scoped commits
- `design/Termcraft UI.dc.html` — visual source of truth for screens and status-bar language
