import { describe, expect, test } from "bun:test";

import type { ControlEnvelope, JsonValue } from "../../protocol";
import type { ControlEvent } from "../types";
import { CONTROL_MAILBOX_CAPACITY, createControlMailbox } from "./control-mailbox";
import { SupervisorError } from "./errors";

const ID = { sessionId: "s-1", nonce: "a".repeat(32) };
let mid = 0;
function env(kind: string, extra: Record<string, JsonValue> = {}): ControlEnvelope {
  mid += 1;
  return {
    protocolVersion: 1,
    kind,
    sessionId: ID.sessionId,
    nonce: ID.nonce,
    messageId: String(mid),
    body: extra,
  };
}
const event = (kind: string, extra?: Record<string, JsonValue>): ControlEvent => ({
  kind,
  envelope: env(kind, extra),
});

describe("createControlMailbox — capacity + CONTROL_BACKPRESSURE (§8)", () => {
  test("capacity constant is 256", () => {
    expect(CONTROL_MAILBOX_CAPACITY).toBe(256);
  });

  test("256 offers are accepted, the 257th is rejected with CONTROL_BACKPRESSURE and nothing is enqueued", () => {
    const mailbox = createControlMailbox();
    for (let i = 0; i < CONTROL_MAILBOX_CAPACITY; i += 1) {
      expect(mailbox.offer(event("input", { n: i }))).toBe("accepted");
    }
    expect(mailbox.size()).toBe(CONTROL_MAILBOX_CAPACITY);
    const overflow = mailbox.offer(event("input", { n: 999 }));
    expect(overflow).toBeInstanceOf(SupervisorError);
    if (overflow instanceof SupervisorError) {
      expect(overflow.code).toBe("CONTROL_BACKPRESSURE");
      expect(overflow.reason).toBe("inbound control mailbox full (256)");
    }
    expect(mailbox.size()).toBe(CONTROL_MAILBOX_CAPACITY); // unchanged — the rejected event was not enqueued
    // the first accepted event is still first (nothing dropped/reordered by the rejection)
    expect(mailbox.drain()?.envelope.body.n).toBe(0);
  });

  test("drain frees slots so offer succeeds again, and drain is FIFO", () => {
    const mailbox = createControlMailbox();
    for (let i = 0; i < CONTROL_MAILBOX_CAPACITY; i += 1) mailbox.offer(event("input", { n: i }));
    expect(mailbox.offer(event("input", { n: 256 }))).toBeInstanceOf(SupervisorError); // full

    // drain three oldest — FIFO order
    expect(mailbox.drain()?.envelope.body.n).toBe(0);
    expect(mailbox.drain()?.envelope.body.n).toBe(1);
    expect(mailbox.drain()?.envelope.body.n).toBe(2);
    expect(mailbox.size()).toBe(CONTROL_MAILBOX_CAPACITY - 3);

    // slots freed ⇒ offers accepted again
    expect(mailbox.offer(event("input", { n: 300 }))).toBe("accepted");
    expect(mailbox.offer(event("input", { n: 301 }))).toBe("accepted");
    expect(mailbox.offer(event("input", { n: 302 }))).toBe("accepted");
    expect(mailbox.size()).toBe(CONTROL_MAILBOX_CAPACITY);
    // the newly-offered events tail the FIFO after the remaining originals (3..255)
    expect(mailbox.drain()?.envelope.body.n).toBe(3);
  });
});

describe("createControlMailbox — reserved terminal slot (§8)", () => {
  test("offerTerminal is accepted even when the ordinary buffer is full and does not count toward size()", () => {
    const mailbox = createControlMailbox();
    for (let i = 0; i < CONTROL_MAILBOX_CAPACITY; i += 1) mailbox.offer(event("input", { n: i }));
    expect(mailbox.size()).toBe(CONTROL_MAILBOX_CAPACITY);
    mailbox.offerTerminal(event("fatal"));
    expect(mailbox.size()).toBe(CONTROL_MAILBOX_CAPACITY); // terminal slot excluded from size()
    // ordinary offers still rejected — terminal did not consume an ordinary slot
    expect(mailbox.offer(event("input", { n: 999 }))).toBeInstanceOf(SupervisorError);
  });

  test("ordinary events drain first; the terminal event drains last, then null", () => {
    const mailbox = createControlMailbox();
    for (let i = 0; i < CONTROL_MAILBOX_CAPACITY; i += 1) mailbox.offer(event("input", { n: i }));
    mailbox.offerTerminal(event("fatal", { code: "CONTROL_BACKPRESSURE" }));

    for (let i = 0; i < CONTROL_MAILBOX_CAPACITY; i += 1) {
      expect(mailbox.drain()?.envelope.body.n).toBe(i);
    }
    expect(mailbox.size()).toBe(0); // ordinary buffer empty; terminal slot excluded
    const terminal = mailbox.drain();
    expect(terminal?.kind).toBe("fatal");
    expect(terminal?.envelope.body.code).toBe("CONTROL_BACKPRESSURE");
    expect(mailbox.drain()).toBeNull(); // terminal returned once only
  });

  test("terminal event drains when no ordinary events are buffered", () => {
    const mailbox = createControlMailbox();
    mailbox.offerTerminal(event("fatal"));
    expect(mailbox.size()).toBe(0);
    expect(mailbox.drain()?.kind).toBe("fatal");
    expect(mailbox.drain()).toBeNull();
  });
});

describe("createControlMailbox — empty behaviour (§8)", () => {
  test("drain() on an empty mailbox returns null and size() is 0", () => {
    const mailbox = createControlMailbox();
    expect(mailbox.size()).toBe(0);
    expect(mailbox.drain()).toBeNull();
  });
});
