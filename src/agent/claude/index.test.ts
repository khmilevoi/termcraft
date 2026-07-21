import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CLAUDE_BACKEND_ID, claudeCapabilities } from "./backend";
import { createProductionClaudeBackend, createProductionClaudeBackendDeps } from "./index";

test("the production backend exposes the five port methods and static capabilities", () => {
  const backend = createProductionClaudeBackend();
  expect(typeof backend.startTurn).toBe("function");
  expect(typeof backend.cancel).toBe("function");
  expect(typeof backend.healthCheck).toBe("function");
  expect(typeof backend.capabilities).toBe("function");
  expect(typeof backend.sessionScope).toBe("function");
  expect(backend.capabilities().backendId).toBe(CLAUDE_BACKEND_ID);
});

test("capabilities() is the real static Claude table, not a stub", () => {
  const backend = createProductionClaudeBackend();
  expect(backend.capabilities()).toEqual(claudeCapabilities());
});

// The production factory must actually wire the Spike F reparse-point
// backstop, not just leave `hasReparsePoint` undefined.
const onWindows = process.platform === "win32";

describe.skipIf(!onWindows)("createProductionClaudeBackendDeps (Windows)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "termcraft-agent-reparse-"));

  test("supplies a hasReparsePoint hook", () => {
    expect(typeof createProductionClaudeBackendDeps().hasReparsePoint).toBe("function");
  });

  test("the supplied hook detects a real junction and passes through a plain directory", () => {
    const target = path.join(root, "target");
    fs.mkdirSync(target);
    const plain = path.join(root, "plain");
    fs.mkdirSync(plain);
    const link = path.join(root, "junction");
    // `junction` type does not require elevation on Windows (Spike F).
    fs.symlinkSync(target, link, "junction");

    const hasReparsePoint = createProductionClaudeBackendDeps().hasReparsePoint!;
    expect(hasReparsePoint(link)).toBe(true);
    expect(hasReparsePoint(plain)).toBe(false);

    fs.rmSync(root, { recursive: true, force: true });
  });
});
