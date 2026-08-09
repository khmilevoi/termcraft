import type { PageSlug } from "entities/page";

/**
 * THE PORT THIS MODULE CONSUMES, DECLARED HERE BECAUSE THIS MODULE IS THE CONSUMER
 * (docs/architecture/code-structure.md item 4). The real answer comes from the Gate — but
 * `agent` may import neither `gate` (the adapter) nor `core` (where `core/ports/gate-runner.ts`
 * lives), so the port cannot be imported from either. It is DECLARED here and the COMPOSITION
 * ROOT injects a `gate`-backed implementation (`entrypoint/model/design-checker.ts`'s
 * `createGateDesignChecker`), exactly the shape `agent/types.ts`'s `AgentBackend` already
 * establishes in the other direction ("a port lifted verbatim into `core/ports/`" — that file's
 * own comment, :162-164).
 *
 * The types below are a NARROW REDRAW of `core/ports/gate-runner.ts`'s `GateErrorV1`/
 * `GateWarningV1`, not an import of them, for the same reason that port is itself a redraw of
 * `gate/types.ts`: the shapes are plain data, so redrawing them locally costs a structural
 * conformance assertion at the injection site and buys a ring edge that does not exist.
 * `kind`/`code` stay OPEN strings rather than the port's unions — this module renders them, it
 * never switches on them, and pinning the union here would be a third copy of a vocabulary that
 * already has two owners (`gate/types.ts` and `core/ports/gate-runner.ts`).
 *
 * NON-REATOM, like every other module under `agent/`: no atoms, no connect-hook lifetimes. The
 * check is a plain async call made from inside one SDK tool handler, whose lifetime is the tool
 * call itself.
 */

/** One fatal the design check found. `file` is TREE-relative, exactly as the Gate produces it. */
export interface DesignCheckErrorV1 {
  readonly kind: string;
  readonly code: string;
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
  readonly blockedPages?: readonly PageSlug[];
}

/** One non-fatal finding. `file` is TREE-relative; absent means "about the TREE, not a file". */
export interface DesignCheckWarningV1 {
  readonly kind: string;
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
  readonly blockedPages?: readonly PageSlug[];
}

/**
 * One check's findings. An EMPTY `errors` means the stages this check runs found nothing fatal
 * — NOT that the Gate would accept the turn: the page-contract stage and the smoke render are
 * deliberately not run (see {@link DesignCheckerPort.check}), and the renderer says so out loud
 * rather than letting a clean report be read as a guaranteed pass.
 */
export interface DesignCheckReportV1 {
  readonly errors: readonly DesignCheckErrorV1[];
  readonly warnings: readonly DesignCheckWarningV1[];
}

export interface DesignCheckInputV1 {
  /**
   * The turn workspace root — the agent's cwd and only writable root. The design tree is staged
   * one level down under `design/` (`store/sandbox/model/staging-store.ts`).
   *
   * NOT AN ARGUMENT THE MODEL SUPPLIES. `check_design`'s input schema has no path field at all
   * (correction C9): the value here is captured from the `AgentTask` when the tool is built, so
   * there is nothing a caller could aim elsewhere. This field exists so the ADAPTER is told
   * which workspace to read, not so a tool call can choose one.
   */
  readonly workspacePath: string;
}

export interface DesignCheckerPort {
  /**
   * Run the design check against the LIVE contents of `workspacePath` — re-reading the tree on
   * every call, never answering from a snapshot. That is the entire point of the tool this port
   * serves: the agent edits, checks, and edits again inside ONE attempt, so a check answered
   * from a report frozen at attempt start would describe code the agent already fixed.
   *
   * WHAT AN IMPLEMENTATION IS EXPECTED TO RUN, and what it is expected NOT to: the manifest
   * slice, the flat import allowlist, every entry's closure resolution, the import-graph
   * warnings, and ONE whole-tree TypeScript program — i.e. the stages behind
   * `GateRunner.runManifestSlice` and `GateRunner.runTree`. The per-page pipeline
   * (`GateRunner.runPage`) is NOT run: its smoke stage spawns a host child process per page,
   * which is precisely the cost a mid-attempt self-check must not pay, and its per-page
   * determinism lints duplicate findings the whole-tree pass already produces (the collision
   * `core/turns/model/validation.ts`'s `dedupeWarnings` exists to collapse). The renderer states
   * the resulting gap to the agent verbatim, so a clean check is never sold as a Gate pass.
   *
   * Returns an `Error` VALUE, never throws, when the check could not run at all (no design tree
   * on disk, an unreadable file). A caller must render that as a failure — a check that did not
   * happen is not a clean check.
   */
  check(input: DesignCheckInputV1): Promise<Error | DesignCheckReportV1>;
}
