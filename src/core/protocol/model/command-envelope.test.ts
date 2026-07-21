import { describe, expect, test } from "bun:test"

import { uuidv7 } from "infrastructure/uuid"

import { COMMAND_KINDS_V1 } from "./command-kind"
import { CommandDecodeError, decodeCommandEnvelope, envelopeFingerprint } from "./command-envelope"

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    commandId: uuidv7(),
    expectedRevision: "7",
    kind: "chat.create",
    payload: {},
    ...overrides,
  }
}

describe("decodeCommandEnvelope", () => {
  test("accepts a well-formed envelope and returns it typed", () => {
    const raw = envelope()
    const decoded = decodeCommandEnvelope(raw)
    expect(decoded).not.toBeInstanceOf(Error)
    if (decoded instanceof Error) return
    expect(decoded.kind).toBe("chat.create")
    expect(decoded.expectedRevision).toBe("7")
  })

  test("rejects an unsupported protocol version with its own code", () => {
    // §11.1 separates UNSUPPORTED_PROTOCOL from INVALID_ENVELOPE: a version mismatch
    // is a negotiable condition, a malformed body is not.
    const decoded = decodeCommandEnvelope(envelope({ protocolVersion: 2 }))
    expect(decoded).toBeInstanceOf(CommandDecodeError)
    if (!(decoded instanceof CommandDecodeError)) return
    expect(decoded.code).toBe("UNSUPPORTED_PROTOCOL")
  })

  test("reports a malformed envelope as INVALID_ENVELOPE", () => {
    for (const bad of [
      envelope({ commandId: "not-a-uuid" }),
      envelope({ expectedRevision: "007" }),
      envelope({ expectedRevision: 7 }),
      envelope({ kind: "chat.destroy" }),
      envelope({ extra: true }),
      null,
      "string",
      42,
      [],
    ]) {
      const decoded = decodeCommandEnvelope(bad)
      expect(decoded).toBeInstanceOf(CommandDecodeError)
      if (!(decoded instanceof CommandDecodeError)) continue
      expect(decoded.code).toBe("INVALID_ENVELOPE")
    }
  })

  test("validates the payload against the schema of its own kind", () => {
    // chat.switch requires a chatId; an empty payload belongs to chat.create.
    const decoded = decodeCommandEnvelope(envelope({ kind: "chat.switch", payload: {} }))
    expect(decoded).toBeInstanceOf(CommandDecodeError)
  })

  test("rejects a payload valid for a different kind", () => {
    const decoded = decodeCommandEnvelope(
      envelope({ kind: "chat.create", payload: { chatId: uuidv7() } }),
    )
    expect(decoded).toBeInstanceOf(CommandDecodeError)
  })

  test("every command kind is decodable — no kind is unreachable through the envelope", () => {
    // A kind present in the union but missing from the payload map would be a command
    // the protocol advertises and can never accept.
    for (const kind of COMMAND_KINDS_V1) {
      const decoded = decodeCommandEnvelope(envelope({ kind, payload: {} }))
      // errore tagged-template vars are typed string | number, so coerce before matching
      // (the repo idiom — see host-state-machine.ts and entry.ts).
      const unreachable =
        decoded instanceof CommandDecodeError &&
        String(decoded.reason).includes("no payload schema")
      expect(unreachable).toBe(false)
    }
  })
})

describe("envelopeFingerprint", () => {
  test("is stable across key order in the envelope and in the payload", () => {
    const id = uuidv7()
    const left = {
      protocolVersion: 1,
      commandId: id,
      expectedRevision: "3",
      kind: "chat.switch",
      payload: { chatId: id },
    }
    const right = {
      payload: { chatId: id },
      kind: "chat.switch",
      expectedRevision: "3",
      commandId: id,
      protocolVersion: 1,
    }
    expect(envelopeFingerprint(left)).toBe(envelopeFingerprint(right))
  })

  test("changes when any field changes", () => {
    const raw = envelope({ kind: "turn.cancel", payload: { turnId: uuidv7() } })
    const base = envelopeFingerprint(raw)
    expect(envelopeFingerprint({ ...raw, expectedRevision: "8" })).not.toBe(base)
    expect(envelopeFingerprint({ ...raw, commandId: uuidv7() })).not.toBe(base)
    expect(envelopeFingerprint({ ...raw, payload: { turnId: uuidv7() } })).not.toBe(base)
  })

  test("returns the error rather than a hash when the envelope cannot be canonicalized", () => {
    expect(envelopeFingerprint({ ...envelope(), payload: { a: undefined } })).toBeInstanceOf(Error)
  })
})
