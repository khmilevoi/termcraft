import * as errore from "errore";

import type {
  CommandKindV1,
  CommandPayloadByKindV1,
  CommandResultV1,
  UInt64String,
} from "core/protocol";
import { uuidv7 } from "infrastructure/uuid";

import type { KernelPort } from "../types";

/**
 * A `KernelPort.dispatch` promise rejected. The port contract returns errors as VALUES, so
 * this only fires if a composition-root adapter (or a test double) throws instead — wrapped
 * here with its cause per the errore boundary rules so the failure is a typed value, never a
 * thrown exception escaping into a React event handler.
 */
export class KernelDispatchError extends errore.createTaggedError({
  name: "KernelDispatchError",
  message: "kernel dispatch threw for $kind",
}) {}

/**
 * The single command-issuance seam every screen uses (phase-7 plan D4). It mints one fresh
 * `commandId` per user intent (§8.5), stamps the caller's last-mirrored `stateRevision` as
 * `expectedRevision`, builds the raw `CommandEnvelopeV1` shape, and forwards it to the port —
 * which owns decoding/validation. No component ever hand-builds an envelope.
 */
export interface Dispatcher {
  dispatch<K extends CommandKindV1>(
    kind: K,
    payload: CommandPayloadByKindV1[K],
  ): Promise<CommandResultV1 | Error>;
}

export interface DispatcherDeps {
  readonly port: Pick<KernelPort, "dispatch">;
  /** Reads the UI mirror's current `stateRevision` — the value echoed as `expectedRevision`. */
  readonly revision: () => UInt64String;
}

export function createDispatcher({ port, revision }: DispatcherDeps): Dispatcher {
  async function dispatch<K extends CommandKindV1>(
    kind: K,
    payload: CommandPayloadByKindV1[K],
  ): Promise<CommandResultV1 | Error> {
    // Every reactive/mirror read happens BEFORE the await — nothing below touches an atom.
    const raw = {
      protocolVersion: 1 as const,
      commandId: uuidv7(),
      expectedRevision: revision(),
      kind,
      payload,
    };
    return await port
      .dispatch(raw)
      .catch((cause: Error) => new KernelDispatchError({ kind, cause }));
  }
  return { dispatch };
}
