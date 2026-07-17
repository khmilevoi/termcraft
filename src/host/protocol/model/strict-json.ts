import * as errore from "errore"

import { ProtocolError } from "./errors"

/** A structurally-valid JSON value produced by the strict decoder. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true })

/** §5: invalid UTF-8 is a protocol violation. A non-streaming decode resets each call. */
export function decodeUtf8(bytes: Uint8Array): ProtocolError | string {
  // errore.try's custom-catch overload takes an OPTIONS OBJECT { try, catch } in
  // this installed version (^0.14.1) — not positional args. The catch callback is
  // typed (e: Error).
  return errore.try({
    try: () => UTF8_DECODER.decode(bytes),
    catch: (cause) =>
      new ProtocolError({
        code: "MALFORMED_PROTOCOL",
        reason: "payload is not valid UTF-8",
        cause,
      }),
  })
}

/**
 * Structurally parse JSON, then enforce the two §5 rules `JSON.parse` cannot:
 * duplicate object keys and unsafe-integer number tokens. `JSON.parse` already
 * rejects malformed input and the non-finite `NaN`/`Infinity` literals.
 */
export function parseStrictJson(text: string): ProtocolError | JsonValue {
  const parsed = errore.try({
    try: () => JSON.parse(text) as JsonValue,
    catch: (cause) =>
      new ProtocolError({
        code: "MALFORMED_PROTOCOL",
        reason: "payload is not valid JSON",
        cause,
      }),
  })
  if (parsed instanceof ProtocolError) return parsed

  const violation = scanStrictJson(text)
  if (violation instanceof ProtocolError) return violation

  return parsed
}

/** Convenience: UTF-8 decode then strict JSON parse. */
export function decodeJsonPayload(bytes: Uint8Array): ProtocolError | JsonValue {
  const text = decodeUtf8(bytes)
  if (text instanceof ProtocolError) return text
  return parseStrictJson(text)
}

// The scanner assumes `text` is already valid JSON (JSON.parse accepted it), so
// it never has to recover from malformed structure — it only walks tokens and
// flags duplicate keys and unsafe-integer number tokens. `JSON.parse` decodes
// key string tokens so escaped and literal spellings of the same key collide.
function scanStrictJson(text: string): ProtocolError | null {
  const objectKeys: Set<string>[] = []
  const contexts: ("object" | "array")[] = []
  let expectingKey = false
  let pos = 0
  const length = text.length

  while (pos < length) {
    const ch = text.charAt(pos)
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      pos += 1
      continue
    }
    if (ch === "{") {
      contexts.push("object")
      objectKeys.push(new Set())
      expectingKey = true
      pos += 1
      continue
    }
    if (ch === "}") {
      contexts.pop()
      objectKeys.pop()
      expectingKey = false
      pos += 1
      continue
    }
    if (ch === "[") {
      contexts.push("array")
      expectingKey = false
      pos += 1
      continue
    }
    if (ch === "]") {
      contexts.pop()
      pos += 1
      continue
    }
    if (ch === ":") {
      expectingKey = false
      pos += 1
      continue
    }
    if (ch === ",") {
      expectingKey = contexts[contexts.length - 1] === "object"
      pos += 1
      continue
    }
    if (ch === '"') {
      const end = scanStringEnd(text, pos)
      if (expectingKey && contexts[contexts.length - 1] === "object") {
        const key = JSON.parse(text.slice(pos, end)) as string
        const keys = objectKeys[objectKeys.length - 1]
        if (keys) {
          if (keys.has(key)) {
            return new ProtocolError({
              code: "MALFORMED_PROTOCOL",
              reason: `duplicate object key ${JSON.stringify(key)}`,
            })
          }
          keys.add(key)
        }
        expectingKey = false
      }
      pos = end
      continue
    }
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      const end = scanNumberEnd(text, pos)
      const violation = checkNumberToken(text.slice(pos, end))
      if (violation instanceof ProtocolError) return violation
      pos = end
      continue
    }
    // true / false / null — advance one letter at a time; structure is already valid.
    pos += 1
  }
  return null
}

function scanStringEnd(text: string, start: number): number {
  let pos = start + 1
  while (pos < text.length) {
    const ch = text.charAt(pos)
    if (ch === "\\") {
      pos += 2
      continue
    }
    if (ch === '"') return pos + 1
    pos += 1
  }
  return pos
}

function scanNumberEnd(text: string, start: number): number {
  let pos = start
  while (pos < text.length) {
    const ch = text.charAt(pos)
    const isNumberChar =
      (ch >= "0" && ch <= "9") ||
      ch === "-" ||
      ch === "+" ||
      ch === "." ||
      ch === "e" ||
      ch === "E"
    if (!isNumberChar) break
    pos += 1
  }
  return pos
}

function checkNumberToken(token: string): ProtocolError | null {
  // Only plain integer literals can be an "unsafe integer JSON number"; float or
  // exponent notation is range-checked per field by later validators.
  const isIntegerLiteral =
    !token.includes(".") && !token.includes("e") && !token.includes("E")
  if (!isIntegerLiteral) return null
  if (!Number.isSafeInteger(Number(token))) {
    return new ProtocolError({
      code: "MALFORMED_PROTOCOL",
      reason: `unsafe integer JSON number ${token}`,
    })
  }
  return null
}
