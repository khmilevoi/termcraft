import { describe, expect, test } from "bun:test";

import { atom } from "@reatom/core";

import { uuidv7 } from "infrastructure/uuid";

import type { ProjectMirror } from "../types";
import { MIN_FRAME, createScreenAtom, deriveScreen } from "./screen";

const OK = { w: 120, h: 40 };
const projectId = uuidv7();

describe("deriveScreen (phase-7 plan D6)", () => {
  test("below the minimum frame on either axis -> enlarge, over everything else", () => {
    expect(
      deriveScreen({
        projectId,
        trust: "trusted",
        terminal: { w: 79, h: 40 },
        startupOpenPending: false,
        openFailed: false,
      }),
    ).toBe("enlarge");
    expect(
      deriveScreen({
        projectId,
        trust: "trusted",
        terminal: { w: 120, h: 23 },
        startupOpenPending: false,
        openFailed: false,
      }),
    ).toBe("enlarge");
    expect(
      deriveScreen({
        projectId: null,
        trust: null,
        terminal: { w: 10, h: 10 },
        startupOpenPending: false,
        openFailed: false,
      }),
    ).toBe("enlarge");
  });

  test("no project -> home", () => {
    expect(
      deriveScreen({
        projectId: null,
        trust: null,
        terminal: OK,
        startupOpenPending: false,
        openFailed: false,
      }),
    ).toBe("home");
  });

  test("untrusted-read-only project -> read-only", () => {
    expect(
      deriveScreen({
        projectId,
        trust: "untrusted-read-only",
        terminal: OK,
        startupOpenPending: false,
        openFailed: false,
      }),
    ).toBe("read-only");
  });

  test("project open but trust undecided -> trust-prompt", () => {
    expect(
      deriveScreen({
        projectId,
        trust: null,
        terminal: OK,
        startupOpenPending: false,
        openFailed: false,
      }),
    ).toBe("trust-prompt");
  });

  test("trusted project at a big-enough terminal -> workspace", () => {
    expect(
      deriveScreen({
        projectId,
        trust: "trusted",
        terminal: OK,
        startupOpenPending: false,
        openFailed: false,
      }),
    ).toBe("workspace");
  });

  test("MIN_FRAME is 80x24", () => {
    expect(MIN_FRAME).toEqual({ w: 80, h: 24 });
  });
});

describe("createScreenAtom", () => {
  test("recomputes as the project slice and terminal size change", () => {
    const project = atom<ProjectMirror>(
      {
        projectId: null,
        activePageSlug: null,
        activeChatId: null,
        trust: null,
        openFailure: null,
        opening: false,
      },
      "test.project",
    );
    const terminal = atom(OK, "test.terminal");
    const screen = createScreenAtom({
      project: () => project(),
      terminal: () => terminal(),
      startupOpenPending: () => false,
    });

    expect(screen()).toBe("home");
    project.set({
      projectId,
      activePageSlug: "main",
      activeChatId: uuidv7(),
      trust: "trusted",
      openFailure: null,
      opening: false,
    });
    expect(screen()).toBe("workspace");
    terminal.set({ w: 40, h: 20 });
    expect(screen()).toBe("enlarge");
  });

  test("recomputes to workspace when startupOpenPending flips true", () => {
    const project = atom<ProjectMirror>(
      {
        projectId: null,
        activePageSlug: null,
        activeChatId: null,
        trust: null,
        openFailure: null,
        opening: false,
      },
      "test.project.startupOpenPending",
    );
    const terminal = atom(OK, "test.terminal.startupOpenPending");
    const startupOpenPending = atom(false, "test.startupOpenPending");
    const screen = createScreenAtom({
      project: () => project(),
      terminal: () => terminal(),
      startupOpenPending: () => startupOpenPending(),
    });

    expect(screen()).toBe("home");
    startupOpenPending.set(true);
    expect(screen()).toBe("workspace");
  });
});

const OPENING = { projectId: null, trust: null, terminal: OK } as const;

describe("deriveScreen — the workspace-first opening state (spec 2026-08-02)", () => {
  test("a startup open in flight mounts the Workspace, not Home", () => {
    expect(deriveScreen({ ...OPENING, startupOpenPending: true, openFailed: false })).toBe(
      "workspace",
    );
  });

  test("no startup open pending still parks on Home — a genuinely fresh directory", () => {
    // Also the shape `startupOpenPending` lands in once a startup `project.open` dispatch is
    // abandoned (`run-app.ts`'s dispatch failed or was rejected): neither `finishOpen` nor
    // `blockOpen` will ever arrive for it, so `startupOpenPending` going false is the only thing
    // that can end that state — `deriveScreen` is a pure function of these same inputs either way,
    // so there is no separate case to cover here.
    expect(deriveScreen({ ...OPENING, startupOpenPending: false, openFailed: false })).toBe("home");
  });

  test("a blocked open drops back to Home, which owns the failure panel and the retry", () => {
    expect(deriveScreen({ ...OPENING, startupOpenPending: true, openFailed: true })).toBe("home");
  });

  test("the enlarge placeholder still outranks the opening state", () => {
    expect(
      deriveScreen({
        ...OPENING,
        terminal: { w: 79, h: 40 },
        startupOpenPending: true,
        openFailed: false,
      }),
    ).toBe("enlarge");
  });

  test("finishOpen resolves the opening state to a real Workspace, and to read-only when untrusted", () => {
    expect(
      deriveScreen({
        projectId,
        trust: "trusted",
        terminal: OK,
        startupOpenPending: true,
        openFailed: false,
      }),
    ).toBe("workspace");
    expect(
      deriveScreen({
        projectId,
        trust: "untrusted-read-only",
        terminal: OK,
        startupOpenPending: true,
        openFailed: false,
      }),
    ).toBe("read-only");
  });
});
