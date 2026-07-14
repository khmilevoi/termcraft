Everything termcraft persists lives in one plain-text folder, `.termcraft/`, next to the code it describes. This document maps that folder: what each file holds, what commits to git versus what stays machine-local, and how every file carries a format version so data outlives binaries.

```mermaid
flowchart TB
    subgraph tc[".termcraft/ — one folder, one project"]
        cfg["config.toml — agent · model · effort, target stack, preview defaults"]
        proj["project.toml — name, ordered pages, active page"]
        chat["chat.jsonl — dialog log with typed header"]
        gi[".gitignore — written by termcraft"]
        subgraph localonly["machine-local (gitignored)"]
            lock["lock — owner PID, single instance"]
            sess["session.local.toml — agent session id"]
        end
        subgraph pg["pages/ — one folder per page slug"]
            vers["v1.json … vN.json — append-only page versions"]
            comm["comments.jsonl — pin records"]
        end
        subgraph ex["export/ — derived, overwritten in place"]
            dp["design-prompt.md"]
            pjson["pages/*.json — head-version copies"]
        end
    end
```

## Walkthrough

1. Creation: the folder appears when the first prompt is submitted from Home — default config plus a zero-page manifest.
2. What commits: everything except the generated `.gitignore` matches (`lock`, `*.local.toml`, `backup-*/`); designs diff and commit alongside the target project's code.
3. Record schemas: `chat.jsonl` starts with the header `{"kind":"chat","version":1}`, then one record per line, each with an ISO 8601 `ts`:
   - `user` — `{"kind":"user", "text", "selection"?, "pins":[…]}`, exactly what was sent to the agent.
   - `agent` — `{"kind":"agent", "text", "applied":{"<page>": N}}`, the agent's final message and the versions the turn produced.
   - `system` — `{"kind":"system", "event":"rollback"|"error"|"cancelled", "text"}`, rollbacks, honest post-retry errors, and cancellations.

   `comments.jsonl` starts with its own header, then pin records `{id, element, fx, fy, text, status, ts}`.
4. Version files are append-only and written create-new: if `vN.json` unexpectedly exists, termcraft rescans the page's folder and takes the next free number — worst case a duplicate version, never an overwrite.
5. Single-writer rule: a running termcraft owns the folder; external edits while it runs are unsupported — restart to pick them up. Failure branch: a second instance finds the lock file (holding the owner's PID) and refuses politely; a lock whose owner process is dead is removed automatically on startup.
6. Format versioning: every JSON file carries a top-level `schemaVersion`, every JSONL file starts with a typed header line, every TOML file carries a `format_version` — each file kind keeps its own independent counter. Reads run the migration chain up to the current in-memory model; writes always emit the current version. Details of the migration process: `flows/migration.md`.
7. Failure branch: a file newer than the binary understands produces a hard error naming the file, with no partial reads — downgrades are unsupported.

## Source anchors

- `docs/superpowers/specs/2026-07-13-termcraft-design.md` — §7.1 storage layout and record schemas, §7.2 format versioning, §3.1 project creation, §9 second-instance handling
