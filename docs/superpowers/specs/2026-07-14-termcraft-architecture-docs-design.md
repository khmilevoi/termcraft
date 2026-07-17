# termcraft — Architecture Docs Design

Date: 2026-07-14
Status: completed and revised
Parent spec: [2026-07-13-termcraft-design.md](2026-07-13-termcraft-design.md)
Production-hardening register: [2026-07-16-production-hardening-decisions-design.md](2026-07-16-production-hardening-decisions-design.md)

## 1. Purpose

Bootstrap and maintain `docs/architecture/` as the compact, stack-aware map of the
v1 target before production code exists. The architecture documents summarize the
normative specifications; they do not introduce a second product contract. When a
detailed production-hardening design changes a boundary, the corresponding
architecture walkthrough changes in the same documentation commit.

`code-structure.md` is the one document that decides rather than summarizes, and it
is a narrow exception in a different dimension: it owns the source-tree convention,
which no product specification covers. It holds no product authority — every
behavioral claim it makes cites a governing spec — and it is also the only document
in the set addressed to a reader who reads the source language.

## 2. Governing decisions

- **Scope:** production-grade local, single-user, single-process v1. Daemon,
  multi-client IPC, network filesystems, and distributed coordination are outside
  the documented contract.
- **Location:** `docs/architecture/`, with `README.md` as the reading-order and
  precedence index.
- **Source anchors:** until code exists, every architecture document points to the
  governing design specs and relevant `design/NN-*.dc.html` prototype. Anchors move
  to implementation paths as modules land.
- **No hidden authority:** architecture summaries must preserve the Kernel guards,
  storage identities, transaction boundaries, protocol ownership, and limits from
  the detailed specs. A summary may omit detail but may not weaken it.
- **English only**, matching the repository's architecture-document convention.

## 3. Component vocabulary

The architecture uses these seven roles consistently:

| Role | Responsibility |
|---|---|
| **UI shell** | Screens, local focus/applicability, the action table, chat and preview presentation; no domain or process authority |
| **Kernel** | Authoritative Reatom state machines, Commands/Results/Events, capabilities, revisions, turn admission, and project-write coordination |
| **Agent gateway** | Vendor SDK confinement, normalized events, fenced attempts, session checkpoints, deadlines, and confirmed cancellation |
| **Runtime** | The only saved-page import surface: Reatom-first page model, supported components, low-level primitives, navigation, tweaks, and compatibility version |
| **Gate** | Safe candidate semantics: import/type/page-contract checks, smoke render, and diagnostics |
| **HostSupervisor** | Sole owner of host subprocesses, framed protocol, `PreviewSession`, bounded frame delivery, timeouts, and crash-loop protection |
| **Project store** | Portable/local state split, `SafeProjectFs`, OS lease, transactions and startup recovery, migrations, projections, trust, and Git adapter |

The UI and Kernel exchange serializable, versioned DTOs over an in-process channel;
this is transport-neutral but not a finished daemon wire protocol. Preview frame
bytes use a separate bounded stream. The UI never accesses the Project store or host
stdio directly. Critical subprocess, cancellation, and transaction lifetimes are
owned explicitly. Reatom connection hooks own only connection-scoped
subscriptions/resources and return cleanup; scoped-model lookup uses the facade's
context hook and does not own resource lifetime.

## 4. Document set and owned questions

```text
docs/architecture/
  README.md
  overview.md
  modules.md
  storage.md
  code-structure.md
  flows/
    launch.md
    generation-turn.md
    versions.md
    chats.md
    interactive-prototype.md
    pins-and-selection.md
    export.md
    migration.md
```

| Document | Required contract |
|---|---|
| `overview.md` | actors, trust gate, local operating envelope, unique turn workspace, recovery before Workspace |
| `modules.md` | Kernel authority, runtime/Gate/host ownership, Reatom boundaries, mutex and Git concurrency |
| `storage.md` | portable/local split, slug and UUIDv7 identities, JSONL, transactions, lease, trust, caches, backups, exclusions |
| `code-structure.md` | entity-first grouping, `entities/` versus consumer-declared ports, domain-free `infrastructure/`, composition root and the module DAG |
| `launch.md` | lease, trust subject, schema validation, transaction recovery, first-project creation |
| `generation-turn.md` | fenced attempts, confirmed exit, immutable candidate, Gate, CAS, durable `TurnTransaction` |
| `versions.md` | canonical Current source, lazy first-parent Git history, explicit durable Restore, three commit scopes |
| `chats.md` | lazy UUIDv7 chat logs, captured target chat, scoped session checkpoint |
| `interactive-prototype.md` | Reatom-first page model through `PreviewSession`; historical view is read-only |
| `pins-and-selection.md` | frame-sequenced geometry and append-only pin-state events committed by Kernel |
| `export.md` | canonical Current sources, bounded render pool/cache, complete-generation publication transaction |
| `migration.md` | independent format chains, verified external backup, transactional roll-forward |

## 5. Consistency rules

The following phrases are never used as current architecture:

- private `vN.tsx` versions, `cN` chat ids, or portable `config.toml`;
- shared/reused writable staging;
- simultaneous multi-file filesystem atomicity or in-memory-only recovery;
- UI-authoritative turn locks, UI pin persistence, or direct UI-to-host stdio;
- direct saved-page imports from Reatom, React, OpenTUI, or `@termcraft/kit`;
- Git as a migration backup or PID reuse as lock ownership proof;
- unbounded history/chat/frame/export processing.

Architecture changes are audited in four passes: durability/concurrency,
storage/identity, Kernel/host/runtime ownership, and projections/scale. A change is
complete only when the architecture summaries, their source anchors, and the
governing specs agree.

## 6. Definition of done

- Every listed file exists, follows the repository's Mermaid/walkthrough/source
  anchor style where applicable, and links only to existing sources.
- `README.md` gives the current reading order and normative precedence.
- Repo-wide scans find no current use of the obsolete contracts in §5.
- Transaction recovery, Safe filesystem checks, command guards, host framing, and
  scale limits appear in both the detailed design and the relevant architecture
  summary without competing ownership claims.
