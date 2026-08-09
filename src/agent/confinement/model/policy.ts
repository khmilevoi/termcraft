import type { ConfinementTables, PermissionResultLike } from "../types";
import { isInsideStaging } from "./path-containment";

function primaryPath(
  pathFields: readonly string[],
  input: Record<string, unknown>,
  blockedPath?: string,
): string | null {
  if (typeof blockedPath === "string") return blockedPath;
  for (const field of pathFields) {
    const v = input[field];
    if (typeof v === "string") return v;
  }
  return null;
}

/**
 * The deny-by-default confinement decision behind a backend's tool-permission
 * callback (master §6.1; confirmed by Spike H for Claude Code's `canUseTool`).
 * Allows file tools only when their path is inside `stagingRoot`; denies
 * run/web + unknown tools. Defense-in-depth — the Gate is the load-bearing
 * wall.
 *
 * `tables` is the backend's own tool vocabulary (see {@link ConfinementTables}) —
 * this function itself knows no vendor tool names, only the RULE: deny by
 * default, allow a file tool only when its resolved path stays inside
 * `stagingRoot`, and allow a PATHLESS tool only when the tables name it
 * (`pathlessAllowedTools`, added for the in-process `check_design` tool — see
 * that field's own doc for why it is a third set rather than a widened
 * `optionalPathTools`).
 *
 * Non-Reatom: this module holds no atoms and owns no Reatom lifetime — it is a
 * pure decision function called synchronously from a backend's own
 * tool-permission callback, matching the module's `agent/` non-Reatom adapter
 * status (CLAUDE.md / plan Global Constraints).
 */
export function createConfinementPolicy(
  stagingRoot: string,
  tables: ConfinementTables,
  options?: { hasReparsePoint?: (p: string) => boolean },
) {
  return (
    toolName: string,
    input: Record<string, unknown>,
    blockedPath?: string,
  ): PermissionResultLike => {
    if (tables.deniedTools.has(toolName)) {
      return { behavior: "deny", message: `${toolName} is not permitted in a design turn` };
    }
    // ORDER: denied -> pathless-allowed -> file tools -> deny. This branch sits ABOVE the file
    // -tool test because the test below it resolves a PATH and refuses when none resolves — a
    // pathless tool would hit that refusal on every call. It sits BELOW the denied test so a
    // name present in both sets is still denied: deny always wins, and a future table edit
    // cannot quietly un-deny a tool by adding it to the newer set.
    //
    // NEITHER `input` NOR `blockedPath` IS CONSULTED, and for the same reason. These tools have no
    // path argument at all (see `ConfinementTables.pathlessAllowedTools`), so there is nothing in
    // `input` that could change the answer, and reading a path-shaped field out of one anyway would
    // invent an aiming mechanism the tool does not have. `blockedPath` is the SDK's own denial
    // signal about a path — so it is answering a question a pathless tool never asks; returning
    // before it is read is the same statement, not an oversight (final whole-branch review, M7,
    // 2026-08-10: the previous wording covered only `input`, which read as if `blockedPath` had
    // simply been forgotten). If a pathless tool ever gains a path, it stops belonging in this set
    // and moves to `fileTools`, where both signals are consulted below.
    if (tables.pathlessAllowedTools.has(toolName)) {
      return { behavior: "allow" };
    }
    if (!tables.fileTools.has(toolName)) {
      return { behavior: "deny", message: `Tool ${toolName} is not on the design-turn allowlist` };
    }
    // A path-less call resolves to the staging root ITSELF only for tools
    // whose schema documents `path` as optional-defaulting-to-cwd (see
    // `tables.optionalPathTools`) — "no path" means "here", and "here" is
    // staging. Every other file tool still denies outright on a missing
    // path: a schema rename on a WRITE tool still denies.
    const target =
      primaryPath(tables.pathFields, input, blockedPath) ??
      (tables.optionalPathTools.has(toolName) ? stagingRoot : null);
    if (target === null) {
      return { behavior: "deny", message: `${toolName} call has no resolvable path` };
    }
    if (!isInsideStaging(target, stagingRoot, options)) {
      return { behavior: "deny", message: `${toolName} target is outside the turn workspace` };
    }
    return { behavior: "allow" };
  };
}
