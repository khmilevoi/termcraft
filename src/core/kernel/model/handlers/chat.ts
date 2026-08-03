import { wrap } from "@reatom/core";

import { buildChatRecordsPayload, resolveChatDisplayName } from "core/chats";
import type { ChatSummaryV1 } from "core/chats";
import type { PublishableEventV1 } from "core/mailbox";
import type { EventPayloadByKindV1 } from "core/protocol";

import type { CommandHandler, FamilyHandlerMap, HandlerContext } from "./types";
import { startedOutcome } from "./types";

/**
 * `chat.create` / `chat.switch` (kernel-assembly WP-1 task 9, Step B — the `chat`
 * family). Both are the two `ChatMutations` commands kernel-command-contract §8.2
 * names: `chat.create` ("Create and select a fresh chat through a Kernel
 * transaction"), `chat.switch` ("Select an existing chat without changing shared
 * pages, preview, selection, or pins."). `chat` has no state machine of its own among
 * the seven `KernelMachines` (`./types.ts`'s own comment: "chat/model/page/selection/
 * pin/history have no machine of their own"), so neither handler ever calls
 * `context.machines.*`, and neither touches any of `HandlerContext`'s five Kernel-held
 * mutators — nothing about "which chat is active" is Kernel-held state today (see the
 * divergence note below).
 *
 * BOTH PORT CALLS ARE GENUINELY ASYNC (`ChatMutations.create`/`switchActive` both
 * return a `Promise`), and `CommandHandler` itself returns `CommandOutcomeV1`
 * SYNCHRONOUSLY, never a `Promise` (`./types.ts`'s own `CommandHandler` doc) — so
 * neither handler can simply `await` its port call inline. `context.launchOperation`
 * (`./types.ts`) is the one sanctioned way to start that async work: each handler
 * calls it exactly once, synchronously, with a `run` closure that performs the actual
 * port call(s) and converts the result into this operation's terminal events, then
 * returns `startedOutcome([])` — no admission events fire synchronously here, because
 * nothing about the outcome (was a chat created? did the switch succeed?) is known
 * until the promise settles. No `operationId` is minted either: kernel-command-contract
 * §8.3's `operationId` is reserved for the recoverable, progress-tracked operations
 * (`commit`/`export`/`migration`/`restore`) that later retry or report progress by that
 * id — `chat.create`/`chat.switch` are neither, and nothing in §8.2's row for either
 * command mentions one.
 *
 * TWO OUTCOMES ONLY, PER `CommandHandler`'s OWN DOC — never a third, handler-invented
 * "failed" shape:
 * - `ChatMutations.create`/`switchActive` succeeds -> the operation publishes a
 *   `chat.changed` event AND a `chat.records` event (WP-10 Task 5: the new event kind,
 *   `core/protocol/model/event-kind.ts`, carrying the chat's persisted tail so a
 *   fresh-open UI can restore scrollback — see the "tail delivery" note below for the
 *   exact split between the two handlers).
 * - `ChatMutations.create`/`switchActive` fails (`FailureDtoV1`) -> the operation
 *   publishes NO event and logs the failure (errore rule 21: an error this module
 *   chooses not to propagate must still leave a trace). This is a deliberate,
 *   documented divergence from `CommandHandler`'s "ran and failed" category (which
 *   says a failure should still publish a `*.failed`-shaped event): the closed v1
 *   event registry has no `chat.failed` (or any other `chat.*`) member to carry one,
 *   and inventing an event kind outside that closed union is exactly the "forging a
 *   reason/event shape the protocol does not cover" this project's rules forbid
 *   (mirroring `./deferred.ts`'s own header comment on why `migration.*` is not
 *   silently folded into a shape `core/versions` does not actually give it). Since
 *   `ChatMutations`'s own port contract is the only thing that failed here — no Kernel
 *   fact, no durable persisted state changed as a result — "no event, logged" is the
 *   closest sound encoding available, not a guess.
 *
 * TAIL DELIVERY (WP-10 Task 5, `docs/superpowers/plans/2026-07-24-chat-transport.md`):
 * - `chat.create`'s fresh chat has no records yet — its `chat.records` payload is built
 *   directly as `{chatId, records: [], prevCursor: null}`, no `ChatReader` round trip
 *   needed (there is nothing on disk yet to load).
 * - `chat.switch` loads the switched-to chat's tail through `ChatReader.open` +
 *   `ChatHandleV1.loadTail` (`loadActiveChatTail` below), derives its `displayName`
 *   (`core/chats`'s `resolveChatDisplayName`, walking back to the chat's true first page —
 *   see that function's own doc comment) from the loaded records, and reports it on
 *   `chat.changed`'s `updated` array. A tail-load failure here is a SEPARATE, best-effort
 *   concern from the switch itself: it is logged (errore rule 21) and BOTH the summary
 *   and the `chat.records` event are skipped for this operation, but `chat.changed`
 *   still publishes reporting the switch — mirroring the `writeWorkspaceState`-failure
 *   handling immediately below (a producer hiccup after the fact must not undo or hide a
 *   state change that already genuinely happened).
 *
 * BOTH HANDLERS PERSIST THE ACTIVE CHAT the SAME WAY: kernel-assembly task 9's own
 * brief for this family says "chat.switch also persists the active chat via
 * ProjectStore.writeWorkspaceState per the workspace-state shape" — but `turn.start`
 * resolves ITS active chat from that SAME durable `ProjectStore.readWorkspaceState()`
 * read (`turn.ts`'s own admission read), never from the `ui/mirror` slice
 * `chat.changed` updates, so `chat.create` needs the identical write or a turn
 * dispatched right after `/new` finds durable `activeChatId` still `null` and refuses
 * admission (seam finding, fix wave — this was originally a documented asymmetry:
 * "chat.switch has one extra step chat.create does not", which the seam finding showed
 * was actually a gap, not a deliberate omission). So after a successful
 * `create`/`switchActive`, each handler also calls
 * `context.deps.projectStore.writeWorkspaceState({ activeChatId: <the chat just
 * created/switched to> })` (`core/ports/project-store.ts`'s own
 * `WorkspaceStateV1.activeChatId: string | null` field) to persist the choice
 * machine-locally. IF THAT WRITE ITSELF FAILS, the operation still publishes
 * `chat.changed`: `create`/`switchActive` already succeeded by that point — the live,
 * in-Kernel active chat genuinely did get created or did switch, which is the fact
 * `chat.changed.activeChatId` reports — and `writeWorkspaceState` is a best-effort
 * DURABILITY step (so the choice survives a restart), not the source of truth for
 * whether the create/switch itself took place. A write failure here is logged, never
 * silently dropped, but does not roll back or suppress the event a successful,
 * already-completed create/switch earned.
 *
 * `kernel.snapshot`'s OWN `activeChatId` field (`KernelSnapshotPayloadV1`,
 * distinct from this file's `chat.changed.activeChatId`) is deliberately NOT updated
 * by either handler here: `HandlerContext` (`./types.ts`) exposes exactly five
 * Kernel-held mutators, none of which is an `activeChatId` setter, and `kernel.ts`'s
 * own construction comment already assigns populating `kernel.snapshot`'s
 * `projectId`/`activePageSlug`/`activeChatId` trio to "Task 9's `project.open`/
 * `project.create` handlers" — a different, already-named family, not `chat`. Adding
 * a sixth mutator to `HandlerContext` to let `chat` reach that fact too would be
 * exactly the "invent kernel state outside the contract" this task's brief forbids
 * when a primitive is missing; since nothing in this family's own brief asks for it
 * (the brief names only `ChatMutations` calls, `chat.*` events, and the
 * `ProjectStore.writeWorkspaceState` persistence above), this is a documented
 * non-gap, not a silently-skipped one.
 */

type ChatChangedPayloadV1 = EventPayloadByKindV1["chat.changed"];
type ChatRecordsPayloadV1 = EventPayloadByKindV1["chat.records"];

function chatChangedEvent(payload: ChatChangedPayloadV1): PublishableEventV1<"chat.changed"> {
  return { kind: "chat.changed", payload };
}

function chatRecordsEvent(payload: ChatRecordsPayloadV1): PublishableEventV1<"chat.records"> {
  return { kind: "chat.records", payload };
}

/** {@link loadActiveChatTail}'s successful result — the switched-to chat's refreshed summary plus its `chat.records` event, built together since both are derived from the SAME loaded tail. */
interface ActiveChatTail {
  readonly summary: ChatSummaryV1;
  readonly recordsEvent: PublishableEventV1<"chat.records">;
}

/**
 * Loads `chatId`'s persisted tail through `ChatReader.open` + `ChatHandleV1.loadTail`
 * (WP-10 Task 5) and derives its `displayName` (design §3.9) from the chat's TRUE first
 * `user` record via `core/chats`'s `resolveChatDisplayName` — NOT from the (possibly
 * later, bounded) tail page alone, which names the wrong record for any chat longer than
 * one tail page (review finding IMPORTANT, WP-10 fix wave; see `resolveChatDisplayName`'s
 * own doc comment for why the existing `loadBefore` cursor is sufficient without a port
 * extension). `null` on ANY of `open`/`loadTail`/the display-name walk's own `loadBefore`
 * calls failing — logged here (errore rule 21), never propagated: this is `chat.switch`'s
 * OWN best-effort tail read, distinct from whether the switch itself succeeded (see this
 * file's header, "TAIL DELIVERY"). Every port call here is `await wrap(...)`-ed (Reatom
 * rule RTM-A04) — a raw `await` drops the Kernel's own Reatom frame the moment control
 * returns to the event loop, and a LATER `wrap(...)` call in the same closure would then
 * only ever restore an already-dropped frame (review finding RTM-A04, WP-10 fix wave).
 */
async function loadActiveChatTail(
  context: HandlerContext,
  chatId: string,
): Promise<ActiveChatTail | null> {
  const handle = await wrap(context.deps.chatReader.open(chatId));
  if ("code" in handle) {
    console.warn(
      `core/kernel: chat.switch could not open chatId ${chatId} to load its tail: ${handle.safeMessage}`,
    );
    return null;
  }

  const loadResult = await wrap(handle.loadTail());
  if ("code" in loadResult) {
    console.warn(
      `core/kernel: chat.switch could not load the tail for chatId ${chatId}: ${loadResult.safeMessage}`,
    );
    return null;
  }

  const displayName = await wrap(resolveChatDisplayName(handle, loadResult));
  // `resolveChatDisplayName`'s success values (`string | null`) are never objects, so a bare
  // `"code" in displayName` would throw for them — `value !== null && typeof value ===
  // "object"` is this codebase's own established failure-narrowing idiom for a union whose
  // success side includes primitives/`null` (`core/ports/fakes/projections.ts`,
  // `store/transaction/model/plan.ts`).
  if (displayName !== null && typeof displayName === "object") {
    console.warn(
      `core/kernel: chat.switch could not resolve chatId ${chatId}'s true first-page display name: ${displayName.safeMessage}`,
    );
    return null;
  }

  const recordsPayload = buildChatRecordsPayload(chatId, loadResult);
  return {
    summary: {
      chatId,
      createdAt: handle.header.createdAt,
      displayName,
    },
    recordsEvent: chatRecordsEvent(recordsPayload),
  };
}

const handleChatCreate: CommandHandler<"chat.create"> = (_payload, context) => {
  context.launchOperation("kernel.chat.create", async () => {
    const header = await wrap(context.deps.chatMutations.create());
    if ("code" in header) {
      console.warn(`core/kernel: chat.create failed: ${header.safeMessage}`);
      return [];
    }

    // Persist the freshly minted chat as active the SAME way `chat.switch` does (this
    // file's header, "BOTH HANDLERS PERSIST THE ACTIVE CHAT" paragraph) — `turn.start`
    // resolves its active chat from `ProjectStore.readWorkspaceState()` (`turn.ts`'s own
    // admission read), never from the `ui/mirror` slice `chat.changed` below updates, so
    // without this write a turn dispatched right after `/new` would find durable
    // `activeChatId` still `null` and refuse admission (seam finding, fix wave). A write
    // failure here is best-effort and logged (errore rule 21), never blocking: exactly
    // like `chat.switch`, `ChatMutations.create` already succeeded by this point — the
    // fact `chat.changed.activeChatId` below reports — and `writeWorkspaceState` only
    // affects whether that choice survives a restart, not whether creation happened.
    const persistFailure = await wrap(
      context.deps.projectStore.writeWorkspaceState({
        activeChatId: header.chatId,
      }),
    );
    if (persistFailure !== undefined) {
      console.warn(
        `core/kernel: chat.create succeeded but persisting the active chat failed: ${persistFailure.safeMessage}`,
      );
    }

    return [
      chatChangedEvent({
        activeChatId: header.chatId,
        // A freshly created chat has no records yet, so its derived display name
        // (design §3.9, `core/chats`'s `deriveChatDisplayName`) is null until a
        // `user` record lands — see `chat.switch`/`project.open` (WP-10 Tasks 5/6) for
        // the paths that fill this field from an already-loaded tail.
        added: [{ chatId: header.chatId, createdAt: header.createdAt, displayName: null }],
        updated: [],
        removedChatIds: [],
      }),
      // The empty tail, built directly (WP-10 Task 5, this file's header "TAIL DELIVERY")
      // — no `ChatReader` round trip: a chat this fresh has nothing on disk to load, and
      // publishing the empty page still clears any stale `ui/mirror` records slice left
      // over from a previously active chat (see the WP-10 plan's own mirror-fence note).
      // A chat this fresh has nothing on disk, so its total is 0 — the honest count, not a
      // placeholder (chat-scroll spec §6.3).
      chatRecordsEvent({
        chatId: header.chatId,
        records: [],
        prevCursor: null,
        totalRecordCount: 0,
      }),
    ];
  });

  return startedOutcome([]);
};

const handleChatSwitch: CommandHandler<"chat.switch"> = (payload, context) => {
  context.launchOperation("kernel.chat.switch", async () => {
    const switchFailure = await wrap(context.deps.chatMutations.switchActive(payload.chatId));
    if (switchFailure !== undefined) {
      console.warn(`core/kernel: chat.switch failed: ${switchFailure.safeMessage}`);
      return [];
    }

    const persistFailure = await wrap(
      context.deps.projectStore.writeWorkspaceState({
        activeChatId: payload.chatId,
      }),
    );
    if (persistFailure !== undefined) {
      console.warn(
        `core/kernel: chat.switch succeeded but persisting the active chat failed: ${persistFailure.safeMessage}`,
      );
    }

    const tail = await wrap(loadActiveChatTail(context, payload.chatId));
    if (tail === null) {
      return [
        chatChangedEvent({
          activeChatId: payload.chatId,
          added: [],
          updated: [],
          removedChatIds: [],
        }),
      ];
    }

    return [
      chatChangedEvent({
        activeChatId: payload.chatId,
        added: [],
        updated: [tail.summary],
        removedChatIds: [],
      }),
      tail.recordsEvent,
    ];
  });

  return startedOutcome([]);
};

/** The `chat` family's `FamilyHandlerMap` — `chat.create` and `chat.switch`, the only two `chat.*` `CommandKindV1` members (neither is Tier-C deferred). */
export const chatHandlers: FamilyHandlerMap<"chat"> = {
  "chat.create": handleChatCreate,
  "chat.switch": handleChatSwitch,
};
