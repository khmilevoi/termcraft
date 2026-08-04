import { describe, expect, test } from "bun:test";

import { type KernelDeps, createKernel } from "core";
import type { EventEnvelopeV1 } from "core/mailbox";
import type {
  ChatHeaderV1,
  ChatListingEntryV1,
  ChatLoadResultV1,
  ChatMutations,
  ChatReader,
} from "core/ports";
import {
  createFakeAgentPromptSource,
  createFakeAgentRegistry,
  createFakeDesignStoreForPages,
  createFakeDiagnosticsCache,
  createFakeExportPublish,
  createFakeExportRenderPort,
  createFakeGateRunner,
  createFakeHostSupervisorPort,
  createFakePageMetaCache,
  createFakePinStore,
  createFakeProjectStore,
  createFakeProjectWriteCoordinator,
  createFakeRecoveryService,
  createFakeRenderCache,
  createFakeSessionCheckpointService,
  createFakeStagingService,
  createFakeTrustGate,
  createFakeTurnTransactionService,
} from "core/ports/fakes";
import { type FailureDtoV1, eventPayloadV1SchemaByKind } from "core/protocol";
import { type PageSlug, parsePageSlug } from "entities/page";
import type { Clock } from "infrastructure/clock";
import { uuidv7 } from "infrastructure/uuid";

/**
 * WP-10 Task 10 — the relaunch round-trip gate, CORE HALF ONLY.
 *
 * `docs/superpowers/plans/2026-07-24-chat-transport.md`'s own Task 10 asks for a test that
 * feeds the exact `EventEnvelopeV1` sequence a relaunch produces through `mirror.apply`,
 * then asserts `mirror.records()`/`mirror.chats().summaries` and a mounted `Workspace`.
 * That UI slice (`Mirror.records`, `ChatScrollback`, the `/chats` derived-name row — WP-10
 * Tasks 7-9) lives on a SEPARATE ui-completion worktree branch and is NOT in this tree —
 * see this repo's own WP-10 core report, "Task 10" section, for the exact commit this test
 * was scoped against. Rebuilding the ui slice here would duplicate work already landed
 * elsewhere under a different branch; this file proves everything the CORE side owns:
 * that a genuine relaunch — a fresh `Kernel`, a project whose on-disk workspace state
 * already names an active chat with a persisted user+agent tail — actually crosses the
 * real `createKernel` + `EventBus` seam as `chat.changed` (carrying the Task 4 derived
 * `displayName`) followed by `chat.records` (carrying the Task 2 `ChatRecordDtoV1[]`
 * tail, mapped by Task 5's `chatRecordToDtoV1`), each schema-valid against the exact
 * closed-union schemas (`core/protocol`) the not-yet-landed `Mirror.records: Atom<readonly
 * EventPayloadByKindV1["chat.records"]["records"][number][]>` (Task 7's own planned type)
 * will index into unchanged — the wire shape this proves IS that type, by construction,
 * since both are `EventPayloadByKindV1["chat.records"]` read through the same closed
 * protocol barrel.
 *
 * UNLIKE `handlers/project.test.ts`'s own Task 6 coverage (a single `user` record, and the
 * bare handler function called directly against a hand-built `HandlerContext`), this test:
 * (a) dispatches through the REAL assembled `Kernel` (`createKernel` + its real `EventBus`,
 * dedupe ledger, and capability-growth tracking) — the same object the composition root
 * hands the real transport, not a handler-level stand-in; and (b) seeds a MIXED tail (one
 * `user` record then one `agent` record, the exact pairing the plan's own Task 10 text
 * names — "a user + agent record") to exercise `chatRecordToDtoV1`'s `agent` branch inside
 * a genuine relaunch, which Task 6's own single-user-record fixture never exercised.
 *
 * NOT ASSERTED: the bootstrap `kernel.snapshot`'s own `activeChatId` field. `kernel.ts`'s
 * `buildSnapshotPayload` hardcodes it to `null` unconditionally (see that file's own header:
 * "No project has ever been opened/created yet in a freshly-assembled Kernel... kernel.
 * snapshot's own projectId/activePageSlug/activeChatId/pageDescriptors fields... have NO
 * corresponding mutator on HandlerContext") — a real, already-flagged, pre-existing gap
 * unrelated to WP-10 (fixing it would need a `HandlerContext` mutator no chat/project
 * handler is asked for here). The plan's own Task 10 text ("kernel.snapshot (activeChatId
 * set)") describes the eventual ui-mirror-level scenario once that gap AND the ui slice
 * both land; this core-only test instead proves the part that is actually testable today —
 * `project.open`'s own `chat.changed`/`chat.records` publish, the two events that actually
 * carry the restored tail.
 */

function slug(value: string): PageSlug {
  const parsed = parsePageSlug(value);
  if (parsed instanceof Error) throw parsed;
  return parsed;
}

interface SeededChatStoreCall {
  readonly method: "open";
  readonly chatId: string;
}

/**
 * A `ChatReader & ChatMutations` double PRE-SEEDED with one chat's persisted tail —
 * unlike `kernel.integration.test.ts`'s own `createChatMutationsStub` (which MINTS a fresh
 * chat via `create()` mid-test), this double simulates a chat that already existed BEFORE
 * this Kernel was ever constructed: exactly the "records already on disk from a prior
 * session" precondition a relaunch tests against. `create()`/`switchActive()` are never
 * exercised by a relaunch (`project.open` alone) and return a loud `PERSISTENCE_FAILED`
 * failure if ever called, so an accidental call surfaces as a visible assertion failure
 * rather than silently minting a second, untested chat.
 *
 * `listEntries` (fix-bundle Task 7) is this project's WHOLE on-disk chat listing — not just
 * the seeded/active chat — proving `chat.changed` now reflects `ChatReader.list()` rather
 * than only whatever chat `project.open` happened to open a tail for.
 */
function createSeededChatStore(
  header: ChatHeaderV1,
  tail: ChatLoadResultV1,
  listEntries: readonly ChatListingEntryV1[],
): ChatReader & ChatMutations & { readonly calls: readonly SeededChatStoreCall[] } {
  const calls: SeededChatStoreCall[] = [];

  function notSeeded(chatId: string): FailureDtoV1 {
    return {
      code: "PERSISTENCE_FAILED",
      retryable: false,
      safeMessage: `seeded relaunch chat store only knows chatId ${header.chatId}, not ${chatId}`,
      details: { chatId },
    };
  }

  function unsupported(method: string): FailureDtoV1 {
    return {
      code: "PERSISTENCE_FAILED",
      retryable: false,
      safeMessage: `seeded relaunch chat store does not implement "${method}" — this test never calls it`,
      details: { method },
    };
  }

  return {
    calls,
    async open(chatId: string) {
      calls.push({ method: "open", chatId });
      if (chatId !== header.chatId) return notSeeded(chatId);
      return {
        header,
        async loadTail() {
          return tail;
        },
        async loadBefore() {
          return notSeeded(chatId);
        },
      };
    },
    async readAppendBase(chatId: string) {
      return notSeeded(chatId);
    },
    async list() {
      return listEntries;
    },
    async create() {
      return unsupported("create");
    },
    async switchActive() {
      return unsupported("switchActive");
    },
  };
}

function makeClock(nowMs: number): Clock {
  return { now: () => new Date(nowMs) };
}

/** Resolves with the first delivered envelope matching `predicate` — the identical helper `kernel.integration.test.ts`'s own gate already establishes (subscribed BEFORE the triggering dispatch, so nothing racing ahead of the `await` is missed). */
function waitForEvent(
  kernel: ReturnType<typeof createKernel>,
  predicate: (envelope: EventEnvelopeV1) => boolean,
): Promise<EventEnvelopeV1> {
  return new Promise((resolve, reject) => {
    const unsubscribe = kernel.events((envelope) => {
      if (!predicate(envelope)) return;
      if (typeof unsubscribe === "function") unsubscribe();
      resolve(envelope);
    });
    if (unsubscribe instanceof Error) reject(unsubscribe);
  });
}

/** Every `KernelDeps` field the real `createKernel` needs — the same shape `kernel.integration.test.ts`'s own `buildDeps` assembles, trimmed to plain defaults since this scenario never drives turn/preview/export. */
function buildRelaunchDeps(options: {
  readonly chatStore: ChatReader & ChatMutations;
  readonly projectStore: ReturnType<typeof createFakeProjectStore>;
  readonly pageStore: ReturnType<typeof createFakeDesignStoreForPages>;
}): KernelDeps {
  const pinStore = createFakePinStore();
  return {
    projectStore: options.projectStore,
    chatReader: options.chatStore,
    chatMutations: options.chatStore,
    designReader: options.pageStore,
    pageMutations: options.pageStore,
    pinReader: pinStore,
    pinMutations: pinStore,
    turnTransactions: createFakeTurnTransactionService(),
    projectWrite: createFakeProjectWriteCoordinator(),
    staging: createFakeStagingService(),
    trustGate: createFakeTrustGate(),
    pageMetaCache: createFakePageMetaCache(),
    diagnosticsCache: createFakeDiagnosticsCache(),
    renderCache: createFakeRenderCache(),
    sessionCheckpoint: createFakeSessionCheckpointService(),
    recovery: createFakeRecoveryService(),
    gateRunner: createFakeGateRunner(),
    hostSupervisor: createFakeHostSupervisorPort(),
    exportRender: createFakeExportRenderPort(),
    exportPublish: createFakeExportPublish(),
    agentRegistry: createFakeAgentRegistry([]),
    agentPromptSource: createFakeAgentPromptSource(),
    clock: makeClock(1_700_000_000_000),
  };
}

describe("WP-10 Task 10 — the chat tail round-trips on relaunch (core half, §11/M10)", () => {
  test("project.open, dispatched through the real Kernel + EventBus, restores the active chat's persisted user+agent tail as chat.changed (derived displayName) then chat.records, each schema-valid", async () => {
    const home = slug("home");
    const chatId = uuidv7();
    const userRecordId = uuidv7();
    const agentRecordId = uuidv7();
    const turnId = uuidv7();
    const header: ChatHeaderV1 = { chatId, createdAt: "2024-06-01T00:00:00.000Z" };

    // The exact pairing WP-10's own plan text names for Task 10: "a user + agent record" —
    // seeded here as already-persisted disk state from a PRIOR session, in the natural
    // temporal order a real chat writes them (the user record opens the turn, the agent
    // record closes it).
    const tail: ChatLoadResultV1 = {
      records: [
        {
          kind: "user",
          recordId: userRecordId,
          turnId,
          text: "Restore my chat, please",
          ts: "2024-06-01T00:00:01.000Z",
        },
        {
          kind: "agent",
          recordId: agentRecordId,
          turnId,
          text: "**Done.** Your chat is restored.",
          changedPages: [home],
          warnings: [],
          ts: "2024-06-01T00:00:02.000Z",
        },
      ],
      prevCursor: null,
      totalRecordCount: 2,
    };

    // fix-bundle Task 7 (Gap E): the project holds THREE chats on disk — not just the one
    // `project.open` restores a tail for — proving `chat.changed` reflects the project's own
    // full listing (`ChatReader.list()`), the exact "three chats on disk, one row after a
    // restart" bug this task closes.
    const otherChatB = uuidv7();
    const otherChatC = uuidv7();
    const listEntries: readonly ChatListingEntryV1[] = [
      { chatId, createdAt: header.createdAt, firstUserText: "Restore my chat, please" },
      {
        chatId: otherChatB,
        createdAt: "2024-05-30T00:00:00.000Z",
        firstUserText: "a second chat on disk",
      },
      { chatId: otherChatC, createdAt: "2024-05-31T00:00:00.000Z", firstUserText: null },
    ];
    const chatStore = createSeededChatStore(header, tail, listEntries);

    // The on-disk workspace state a PRIOR session already wrote: an active chat is named,
    // exactly the relaunch precondition (§11: "the Workspace opens with the active chat's
    // history restored").
    const projectStore = createFakeProjectStore({
      root: "/relaunch-root",
      // A valid-looking UUIDv7 (fake-fidelity: the real store always mints `projectId` via
      // `uuidv7()`, and `kernel.project.finishOpen`'s own event metadata — §10 smoke
      // closeout — now carries it through a real `UUIDv7`-validating schema).
      manifest: { projectId: "0192f000-0000-7000-8000-00000000aaaa" },
      workspaceState: { activePageSlug: home, activeChatId: chatId },
    });
    // Task 7 fix round 1: `sha256` used to be a required, fabricated `"a".repeat(64)` here —
    // never read back by anything in this file (nothing here asserts a page's hash). Omitted so
    // the fake derives the real hash of these bytes instead.
    const pageStore = createFakeDesignStoreForPages({
      pages: [
        {
          pageSlug: home,
          bytes: new TextEncoder().encode("export const meta = {}"),
        },
      ],
    });

    const kernel = createKernel(buildRelaunchDeps({ chatStore, projectStore, pageStore }));

    const envelopes: EventEnvelopeV1[] = [];
    const unsubscribe = kernel.events((envelope) => envelopes.push(envelope));
    if (unsubscribe instanceof Error) throw unsubscribe;

    // The bootstrap `kernel.snapshot`, delivered synchronously on subscribe — see this
    // file's own header for why its `activeChatId` is not asserted here.
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.kind).toBe("kernel.snapshot");

    // --- The relaunch: dispatch project.open, wait for the tail to arrive -----------------
    const recordsDelivered = waitForEvent(kernel, (envelope) => envelope.kind === "chat.records");

    const openResult = await kernel.dispatch({
      protocolVersion: 1,
      commandId: uuidv7(),
      expectedRevision: "0",
      kind: "project.open",
      payload: { root: "/relaunch-root" },
    });
    if (openResult instanceof Error) throw openResult;
    expect(openResult.status).toBe("accepted");
    if (openResult.status !== "accepted") throw new Error("unreachable");
    expect(openResult.disposition).toBe("started");

    const recordsEnvelope = await recordsDelivered;
    unsubscribe();

    expect(chatStore.calls).toEqual([{ method: "open", chatId }]);

    // --- The transport proof: chat.changed then chat.records, in that relative order ------
    // Filtered to the kinds a UI mirror actually reacts to for this scenario — the batch
    // also carries `page.descriptorsChanged`/`kernel.stateChanged` (finishOpen) ahead of
    // them, plus an incidental `kernel.capabilitiesChanged` once `activeChatId` first
    // becomes projectable (`kernel.ts`'s own capability-growth tracking) — neither is
    // WP-10's concern, so neither is asserted here.
    const chatEventKinds = envelopes
      .filter(
        (e) =>
          e.kind === "kernel.snapshot" || e.kind === "chat.changed" || e.kind === "chat.records",
      )
      .map((e) => e.kind);
    expect(chatEventKinds).toEqual(["kernel.snapshot", "chat.changed", "chat.records"]);

    const changedEnvelope = envelopes.find((e) => e.kind === "chat.changed");
    if (changedEnvelope === undefined) throw new Error("expected a chat.changed envelope");

    // The exact content a `/chats` popup needs: ALL THREE chats the project holds on disk —
    // not just the active one — each with its own derived `displayName` (design §3.9) computed
    // from ITS OWN first `user` record's first line (fix-bundle Gap E, Task 7). `chat.changed`
    // is fed entirely by `ChatReader.list()` now, so every listed chat lands in `added`.
    expect(changedEnvelope.payload).toEqual({
      activeChatId: chatId,
      added: [
        { chatId, createdAt: header.createdAt, displayName: "Restore my chat, please" },
        {
          chatId: otherChatB,
          createdAt: "2024-05-30T00:00:00.000Z",
          displayName: "a second chat on disk",
        },
        { chatId: otherChatC, createdAt: "2024-05-31T00:00:00.000Z", displayName: null },
      ],
      updated: [],
      removedChatIds: [],
    });

    // The exact content `ChatScrollback` (Task 8, ui-side) needs: both records, in order,
    // fully mapped (no `undefined`, every optional made explicit per §8.1) — proving the
    // mixed `user`+`agent` tail crosses the seam intact, not just the single-`user`-record
    // case `handlers/project.test.ts`'s own Task 6 coverage already proved.
    expect(recordsEnvelope.payload).toEqual({
      chatId,
      records: [
        {
          kind: "user",
          recordId: userRecordId,
          turnId,
          text: "Restore my chat, please",
          selection: null,
          pins: [],
          ts: "2024-06-01T00:00:01.000Z",
        },
        {
          kind: "agent",
          recordId: agentRecordId,
          turnId,
          text: "**Done.** Your chat is restored.",
          changedPages: [home],
          warnings: [],
          ts: "2024-06-01T00:00:02.000Z",
        },
      ],
      prevCursor: null,
      totalRecordCount: 2,
    });

    // Every envelope actually published during this relaunch — not merely the ones this
    // test waited on — parses against the exact schema its own `kind` names, proving the
    // whole streamed sequence (including the incidental capability-growth event) is
    // schema-valid end to end, the same discipline `kernel.integration.test.ts`'s own gate
    // already establishes.
    for (const envelope of envelopes) {
      const schema =
        eventPayloadV1SchemaByKind[envelope.kind as keyof typeof eventPayloadV1SchemaByKind];
      expect(schema.safeParse(envelope.payload).success).toBe(true);
    }
  });
});
