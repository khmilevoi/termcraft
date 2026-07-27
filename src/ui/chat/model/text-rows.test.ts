import { describe, expect, it } from "bun:test";

import { renderedRowCount } from "./text-rows";

describe("renderedRowCount", () => {
  it("is 1 for text that fits", () => {
    expect(renderedRowCount("one", 10)).toBe(1);
    expect(renderedRowCount("", 10)).toBe(1);
  });

  it("reserves the inter-word space, so an exactly-width pair still breaks", () => {
    // "alpha beta" is exactly 10 columns, but `beta` is not the final word, so the space that
    // would follow it is reserved too — the renderer breaks here (see this module's own doc).
    expect(renderedRowCount("alpha beta gamma delta epsilon zeta", 10)).toBe(6);
  });

  it("does not reserve a trailing space for the final word", () => {
    // Same text at 12: "epsilon zeta" is exactly 12 and `zeta` IS final, so it fits.
    expect(renderedRowCount("alpha beta gamma delta epsilon zeta", 12)).toBe(3);
  });

  it("wraps non-ASCII text on the same rule", () => {
    expect(renderedRowCount("Готово — исправлено по замечаниям Gate соберём", 14)).toBe(4);
  });

  it("hard-splits a word wider than the whole width", () => {
    expect(renderedRowCount("supercalifragilistic word", 8)).toBe(4);
  });

  it("returns 1 for a non-positive width instead of looping", () => {
    expect(renderedRowCount("anything at all", 0)).toBe(1);
    expect(renderedRowCount("anything at all", -3)).toBe(1);
  });
});
