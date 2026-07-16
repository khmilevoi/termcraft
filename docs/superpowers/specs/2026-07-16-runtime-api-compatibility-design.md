# termcraft — Runtime API Compatibility Design

Date: 2026-07-16
Status: approved design
Parent spec: [2026-07-13-termcraft-design.md](2026-07-13-termcraft-design.md)
History continuation: [2026-07-16-git-backed-page-history-design.md](2026-07-16-git-backed-page-history-design.md)

This continuation governs the authored page API, page metadata, reactive model
policy, compatibility checks, historical-source behavior, and export identity. It
supersedes conflicting `@termcraft/kit`, direct React/OpenTUI, `useState`, cached
page-metadata, and kit-semver prose in the parent spec and current architecture
documents until those documents are folded forward.

## 1. Purpose

Saved page source needs one durable API contract that termcraft can validate,
execute, migrate, browse through Git history, and export without coupling projects
to termcraft's dependency graph. That contract is the embedded
`@termcraft/runtime` facade.

The facade has four jobs:

1. give agent-generated pages one import boundary for rendering, state,
   interactivity, navigation, tweaks, themes, and host capabilities;
2. make Reatom-first state and orchestration the normal and enforceable page shape;
3. expose an integer compatibility identity that the Gate, host, migration system,
   history flow, Restore, and export all interpret the same way; and
4. keep Reatom, React, and OpenTUI package identities and versions private so they
   can change without rewriting page source when the public runtime contract is
   unchanged.

`@termcraft/runtime` is a public module identity resolved from the termcraft binary.
It is not a decision to publish an npm package or create another top-level workspace
package. Existing internal modules may implement and assemble the facade: the
runtime owns the public design vocabulary, the Gate owns static validation and type
declarations, the host owns module resolution and execution, and the Kernel brokers
runtime capabilities. This design introduces no eighth top-level component and makes
no further package-topology commitment.

## 2. Governing invariants

- A saved `.termcraft/pages/<slug>/page.tsx` imports from the exact module specifier
  `@termcraft/runtime` and from no other module.
- The same rule applies to staging candidates, canonical current sources, temporary
  historical snapshots, smoke renders, and exported page copies.
- Direct imports from `@termcraft/kit`, any `@reatom/*` package, `react`,
  `react/jsx-runtime`, any `@opentui/*` package, relative paths, and arbitrary npm,
  Bun, or Node modules are forbidden.
- Stateful and orchestration logic in termcraft and in generated pages is
  Reatom-first. React-compatible rendering remains inside `reatomComponent`; React
  hooks do not become an orchestration layer.
- Every atom, computed, and action has a stable trace name. A single direct state
  update uses `atom.set`; a meaningful multi-state transition uses a named action.
- Every async continuation that touches reactive state preserves Reatom context with
  `wrap`. Async reads use `computed` plus `withAsyncData`; commands and mutations use
  `action` plus `withAsync`; writable dependent state uses `withComputed`.
- Critical subprocess, watchdog, transport, mutex, and transaction lifetimes belong
  to explicit supervisors or transaction services. They are never started or
  stopped implicitly because a reactive consumer connected or disconnected.
- Each page exports static metadata containing a mandatory positive integer
  `kitApiVersion`. Runtime API version 1 is the first shipped contract.
- The page source is the sole durable source of its title, minimum size, theme, and
  compatibility declaration. A manifest or chat record must not carry an
  independently authoritative copy.
- The Gate and host both enforce the import and compatibility boundary. The host
  announces its runtime support before any page module executes.
- Historical Git objects are immutable inputs. Browse reads exact historical bytes;
  Restore writes exact historical bytes only after those bytes pass the current
  Gate. Migration never rewrites a Git object.
- Export copies each canonical page source byte-for-byte and reports the public
  runtime API identity separately. It never exposes private dependency versions.

## 3. Authored-source API boundary

### 3.1 Import rule

The only legal authored module edge is:

```tsx
import { definePage, atom, reatomComponent, Panel } from "@termcraft/runtime"
```

The Gate examines every syntax capable of creating a module edge, including value
imports, type-only imports, re-exports, side-effect imports, dynamic imports,
CommonJS-style loads, and JSX runtime directives. Only static imports from the exact
root specifier are accepted. Dynamic imports and re-exports are rejected even when
they name the runtime, because one page remains one independently renderable file
with no runtime-selected code loading.

No `@termcraft/runtime/*` authored subpath is public. In particular, a page cannot
name a JSX-runtime subpath, a private Reatom adapter, or an OpenTUI bridge. The host's
compiler owns the JSX transform and resolves any generated JSX helper internally.
Compiler-generated helper resolution is not an authored source import, does not
appear in the saved or exported TSX, and does not widen the Gate allowlist.

The host repeats the same import scan before linking a page. This catches canonical
files changed by hand after a Gate run and historical snapshots that predate the
runtime-only rule.

### 3.2 Controlled facade surface

Runtime API version 1 exposes these public families from the root facade:

| Family | Public contract |
|---|---|
| Page contract | `definePage` and the types for static page metadata, sizes, themes, and runtime API identity |
| Reatom state | `atom`, `computed`, `action`, and the public types needed to type page models |
| Reatom async and derivation | `wrap`, `withAsync`, `withAsyncData`, `withComputed`, `withAbort`, and `withConnectHook` for strictly connection-scoped local resources |
| React binding | `reatomComponent` plus minimal model-scope/context plumbing; no general-purpose state or effect hooks |
| Design system | the themed components, token types, stable-id contract, and controlled low-level rendering primitives needed for bespoke widgets |
| Page capabilities | declarations and scoped access for navigation, tweaks, theme tokens, viewport/color capabilities, interaction mode, and export mode |
| Interaction types | the facade-owned event, focus, layout, and style types accepted by public components and low-level primitives |

The list is deliberately curated. A symbol being available in Reatom, React, or
OpenTUI does not make it part of the page API. Adding a non-breaking facade symbol
can retain the current integer version; removing a symbol, changing a public type or
component contract incompatibly, changing authored JSX semantics, or changing a
runtime capability's meaning requires a new `kitApiVersion`.

Runtime API version 1 exports the following facade-owned lifecycle types and
signature. `AtomLike` and `Ext` here are the public facade types needed to type page
models; their declaration shape must not reveal a private `@reatom/core` module path
or package version.

```ts
export type ConnectionCleanup = () => void
export type ConnectionHookResult =
  | void
  | ConnectionCleanup
  | Promise<void | ConnectionCleanup>

export declare const withConnectHook: <Target extends AtomLike>(
  callback: (target: Target) => ConnectionHookResult,
) => Ext<Target>
```

This is a Reatom atom-extension API, not a React hook. The callback runs when the
target receives its first consumer in a connection lifetime. Disconnect aborts
Reatom work scoped by that connection and invokes the returned cleanup at most once.
The narrower facade return type intentionally admits only no cleanup or one cleanup
function, synchronously or asynchronously; it does not expose private subscription
object types.

The low-level escape hatch remains available, but through facade-owned primitives
and types rather than direct OpenTUI imports. It preserves the design goal that a
page can build a bespoke terminal widget while preventing the page from binding to
an OpenTUI package path or release.

### 3.3 Private dependency identities

Reatom v1001 is embedded behind the facade and defines the reactive semantics of
runtime API version 1. React and OpenTUI are likewise embedded implementation
dependencies. Their package names and versions are absent from:

- saved page imports and ambient type declarations;
- page metadata and host-facing page contracts;
- Gate compatibility diagnostics intended for designers or agents;
- exported runtime identity; and
- compatibility decisions.

The facade's declaration environment does not provide ambient declarations for
`@reatom/*`, `react`, `react/jsx-runtime`, or `@opentui/*`. A private dependency
upgrade that preserves the facade contract and passes compatibility fixtures does
not change `kitApiVersion`. If it cannot preserve that contract, the public integer
version changes and the migration policy in §10 applies.

## 4. Page contract and metadata ownership

Every canonical or proposed page has one static `meta` export and one default page
component. The initial contract is:

```tsx
import {
  definePage,
  Panel,
  Text,
  atom,
  reatomComponent,
} from "@termcraft/runtime"

export const meta = definePage({
  kitApiVersion: 1,
  title: "Dashboard",
  minSize: { w: 80, h: 24 },
  theme: "dark-default",
})

const visits = atom(42, "dashboard.visits")

export default reatomComponent(() => (
  <Panel id="visits" title="Visits">
    <Text id="visits-value">{visits()}</Text>
  </Panel>
))
```

"Static" has one precise meaning: `meta` is a direct `definePage` call whose single
argument is an object literal; `kitApiVersion`, `title`, `minSize.w`, `minSize.h`,
and `theme` are literals; there are no spreads, variable references, getters,
computed keys, conditionals, or calls inside those fields. The Gate reads the AST
without executing the page.

The fields are mandatory:

- `kitApiVersion` is a positive integer literal and must be accepted by the current
  Gate and target host;
- `title` is a non-empty display string;
- `minSize.w` and `minSize.h` are positive integer terminal-cell dimensions; and
- `theme` names a theme in the declared runtime API.

The source owns these values. `project.toml` owns page identity and order, while
machine-local `workspace.local.toml` owns the active page. Neither owns
authoritative title, minimum size, theme, or compatibility. The staging
`pages.json` manifest slice carries slugs, order, and a requested local active-page
effect,
not copies of page metadata. Tabs, status-bar sizing, preview theme selection,
export sizing, and compatibility UI receive a `PageDescriptor` parsed from the
selected source by the Gate/Kernel path.

An in-memory or machine-local descriptor cache is allowed only as rebuildable
derived data keyed by page slug, exact source content hash, and extractor version.
It is invalidated on source change and can never override a fresh parse. There is
no portable or authoritative metadata cache to reconcile. A UI rename is an
explicit mechanical edit of the `meta.title` literal followed by the same static
contract and compatibility validation as any other canonical source write.

If metadata cannot be parsed, the UI may use the immutable slug as an error-row
label, but that fallback is presentation, not page metadata.

## 5. Reatom-first model design

### 5.1 Model rules

State and orchestration live in named Reatom units, not component hooks:

- atoms hold writable state;
- computeds hold derived state and idempotent read flows;
- actions express commands and grouped transitions;
- `reatomComponent` reads atoms and computeds directly by calling them;
- a trivial one-atom event calls `atom.set` directly;
- a handler that validates, maps, requests, or changes more than one state delegates
  to a named model action;
- reusable subtrees receive a scoped model through context; their hook performs only
  that context lookup and returns the model;
- hooks do not fetch, mirror atoms into component state, coordinate enabled flags,
  reset sibling state, own timers, or sequence commands; and
- atom reads happen after early-return guards so inactive branches do not subscribe
  or start work.

All unit names are stable, human-readable traces. A model factory accepts a model
name and derives child names such as `dashboard.filter`, `dashboard.visibleRows`,
and `dashboard.refresh`. Anonymous atoms, computeds, actions, and routes are invalid
generated-page style and invalid termcraft internal style.

### 5.2 Conceptual page model

The exact visual components are illustrative; the reactive shape is normative:

```tsx
import {
  action,
  atom,
  computed,
  definePage,
  reatomComponent,
  wrap,
  withAsync,
  withAsyncData,
  withComputed,
  Button,
  Column,
  Text,
} from "@termcraft/runtime"

export const meta = definePage({
  kitApiVersion: 1,
  title: "Orders",
  minSize: { w: 80, h: 24 },
  theme: "dark-default",
})

const createOrdersModel = (name: string) => {
  const filter = atom("all", `${name}.filter`)
  const page = atom(1, `${name}.page`).extend(
    withComputed(() => {
      filter()
      return 1
    }),
  )
  const rows = atom(seedOrders, `${name}.rows`)
  const visibleRows = computed(
    () => selectRows(rows(), filter(), page()),
    `${name}.visibleRows`,
  )

  const details = computed(async () => {
    const first = visibleRows()[0]
    if (!first) return null
    return await wrap(loadSimulatedDetails(first.id))
  }, `${name}.details`).extend(withAsyncData({ initState: null }))

  const advance = action(() => {
    page.set((current) => current + 1)
  }, `${name}.advance`)

  const refresh = action(async () => {
    const next = await wrap(loadSimulatedOrders())
    rows.set(next)
  }, `${name}.refresh`).extend(withAsync())

  return { filter, page, visibleRows, details, advance, refresh }
}

const model = createOrdersModel("orders")

export default reatomComponent(() => {
  const error = model.details.error()
  if (error) return <Text id="error">Unable to load preview data</Text>
  if (!model.details.ready()) return <Text id="loading">Loading…</Text>

  return (
    <Column id="orders">
      <Text id="summary">{model.visibleRows().length} orders</Text>
      <Button id="next" onPress={wrap(() => model.advance())}>Next</Button>
    </Column>
  )
})
```

The example's loaders are same-file simulated prototype work; the existing ban on
page access to networks, files, and subprocesses remains. For a reusable model, a
provider owns the model instance and a small page-local hook retrieves it from the
facade's scoped context. The component still reads returned atoms directly. The hook
does not become a second state model.

### 5.3 Async policy

The binding rules are mandatory for termcraft internals and generated pages:

| Need | Required shape | Rejected shape |
|---|---|---|
| Idempotent read/query | named `computed(async)` plus `withAsyncData` | mount-time fetch effect, manual data/loading/error atoms |
| User command or mutation | named `action(async)` plus `withAsync` | component pending state and `finally` bookkeeping |
| Continuation after promise, timer, event, or callback | `wrap` around the promise or callback before touching Reatom | raw `await`, `.then`, timer, or event callback that resumes into atoms/actions without context |
| Writable state derived from another atom | `withComputed` on the writable atom | React key reset, synchronization effect, repeated reset calls across handlers |
| Grouped transition | named model action | several atom writes authored in a view handler |
| One trivial local change | direct `atom.set` | pass-through setter action |

An async computed uses early returns for missing prerequisites instead of sentinel
arguments or hook-style `enabled` flags. The view reads `error`, then `ready`, then
`data`, avoiding subscriptions and work for branches that have already returned.

The Gate can prove some violations statically and treats them as page errors:
anonymous Reatom constructors, references to forbidden React orchestration hooks,
and direct imports that bypass the facade. It reports mechanically clear async and
identity-action violations as errors. Where an opaque callback prevents a sound
decision, it emits a targeted warning to the agent rather than claiming complete
static proof. Internal termcraft code uses the same rules through its lint, review,
and test policy.

### 5.4 Lifecycle ownership

`withConnectHook` is appropriate only when the resource is local, non-critical, and
its correct lifetime is exactly "while this reactive unit has consumers." It is not
a React hook and must not be called from component render logic. Its callback returns
no cleanup or one connection-local cleanup, and callbacks that touch Reatom are
wrapped.

That rule does not own critical runtime resources. In particular:

- the design-host subprocess and its heartbeat watchdog belong to a host supervisor;
- command/event transports belong to an explicit transport supervisor;
- the project-write mutex and multi-file apply boundary belong to the transaction
  service;
- Git Restore and scoped commit execution belong to explicit Kernel action plans and
  transaction services; and
- cancellation and shutdown are explicit supervisor commands with observable state.

Reactive units expose supervisor state and actions, but connecting a preview
component cannot start a process, and disconnecting the last observer cannot kill
one. A connect hook may subscribe to supervisor events for a view and clean up that
subscription; it does not own the supervised resource. This preserves deterministic
subprocess and transaction lifetimes across UI remounts, history-source switches,
export jobs, Gate smoke renders, and future IPC clients.

### 5.5 UI–Kernel boundary

The UI shell and Kernel each maintain their own named Reatom graph. Commands and
Events remain the only values crossing their boundary. The UI does not import Kernel
atoms, and the Kernel does not expose a shared mutable store. Channel callbacks are
wrapped before they update the receiving side's graph. This keeps the future IPC
seam intact while making orchestration Reatom-first on both sides.

## 6. Runtime capabilities

The facade exposes host-scoped capability models rather than private host objects or
framework globals. The public capability families are:

- **navigation** — named actions that emit page-navigation requests; missing target
  pages remain no-ops with the existing quiet notice;
- **tweaks** — `defineTweaks` declarations plus scoped reactive values for toggle,
  select, and text controls;
- **theme** — current theme id and token atoms, including preview overrides without
  rewriting `meta.theme`;
- **viewport and terminal capability** — reactive size and color-capability values
  supplied by the host; and
- **mode** — reactive preview/export and static/interactive capability values so
  deterministic render behavior does not rely on private globals. The host-scoped
  interaction-mode atom is initialized only from an accepted `ready` response and
  changes only from an accepted correlated `set-mode` response. Sending a request,
  changing UI intent, receiving a rejection, or observing a stale response never
  updates the atom optimistically.

Capability accessors are minimal context lookups. They return facade-owned models
whose values are atoms/computeds and whose commands are actions; a
`reatomComponent` reads them directly. Navigation and tweak messages are the only
page behaviors that cross to the shell. Theme, viewport, and mode are host inputs.
No capability grants network, filesystem, environment, process, module-loader, or
arbitrary terminal access.

## 7. Compatibility identity and enforcement

### 7.1 Public identity

The authored API identity is the pair:

```text
module = @termcraft/runtime
kitApiVersion = <positive integer from page meta>
```

Version 1 is the first current version. Each termcraft binary embeds:

- one `currentKitApiVersion`, used in agent instructions, generated examples, and
  newly created pages; and
- an explicit set of `supportedKitApiVersions`, used for validation and execution.

The set is explicit rather than inferred from semver or assumed contiguous. A binary
may temporarily support an older integer through compatibility adapters. A source is
compatible only when its exact integer is in the target Gate and host support sets.
New or agent-modified source must declare `currentKitApiVersion`; compatibility
adapters exist for reading and controlled migration, not for generating legacy code.

The exact public declaration exchanged before host mount is closed and versioned:

```ts
interface RuntimeDeclarationBundleV1 {
  module: "@termcraft/runtime"
  currentKitApiVersion: number
  supportedKitApiVersions: number[]
  publicCapabilityIds: string[]
}
```

Both arrays are sorted, duplicate-free canonical JSON arrays. Kit API values are
positive safe integers, `supportedKitApiVersions` contains
`currentKitApiVersion`, and every capability identifier is a non-empty bounded
ASCII string. Theme contracts use capability identifiers such as `theme:<themeId>`;
private Reatom, React, OpenTUI, and JSX-transform identities never appear.

### 7.2 Host handshake

After the Kernel has selected and hashed a source but before the host receives its
path or executes page code, the supervisor and host exchange the exact closed
`ClientHelloV1` and `HostHelloV1` DTOs owned by the host protocol design. Each hello
carries one `RuntimeDeclarationBundleV1`; `ClientHelloV1` additionally carries the
wire identity, host mode, page slug, and the source's Gate-parsed `sourceHash` and
`sourceKitApiVersion` fields exactly as the host protocol defines. No runtime
identity beyond the bundle and the source's declared kit integer appears in a hello.

At handshake the Kernel verifies exact agreement between the Gate and host runtime
declaration bundles and membership of the source's `kitApiVersion` in the supported
set. Either mismatch is a binary-integrity error (`RUNTIME_INTEGRITY_MISMATCH` or
`KIT_API_MISMATCH`): the Kernel sends no page to that host, kills it, and refuses
preview, smoke render, Restore validation, or export through that process. The
handshake reports no Reatom, React, or OpenTUI versions.

After the handshake matches, the Kernel sends the correlated `mount` request with
the immutable source path and the expected content hash; the source's
`kitApiVersion` was already validated at handshake. The host validates the path,
recomputes and verifies the content hash, re-parses imports and static metadata,
and only then links the facade and executes the page. A disagreement is an error,
not a best-effort render.

### 7.3 Gate sequence

For each new or changed page, and for every Restore candidate, the Gate performs:

1. authored import scan: exact root runtime imports only;
2. static page-contract parse, including all mandatory metadata literals;
3. compatibility check against the Gate support set, with current-version
   enforcement for agent-created or agent-modified sources;
4. TypeScript checking against only the facade declarations and compiler-owned JSX
   support;
5. Reatom/design policy checks, including named units and detectable orchestration
   violations;
6. semantic design lints such as ids and deterministic-export warnings; and
7. smoke render through a freshly handshaken host at the source-declared minimum
   size and theme.

The host repeats the security- and compatibility-critical checks. A valid TypeScript
program that reaches a private package through module-resolution tricks still fails
the import/link boundary.

## 8. Data flow

### 8.1 Generation and apply

1. The Kernel snapshots canonical `page.tsx` files into staging without rewriting
   their imports or metadata.
2. The staging reference and type declarations describe only
   `@termcraft/runtime`, the current `kitApiVersion`, Reatom-first model rules, and
   the runtime capabilities.
3. The agent edits one-file pages. Newly created or changed pages import only the
   facade and declare the current integer.
4. The Gate runs §7.3. Import, metadata, compatibility, type, or smoke-render errors
   enter the existing retry loop; warnings are returned with the turn.
5. After a successful Gate result, the existing project-write transaction boundary
   replaces canonical sources and records `changedPages`. No manifest metadata copy
   is written.
6. The Kernel publishes source-hash-bound `PageDescriptor` events. The UI refreshes
   tabs, minimum-size status, theme, and compatibility presentation from those
   descriptors and respawns the preview host on the exact selected source.

An empty diff remains valid. A failed turn leaves canonical sources and their
metadata unchanged.

### 8.2 Preview and interaction

1. The Kernel selects and hashes the canonical Current source, staging candidate,
   export capture, or historical snapshot before spawn, but withholds its path and
   bytes from the child.
2. `client.hello`/`host.hello` negotiate protocol and runtime support against that
   source identity; only after a match does the Kernel send the selected source path.
3. The host validates the source boundary and mounts the default
   `reatomComponent` tree inside a scoped runtime context.
4. Forwarded input invokes wrapped handlers and named model actions; atom changes
   invalidate computeds and direct reads; the component re-renders; the host emits a
   new frame.
5. Navigation events cross to the shell, while tweak/theme/viewport/mode changes
   cross into the host's scoped capability model.
6. Killing or replacing the host discards page model state. Supervisor ownership,
   not React connection state, controls that process transition.

### 8.3 Historical browse and Restore

Git browsing continues to read the exact `page.tsx` bytes from a selected commit
into a temporary read-only snapshot. No import rewrite, metadata insertion, version
bump, compatibility shim source edit, or codemod runs against that snapshot.

The browse path asks `HostSupervisor` for a dedicated historical session to validate
and render those exact bytes. A
historical source using `@termcraft/kit`, React, OpenTUI, missing
`kitApiVersion`, or declaring an unsupported integer remains selectable but the
preview displays the specific compatibility/Gate error. Browsing performs no
project or Git write.

Restore remains stricter than browse. The Kernel runs the exact selected bytes
through the full current Gate and a matching current host under the existing
freshness, index, confirmation, mutex, and audit-record rules. If the snapshot does
not pass unchanged, Restore is disabled and the canonical source remains untouched.
termcraft never codemods a temporary historical snapshot as part of Restore and
never writes a transformed interpretation of a commit.

### 8.4 Export

Export captures canonical current page sources from disk before rendering and uses
those captured bytes for the entire all-or-nothing job. Each `pages/*.tsx` output is
a byte-for-byte copy: no formatting, import rewrite, metadata normalization, JSX
lowering, or migration occurs in the export directory.

The package adds `runtime-api.json` with the public identity consumed by the copied
sources:

```json
{
  "module": "@termcraft/runtime",
  "currentKitApiVersion": 1,
  "pages": {
    "dashboard": { "kitApiVersion": 1 }
  }
}
```

`design-prompt.md` repeats the same identity in human-readable form and tells an
implementing agent that page source targets the termcraft facade, not direct React,
Reatom, or OpenTUI packages. The identity file records the public module and page
integers only. It is derived from the captured source metadata and is never an
alternate metadata input or source of truth. It does not contain the termcraft
host's Reatom, React, OpenTUI, or JSX-transform versions.

The Gate and handshake checks run before capture renders. Any incompatible page,
handshake mismatch, or render failure refuses the complete export and leaves the
previous complete package active.

## 9. Error behavior

Errors identify the source path, operation, public runtime identity, and actionable
cause without leaking private dependency versions.

| Condition | Behavior |
|---|---|
| Any direct or indirect authored import outside the exact facade root | Gate error naming the forbidden specifier and the only allowed specifier; generation may retry; canonical source is unchanged |
| Missing, non-literal, non-integer, or non-positive `kitApiVersion` | Static page-contract error before typecheck or execution |
| Agent-created or changed page declares a non-current integer | Gate error naming the required current integer |
| Existing or historical source declares an unsupported integer | Compatibility error naming declared and supported public integers; no page execution |
| Host and Gate handshakes disagree | Internal runtime-integrity error; host is killed; preview/Gate/Restore/export do not continue through it |
| Source hash or host metadata differs from the Gate selection | Source-race/integrity error; process is discarded and the operation retries from a fresh source snapshot where the parent flow permits |
| Page references a facade symbol unavailable in its declared API | Typecheck error against the facade declarations |
| Canonical current source is incompatible at launch | Workspace and composer remain available; preview shows the compatibility error; no automatic replacement or historical fallback occurs |
| Historical source is incompatible | History row remains browsable as an error state; project file, Git state, pins, and chat remain unchanged; Restore is disabled |
| Restore candidate fails any current Gate stage | Restore performs no source or audit-record write |
| Canonical page codemod fails or its result fails Gate | Original canonical bytes remain active; migration names the page and failed step |
| Export contains an incompatible page | Whole export is refused; the previous complete export remains active |

If metadata itself cannot be parsed, the UI uses the slug only to identify the
broken page. It must not reuse stale title, size, theme, or compatibility data from a
manifest.

## 10. Migration and compatibility evolution

### 10.1 Version changes

A breaking authored API change increments `currentKitApiVersion`. The binary may
embed a bounded compatibility adapter for selected earlier integers, but support is
always explicit in the Gate and host sets. Agent instructions and generated source
target only the current integer.

Every breaking version ships with an ordered `N → N+1` canonical-source codemod in
the existing migration registry. A newly planned code migration starts only after
the composite workspace trust check; already intended transaction recovery may run
before trust because it only rolls prepared bytes forward and never executes page
code. A code migration:

1. reads only `.termcraft/pages/<slug>/page.tsx` files selected by the current
   project manifest;
2. writes a transformed candidate to migration scratch space;
3. updates the runtime-only imports and static `kitApiVersion` as defined by that
   step;
4. runs the current import scan, metadata parser, typecheck, policy checks, and smoke
   render against the candidate; and
5. replaces the canonical source through the Project store only after validation.

Failure leaves the original bytes in place. Before any transformed bytes are
written, migration creates and verifies its required machine-local backup outside
`.termcraft`, regardless of Git status.

Codemods do not traverse `.git`, enumerate commits, replace objects, amend commits,
or transform a history-browse snapshot. Git object ids and committed source bytes
remain immutable. A future Restore succeeds only if the selected exact historical
source is already accepted by the current Gate.

### 10.2 Initial rollout

The direct `@termcraft/kit`/React/OpenTUI page API and hook-state model exist only in
pre-implementation design prose; no shipped numbered-page or page-runtime format
requires a user-data migration. The first implementation creates canonical pages
with the root runtime import and `kitApiVersion: 1`. Test fixtures for the abandoned
prose are validation-rejection fixtures, not migration inputs.

After runtime API version 1 ships, every released integer receives permanent
fixtures for import, metadata, type, render, history, Restore, migration, and export
behavior.

## 11. Testing strategy

### 11.1 Facade contract tests

- Compile representative stateless, stateful, async, tweak, navigation, theme, and
  low-level-widget pages through only `@termcraft/runtime`.
- Snapshot the public declaration/export surface for each supported integer.
- Assert runtime API version 1 exports `withConnectHook` with the exact
  `ConnectionHookResult` signature, that its cleanup runs once on disconnect, and
  that the symbol is absent from React-hook namespaces.
- Assert private dependency module names and versions are absent from facade types,
  runtime identity, diagnostics, and export metadata.
- Upgrade private dependency fixtures while holding the public version constant and
  prove existing runtime API fixtures still typecheck and render identically.
- Prove compiler-owned JSX support works while explicit `react/jsx-runtime` and
  runtime subpath imports fail.

### 11.2 Reatom policy tests

- Static fixtures reject unnamed atoms, computeds, and actions, forbidden React
  orchestration-hook references, and `withConnectHook` uses that exceed the
  connection-local lifecycle contract.
- Model tests cover direct `atom.set`, grouped named actions, `withComputed`
  dependent state, early-return async computeds, `withAsyncData` read status, and
  `withAsync` command status.
- Async tracing tests cross promises, callbacks, event handlers, cancellation, and
  timers and verify `wrap` preserves causes and updates the intended graph.
- React render tests prove `reatomComponent` subscribes only to atoms read on the
  active branch and that scoped-model hooks perform context lookup without duplicate
  state or effects.
- Supervisor tests prove mounting or unmounting a view does not spawn or kill the
  design host, release a project transaction, or cancel a Git action; explicit
  supervisor/transaction commands do.
- Lifecycle fixtures prove `withConnectHook` may own only local connection-scoped
  listeners, timers, or subscriptions and cannot become the owner of a host,
  transport, mutex, transaction, Restore, commit, or cancellation lifetime.

### 11.3 Gate and host tests

- Reject value imports, type imports, re-exports, dynamic imports, CommonJS loads,
  JSX directives, relative imports, and private package specifiers outside the
  exact facade root.
- Reject missing or non-static metadata, every invalid integer case, unsupported
  versions, and non-current versions on changed/generated sources.
- Verify title, minimum size, theme, and compatibility always come from the selected
  source and a content-hash cache invalidates on any source edit.
- Exercise matching and mismatching Gate/host support sets and capability
  handshakes; prove no page executes before a valid handshake.
- Change a canonical file between Gate and host load and verify the hash check
  prevents execution of the unvalidated bytes.
- Re-run import and compatibility validation in the host against manually edited
  canonical sources and historical snapshots.

### 11.4 Flow integration tests

- Generation stages exact canonical sources, gives the agent facade-only docs/types,
  retries invalid runtime imports or versions, and applies no durable metadata copy.
- Interactive fixtures route input through wrapped actions and direct atom reads,
  then exercise navigation, tweaks, theme, viewport, and export-mode capabilities.
- Interaction-mode fixtures initialize the runtime atom from accepted `ready`, update
  it only from the matching accepted `set-mode` response, and keep its prior value on
  request dispatch, rejection, timeout, or stale response.
- An incompatible canonical source opens in a repairable Workspace error state
  without automatic replacement.
- Git browse renders compatible exact bytes and shows deterministic errors for old
  kit/React/OpenTUI imports, absent integers, and unsupported integers without any
  project or Git write.
- Restore copies exact compatible bytes only after the current Gate; incompatible
  candidates leave the canonical source, index, `HEAD`, and audit chat untouched.
- Migration changes only canonical current sources, leaves commit object ids and
  historical bytes unchanged, and preserves originals on transform or Gate failure.
- Export compares every source copy byte-for-byte with its captured canonical input,
  validates `runtime-api.json` and the prompt identity, excludes private versions,
  and preserves the prior package on any failure.

## 12. Acceptance criteria

The design is implemented when all of the following are true:

- every created, staged, canonical, historical, and exported page is interpreted
  against the exact-root `@termcraft/runtime` authored-source rule;
- direct `@termcraft/kit`, `@reatom/*`, React, React JSX-runtime, OpenTUI, relative,
  and arbitrary package imports are rejected by both Gate and host paths;
- runtime API version 1 exposes the controlled Reatom, render, page-contract,
  navigation, tweak, theme, and host-capability surface without exposing private
  package versions;
- all termcraft state/orchestration and all generated page state use named
  Reatom-first models, direct atom reads in `reatomComponent`, the required async
  extensions, and wrapped continuations;
- runtime API version 1 exports the facade-owned `withConnectHook` signature only for
  strictly connection-scoped local cleanup; it is not a React hook and owns no
  critical resource lifetime;
- component hooks are limited to props/framework necessities and scoped model or
  runtime-capability lookup, with no hook-driven orchestration;
- host, watchdog, transport, mutex, apply, Restore, and commit lifetimes are owned by
  explicit supervisors or transaction services rather than reactive connection
  lifetimes;
- every page has static source-owned `kitApiVersion`, title, minimum size, and theme,
  and no durable manifest metadata can override them;
- Gate declarations and every host handshake agree on current and supported runtime
  API versions before any page executes;
- incompatible historical sources remain read-only error states, and Restore changes
  canonical source only when the exact historical bytes pass the current Gate;
- migrations and codemods touch canonical current sources only and never mutate Git
  history or temporary historical snapshots; and
- export copies exact canonical source bytes and publishes the matching public
  runtime API identity without private dependency identities.

## 13. Superseded prose

This design replaces the following earlier statements wherever they conflict:

| Earlier prose | Governing replacement |
|---|---|
| Pages import `@termcraft/kit`, React, and `@opentui/*` | Pages import only the exact root `@termcraft/runtime` facade |
| Reatom is internal and does not affect page code | Reatom v1001 semantics are embedded in the facade; page state and orchestration are Reatom-first |
| Prototype behavior is ordinary `useState` and hook state | Named atoms/computeds/actions own behavior; `reatomComponent` reads them directly; hooks only retrieve scopes/capabilities |
| Raw OpenTUI imports are the escape hatch | Controlled low-level runtime primitives are the escape hatch; OpenTUI identity remains private |
| Host watchdog lifetime is hidden in connect hooks | The host and watchdog are owned by an explicit supervisor; connection hooks may observe them only |
| Evaluated metadata is cached authoritatively in the project manifest | Static page source is the sole durable source; any in-memory descriptor cache is content-hash-derived |
| Page compatibility follows kit semver | `kitApiVersion` is the authored compatibility integer; private package semvers are irrelevant |
| Gate/host allow kit, React, and OpenTUI imports | Gate and host allow only the facade root and independently enforce the declared integer |
| Interactive flow describes design-local React state | Interactive flow uses host-scoped Reatom models and facade capabilities |
| Export copies source without an explicit runtime contract record | Export still copies exact source and additionally emits `runtime-api.json` plus prompt identity |

The canonical-source, `changedPages`, first-parent Git history, read-only browsing,
Restore transaction, scoped commit, and exact-current-source export decisions from
the Git-backed history continuation remain in force.

## 14. Alternatives rejected

1. **Keep separate kit, Reatom, React, and OpenTUI imports.** This makes every saved
   page depend on several package identities and compatible version combinations,
   leaks implementation upgrades into project data, and makes historical validation
   ambiguous.
2. **Expose the facade but keep generic React state/effect hooks as the primary page
   model.** This preserves hook-driven enabled flags, synchronization effects,
   duplicated loading/error state, and lifecycle coupling that the Reatom-first
   architecture is intended to remove.
3. **Convert pages to a closed declarative document.** This restores a hard ceiling
   on bespoke terminal designs and reverses the approved real-code design-runtime
   pivot.

The selected facade approach keeps authored code expressive while making its module,
state, compatibility, history, and export contracts singular and testable.

## 15. Out of scope

- publishing `@termcraft/runtime` as a standalone npm package;
- choosing a monorepo/workspace package split or changing the seven existing
  top-level component boundaries;
- exposing arbitrary Reatom, React, or OpenTUI APIs or their installed versions;
- multi-file pages, page-to-page imports, or user-installed page dependencies;
- real network, filesystem, environment, or subprocess access from page code;
- rewriting, amending, replacing, or otherwise migrating Git commit objects;
- automatically transforming a historical snapshot before Browse or Restore;
- automatic compatibility claims for integers absent from the explicit host/Gate
  support set;
- redefining the separate recoverable project-transaction protocol; and
- changing the existing workspace-trust and process-isolation threat model.
