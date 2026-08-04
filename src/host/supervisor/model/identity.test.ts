import { describe, expect, test } from "bun:test";

import type { HostSessionSpec } from "../../types";
import { mintIdentity, mintNonce } from "./identity";

const spec: HostSessionSpec = {
  mode: "preview",
  interactionMode: "static",
  pageSlug: "dashboard",
  treeRoot: "/scratch/design",
  entryRelPath: "pages/dashboard.tsx",
  expectedFiles: [{ relPath: "pages/dashboard.tsx", sha256: "a".repeat(64) }],
  sourceHash: "a".repeat(64),
  treeRevision: "a".repeat(64),
  kitApiVersion: 1,
  size: { w: 80, h: 24 },
  theme: "dark-default",
  capabilities: { colorDepth: 24 },
};

describe("mintNonce", () => {
  test("is 32 lowercase hex characters", () => {
    const nonce = mintNonce();
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
  });
  test("is fresh each call", () => {
    expect(mintNonce()).not.toBe(mintNonce());
  });
});

describe("mintIdentity", () => {
  test("mints a UUIDv7 sessionId and a fresh nonce, copying spec identity fields", () => {
    const id = mintIdentity(spec);
    expect(id.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(id.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(id.mode).toBe("preview");
    expect(id.pageSlug).toBe("dashboard");
    expect(id.sourceHash).toBe("a".repeat(64));
    expect(id.kitApiVersion).toBe(1);
  });

  test("keeps a supplied sessionId (stable across restart) but re-mints the nonce", () => {
    const first = mintIdentity(spec);
    const second = mintIdentity(spec, first.sessionId);
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.nonce).not.toBe(first.nonce);
  });
});
