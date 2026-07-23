import type { PreviewFrameV1 } from "core/ports";
import { uuidv7 } from "infrastructure/uuid";
import type { UiEnv } from "ui";
import { TEST_SHA, createFakeKernel, createFakePreviewSession } from "ui/testing";

import type { AppShell, EntrypointMode } from "../types";

/**
 * Builds the Kernel boundary one run drives.
 *
 * DEFERRED, ON PURPOSE: there is no composed production `KernelPort` yet. `core/` owns the
 * machines, guards, mailbox and orchestration, but nothing maps `store`/`agent`/`gate`/`host`
 * onto `core/ports/` and no handler registry exists, so a "production" shell here would be
 * fake-to-real wiring pretending to be a kernel. Until that composition lands, BOTH modes run
 * the in-memory `ui`-owned kernel; `bootstrap` is what keeps `interactive` from silently
 * passing itself off as the real application.
 *
 * The two modes differ only in their seed: `interactive` opens on Home with the caller's
 * project root, `demo` opens straight into a trusted workspace with a preview session, so the
 * shell is explorable offline with no credentials and no project on disk.
 */
export function createShell(mode: EntrypointMode, env: UiEnv): AppShell {
  return mode === "demo" ? demoShell(env) : interactiveShell(env);
}

function interactiveShell(env: UiEnv): AppShell {
  const port = createFakeKernel();
  return {
    mode: "interactive",
    port,
    env,
    close: () => Promise.resolve(),
  };
}

function demoShell(env: UiEnv): AppShell {
  const preview = createFakePreviewSession({ pageSlug: DEMO_PAGE_SLUG });
  const port = createFakeKernel({
    snapshot: {
      projectId: uuidv7(),
      activePageSlug: DEMO_PAGE_SLUG,
      activeChatId: uuidv7(),
      trust: "trusted",
      capabilities: [
        { id: "chat.create", target: {}, state: { available: true } },
        { id: "turn.start", target: {}, state: { available: true } },
        { id: "export.start", target: {}, state: { available: true } },
      ],
      pageDescriptors: [
        {
          status: "ready",
          pageSlug: DEMO_PAGE_SLUG,
          sourceHash: TEST_SHA,
          title: "Main",
          minSize: { w: 80, h: 24 },
          theme: "dark-default",
          kitApiVersion: 1,
        },
      ],
    },
  });
  port.setPreview(preview.handle);
  preview.pushFrame(demoFrame(preview.handle.previewSessionId));

  let closed = false;
  return {
    mode: "demo",
    port,
    env,
    close: () => {
      if (closed) return Promise.resolve();
      closed = true;
      preview.end();
      return Promise.resolve();
    },
  };
}

const DEMO_PAGE_SLUG = "main";

/**
 * One static frame standing in for a host-rendered page. Every run is `"default"`/`"default"`:
 * frame colors belong to the design pages the host renders, and this module has no design
 * source to take them from — inventing hex values here would put unapproved color in the
 * preview region.
 */
function demoFrame(sessionId: string): PreviewFrameV1 {
  const lines = [
    "termcraft demo preview",
    "",
    "This frame is served by the in-memory kernel.",
    "The design host is not spawned in demo mode.",
  ];
  return {
    sessionId,
    sourceHash: TEST_SHA,
    frameSeq: "1",
    width: Math.max(...lines.map((line) => line.length)),
    height: lines.length,
    rows: lines.map((text) => [{ text, fg: "default", bg: "default", attrs: 0 } as const]),
  };
}
