import { describe, expect, test } from "bun:test";

import { LIGHT_SHELL_PALETTE, SHELL_PALETTE, shellAttrs } from "./palette";

describe("shell palette (design pal, termcraft-engine.js:6-13)", () => {
  test("dark tokens carry the exact design hexes", () => {
    // A representative spread across the token space; the full object is the source of truth.
    expect(SHELL_PALETTE.bg).toBe("#14110d");
    expect(SHELL_PALETTE.fg).toBe("#d7d0c2");
    expect(SHELL_PALETTE.dim).toBe("#8f877a");
    expect(SHELL_PALETTE.faint).toBe("#5b544a");
    expect(SHELL_PALETTE.border).toBe("#403a2f");
    expect(SHELL_PALETTE.line).toBe("#2c2820");
    expect(SHELL_PALETTE.amber).toBe("#e6a23c");
    expect(SHELL_PALETTE.amberHi).toBe("#f6c163");
    expect(SHELL_PALETTE.amberDim).toBe("#8a6d33");
    expect(SHELL_PALETTE.sel).toBe("#392c11");
    expect(SHELL_PALETTE.selFg).toBe("#f6c163");
    expect(SHELL_PALETTE.green).toBe("#8fb96b");
    expect(SHELL_PALETTE.red).toBe("#dd7b60");
    expect(SHELL_PALETTE.redDim).toBe("#4d2a20");
    expect(SHELL_PALETTE.statusBg).toBe("#231d12");
  });

  test("every token is a lowercase #rrggbb hex, in both palettes", () => {
    const hex = /^#[0-9a-f]{6}$/;
    for (const value of Object.values(SHELL_PALETTE)) expect(value).toMatch(hex);
    for (const value of Object.values(LIGHT_SHELL_PALETTE)) expect(value).toMatch(hex);
  });

  test("selFg equals amberHi in the dark palette (selected-row text is amberHi)", () => {
    expect(SHELL_PALETTE.selFg).toBe(SHELL_PALETTE.amberHi);
  });

  test("light palette declares the same token set as dark", () => {
    expect(Object.keys(LIGHT_SHELL_PALETTE).sort()).toEqual(Object.keys(SHELL_PALETTE).sort());
  });
});

describe("shellAttrs (TextAttributes bitmask)", () => {
  test("no style is a zero mask", () => {
    expect(shellAttrs({})).toBe(0);
  });

  test("bold=1, dim=2, and their union=3", () => {
    expect(shellAttrs({ bold: true })).toBe(0b1);
    expect(shellAttrs({ dim: true })).toBe(0b10);
    expect(shellAttrs({ bold: true, dim: true })).toBe(0b11);
  });

  test("blink is bit 16 (the prompt cursor)", () => {
    expect(shellAttrs({ blink: true })).toBe(16);
  });

  test("italic=4, underline=8, inverse=32 combine into one mask", () => {
    expect(shellAttrs({ italic: true, underline: true, inverse: true })).toBe(4 | 8 | 32);
  });
});
