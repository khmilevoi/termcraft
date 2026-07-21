import { describe, expect, test } from "bun:test";

import { atom } from "@reatom/core";

import { uuidv7 } from "infrastructure/uuid";

import type { ProjectMirror } from "../types";
import { MIN_FRAME, createScreenAtom, deriveScreen } from "./screen";

const OK = { w: 120, h: 40 };
const projectId = uuidv7();

describe("deriveScreen (phase-7 plan D6)", () => {
  test("below the minimum frame on either axis -> enlarge, over everything else", () => {
    expect(deriveScreen({ projectId, trust: "trusted", terminal: { w: 79, h: 40 } })).toBe(
      "enlarge",
    );
    expect(deriveScreen({ projectId, trust: "trusted", terminal: { w: 120, h: 23 } })).toBe(
      "enlarge",
    );
    expect(deriveScreen({ projectId: null, trust: null, terminal: { w: 10, h: 10 } })).toBe(
      "enlarge",
    );
  });

  test("no project -> home", () => {
    expect(deriveScreen({ projectId: null, trust: null, terminal: OK })).toBe("home");
  });

  test("untrusted-read-only project -> read-only", () => {
    expect(deriveScreen({ projectId, trust: "untrusted-read-only", terminal: OK })).toBe(
      "read-only",
    );
  });

  test("project open but trust undecided -> trust-prompt", () => {
    expect(deriveScreen({ projectId, trust: null, terminal: OK })).toBe("trust-prompt");
  });

  test("trusted project at a big-enough terminal -> workspace", () => {
    expect(deriveScreen({ projectId, trust: "trusted", terminal: OK })).toBe("workspace");
  });

  test("MIN_FRAME is 80x24", () => {
    expect(MIN_FRAME).toEqual({ w: 80, h: 24 });
  });
});

describe("createScreenAtom", () => {
  test("recomputes as the project slice and terminal size change", () => {
    const project = atom<ProjectMirror>(
      { projectId: null, activePageSlug: null, activeChatId: null, trust: null },
      "test.project",
    );
    const terminal = atom(OK, "test.terminal");
    const screen = createScreenAtom({ project: () => project(), terminal: () => terminal() });

    expect(screen()).toBe("home");
    project.set({ projectId, activePageSlug: "main", activeChatId: uuidv7(), trust: "trusted" });
    expect(screen()).toBe("workspace");
    terminal.set({ w: 40, h: 20 });
    expect(screen()).toBe("enlarge");
  });
});
