Stored data outlives any single termcraft binary. This document covers how old files are upgraded — lazily on read, or in bulk with a backup — and what happens when a file is newer than the program reading it.

```mermaid
flowchart TD
    read(["file read"]) --> ver{"file version vs binary"}
    ver -- "current" --> use["parse into the current in-memory model"]
    ver -- "older" --> chain["run the registered step chain, one version at a time"]
    chain --> use
    ver -- "newer" --> err["hard error naming the file: update termcraft"]

    bulk(["bulk migration: wizard offer or the migrate command"]) --> gitq{"folder under git?"}
    gitq -- "yes" --> warn["warn only, no backup"]
    gitq -- "no" --> backup["back up to a timestamped backup folder"]
    warn --> all["run the chain over every file kind"]
    backup --> all
    all --> use
```

## Walkthrough

1. Versioning ground rules (statics in `storage.md`): every data file kind carries its own independent version counter — `schemaVersion` in JSON, a typed header line in JSONL, `format_version` in TOML. Page sources are the exception: they are code, versioned by the embedded design kit's semver rather than a counter in the file.
2. The migration registry: an ordered chain of single-step upgrades per file kind; reading an old file runs the chain to the current model; writing always emits the current version. A breaking kit change ships as a codemod step for the page-source file kind in the same registry — machinery with zero entries until the first breaking change, like the rest of the registry.
3. Lazy trigger: any read of an old file migrates in memory; the file on disk is rewritten in the current format on its next write.
4. Bulk trigger: opening an old `.termcraft/` offers bulk migration in the wizard; a dedicated migrate command does the same from the CLI.
5. Backup policy: bulk migration first backs up the whole folder to a timestamped backup directory — unless the folder is under git, where a warning suffices (backup dirs are gitignored).
6. Failure branch: a file newer than the binary understands → hard error naming the file ("update termcraft"), no partial reads.
7. Failure branch: downgrades are unsupported — older binaries refuse newer data rather than guessing.
8. Safety net: fixtures of every historical version of every file kind run through the chain in tests, validating against the current schema.

## Source anchors

- `docs/superpowers/specs/2026-07-13-termcraft-design.md` — §7.2 format versioning, kit semver, and the migration registry, §3.1 bulk offer, §9 too-new file error, §10 migration fixtures
- `design/16-wizard-migration.dc.html` — migration offer screen
