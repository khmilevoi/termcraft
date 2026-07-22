import { describe, expect, test } from "bun:test";

import type { KeyContext, KeyLike } from "./keymap";
import { resolveKey } from "./keymap";

const key = (over: Partial<KeyLike>): KeyLike => ({ name: "", ctrl: false, sequence: "", ...over });
const ctx = (over: Partial<KeyContext>): KeyContext => ({
  screen: "workspace",
  focus: "composer",
  overlayOpen: false,
  ...over,
});

describe("resolveKey — global keys (design §3.8)", () => {
  test("Escape -> esc from any screen/focus", () => {
    expect(resolveKey(key({ name: "escape" }), ctx({ screen: "home" }))).toEqual({ kind: "esc" });
    expect(resolveKey(key({ name: "escape" }), ctx({ focus: "preview" }))).toEqual({ kind: "esc" });
  });

  test("F2 -> fullscreen even while the composer is focused", () => {
    expect(resolveKey(key({ name: "f2" }), ctx({ focus: "composer" }))).toEqual({
      kind: "fullscreen",
    });
  });

  test("Ctrl+E -> export", () => {
    expect(resolveKey(key({ name: "e", ctrl: true, sequence: "\x05" }), ctx({}))).toEqual({
      kind: "export",
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
    expect(resolveKey(key({ name: "x", sequence: "x" }), ctx({ overlayOpen: true }))).toEqual({
      kind: "none",
    });
  });

  test("a control byte is not treated as printable", () => {
    expect(resolveKey(key({ name: "up", sequence: "\x1b[A" }), ctx({}))).toEqual({ kind: "none" });
  });
});
