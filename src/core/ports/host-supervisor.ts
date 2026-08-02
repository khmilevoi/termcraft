import type { FailureDtoV1, Sha256Hex } from "core/protocol";
import type { DesignFileEntryV1 } from "entities/design-tree";
import type { Size } from "entities/page";

import type { InteractionModeV1, PreviewSession, TerminalCapabilitiesV1 } from "./preview-session";

/**
 * `HostSupervisorPort`: the standalone Kernel-side supervisor over multiple preview
 * sessions (host-supervision §2, §10, §13), narrowed from `host/supervisor/types.ts`'s real
 * `HostSupervisor` per decision C1.
 *
 * `preview(spec)` returns a {@link PreviewSession} — NOT a `PreviewHandle` — per blocker
 * B4's decision: "`HostSupervisor.preview()` returns `PreviewHandle`, not `PreviewSession`.
 * A restart-managed, resizable, mode-settable session does not exist...
 * `host/supervisor/model/preview-session.ts` records that both shapes exist 'with no
 * `core` yet to choose between them'. Phase 6 chooses `PreviewSession` (the contract's
 * shape) and `host` composes them." The real `HostSupervisor.preview` signature today is
 * synchronous (`PreviewHandle | SupervisorError`); this port's `preview` is `Promise`-typed
 * instead because composing a restart-managed `PreviewSession` on top of the supervisor's
 * queued/backoff start path is no longer a synchronous construction — `host`'s adapter
 * resolves the promise once the composed session exists (queued starts included), not once
 * the underlying incarnation reaches `ready`.
 *
 * `onEvent` narrows `HostSupervisorDeps.onEvent` (an injected constructor-time callback on
 * the real supervisor) into a subscribable sink returning its own unsubscribe — the shape
 * `host/supervisor/types.ts` itself says "phase 6 wires this onto the Kernel event channel."
 */

export type HostModeV1 = "preview" | "historical" | "smoke" | "export";

/**
 * `treeRoot`/`entryRelPath`/`expectedFiles` REPLACED a single `sourcePath` in task 15 (design
 * §6, §9.2): a preview mounts the page's whole closure, so the spec names the tree it reads and
 * the inventory it expects to find there. `sourceHash` stays the ENTRY file's own hash — it is
 * the session's identity (every `PreviewFrame` carries it, the supervisor keys restart on it),
 * never a verification input; the host verifies bytes against `expectedFiles`.
 */
export interface HostSessionSpecV1 {
  readonly mode: HostModeV1;
  readonly interactionMode: InteractionModeV1;
  readonly pageSlug: string;
  /** The ABSOLUTE `…/design` directory this session mounts from. */
  readonly treeRoot: string;
  /** TREE-relative — the `entry` `design/pages.json` bound to `pageSlug`. */
  readonly entryRelPath: string;
  /** The tree revision's inventory: `(relPath, sha256)` for every file under `treeRoot`. */
  readonly expectedFiles: readonly DesignFileEntryV1[];
  readonly sourceHash: Sha256Hex;
  readonly kitApiVersion: number;
  readonly size: Size;
  readonly theme: string;
  readonly capabilities: TerminalCapabilitiesV1;
}

/**
 * A bounded, structured lifecycle diagnostic (host-supervision §13) — no absolute paths,
 * env values, or source contents; only the source-hash prefix and a nonce-free identity.
 */
export interface SupervisorEventV1 {
  readonly type: "spawning" | "ready" | "backoff" | "circuitOpened" | "stopped";
  readonly key: string;
  readonly sessionId: string;
  readonly pageSlug: string;
  readonly sourceHashPrefix: string;
  readonly attempt?: number;
  readonly delayMs?: number;
  readonly attempts?: number;
  readonly reason?: string;
  /** The failing incarnation's own error, on `circuitOpened` only — distinct from `reason` (the restart policy's verdict). */
  readonly failureCode?: string;
  readonly failureMessage?: string;
}

export interface HostSupervisorPort {
  preview(spec: HostSessionSpecV1): Promise<FailureDtoV1 | PreviewSession>;
  /** Live (non-stopped, non-queued) incarnation count across all keys (§13: ≤10). */
  liveCount(): number;
  stopAll(): Promise<void>;
  /** Subscribe to bounded lifecycle diagnostics; returns the unsubscribe function. */
  onEvent(listener: (event: SupervisorEventV1) => void): () => void;
}
