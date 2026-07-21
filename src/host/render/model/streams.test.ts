import { describe, expect, test } from "bun:test";

import { makeHeadlessStreams } from "./streams";

describe("makeHeadlessStreams", () => {
  test("stdout reports the requested size and swallows writes", async () => {
    const { stdout } = makeHeadlessStreams({ w: 100, h: 40 });
    expect(stdout.isTTY).toBe(true);
    expect(stdout.columns).toBe(100);
    expect(stdout.rows).toBe(40);
    expect(stdout.getColorDepth()).toBe(24);
    // Bun's node:stream Writable defers the write callback to process.nextTick
    // (measured: it does not fire synchronously, unlike the plan's assumption),
    // so await it instead of asserting synchronous completion.
    await new Promise<void>((resolve) => {
      stdout.write(Buffer.from("x"), () => resolve());
    });
  });

  test("stdin is a TTY with setRawMode", () => {
    const { stdin } = makeHeadlessStreams({ w: 10, h: 5 });
    expect(stdin.isTTY).toBe(true);
    expect(typeof stdin.setRawMode).toBe("function");
    expect(stdin.setRawMode(true)).toBe(stdin);
  });
});
