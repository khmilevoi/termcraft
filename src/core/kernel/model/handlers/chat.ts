import type { PublishableEventV1 } from "core/mailbox";
import type { EventPayloadByKindV1 } from "core/protocol";

import type { CommandHandler, FamilyHandlerMap } from "./types";
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
 * - `ChatMutations.create`/`switchActive` succeeds -> the operation publishes exactly
 *   one `chat.changed` event (the only `chat.*` `EventKindV1` member the closed v1
 *   protocol defines, `core/protocol/model/event-kind.ts`).
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
 * `chat.switch` HAS ONE EXTRA STEP `chat.create` DOES NOT: kernel-assembly task 9's
 * own brief for this family — "chat.switch also persists the active chat via
 * ProjectStore.writeWorkspaceState per the workspace-state shape" — so, after a
 * successful `switchActive`, the handler also calls
 * `context.deps.projectStore.writeWorkspaceState({ activeChatId })`
 * (`core/ports/project-store.ts`'s own `WorkspaceStateV1.activeChatId: string | null`
 * field) to persist the choice machine-locally. IF THAT WRITE ITSELF FAILS, the
 * operation still publishes `chat.changed`: `switchActive` already succeeded by that
 * point — the live, in-Kernel active chat genuinely did switch, which is the fact
 * `chat.changed.activeChatId` reports — and `writeWorkspaceState` is a best-effort
 * DURABILITY step (so the choice survives a restart), not the source of truth for
 * whether the switch itself took place. A write failure here is logged, never
 * silently dropped, but does not roll back or suppress the event a successful,
 * already-completed switch earned.
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

function chatChangedEvent(payload: ChatChangedPayloadV1): PublishableEventV1<"chat.changed"> {
  return { kind: "chat.changed", payload };
}

const handleChatCreate: CommandHandler<"chat.create"> = (_payload, context) => {
  context.launchOperation("kernel.chat.create", async () => {
    const header = await context.deps.chatMutations.create();
    if ("code" in header) {
      console.warn(`core/kernel: chat.create failed: ${header.safeMessage}`);
      return [];
    }

    return [
      chatChangedEvent({
        activeChatId: header.chatId,
        // A freshly created chat has no records yet, so its derived display name
        // (design §3.9, `core/chats`'s `deriveChatDisplayName`) is null until a
        // `user` record lands — see WP-10 Task 5 for the `chat.switch`/`project.open`
        // paths that fill this field from an already-loaded tail.
        added: [{ chatId: header.chatId, createdAt: header.createdAt, displayName: null }],
        updated: [],
        removedChatIds: [],
      }),
    ];
  });

  return startedOutcome([]);
};

const handleChatSwitch: CommandHandler<"chat.switch"> = (payload, context) => {
  context.launchOperation("kernel.chat.switch", async () => {
    const switchFailure = await context.deps.chatMutations.switchActive(payload.chatId);
    if (switchFailure !== undefined) {
      console.warn(`core/kernel: chat.switch failed: ${switchFailure.safeMessage}`);
      return [];
    }

    const persistFailure = await context.deps.projectStore.writeWorkspaceState({
      activeChatId: payload.chatId,
    });
    if (persistFailure !== undefined) {
      console.warn(
        `core/kernel: chat.switch succeeded but persisting the active chat failed: ${persistFailure.safeMessage}`,
      );
    }

    return [
      chatChangedEvent({
        activeChatId: payload.chatId,
        added: [],
        updated: [],
        removedChatIds: [],
      }),
    ];
  });

  return startedOutcome([]);
};

/** The `chat` family's `FamilyHandlerMap` — `chat.create` and `chat.switch`, the only two `chat.*` `CommandKindV1` members (neither is Tier-C deferred). */
export const chatHandlers: FamilyHandlerMap<"chat"> = {
  "chat.create": handleChatCreate,
  "chat.switch": handleChatSwitch,
};
