import { describe, expect, test } from "bun:test";

import { atom } from "@reatom/core";

import { uuidv7 } from "infrastructure/uuid";

import type { ProjectMirror } from "../types";
import { MIN_FRAME, createScreenAtom, deriveScreen } from "./screen";

const OK = { w: 120, h: 40 };
const projectId = uuidv7();
const IDLE = { startupOpenPending: false, openFailed: false } as const;

describe("deriveScreen (phase-7 plan D6)", () => {
  test("below the minimum frame on either axis -> enlarge, over everything else", () => {
    expect(deriveScreen({ ...IDLE, projectId, trust: "trusted", terminal: { w: 79, h: 40 } })).toBe(
      "enlarge",
    );
    expect(
      deriveScreen({ ...IDLE, projectId, trust: "trusted", terminal: { w: 120, h: 23 } }),
    ).toBe("enlarge");
    expect(
      deriveScreen({ ...IDLE, projectId: null, trust: null, terminal: { w: 10, h: 10 } }),
    ).toBe("enlarge");
  });

  test("a startup open that is still pending mounts the Workspace, not Home", () => {
    expect(
      deriveScreen({
        projectId: null,
        trust: null,
        terminal: OK,
        startupOpenPending: true,
        openFailed: false,
      }),
    ).toBe("workspace");
  });

  test("enlarge still outranks the opening Workspace", () => {
    expect(
      deriveScreen({
        projectId: null,
        trust: null,
        terminal: { w: 79, h: 40 },
        startupOpenPending: true,
        openFailed: false,
      }),
    ).toBe("enlarge");
  });

  test("a blocked open falls back to Home — Home owns the failure panel and the retry", () => {
    expect(
      deriveScreen({
        projectId: null,
        trust: null,
        terminal: OK,
        startupOpenPending: true,
        openFailed: true,
      }),
    ).toBe("home");
  });

  test("a startup dispatch that never reached the Kernel falls back to Home", () => {
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

  test("no project and no startup open -> home", () => {
    expect(deriveScreen({ ...IDLE, projectId: null, trust: null, terminal: OK })).toBe("home");
  });

  test("finishOpen turns the opening Workspace into a filled one", () => {
    expect(
      deriveScreen({
        projectId,
        trust: "trusted",
        terminal: OK,
        startupOpenPending: true,
        openFailed: false,
      }),
    ).toBe("workspace");
  });

  test("finishOpen with an untrusted grant lands on read-only, not the Workspace", () => {
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

  test("untrusted-read-only project -> read-only", () => {
    expect(deriveScreen({ ...IDLE, projectId, trust: "untrusted-read-only", terminal: OK })).toBe(
      "read-only",
    );
  });

  test("project open but trust undecided -> trust-prompt", () => {
    expect(deriveScreen({ ...IDLE, projectId, trust: null, terminal: OK })).toBe("trust-prompt");
  });

  test("trusted project at a big-enough terminal -> workspace", () => {
    expect(deriveScreen({ ...IDLE, projectId, trust: "trusted", terminal: OK })).toBe("workspace");
  });

  test("MIN_FRAME is 80x24", () => {
    expect(MIN_FRAME).toEqual({ w: 80, h: 24 });
  });
});

describe("createScreenAtom", () => {
  const EMPTY_PROJECT: ProjectMirror = {
    projectId: null,
    activePageSlug: null,
    activeChatId: null,
    trust: null,
    openFailure: null,
    opening: false,
  };

  test("recomputes as the project slice and terminal size change", () => {
    const project = atom<ProjectMirror>(EMPTY_PROJECT, "test.project");
    const terminal = atom(OK, "test.terminal");
    const startupOpenPending = atom(false, "test.startupOpenPending");
    const screen = createScreenAtom({
      project: () => project(),
      terminal: () => terminal(),
      startupOpenPending: () => startupOpenPending(),
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

  test("a pending startup open mounts the Workspace, and a blockOpen drops it back to Home", () => {
    const project = atom<ProjectMirror>(EMPTY_PROJECT, "test.project");
    const terminal = atom(OK, "test.terminal");
    const startupOpenPending = atom(true, "test.startupOpenPending");
    const screen = createScreenAtom({
      project: () => project(),
      terminal: () => terminal(),
      startupOpenPending: () => startupOpenPending(),
    });

    expect(screen()).toBe("workspace");
    project.set({
      ...EMPTY_PROJECT,
      openFailure: { reason: "manifest-read-failed", safeMessage: "project.toml unreadable" },
    });
    expect(screen()).toBe("home");
  });

  test("abandoning the startup open drops the empty Workspace back to Home", () => {
    const project = atom<ProjectMirror>(EMPTY_PROJECT, "test.project");
    const terminal = atom(OK, "test.terminal");
    const startupOpenPending = atom(true, "test.startupOpenPending");
    const screen = createScreenAtom({
      project: () => project(),
      terminal: () => terminal(),
      startupOpenPending: () => startupOpenPending(),
    });

    expect(screen()).toBe("workspace");
    startupOpenPending.set(false);
    expect(screen()).toBe("home");
  });
});
