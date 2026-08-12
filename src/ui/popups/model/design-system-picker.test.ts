import { expect, test } from "bun:test";

import type { DesignSystemSummaryDtoV1, SourceListingDtoV1 } from "core/protocol";

import { computeChatListViewport } from "./chat-list";
import {
  DESIGN_SYSTEM_VIEWPORT_CAP,
  designSystemRows,
  formatContents,
  visibleSwatches,
} from "./design-system-picker";

function summary(
  id: string,
  overrides: Partial<Omit<DesignSystemSummaryDtoV1, "id">> = {},
): DesignSystemSummaryDtoV1 {
  return {
    id,
    name: id,
    version: "1.0.0",
    kitApiVersion: 1,
    defaultTheme: "dark",
    defaultThemeTokens: [],
    componentNames: [],
    ...overrides,
  };
}

const MIDNIGHT_SUMMARY = summary("midnight", { name: "midnight" });
const AURORA_SUMMARY = summary("aurora", { name: "aurora" });
const SLATE_SUMMARY = summary("slate", { name: "slate" });

function listing(
  sourceId: string,
  label: string,
  canPublish: boolean,
  systems: readonly DesignSystemSummaryDtoV1[],
): SourceListingDtoV1 {
  return { sourceId, label, canPublish, state: "listed", systems, reason: null };
}

test("every listed system becomes a row, grouped under its source in configured order", () => {
  const rows = designSystemRows([
    listing("local", "Local library", true, [MIDNIGHT_SUMMARY, AURORA_SUMMARY]),
    listing("github:acme/ds", "acme", false, [SLATE_SUMMARY]),
  ]);
  expect(rows.map((row) => row.key)).toEqual([
    "local:aurora",
    "local:midnight",
    "github:acme/ds:slate",
  ]);
});

test("systems are sorted within a source so the list is stable across runs", () => {
  const rows = designSystemRows([
    listing("local", "Local library", true, [MIDNIGHT_SUMMARY, AURORA_SUMMARY]),
  ]);
  expect(rows.map((row) => row.systemId)).toEqual(["aurora", "midnight"]);
});

test("an ungranted source becomes ONE status row carrying its reason, never a phantom system", () => {
  const rows = designSystemRows([
    {
      sourceId: "github:acme/ds",
      label: "acme",
      canPublish: false,
      state: "ungranted",
      systems: [],
      reason: "this source has not been granted",
    },
  ]);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    state: "ungranted",
    systemId: null,
    note: "this source has not been granted",
  });
});

test("an unavailable source becomes ONE status row carrying its reason", () => {
  const rows = designSystemRows([
    {
      sourceId: "github:acme/ds",
      label: "acme",
      canPublish: false,
      state: "unavailable",
      systems: [],
      reason: "did not answer within 3000 ms",
    },
  ]);
  expect(rows[0]).toMatchObject({ state: "unavailable", note: "did not answer within 3000 ms" });
});

test("a granted but empty source says so rather than vanishing", () => {
  const rows = designSystemRows([listing("local", "Local library", true, [])]);
  expect(rows[0]).toMatchObject({ state: "empty", systemId: null });
});

test("the swatch row keeps the manifest's DECLARATION order and truncates to the cells available", () => {
  const swatches = [
    { name: "background", value: "#0b0f14" },
    { name: "accent", value: "#4cc9f0" },
    { name: "brandBlue", value: "#4cc9f0" },
  ];
  expect(visibleSwatches(swatches, 2)).toEqual(swatches.slice(0, 2));
  expect(visibleSwatches(swatches, 10)).toEqual(swatches);
  expect(visibleSwatches(swatches, 0)).toEqual([]);
});

test("contents lists component names and says how many were elided", () => {
  expect(formatContents(["Button", "PageShell", "Card"], 40)).toBe("Button · PageShell · Card");
  expect(formatContents(["Button", "PageShell", "Card"], 12)).toBe("Button +2");
  expect(formatContents([], 40)).toBe("no components");
});

test("the viewport windows the rows with the shared chat-list math", () => {
  const viewport = computeChatListViewport({
    total: 20,
    selectedIndex: 12,
    cap: DESIGN_SYSTEM_VIEWPORT_CAP,
  });
  expect(viewport.visibleCount).toBe(DESIGN_SYSTEM_VIEWPORT_CAP);
  expect(viewport.start).toBeLessThanOrEqual(12);
  expect(viewport.start + viewport.visibleCount).toBeGreaterThan(12);
});
