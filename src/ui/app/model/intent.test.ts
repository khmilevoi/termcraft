import { beforeEach, describe, expect, test } from "bun:test";

import { uuidv7 } from "infrastructure/uuid";
import { TEST_SHA, TEST_TS, createFakeKernel, event, resetEventSeq, snapshot } from "ui/testing";
import type { TextEditorHandle } from "ui/text-input";

import { createUiDeps } from "./deps";
import { applyIntent } from "./intent";

beforeEach(() => resetEventSeq());

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A recording stand-in for a mounted editor, appending to the caller's own `calls` array.
 *
 * ONE helper rather than the five identical inline literals this file used to carry: that
 * duplication is why `TextEditorHandle`'s `clear`/`focus`/`blur` could sit dead in the interface
 * for three tasks with every fake still dutifully implementing them.
 */
function recordingHandle(calls: string[]): TextEditorHandle {
  const state = { text: "" };
  return {
    setText: (text) => {
      state.text = text;
      calls.push(`setText:${text}`);
    },
    text: () => state.text,
    deleteCharBackward: () => calls.push("deleteCharBackward"),
  };
}

function dispatchedKinds(kernel: { dispatched: readonly unknown[] }): string[] {
  return kernel.dispatched.map((raw) => (raw as { kind: string }).kind);
}

describe("applyIntent — text inputs", () => {
  test("home-submit dispatches project.create carrying the prompt as text", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(
      kernel,
      { w: 120, h: 36 },
      { root: "/proj", workspaceIdentity: "wid", projectExists: false },
    );
    deps.local.prompt.set("a dashboard");
    applyIntent({ kind: "home-submit" }, deps);
    expect(kernel.dispatched).toHaveLength(1);
    const raw = kernel.dispatched[0] as {
      kind: string;
      payload: { root: string; text: string; creationDefaults: unknown };
    };
    expect(raw.kind).toBe("project.create");
    expect(raw.payload.text).toBe("a dashboard");
    expect(raw.payload.root).toBe("/proj");
    expect(raw.payload.creationDefaults).toEqual({ trust: "trusted", workspaceIdentity: "wid" });
  });

  test("home-submit dispatches project.open carrying the prompt as text when the shell found an existing project (Gap D)", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(
      kernel,
      { w: 120, h: 36 },
      { root: "/proj", workspaceIdentity: "wid", projectExists: true },
    );
    deps.local.prompt.set("add a settings page");
    applyIntent({ kind: "home-submit" }, deps);
    expect(kernel.dispatched).toHaveLength(1);
    const raw = kernel.dispatched[0] as { kind: string; payload: { root: string; text: string } };
    expect(raw.kind).toBe("project.open");
    expect(raw.payload).toEqual({ root: "/proj", text: "add a settings page" });
  });

  test("home-submit on an empty prompt dispatches nothing", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    applyIntent({ kind: "home-submit" }, deps);
    expect(kernel.dispatched).toHaveLength(0);
  });

  test("home-submit clears the prompt only once the dispatch resolves accepted (fix round 1, Finding 2)", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    deps.local.prompt.set("a dashboard");
    applyIntent({ kind: "home-submit" }, deps);
    expect(kernel.dispatched).toHaveLength(1);
    // Not cleared synchronously with the dispatch call — only once it RESOLVES accepted
    // (`createFakeKernel`'s own dispatch accepts by default), mirroring `composer-submit`'s own
    // fix (Task 11) exactly.
    await tick();
    expect(deps.local.prompt()).toBe("");
  });

  test("home-submit leaves the typed text in place when the startup open is still admitting (fix round 1, Finding 2)", async () => {
    const kernel = createFakeKernel();
    // The exact race the finding named: the composition root's own startup `project.open`
    // (`run-app.ts`, Gap D) is still admitting, so a second `project.open` from Home's own Enter
    // is rejected `CAPABILITY_UNAVAILABLE` — the project machine is `"opening"`, not `"closed"`.
    kernel.setDispatchResult({
      protocolVersion: 1,
      commandId: uuidv7() as never,
      status: "rejected",
      currentRevision: "0",
      code: "CAPABILITY_UNAVAILABLE",
      reasons: [{ code: "CAPABILITY_UNAVAILABLE" }],
    });
    const deps = createUiDeps(
      kernel,
      { w: 120, h: 36 },
      { root: "/proj", workspaceIdentity: "wid", projectExists: true },
    );
    deps.local.prompt.set("add a settings page");
    applyIntent({ kind: "home-submit" }, deps);
    await tick();
    // A rejection must not discard what the user typed.
    expect(deps.local.prompt()).toBe("add a settings page");
  });

  test("composer-submit dispatches turn.start and clears the composer once accepted", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    // A `projectId` is what moves `deriveScreen` off Home, which is what makes the COMPOSER the
    // primary input rather than the prompt.
    deps.mirror.apply(snapshot({ projectId: uuidv7(), activePageSlug: "main", trust: "trusted" }));
    deps.local.composer.set("make it blue");
    applyIntent({ kind: "composer-submit" }, deps);
    expect(dispatchedKinds(kernel)).toEqual(["turn.start"]);
    expect((kernel.dispatched[0] as { payload: { text: string } }).payload.text).toBe(
      "make it blue",
    );
    // Fix round 1, Finding 2: the composer now clears only once the dispatch RESOLVES accepted
    // (`createFakeKernel`'s own dispatch accepts by default) — no longer synchronously with the
    // dispatch call itself, so a rejection has a chance to leave the text in place instead.
    await tick();
    expect(deps.local.composer()).toBe("");
  });

  // finding §2.5 (phase-8 Task 16): the composer stays live for the whole turn, so Enter keeps
  // resolving to `composer-submit` (keymap.ts's `composerActive` no longer excludes
  // `turnRunning`) — the refusal now happens here, before a second `turn.start` is ever
  // dispatched, so the Kernel's `TURN_ALREADY_ACTIVE` rejection path is never exercised at all
  // and the draft is never at risk. Design's own copy: `⏎ send disabled — draft kept`
  // (design/termcraft-engine.js:268, `wsGenTyping`).
  test("Enter during a turn does not clear the draft — `⏎ send disabled — draft kept`", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    deps.mirror.apply(
      event("turn.started", { turnId: uuidv7(), chatId: uuidv7(), deadline: TEST_TS }),
    );
    deps.local.composer.set("half a sentence");

    applyIntent({ kind: "composer-submit" }, deps);
    await tick();

    expect(deps.local.composer()).toBe("half a sentence");
    expect(dispatchedKinds(kernel)).not.toContain("turn.start");
  });

  test("composer-submit leaves the typed text in place when the dispatch is rejected", async () => {
    const kernel = createFakeKernel();
    // The exact rejection fix round 1's Finding 2 named: `TURN_ALREADY_ACTIVE`, reachable while
    // Gap C's own auto-started first turn is still admitting.
    kernel.setDispatchResult({
      protocolVersion: 1,
      commandId: uuidv7() as never,
      status: "rejected",
      currentRevision: "0",
      code: "TURN_ALREADY_ACTIVE",
      reasons: [{ code: "TURN_ALREADY_ACTIVE", turnId: uuidv7() as never }],
    });
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    deps.local.composer.set("make it blue");
    applyIntent({ kind: "composer-submit" }, deps);
    await tick();
    // A rejection must not discard what the user typed.
    expect(deps.local.composer()).toBe("make it blue");
  });

  test("the post-accept clear reaches the mounted editor, not only the mirror", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    // A `projectId` is what moves `deriveScreen` off Home, which is what makes the COMPOSER the
    // primary input rather than the prompt.
    deps.mirror.apply(snapshot({ projectId: uuidv7(), activePageSlug: "main", trust: "trusted" }));
    const calls: string[] = [];
    deps.local.composerEditor.set(recordingHandle(calls));
    deps.local.composer.set("send me");
    applyIntent({ kind: "composer-submit" }, deps);
    await tick();
    expect(deps.local.composer()).toBe("");
    expect(calls).toEqual(["setText:"]);
  });

  test("slash-open writes the '/' into both sides, so there is one writer for that transition", () => {
    const deps = createUiDeps(createFakeKernel(), { w: 120, h: 36 });
    deps.mirror.apply(snapshot({ projectId: uuidv7(), activePageSlug: "main", trust: "trusted" }));
    const calls: string[] = [];
    deps.local.composerEditor.set(recordingHandle(calls));
    applyIntent({ kind: "slash-open" }, deps);
    expect(deps.local.composer()).toBe("/");
    expect(calls).toEqual(["setText:/"]);
  });

  test("home-backspace drives the editor handle rather than slicing the mirror", () => {
    const deps = createUiDeps(createFakeKernel(), { w: 120, h: 36 });
    const calls: string[] = [];
    deps.local.promptEditor.set(recordingHandle(calls));
    applyIntent({ kind: "home-backspace" }, deps);
    // In `blocked` the editor is blurred and receives no keys, so this intent is the ONLY route
    // that can empty the prompt — and `q` stays inert until it is empty (keymap.ts, fix round 3).
    expect(calls).toEqual(["deleteCharBackward"]);
  });
});

describe("applyIntent — local toggles", () => {
  test("tab cycles focus composer <-> preview", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    expect(deps.local.focus()).toBe("composer");
    applyIntent({ kind: "tab" }, deps);
    expect(deps.local.focus()).toBe("preview");
    applyIntent({ kind: "tab" }, deps);
    expect(deps.local.focus()).toBe("composer");
  });

  test("fullscreen toggles the fullscreen atom", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    applyIntent({ kind: "action-execute", actionId: "preview.fullscreen" }, deps);
    expect(deps.local.fullscreen()).toBe(true);
  });

  test("export dispatches export.start", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    applyIntent({ kind: "action-execute", actionId: "export.start" }, deps);
    expect(dispatchedKinds(kernel)).toEqual(["export.start"]);
  });
});

describe("applyIntent — page tabs (design extension, 2026-07-27)", () => {
  const pages = (activePageSlug: string) => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    deps.mirror.apply(
      snapshot({
        projectId: uuidv7(),
        activePageSlug,
        activeChatId: uuidv7(),
        trust: "trusted",
        pageDescriptors: [
          {
            status: "ready",
            pageSlug: "main",
            sourceHash: TEST_SHA,
            title: "Main",
            minSize: { w: 80, h: 24 },
            theme: "dark-default",
            kitApiVersion: 1,
          },
          {
            status: "ready",
            pageSlug: "settings",
            sourceHash: TEST_SHA,
            title: "Settings",
            minSize: { w: 80, h: 24 },
            theme: "dark-default",
            kitApiVersion: 1,
          },
        ],
      }),
    );
    return { kernel, deps };
  };

  test("page.next moves to the tab on the right", () => {
    const { deps } = pages("main");
    applyIntent({ kind: "action-execute", actionId: "page.next" }, deps);
    expect(deps.activePageSlug()).toBe("settings");
  });

  test("page.prev moves to the tab on the left", () => {
    const { deps } = pages("settings");
    applyIntent({ kind: "action-execute", actionId: "page.prev" }, deps);
    expect(deps.activePageSlug()).toBe("main");
  });

  test("stepping past the last tab does nothing", () => {
    const { deps } = pages("settings");
    applyIntent({ kind: "action-execute", actionId: "page.next" }, deps);
    expect(deps.activePageSlug()).toBe("settings");
  });
});

describe("applyIntent — exit (phase-8 Task 11 / WP-10)", () => {
  test("the exit intent calls requestExit and dispatches nothing", () => {
    const kernel = createFakeKernel();
    let calls = 0;
    const deps = createUiDeps(kernel, { w: 120, h: 36 }, undefined, undefined, () => {
      calls += 1;
    });
    applyIntent({ kind: "exit" }, deps);
    expect(calls).toBe(1);
    expect(kernel.dispatched).toHaveLength(0);
  });

  test("/exit's action-execute reaches the SAME requestExit call", () => {
    const kernel = createFakeKernel();
    let calls = 0;
    const deps = createUiDeps(kernel, { w: 120, h: 36 }, undefined, undefined, () => {
      calls += 1;
    });
    applyIntent({ kind: "action-execute", actionId: "app.exit" }, deps);
    expect(calls).toBe(1);
    expect(kernel.dispatched).toHaveLength(0);
  });

  test("requestExit defaults to a no-op so existing test constructions keep compiling", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    expect(() => applyIntent({ kind: "exit" }, deps)).not.toThrow();
  });
});

describe("applyIntent — preview retry", () => {
  const circuitOpened = (previewSessionId: string) =>
    event("preview.circuitOpened", {
      previewSessionId,
      pageSlug: "main",
      sourceHash: TEST_SHA,
      attempts: 1,
      finalFailure: {
        code: "HOST_CIRCUIT_OPEN",
        retryable: false,
        safeMessage: "crash-loop circuit is open",
        details: {},
      },
      retryCapability: { available: true },
    });

  test("dispatches preview.retry naming the circuit-open session — the panel's 'press F5' had NO producer before this", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    const previewSessionId = uuidv7();
    deps.mirror.apply(circuitOpened(previewSessionId));

    applyIntent({ kind: "action-execute", actionId: "preview.retry" }, deps);

    // The id is the one the Kernel published, read back from the mirror — never a fresh mint.
    // (`dispatched` records the whole envelope, so this reads the two fields that matter.)
    const retry = kernel.dispatched.find(
      (raw): raw is { kind: string; payload: { previewSessionId: string } } =>
        typeof raw === "object" && raw !== null && "kind" in raw && raw.kind === "preview.retry",
    );
    expect(retry).toBeDefined();
    expect(retry?.payload.previewSessionId).toBe(previewSessionId);
  });

  test("dispatches nothing when the circuit is not open — there is no session to retry", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });

    applyIntent({ kind: "action-execute", actionId: "preview.retry" }, deps);

    expect(
      kernel.dispatched.filter(
        (raw) =>
          typeof raw === "object" && raw !== null && "kind" in raw && raw.kind === "preview.retry",
      ),
    ).toEqual([]);
  });
});

describe("applyIntent — F6 compose-repair", () => {
  const CRASH = "PAGE_RENDER_FAILED: TypeError: ctx.spy is not a function";

  const circuitOpened = (opts?: { hostFailureCode?: string; attempts?: number }) =>
    event("preview.circuitOpened", {
      previewSessionId: uuidv7(),
      pageSlug: "main",
      sourceHash: TEST_SHA,
      attempts: opts?.attempts ?? 4,
      finalFailure: {
        code: "HOST_CIRCUIT_OPEN",
        retryable: true,
        safeMessage: CRASH,
        details: {
          pageSlug: "main",
          attempts: opts?.attempts ?? 4,
          ...(opts?.hostFailureCode === undefined ? {} : { hostFailureCode: opts.hostFailureCode }),
        },
      },
      retryCapability: { available: true },
    });

  test("fills an empty composer with the repair message and moves focus there", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    // A `projectId` is what moves `deriveScreen` off Home, which is what makes the COMPOSER the
    // primary input rather than the prompt.
    deps.mirror.apply(snapshot({ projectId: uuidv7(), activePageSlug: "main", trust: "trusted" }));
    deps.mirror.apply(circuitOpened({ hostFailureCode: "DESIGN_RENDER_FAILED" }));
    deps.local.focus.set("preview");
    const calls: string[] = [];
    deps.local.composerEditor.set(recordingHandle(calls));

    applyIntent({ kind: "action-execute", actionId: "preview.repair" }, deps);

    expect(deps.local.composer()).toContain('The preview cannot render the "main" page.');
    expect(deps.local.composer()).toContain(CRASH);
    expect(deps.local.composer()).toContain(".termcraft/pages/main/page.tsx");
    expect(deps.local.focus()).toBe("composer");
    // Nothing is sent — the design says so on the frame ("nothing is sent — you press ⏎").
    expect(kernel.dispatched).toHaveLength(0);
    // §7.4: the repair fill is an external write and must land on both sides — the mounted
    // editor's handle carries the SAME text the mirror ends up holding.
    expect(calls).toEqual([`setText:${deps.local.composer()}`]);
  });

  test("appends below a blank line rather than overwriting an existing draft", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    // A `projectId` is what moves `deriveScreen` off Home, which is what makes the COMPOSER the
    // primary input rather than the prompt.
    deps.mirror.apply(snapshot({ projectId: uuidv7(), activePageSlug: "main", trust: "trusted" }));
    deps.mirror.apply(circuitOpened({ hostFailureCode: "DESIGN_RENDER_FAILED" }));
    deps.local.composer.set("my own words");
    const calls: string[] = [];
    deps.local.composerEditor.set(recordingHandle(calls));

    applyIntent({ kind: "action-execute", actionId: "preview.repair" }, deps);

    expect(deps.local.composer().startsWith("my own words\n\n")).toBe(true);
    expect(deps.local.composer()).toContain(CRASH);
    expect(calls).toEqual([`setText:${deps.local.composer()}`]);
  });

  test("no-ops when the preview is not in an error phase", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });

    applyIntent({ kind: "action-execute", actionId: "preview.repair" }, deps);

    expect(deps.local.composer()).toBe("");
  });

  test("no-ops when the host never got as far as the page — a spawn failure is not the page's fault", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    deps.mirror.apply(circuitOpened({ hostFailureCode: "SPAWN_FAILED", attempts: 1 }));

    applyIntent({ kind: "action-execute", actionId: "preview.repair" }, deps);

    // Asking the agent to fix page.tsx could not make an unwritable temp directory writable.
    expect(deps.local.composer()).toBe("");
  });

  test("no-ops when the circuit-open carried no host code — absent is not evidence the page failed", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    deps.mirror.apply(circuitOpened());

    applyIntent({ kind: "action-execute", actionId: "preview.repair" }, deps);

    expect(deps.local.composer()).toBe("");
  });
});

describe("applyIntent — slash menu", () => {
  test("opening selects the first enabled row", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    deps.mirror.apply(
      snapshot({
        projectId: uuidv7(),
        trust: "trusted",
        capabilities: [
          {
            id: "chat.create",
            target: null,
            state: { available: false, reasons: [{ code: "CAPABILITY_UNAVAILABLE" }] },
          },
          // `/chats` reads chat.switch's OWN published state, not its null `command.capability`
          // (finding §2.5, phase-8 Task 16 review round 1) — publish it available so this
          // fixture's "skip onto /chats" claim is actually true, not an artifact of a missing
          // capability defaulting to unavailable.
          { id: "chat.switch", target: null, state: { available: true } },
          { id: "export.start", target: null, state: { available: true } },
        ],
      }),
    );

    applyIntent({ kind: "slash-open" }, deps);
    expect(deps.local.composer()).toBe("/");
    expect(deps.local.overlay()).toBe("slash-menu");
    expect(deps.local.slashSelection()).toBe(1); // skips disabled /new onto /chats
  });

  test("arrows wrap across enabled rows and never land on inert rows", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    deps.mirror.apply(
      snapshot({
        projectId: uuidv7(),
        trust: "trusted",
        capabilities: [
          { id: "chat.create", target: null, state: { available: true } },
          // `/chats` reads this, not its own null `command.capability` (finding §2.5, phase-8
          // Task 16 review round 1).
          { id: "chat.switch", target: null, state: { available: true } },
          { id: "export.start", target: null, state: { available: true } },
          {
            id: "model.select",
            target: { backend: "claude", model: "sonnet", effort: "high" },
            state: { available: true },
          },
        ],
      }),
    );
    applyIntent({ kind: "slash-open" }, deps);
    applyIntent({ kind: "slash-move", delta: -1 }, deps);
    // Enabled rows here are /new(0), /chats(1), /export(2), /exit(7) — /model and every
    // /commit-* stay inert regardless of capability. Moving -1 from /new wraps to the LAST
    // enabled row, /exit, not to inert /model or the commits in between.
    expect(deps.local.slashSelection()).toBe(7);
    applyIntent({ kind: "slash-move", delta: 1 }, deps);
    expect(deps.local.slashSelection()).toBe(0);
  });

  test("Enter executes /new, /chats, and /export through their action descriptions", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    deps.mirror.apply(
      snapshot({
        projectId: uuidv7(),
        trust: "trusted",
        capabilities: [
          { id: "chat.create", target: null, state: { available: true } },
          // `/chats` reads this, not its own null `command.capability` (finding §2.5, phase-8
          // Task 16 review round 1) — required for the `/chats` submit below to actually open
          // the chat-list popup instead of being refused as unavailable.
          { id: "chat.switch", target: null, state: { available: true } },
          { id: "export.start", target: null, state: { available: true } },
        ],
      }),
    );

    applyIntent({ kind: "slash-open" }, deps);
    applyIntent({ kind: "slash-submit" }, deps);
    expect(dispatchedKinds(kernel)).toEqual(["chat.create"]);

    deps.local.composer.set("/chats");
    deps.local.overlay.set("slash-menu");
    deps.local.slashSelection.set(0);
    applyIntent({ kind: "slash-submit" }, deps);
    expect(deps.local.overlay()).toBe("chat-list");

    deps.local.composer.set("/export");
    deps.local.overlay.set("slash-menu");
    deps.local.slashSelection.set(0);
    applyIntent({ kind: "slash-submit" }, deps);
    expect(dispatchedKinds(kernel)).toEqual(["chat.create", "export.start"]);
  });

  test("an already-resolved slash submit cannot dispatch after transition to read-only", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    deps.mirror.apply(
      snapshot({
        projectId: uuidv7(),
        trust: "untrusted-read-only",
        capabilities: [{ id: "chat.create", target: null, state: { available: true } }],
      }),
    );
    deps.local.composer.set("/new");
    deps.local.overlay.set("slash-menu");
    deps.local.slashSelection.set(0);

    applyIntent({ kind: "slash-submit" }, deps);

    expect(kernel.dispatched).toHaveLength(0);
    expect(deps.local.overlay()).toBeNull();
  });
});

// §3.10, phase-8 Task 17 (finding §2.4): the slash menu's primary input follows the screen —
// Home writes `local.prompt`, never `local.composer` — via `intent.ts`'s own `primaryInput`.
describe("applyIntent — slash menu on Home (§3.10, phase-8 Task 17)", () => {
  test("slash-open writes '/' into the Home prompt, not the Workspace composer", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    expect(deps.screen()).toBe("home");

    applyIntent({ kind: "slash-open" }, deps);
    expect(deps.local.prompt()).toBe("/");
    expect(deps.local.composer()).toBe("");
    expect(deps.local.overlay()).toBe("slash-menu");
    // /model (unavailable — v1.0) is skipped; selection lands on /exit, the working row.
    expect(deps.local.slashSelection()).toBe(1);
  });

  test("slash-submit on /exit clears the Home prompt and requests shutdown, dispatching nothing", () => {
    const kernel = createFakeKernel();
    let calls = 0;
    const deps = createUiDeps(kernel, { w: 120, h: 36 }, undefined, undefined, () => {
      calls += 1;
    });
    applyIntent({ kind: "slash-open" }, deps);
    expect(deps.local.slashSelection()).toBe(1); // /exit, the one available Home row

    applyIntent({ kind: "slash-submit" }, deps);
    expect(calls).toBe(1);
    expect(deps.local.prompt()).toBe("");
    expect(deps.local.overlay()).toBeNull();
    expect(kernel.dispatched).toHaveLength(0);
  });

  test("slash-move skips the unavailable /model row on Home, exactly as it skips inert rows on Workspace", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    applyIntent({ kind: "slash-open" }, deps);
    applyIntent({ kind: "slash-move", delta: -1 }, deps);
    // Only one enabled row (/exit) exists on Home — moving in either direction wraps to it.
    expect(deps.local.slashSelection()).toBe(1);
    applyIntent({ kind: "slash-move", delta: 1 }, deps);
    expect(deps.local.slashSelection()).toBe(1);
  });
});

describe("applyIntent — chats and trust", () => {
  test("chat navigation wraps and Enter dispatches chat.switch for the selected chatId", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    const first = uuidv7();
    const second = uuidv7();
    deps.mirror.apply(
      event("chat.changed", {
        activeChatId: first,
        added: [
          { chatId: first, createdAt: TEST_TS, displayName: null },
          { chatId: second, createdAt: TEST_TS, displayName: null },
        ],
        updated: [],
        removedChatIds: [],
      }),
    );
    deps.local.overlay.set("chat-list");
    applyIntent({ kind: "chat-move", delta: -1 }, deps);
    expect(deps.local.chatSelection()).toBe(1);
    applyIntent({ kind: "chat-switch" }, deps);
    expect(dispatchedKinds(kernel)).toEqual(["chat.switch"]);
    expect((kernel.dispatched[0] as { payload: { chatId: string } }).payload).toEqual({
      chatId: second,
    });
    expect(deps.local.overlay()).toBeNull();
  });

  test("trust accept and decline dispatch the exact project.setTrust payloads", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(
      kernel,
      { w: 120, h: 36 },
      { root: "/project", workspaceIdentity: "workspace-id", projectExists: false },
    );
    applyIntent({ kind: "trust-accept" }, deps);
    applyIntent({ kind: "trust-decline" }, deps);
    expect(kernel.dispatched.map((raw) => (raw as { payload: unknown }).payload)).toEqual([
      { trust: "trusted", workspaceIdentity: "workspace-id" },
      { trust: "untrusted-read-only", workspaceIdentity: "workspace-id" },
    ]);
  });

  test("popup dismissal closes the overlay without reaching lower Esc layers", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    deps.local.overlay.set("slash-menu");
    deps.local.focus.set("preview");
    applyIntent({ kind: "overlay-dismiss" }, deps);
    expect(deps.local.overlay()).toBeNull();
    expect(deps.local.focus()).toBe("preview");
  });
});

describe("applyIntent — export popup dismissal (M14)", () => {
  test("export-dismiss records the done export's operationId, dispatching nothing", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    const operationId = uuidv7();
    deps.mirror.apply(
      event("export.completed", {
        operationId,
        phase: "publishing",
        destination: ".termcraft/export",
        generationId: null,
        failure: null,
      }),
    );
    expect(deps.local.exportDismissed()).toBeNull();
    applyIntent({ kind: "export-dismiss" }, deps);
    expect(deps.local.exportDismissed()).toBe(operationId);
    expect(kernel.dispatched).toHaveLength(0);
  });

  test("export-dismiss records the failed export's operationId", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    const operationId = uuidv7();
    deps.mirror.apply(
      event("export.failed", {
        operationId,
        phase: "rendering",
        destination: ".termcraft/export",
        generationId: null,
        failure: null,
      }),
    );
    applyIntent({ kind: "export-dismiss" }, deps);
    expect(deps.local.exportDismissed()).toBe(operationId);
  });

  test("export-dismiss is a no-op while no export result is showing", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    applyIntent({ kind: "export-dismiss" }, deps);
    expect(deps.local.exportDismissed()).toBeNull();
    expect(kernel.dispatched).toHaveLength(0);
  });
});

describe("applyIntent — Home agent-health re-check (M15)", () => {
  test("home-recheck re-runs the injected health probe and updates the health atom", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 }, undefined, () =>
      Promise.resolve({ kind: "ready", agent: "claude" }),
    );
    applyIntent({ kind: "home-recheck" }, deps);
    await tick();
    expect(deps.local.homeHealth()).toEqual({ kind: "ready", agent: "claude" });
  });

  test("home-recheck reflects a still-missing agent from the probe", async () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 }, undefined, () =>
      Promise.resolve({ kind: "missing", agent: "claude", detail: "claude CLI not found" }),
    );
    applyIntent({ kind: "home-recheck" }, deps);
    await tick();
    expect(deps.local.homeHealth()).toEqual({
      kind: "missing",
      agent: "claude",
      detail: "claude CLI not found",
    });
  });
});

describe("applyIntent — pin draft", () => {
  test("save dispatches only the opaque geometry token plus text", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    deps.mirror.apply(snapshot({ projectId: uuidv7(), activePageSlug: "main", trust: "trusted" }));
    const geometryToken = uuidv7();
    deps.interaction.pendingPin.set({ geometryToken, point: { x: 4, y: 5 } });
    deps.local.pinDraft.set("why is this always on top?");
    deps.local.overlay.set("pin-input");

    applyIntent({ kind: "pin-save" }, deps);

    const command = kernel.dispatched[0] as { kind: string; payload: Record<string, unknown> };
    expect(command.kind).toBe("pin.create");
    expect(command.payload).toEqual({ geometryToken, text: "why is this always on top?" });
    expect(command.payload).not.toHaveProperty("pageSlug");
    expect(command.payload).not.toHaveProperty("elementId");
    expect(deps.local.overlay()).toBeNull();
    expect(deps.local.pinDraft()).toBe("");
  });

  test("save remains inert after transition to read-only", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    deps.mirror.apply(
      snapshot({
        projectId: uuidv7(),
        activePageSlug: "main",
        trust: "untrusted-read-only",
      }),
    );
    deps.interaction.pendingPin.set({ geometryToken: uuidv7(), point: { x: 1, y: 1 } });
    deps.local.pinDraft.set("must not save");
    deps.local.overlay.set("pin-input");

    applyIntent({ kind: "pin-save" }, deps);

    expect(kernel.dispatched).toHaveLength(0);
  });
});

describe("applyIntent — Esc layers", () => {
  test("esc closes an open overlay first", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    deps.local.overlay.set("chat-list");
    applyIntent({ kind: "esc" }, deps);
    expect(deps.local.overlay()).toBeNull();
  });

  test("esc cancels a running generation (turn.cancel with the active turn id)", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    const turnId = uuidv7();
    deps.mirror.apply(snapshot());
    deps.mirror.apply(event("turn.started", { turnId, chatId: uuidv7(), deadline: TEST_TS }));
    applyIntent({ kind: "esc" }, deps);
    expect(dispatchedKinds(kernel)).toEqual(["turn.cancel"]);
    expect((kernel.dispatched[0] as { payload: { turnId: string } }).payload.turnId).toBe(turnId);
  });

  test("esc with focus on preview returns focus to the composer before cancelling", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    deps.local.focus.set("preview");
    deps.mirror.apply(
      event("turn.started", { turnId: uuidv7(), chatId: uuidv7(), deadline: TEST_TS }),
    );
    applyIntent({ kind: "esc" }, deps);
    expect(deps.local.focus()).toBe("composer");
    expect(kernel.dispatched).toHaveLength(0);
  });

  // TRIAGE #35: `applyEsc` must page-scope `hasSelection` exactly like `deriveComposerAttach`
  // does (`workspace/model/attach.ts`) — the mirror only clears `selection` on a fresh
  // `kernel.snapshot`, never on a page switch, so an unscoped read stays "true" for a selection
  // left over from a page the user has since navigated away from.
  test("esc does not deselect a stale cross-page selection (page-scoped like the composer chip, TRIAGE #35)", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    deps.mirror.apply(snapshot({ projectId: uuidv7(), activePageSlug: "main", trust: "trusted" }));
    deps.mirror.apply(
      event("selection.changed", {
        pageSlug: "other",
        elementId: "gauge-cpu",
        sourceHash: TEST_SHA,
      }),
    );
    applyIntent({ kind: "esc" }, deps);
    expect(kernel.dispatched).toHaveLength(0);
  });

  test("esc still deselects a selection that matches the active page (TRIAGE #35)", () => {
    const kernel = createFakeKernel();
    const deps = createUiDeps(kernel, { w: 120, h: 36 });
    deps.mirror.apply(snapshot({ projectId: uuidv7(), activePageSlug: "main", trust: "trusted" }));
    deps.mirror.apply(
      event("selection.changed", {
        pageSlug: "main",
        elementId: "gauge-cpu",
        sourceHash: TEST_SHA,
      }),
    );
    applyIntent({ kind: "esc" }, deps);
    expect(dispatchedKinds(kernel)).toEqual(["selection.clear"]);
  });
});
