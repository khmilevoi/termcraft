import { describe, expect, test } from "bun:test";

import type { KeyContext, KeyLike } from "./keymap";
import { resolveKey } from "./keymap";

const key = (over: Partial<KeyLike>): KeyLike => ({ name: "", ctrl: false, sequence: "", ...over });
const ctx = (over: Partial<KeyContext>): KeyContext => ({
  screen: "workspace",
  focus: "composer",
  overlay: null,
  composerValue: "",
  exportPopupOpen: false,
  ...over,
});

describe("resolveKey — global keys (design §3.8)", () => {
  test("Escape -> esc from any screen/focus", () => {
    expect(resolveKey(key({ name: "escape" }), ctx({ screen: "home" }))).toEqual({ kind: "esc" });
    expect(resolveKey(key({ name: "escape" }), ctx({ focus: "preview" }))).toEqual({ kind: "esc" });
  });

  test("F2 -> fullscreen even while the composer is focused", () => {
    expect(resolveKey(key({ name: "f2" }), ctx({ focus: "composer" }))).toEqual({
      kind: "action-execute",
      actionId: "preview.fullscreen",
    });
  });

  test("Ctrl+E -> export", () => {
    expect(resolveKey(key({ name: "e", ctrl: true, sequence: "\x05" }), ctx({}))).toEqual({
      kind: "action-execute",
      actionId: "export.start",
    });
  });

  test("F3/F4/Ctrl+P remain known but inert", () => {
    expect(resolveKey(key({ name: "f3" }), ctx({}))).toEqual({ kind: "none" });
    expect(resolveKey(key({ name: "f4" }), ctx({}))).toEqual({ kind: "none" });
    expect(resolveKey(key({ name: "p", ctrl: true, sequence: "\x10" }), ctx({}))).toEqual({
      kind: "none",
    });
  });
});

describe("resolveKey — Home", () => {
  test("printable chars feed the prompt", () => {
    expect(resolveKey(key({ name: "a", sequence: "a" }), ctx({ screen: "home" }))).toEqual({
      kind: "home-input",
      ch: "a",
    });
  });

  test("Enter submits, Backspace deletes", () => {
    expect(resolveKey(key({ name: "return" }), ctx({ screen: "home" }))).toEqual({
      kind: "home-submit",
    });
    expect(resolveKey(key({ name: "backspace" }), ctx({ screen: "home" }))).toEqual({
      kind: "home-backspace",
    });
  });

  test("Tab on Home does nothing", () => {
    expect(resolveKey(key({ name: "tab" }), ctx({ screen: "home" }))).toEqual({ kind: "none" });
  });
});

describe("resolveKey — Workspace composer", () => {
  test("printable chars feed the composer when it is focused", () => {
    expect(resolveKey(key({ name: "x", sequence: "x" }), ctx({}))).toEqual({
      kind: "composer-input",
      ch: "x",
    });
  });

  test("Enter submits the composer", () => {
    expect(resolveKey(key({ name: "return" }), ctx({}))).toEqual({ kind: "composer-submit" });
  });

  test("Tab cycles focus", () => {
    expect(resolveKey(key({ name: "tab" }), ctx({}))).toEqual({ kind: "tab" });
  });

  test("no composer input while the preview is focused", () => {
    expect(resolveKey(key({ name: "x", sequence: "x" }), ctx({ focus: "preview" }))).toEqual({
      kind: "none",
    });
  });

  test("no composer input while an overlay is open", () => {
    expect(resolveKey(key({ name: "x", sequence: "x" }), ctx({ overlay: "chat-list" }))).toEqual({
      kind: "none",
    });
  });

  test("a control byte is not treated as printable", () => {
    expect(resolveKey(key({ name: "up", sequence: "\x1b[A" }), ctx({}))).toEqual({ kind: "none" });
  });

  test("read-only never routes composer editing or submit", () => {
    expect(resolveKey(key({ name: "x", sequence: "x" }), ctx({ screen: "read-only" }))).toEqual({
      kind: "none",
    });
    expect(resolveKey(key({ name: "enter" }), ctx({ screen: "read-only" }))).toEqual({
      kind: "none",
    });
  });
});

describe("resolveKey — slash menu", () => {
  test("/ opens the menu only from an empty focused workspace composer", () => {
    expect(resolveKey(key({ sequence: "/", name: "/" }), ctx({}))).toEqual({
      kind: "slash-open",
    });
    expect(resolveKey(key({ sequence: "/", name: "/" }), ctx({ composerValue: "hello" }))).toEqual({
      kind: "composer-input",
      ch: "/",
    });
  });

  test("printable chars and backspace edit the slash filter", () => {
    expect(resolveKey(key({ sequence: "c", name: "c" }), ctx({ overlay: "slash-menu" }))).toEqual({
      kind: "slash-input",
      ch: "c",
    });
    expect(resolveKey(key({ name: "backspace" }), ctx({ overlay: "slash-menu" }))).toEqual({
      kind: "slash-backspace",
    });
  });

  test("arrows navigate, Enter submits, and Escape dismisses before lower layers", () => {
    expect(resolveKey(key({ name: "up" }), ctx({ overlay: "slash-menu" }))).toEqual({
      kind: "slash-move",
      delta: -1,
    });
    expect(resolveKey(key({ name: "down" }), ctx({ overlay: "slash-menu" }))).toEqual({
      kind: "slash-move",
      delta: 1,
    });
    expect(resolveKey(key({ name: "return" }), ctx({ overlay: "slash-menu" }))).toEqual({
      kind: "slash-submit",
    });
    expect(resolveKey(key({ name: "escape" }), ctx({ overlay: "slash-menu" }))).toEqual({
      kind: "overlay-dismiss",
    });
  });

  test("a stale slash overlay is inert after the workspace becomes read-only", () => {
    const readOnlySlash = ctx({
      screen: "read-only",
      overlay: "slash-menu",
      composerValue: "/new",
    });
    expect(resolveKey(key({ sequence: "x", name: "x" }), readOnlySlash)).toEqual({
      kind: "none",
    });
    expect(resolveKey(key({ name: "backspace" }), readOnlySlash)).toEqual({ kind: "none" });
    expect(resolveKey(key({ name: "up" }), readOnlySlash)).toEqual({ kind: "none" });
    expect(resolveKey(key({ name: "down" }), readOnlySlash)).toEqual({ kind: "none" });
    expect(resolveKey(key({ name: "enter" }), readOnlySlash)).toEqual({ kind: "none" });
    expect(resolveKey(key({ name: "escape" }), readOnlySlash)).toEqual({
      kind: "overlay-dismiss",
    });
  });
});

describe("resolveKey — modal controls", () => {
  test("pin input edits, saves, and dismisses without leaking keys below the modal", () => {
    expect(resolveKey(key({ sequence: "x", name: "x" }), ctx({ overlay: "pin-input" }))).toEqual({
      kind: "pin-input",
      ch: "x",
    });
    expect(resolveKey(key({ name: "backspace" }), ctx({ overlay: "pin-input" }))).toEqual({
      kind: "pin-backspace",
    });
    expect(resolveKey(key({ name: "enter" }), ctx({ overlay: "pin-input" }))).toEqual({
      kind: "pin-save",
    });
    expect(resolveKey(key({ name: "escape" }), ctx({ overlay: "pin-input" }))).toEqual({
      kind: "overlay-dismiss",
    });
  });

  test("a stale pin input is mutation-inert after transition to read-only", () => {
    const readOnlyPin = ctx({ screen: "read-only", overlay: "pin-input" });
    expect(resolveKey(key({ sequence: "x", name: "x" }), readOnlyPin)).toEqual({ kind: "none" });
    expect(resolveKey(key({ name: "backspace" }), readOnlyPin)).toEqual({ kind: "none" });
    expect(resolveKey(key({ name: "enter" }), readOnlyPin)).toEqual({ kind: "none" });
    expect(resolveKey(key({ name: "escape" }), readOnlyPin)).toEqual({
      kind: "overlay-dismiss",
    });
  });

  test("chat list arrows, Enter, and Escape route to chat controls", () => {
    expect(resolveKey(key({ name: "up" }), ctx({ overlay: "chat-list" }))).toEqual({
      kind: "chat-move",
      delta: -1,
    });
    expect(resolveKey(key({ name: "down" }), ctx({ overlay: "chat-list" }))).toEqual({
      kind: "chat-move",
      delta: 1,
    });
    expect(resolveKey(key({ name: "enter" }), ctx({ overlay: "chat-list" }))).toEqual({
      kind: "chat-switch",
    });
    expect(resolveKey(key({ name: "escape" }), ctx({ overlay: "chat-list" }))).toEqual({
      kind: "overlay-dismiss",
    });
  });

  test("trust Enter accepts and trust Escape declines into read-only", () => {
    expect(resolveKey(key({ name: "enter" }), ctx({ screen: "trust-prompt" }))).toEqual({
      kind: "trust-accept",
    });
    expect(resolveKey(key({ name: "escape" }), ctx({ screen: "trust-prompt" }))).toEqual({
      kind: "trust-decline",
    });
  });

  test("export popup: Enter and Escape both dismiss, and no other key leaks through", () => {
    const exportOpen = ctx({ exportPopupOpen: true });
    expect(resolveKey(key({ name: "enter" }), exportOpen)).toEqual({ kind: "export-dismiss" });
    expect(resolveKey(key({ name: "return" }), exportOpen)).toEqual({ kind: "export-dismiss" });
    expect(resolveKey(key({ name: "escape" }), exportOpen)).toEqual({ kind: "export-dismiss" });
    expect(resolveKey(key({ name: "x", sequence: "x" }), exportOpen)).toEqual({ kind: "none" });
  });
});
