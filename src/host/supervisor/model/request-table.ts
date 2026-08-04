// ProtocolError is type-only here (it flows through the table as a terminal outcome
// when the pump settles a request with a MALFORMED_PROTOCOL identity error).
import type { ControlEnvelope, ProtocolError } from "../../protocol";
import type { RequestTable } from "../types";
import type { Clock, TimerHandle } from "./clock";
import { SupervisorError } from "./errors";

/** Outstanding request table capacity (host-supervision §8). */
export const REQUEST_TABLE_CAPACITY = 64;
const QUERY_TIMEOUT_MS = 2_000;

interface PendingEntry {
  readonly kind: string;
  readonly settle: (result: ControlEnvelope | ProtocolError | SupervisorError) => void;
  readonly timer: TimerHandle;
}

/**
 * The outstanding request table (host-supervision §7, §8, §9). Every registered
 * request has exactly ONE terminal outcome: a matching `resolve`, a local
 * `supersede` (`SUPERSEDED`), a `QUERY_TIMEOUT` at the table's default budget or
 * at the per-request budget the caller named (`mount` names §9.4's mount
 * deadline, five times the default), or a teardown `clear`. A response for an
 * unknown/already-settled correlation id is discarded. `onTimeout` feeds the
 * heartbeat watchdog's unresponsiveness counter (§9).
 */
export function createRequestTable(
  clock: Clock,
  opts?: { onTimeout?: () => void; capacity?: number; timeoutMs?: number },
): RequestTable {
  const capacity = opts?.capacity ?? REQUEST_TABLE_CAPACITY;
  const tableTimeoutMs = opts?.timeoutMs ?? QUERY_TIMEOUT_MS;
  const onTimeout = opts?.onTimeout;
  const entries = new Map<string, PendingEntry>();

  function register(
    requestId: string,
    kind: string,
    timeoutMs?: number,
  ): Promise<ControlEnvelope | ProtocolError | SupervisorError> {
    if (entries.size >= capacity) {
      return Promise.resolve(
        new SupervisorError({
          code: "TOO_MANY_REQUESTS",
          reason: `request table full (${capacity})`,
        }),
      );
    }
    if (entries.has(requestId)) {
      return Promise.resolve(
        new SupervisorError({
          code: "TRANSPORT_ERROR",
          reason: `duplicate requestId ${requestId}`,
        }),
      );
    }
    // `Promise.withResolvers` hands back the resolver directly, so there is no
    // definite-assignment dance and no TS7 `never`-narrowing trap to work around.
    const { promise, resolve: settle } = Promise.withResolvers<
      ControlEnvelope | ProtocolError | SupervisorError
    >();
    const effectiveTimeoutMs = timeoutMs ?? tableTimeoutMs;
    const timer = clock.setTimer(effectiveTimeoutMs, () => {
      entries.delete(requestId);
      onTimeout?.();
      settle(
        new SupervisorError({
          code: "QUERY_TIMEOUT",
          reason: `no response for ${kind} within ${effectiveTimeoutMs}ms`,
        }),
      );
    });
    entries.set(requestId, { kind, settle, timer });
    return promise;
  }

  function resolve(responseTo: string, envelope: ControlEnvelope): void {
    const entry = entries.get(responseTo);
    if (entry === undefined) return; // late / unknown response — discarded (§9)
    entry.timer.cancel();
    entries.delete(responseTo);
    entry.settle(envelope);
  }

  function supersede(requestId: string, reason: string): void {
    const entry = entries.get(requestId);
    if (entry === undefined) return;
    entry.timer.cancel();
    entries.delete(requestId);
    entry.settle(new SupervisorError({ code: "SUPERSEDED", reason }));
  }

  function clear(error?: ProtocolError | SupervisorError): void {
    const terminal =
      error ??
      new SupervisorError({ code: "TRANSPORT_ERROR", reason: "request table cleared on teardown" });
    for (const entry of entries.values()) {
      entry.timer.cancel();
      entry.settle(error === undefined ? terminal : error);
    }
    entries.clear();
  }

  return {
    register,
    resolve,
    supersede,
    clear,
    size: () => entries.size,
  };
}
