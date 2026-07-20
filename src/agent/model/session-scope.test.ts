import { expect, test } from "bun:test"
import { deriveSessionScope } from "./session-scope"

const base = { account: "acct-1", model: "claude-opus-4-8", workspaceIdentity: "proj-key-abc" }

test("scope is stable for identical inputs", () => {
  expect(deriveSessionScope("claude", base)).toBe(deriveSessionScope("claude", base))
})

test("scope changes when the model changes", () => {
  expect(deriveSessionScope("claude", base)).not.toBe(
    deriveSessionScope("claude", { ...base, model: "claude-sonnet-5" }),
  )
})

test("scope changes when the account changes", () => {
  expect(deriveSessionScope("claude", base)).not.toBe(
    deriveSessionScope("claude", { ...base, account: "acct-2" }),
  )
})

test("scope changes when the backend changes", () => {
  expect(deriveSessionScope("claude", base)).not.toBe(deriveSessionScope("codex", base))
})

test("a null account yields a unique, non-resumable scope each call", () => {
  const a = deriveSessionScope("claude", { ...base, account: null })
  const b = deriveSessionScope("claude", { ...base, account: null })
  expect(a).not.toBe(b)
})

test("scope changes when the workspace identity changes", () => {
  // SessionScopeInput has no `effort` field at all — effort cannot be part of
  // the derivation because there is nowhere to put it. This test asserts the
  // remaining material composition (workspaceIdentity, the 4th storage-identity
  // §6.2 trigger) genuinely participates in the hash, closing the loop that
  // scope is driven by backendId | account | model | workspaceIdentity only.
  expect(deriveSessionScope("claude", base)).not.toBe(
    deriveSessionScope("claude", { ...base, workspaceIdentity: "proj-key-xyz" }),
  )
})

test("the digest is stable lowercase hex of SHA-256 length", () => {
  const scope = deriveSessionScope("claude", base)
  expect(scope).toMatch(/^[0-9a-f]{64}$/)
})
