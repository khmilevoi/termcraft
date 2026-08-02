import type { EventBusPayloadError, EventEnvelopeV1 } from "core/mailbox";
import type {
  AgentPromptSource,
  AgentRegistry,
  ChatMutations,
  ChatReader,
  DesignTreeReader,
  DiagnosticsCache,
  ExportPublishPort,
  ExportRenderPort,
  GateRunner,
  HostSupervisorPort,
  PageMetaCache,
  PageMutations,
  PinMutations,
  PinReader,
  PreviewFrameV1,
  PreviewSession,
  ProjectStore,
  ProjectWriteCoordinator,
  RecoveryService,
  RenderCache,
  SessionCheckpointService,
  StagingService,
  TrustGate,
  TurnTransactionService,
} from "core/ports";
import type { FrameAckError, PreviewNoLiveSessionError } from "core/preview";
import type {
  CanonicalHashError,
  CommandDecodeError,
  CommandResultV1,
  FrameIdentityV1,
  FrameTokenV1,
  UUIDv7,
} from "core/protocol";
import type { Clock } from "infrastructure/clock";

/**
 * The dependency surface `createKernel` (Task 8) consumes: exactly one field per
 * `core/ports` contract the MVP command set reads or writes, plus the injected `Clock`
 * and `AgentRegistry` — nothing store/gate/host/agent-shaped crosses this boundary
 * directly, only the port types those adapters satisfy (module DAG, Global Constraints).
 *
 * `gitHistory`/`gitCommitter` are deliberately ABSENT: Git is out of MVP scope (kernel-
 * assembly plan, Global Constraints). No command handler is registered for
 * Restore/`/commit-*`/migration, and the capability projector reports those
 * capabilities unavailable through the existing Tier-C deferred guard — there is no
 * port field for `createKernel` to thread through in the first place.
 *
 * `pageMetaCache`/`diagnosticsCache`/`renderCache` are declared as three SEPARATE
 * fields rather than one grouped `projections` field, mirroring `core/ports/
 * projections.ts`'s own header note: "each store owns its own quota/generation/eviction
 * policy, so one flat interface would blur three independent capabilities into one."
 * `KernelDeps` follows the same split its own source ports already made rather than
 * re-bundling them behind a new group here.
 */
export interface KernelDeps {
  readonly projectStore: ProjectStore;
  readonly chatReader: ChatReader;
  readonly chatMutations: ChatMutations;
  /**
   * The canonical design tree's read surface (`core/ports/design-store.ts`). RENAMED AND
   * RETYPED BY TASK 14 from `pageReader: PageReader`, which named a port `core/ports` had
   * already deleted — so this field silently degraded to `any` and EVERY kernel handler's
   * reader call was unchecked. The name moves with the type deliberately: `PageReader`
   * promised `readSource(slug)`/`listSlugs()`, and a slug does not name a file in the design
   * tree — `design/pages.json`'s `entry` does. Keeping the old name over the new port would
   * have left every call site reading as if that promise still held.
   */
  readonly designReader: DesignTreeReader;
  readonly pageMutations: PageMutations;
  readonly pinReader: PinReader;
  readonly pinMutations: PinMutations;
  readonly turnTransactions: TurnTransactionService;
  readonly projectWrite: ProjectWriteCoordinator;
  readonly staging: StagingService;
  readonly trustGate: TrustGate;
  readonly pageMetaCache: PageMetaCache;
  readonly diagnosticsCache: DiagnosticsCache;
  readonly renderCache: RenderCache;
  readonly sessionCheckpoint: SessionCheckpointService;
  readonly recovery: RecoveryService;
  readonly gateRunner: GateRunner;
  readonly hostSupervisor: HostSupervisorPort;
  readonly exportRender: ExportRenderPort;
  readonly exportPublish: ExportPublishPort;
  readonly agentRegistry: AgentRegistry;
  /**
   * The agent-prompt library's composed system prompt and runtime-doc file list (phase-8
   * WP-3) — `turn.start` (`handlers/turn.ts`) is the one caller. Declared in `core/ports/
   * agent-prompt.ts`; implemented by `agent/prompt/` (static prose plus paths into the
   * installed package, no I/O beyond an existence check).
   */
  readonly agentPromptSource: AgentPromptSource;
  readonly clock: Clock;
}

/**
 * The composed Kernel object `createKernel` (Task 8) assembles from `KernelDeps` — the
 * one object `main.ts` and the composition root ultimately drive. Its shape
 * (`dispatch`/`events`/`currentPreview`/`currentPreviewSessionId`/`publishFrame`/
 * `acknowledgeDisplay`/`close`) deliberately differs from `ui/kernel/types.ts`'s `KernelPort`
 * (`dispatch`/`subscribe`/`preview`): that UI-facing port is a separate boundary type the
 * composition root adapts `Kernel` into (WP-4), not built here.
 */
export interface Kernel {
  /**
   * Submits a raw, not-yet-decoded command envelope through `core/mailbox`'s
   * `Dispatch`. Resolves to the accepted/rejected result once dispatch's decode ->
   * dedupe -> revision-check -> guard -> handler pipeline has run, or to a
   * `CommandDecodeError`/`CanonicalHashError` if `raw` never became a well-formed,
   * canonically-hashable `CommandEnvelopeV1` in the first place.
   */
  dispatch(raw: unknown): Promise<CommandDecodeError | CanonicalHashError | CommandResultV1>;
  /**
   * Registers `handler` on the Kernel's `EventBus` and immediately delivers one
   * `kernel.snapshot` envelope before returning — exactly `EventBus["subscribe"]`'s own
   * shape (`core/mailbox/model/event-bus.ts:119-148`), kept as the concrete
   * `EventBusPayloadError` here (not widened to plain `Error`) since this is the
   * internal composed object, not the `ui`-facing decoupling boundary `KernelPort`
   * widens for. Returns an unsubscribe function, or the `EventBusPayloadError` raised
   * when the injected snapshot provider's own payload fails its schema.
   */
  events(handler: (envelope: EventEnvelopeV1) => void): EventBusPayloadError | (() => void);
  /** The current live preview session, or `null` when no preview is established. */
  currentPreview(): PreviewSession | null;
  /**
   * The Kernel-minted `previewSessionId` for the SAME session `currentPreview()` returns
   * (kernel-command-contract §7.6: "Each start/switch mints a UUIDv7 `previewSessionId`"),
   * or `null` when none is established. Added in the MVP blocker fix bundle's Task 10 fix
   * round 1 (Finding 3): before this, `entrypoint/model/create-shell.ts`'s
   * `toPreviewSessionHandle` used `PreviewSession.identity.sessionId` instead — the
   * HOST-internal id, never the one minted here — so a live session had two different
   * `previewSessionId`s in circulation and `ui/preview/model/interaction.ts`'s own
   * correlation check (`current.handle.previewSessionId !== payload.previewSessionId`)
   * could never pass. This is the one Kernel-side fact that lets the composition root use
   * the SAME id both in the `PreviewSessionHandle` it hands to `ui` and in every
   * `preview.*` event's own `previewSessionId` field.
   */
  currentPreviewSessionId(): UUIDv7 | null;
  /**
   * Mints a ledger-recognized `FrameTokenV1` "beside the frame" (kernel-command-contract
   * §8.1: "For each frame-stream item, the Kernel mints a `FrameTokenV1`") for one
   * already-read `PreviewFrameV1`. The composition root calls this once per item it reads
   * off the live `PreviewSession.frames` async iterable (`currentPreview()`, above)
   * before forwarding the frame to the UI, so every token the UI ever sees was minted by
   * THIS Kernel's own `FrameTokenLedger` — never fabricated by the caller. Returns a
   * `PreviewNoLiveSessionError` when no session is currently established (delegates
   * verbatim to `core/preview`'s `PreviewSessionCommands.publishFrame`, which owns the
   * full contract).
   *
   * STEP-1 DECISION (kernel-assembly Task 16, "finish the wiring" for
   * `preview.acknowledgeDisplay`): exposed as these two narrow methods rather than a
   * broader "preview facade" object. Rejected alternatives, and why:
   *   - Returning the internal `previewSessionCommands`/`FrameTokenLedger` object
   *     directly: leaks the FULL preview command router (`selectPage`/`resize`/
   *     `queryGeometry`/... — fifteen methods) across the Kernel boundary, letting a
   *     caller drive Kernel-internal state machines directly. This interface's own
   *     header comment already forbids exactly that ("its shape ... deliberately
   *     differs" from a passthrough).
   *   - One `previewFrames(): AsyncIterable<{frame, frameToken}> | null` facade wrapping
   *     `currentPreview().frames` itself: moves frame-loop ownership (and its async-
   *     generator lifetime) INTO the Kernel, duplicating the identity-by-reference
   *     caching `entrypoint`'s own `toKernelPort` already does for `PreviewSessionHandle`
   *     — and would still need a SEPARATE `acknowledgeDisplay` method regardless, so no
   *     fewer moving parts, just a bigger surface.
   *   - Widening `currentPreview()`'s own return type to carry a token-minting method:
   *     would put a Kernel-authority concern (the `FrameTokenLedger`) onto
   *     `PreviewSession`, a `core/ports` type the Kernel does not own and that other
   *     adapters (`host`, test fakes) must also satisfy structurally.
   * Two methods is the smallest addition that lets the composition root (a) obtain a REAL
   * token per forwarded frame and (b) forward the UI's acknowledgement, without granting
   * it anything else `previewSessionCommands` can do.
   */
  publishFrame(frame: PreviewFrameV1): PreviewNoLiveSessionError | FrameTokenV1;
  /**
   * The UI's typed display acknowledgement (kernel-command-contract §8.1), forwarded
   * verbatim to `core/preview`'s `FrameTokenLedger.acknowledge` via
   * `PreviewSessionCommands.acknowledgeDisplay` — see `publishFrame`'s own doc comment
   * (above) for why this rides alongside it as the Kernel's only other frame-token
   * surface. Not a `dispatch()` command: per `core/preview`'s own header note, it "does
   * not change `stateRevision`".
   */
  acknowledgeDisplay(frameToken: FrameTokenV1): FrameAckError | FrameIdentityV1;
  /** Releases every held resource (project lease, host supervisor, preview session). */
  close(): Promise<void>;
}
