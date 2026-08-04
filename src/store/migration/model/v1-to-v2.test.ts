import { describe, expect, test } from "bun:test";

import type { PageSlug } from "entities/page";

import type { LegacyProjectV1 } from "../types";
import { planV1ToV2 } from "./v1-to-v2";

const USER_STATE_ROOT = "C:\\Users\\dev\\AppData\\Local\\termcraft";
const PROJECT_ID = "019fa002-5f5b-7000-92e3-9931eebd6c52";
const PLAN_ID = "019fb111-0000-7000-8000-000000000001";

const scan = (input: {
  readonly slugs: readonly string[];
  readonly pinned?: readonly string[];
}): LegacyProjectV1 => ({
  formatVersion: 1,
  projectId: PROJECT_ID,
  name: "clock",
  createdAt: "2026-07-26T19:58:57.883Z",
  targetStack: "js-opentui",
  pages: input.slugs.map((slug) => ({
    slug: slug as PageSlug,
    legacySourcePath: `pages/${slug}/page.tsx`,
    legacyPinsPath: (input.pinned ?? []).includes(slug) ? `pages/${slug}/comments.jsonl` : null,
  })),
});

describe("planV1ToV2 (design-tree §12.2 track 1's move set)", () => {
  test("moves each page source into the design tree, in manifest order", () => {
    const plan = planV1ToV2({
      scan: scan({ slugs: ["dashboard", "calendar"] }),
      userStateRoot: USER_STATE_ROOT,
      migrationPlanId: PLAN_ID,
    });
    expect(plan.moves.filter((move) => move.what === "page-source")).toEqual([
      { from: "pages/dashboard/page.tsx", to: "design/pages/dashboard.tsx", what: "page-source" },
      { from: "pages/calendar/page.tsx", to: "design/pages/calendar.tsx", what: "page-source" },
    ]);
  });

  test("moves only the pin logs that exist", () => {
    const plan = planV1ToV2({
      scan: scan({ slugs: ["dashboard", "calendar"], pinned: ["calendar"] }),
      userStateRoot: USER_STATE_ROOT,
      migrationPlanId: PLAN_ID,
    });
    expect(plan.moves.filter((move) => move.what === "pin-log")).toEqual([
      { from: "pages/calendar/comments.jsonl", to: "pins/calendar.jsonl", what: "pin-log" },
    ]);
    expect(plan.pinLogCount).toBe(1);
  });

  test("counts pages and names the real backup directory, not the mock's path", () => {
    const plan = planV1ToV2({
      scan: scan({ slugs: ["dashboard", "calendar"] }),
      userStateRoot: USER_STATE_ROOT,
      migrationPlanId: PLAN_ID,
    });
    expect(plan.pageCount).toBe(2);
    expect(plan.pinLogCount).toBe(0);
    expect(plan.backupsDir).toContain("backups");
    expect(plan.backupsDir).toContain(PROJECT_ID);
    expect(plan.backupsDir).not.toContain(".termcraft");
  });

  test("carries the version pair and the caller's plan id verbatim", () => {
    const plan = planV1ToV2({
      scan: scan({ slugs: [] }),
      userStateRoot: USER_STATE_ROOT,
      migrationPlanId: PLAN_ID,
    });
    expect(plan).toMatchObject({ migrationPlanId: PLAN_ID, fromVersion: 1, toVersion: 2 });
    expect(plan.moves).toEqual([]);
  });
});
