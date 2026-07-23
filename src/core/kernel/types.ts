import type { EventBusPayloadError, EventEnvelopeV1 } from "core/mailbox";
import type {
  AgentRegistry,
  ChatMutations,
  ChatReader,
  DiagnosticsCache,
  ExportPublishPort,
  ExportRenderPort,
  GateRunner,
  HostSupervisorPort,
  PageMetaCache,
  PageMutations,
  PageReader,
  PinMutations,
  PinReader,
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
import type { CanonicalHashError, CommandDecodeError, CommandResultV1 } from "core/protocol";
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
  readonly pageReader: PageReader;
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
  readonly clock: Clock;
}

/**
 * The composed Kernel object `createKernel` (Task 8) assembles from `KernelDeps` — the
 * one object `main.ts` and the composition root ultimately drive. Its shape
 * (`dispatch`/`events`/`currentPreview`/`close`) deliberately differs from `ui/kernel/
 * types.ts`'s `KernelPort` (`dispatch`/`subscribe`/`preview`): that UI-facing port is a
 * separate boundary type the composition root adapts `Kernel` into (WP-4), not built
 * here.
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
  /** Releases every held resource (project lease, host supervisor, preview session). */
  close(): Promise<void>;
}
