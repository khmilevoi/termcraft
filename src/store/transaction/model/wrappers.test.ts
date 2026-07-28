import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  ChatAgentRecord,
  ChatHeader,
  ChatSystemCancelledRecord,
  ChatSystemErrorRecord,
  ChatSystemRestoreRecord,
  ChatUserRecord,
} from "entities/chat";
import { parsePageSlug } from "entities/page";
import type { PageSlug } from "entities/page";
import type { CommentsHeader, PinEvent } from "entities/pin";
import { uuidv7 } from "infrastructure/uuid";
import type { AppendBase } from "store/jsonl";
import {
  encodeChatHeaderLine,
  encodeChatRecordLine,
  encodeCommentsHeaderLine,
  encodePinEventLine,
  sha256Hex,
} from "store/jsonl";
import { createSafeProjectFs, nodeSafeFsDeps, openManagedRoot } from "store/safe-fs";
import type { SafeProjectFs } from "store/safe-fs";
import {
  PROJECT_MANIFEST_FILENAME,
  decodeProjectManifest,
  decodeWorkspaceLocalState,
  encodeProjectManifest,
} from "store/toml";
import type { ProjectManifest } from "store/toml";

import type { FileImage, TransactionOperation } from "../types";
import { nodeTransactionFsDeps } from "./engine";
import {
  SourceChangedError,
  StaleError,
  TurnAlreadyTerminalError,
  TurnRecordNotFoundError,
  admitTurn,
  buildExportPublishTransaction,
  buildMigrationTransaction,
  buildRestoreTransaction,
  buildStandalonePinEventOperation,
  canonicalPagePath,
  chatJsonlPath,
  finalizeTurn,
  pageCommentsPath,
  runProjectMutation,
  terminalizeTurn,
} from "./wrappers";
import type { TransactionWrapperDeps, TurnReadSet } from "./wrappers";
import { createWriteMutex } from "./write-mutex";

const TS = "2026-07-20T10:00:00Z";
const PROJECT_ID = uuidv7();

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
function textOf(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
function concatBytes(pieces: readonly Uint8Array[]): Uint8Array {
  const total = pieces.reduce((sum, piece) => sum + piece.byteLength, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const piece of pieces) {
    out.set(piece, at);
    at += piece.byteLength;
  }
  return out;
}
function slug(value: string): PageSlug {
  const parsed = parsePageSlug(value);
  if (parsed instanceof Error) throw new Error(`fixture bug: ${parsed.message}`);
  return parsed;
}

let scratch = "";
let termcraftDir = "";

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tc-wrappers-"));
  termcraftDir = path.join(scratch, ".termcraft");
  fs.mkdirSync(termcraftDir);
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

function openSafeFs(): SafeProjectFs {
  const deps = nodeSafeFsDeps();
  const root = openManagedRoot({ kind: "project", path: termcraftDir, deps });
  if (root instanceof Error) throw new Error(`openManagedRoot failed: ${root.message}`);
  return createSafeProjectFs(root, deps);
}

function wrapperDeps(): TransactionWrapperDeps {
  return { fs: nodeTransactionFsDeps(openSafeFs()), append: { newPayloadId: uuidv7 } };
}

function absOf(relPath: string): string {
  return path.join(termcraftDir, ...relPath.split("/"));
}

function writeManaged(relPath: string, bytes: Uint8Array): void {
  const abs = absOf(relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);
}

function appendManaged(relPath: string, bytes: Uint8Array): void {
  fs.appendFileSync(absOf(relPath), bytes);
}

function seedChatHeader(chatId: string): void {
  const header: ChatHeader = {
    kind: "chat",
    formatVersion: 1,
    projectId: PROJECT_ID,
    chatId,
    createdAt: TS,
  };
  const line = encodeChatHeaderLine(header);
  if (line instanceof Error) throw new Error(`fixture bug: ${line.message}`);
  writeManaged(chatJsonlPath(chatId), line);
}

function seedChatWithUserRecord(chatId: string, turnId: string): void {
  const header: ChatHeader = {
    kind: "chat",
    formatVersion: 1,
    projectId: PROJECT_ID,
    chatId,
    createdAt: TS,
  };
  const headerLine = encodeChatHeaderLine(header);
  if (headerLine instanceof Error) throw new Error(`fixture bug: ${headerLine.message}`);
  const userLine = encodeChatRecordLineOrThrow(userRecord(turnId));
  writeManaged(chatJsonlPath(chatId), concatBytes([headerLine, userLine]));
}

function encodeChatRecordLineOrThrow(
  record: ChatUserRecord | ChatAgentRecord | ChatSystemErrorRecord | ChatSystemCancelledRecord,
): Uint8Array {
  const line = encodeChatRecordLine(record);
  if (line instanceof Error) throw new Error(`fixture bug: ${line.message}`);
  return line;
}

function seedPinsFile(pageSlug: PageSlug, events: readonly PinEvent[]): void {
  const header: CommentsHeader = {
    kind: "pins",
    formatVersion: 1,
    projectId: PROJECT_ID,
    pageSlug,
  };
  const headerLine = encodeCommentsHeaderLine(header);
  if (headerLine instanceof Error) throw new Error(`fixture bug: ${headerLine.message}`);
  const eventLines = events.map((event) => {
    const line = encodePinEventLine(event);
    if (line instanceof Error) throw new Error(`fixture bug: ${line.message}`);
    return line;
  });
  writeManaged(pageCommentsPath(pageSlug), concatBytes([headerLine, ...eventLines]));
}

function seedManifest(manifest: ProjectManifest): void {
  writeManaged(PROJECT_MANIFEST_FILENAME, bytesOf(encodeProjectManifest(manifest)));
}

function readManaged(relPath: string): Uint8Array {
  return new Uint8Array(fs.readFileSync(absOf(relPath)));
}
function managedExists(relPath: string): boolean {
  return fs.existsSync(absOf(relPath));
}

function fileImageOf(relPath: string): FileImage {
  if (!managedExists(relPath)) return { state: "absent" };
  const bytes = readManaged(relPath);
  return { state: "file", sha256: sha256Hex(bytes), size: bytes.byteLength };
}
function appendBaseOf(relPath: string): AppendBase {
  if (!managedExists(relPath)) return { length: 0, prefixSha256: sha256Hex(new Uint8Array(0)) };
  const bytes = readManaged(relPath);
  return { length: bytes.byteLength, prefixSha256: sha256Hex(bytes) };
}

function emptyReadSet(chatId: string): TurnReadSet {
  return {
    manifest: fileImageOf(PROJECT_MANIFEST_FILENAME),
    canonicalPages: new Map(),
    chat: appendBaseOf(chatJsonlPath(chatId)),
    pins: new Map(),
  };
}

function userRecord(turnId: string, text = "make it red"): ChatUserRecord {
  return { kind: "user", recordId: uuidv7(), turnId, text, ts: TS };
}
function agentRecord(turnId: string, changedPages: readonly PageSlug[] = []): ChatAgentRecord {
  return {
    kind: "agent",
    recordId: uuidv7(),
    turnId,
    text: "Updated.",
    changedPages,
    warnings: [],
    ts: TS,
  };
}
function errorRecord(
  turnId: string,
  outcome: "error" | "stale" | "interrupted",
): ChatSystemErrorRecord {
  return { kind: "system:error", recordId: uuidv7(), turnId, outcome, text: "It failed.", ts: TS };
}
function cancelledRecord(turnId: string): ChatSystemCancelledRecord {
  return { kind: "system:cancelled", recordId: uuidv7(), turnId, text: "Cancelled.", ts: TS };
}

function lineCount(relPath: string): number {
  return textOf(readManaged(relPath))
    .split("\n")
    .filter((line) => line.length > 0).length;
}

// ==========================================================================================
// TurnTransaction
// ==========================================================================================

describe("admitTurn", () => {
  test("commits the user record durably before any agent process would start (invariant 9)", async () => {
    const chatId = uuidv7();
    const turnId = uuidv7();
    seedChatHeader(chatId);
    const deps = wrapperDeps();
    const mutex = createWriteMutex();
    const permit = await mutex.acquire();

    const result = await admitTurn(deps, {
      mutex,
      permit,
      transactionId: uuidv7(),
      turnId,
      targetChatId: chatId,
      userRecord: userRecord(turnId),
      createdAt: TS,
    });
    if (result instanceof Error) throw new Error(`unexpected error: ${result.message}`);

    expect(lineCount(chatJsonlPath(chatId))).toBe(2); // header + user record
    expect(textOf(readManaged(chatJsonlPath(chatId)))).toContain(`"turnId":"${turnId}"`);
  });
});

describe("finalizeTurn — empty diff", () => {
  test("changedPages: [], exactly one agent record, and no pin resolved even if candidates were passed", async () => {
    const chatId = uuidv7();
    const turnId = uuidv7();
    const home = slug("home");
    seedChatHeader(chatId);
    const manifest: ProjectManifest = {
      formatVersion: 1,
      projectId: PROJECT_ID,
      name: "demo",
      createdAt: TS,
      targetStack: "generic",
      pages: [home],
    };
    seedManifest(manifest);

    const deps = wrapperDeps();
    const mutex = createWriteMutex();
    const permit = await mutex.acquire();

    const result = await finalizeTurn(deps, {
      mutex,
      permit,
      transactionId: uuidv7(),
      turnId,
      targetChatId: chatId,
      changedPages: [],
      validatedPageSlugs: [home], // identical to manifest.pages — no manifest operation expected
      manifestBefore: manifest,
      agentRecord: agentRecord(turnId, []),
      resolvedPins: [
        {
          pageSlug: home,
          event: {
            kind: "pin:status",
            recordId: uuidv7(),
            pinId: uuidv7(),
            status: "resolved",
            turnId,
            ts: TS,
          },
        },
      ],
      readSet: emptyReadSet(chatId),
      createdAt: TS,
    });
    if (result instanceof Error) throw new Error(`unexpected error: ${result.message}`);

    expect(result.operations).toHaveLength(1); // only the agent record
    expect(lineCount(chatJsonlPath(chatId))).toBe(2); // header + the one agent record
    expect(managedExists(pageCommentsPath(home))).toBe(false); // the pin candidate's page was never touched
  });
});

describe("finalizeTurn — full successful finalization", () => {
  test("canonical pages (sorted), derived manifest, workspace-local switch, agent record, then pin resolution — in that order", async () => {
    const chatId = uuidv7();
    const turnId = uuidv7();
    const home = slug("home");
    const about = slug("about");
    const pinId = uuidv7();

    seedChatHeader(chatId);
    writeManaged(canonicalPagePath(home), bytesOf("export default function Home() {}\n"));
    seedPinsFile(home, [
      {
        kind: "pin:created",
        recordId: uuidv7(),
        pinId,
        element: "cpu-gauge",
        fx: 0.5,
        fy: 0.5,
        text: "make this red",
        ts: TS,
      },
    ]);
    const manifestBefore: ProjectManifest = {
      formatVersion: 1,
      projectId: PROJECT_ID,
      name: "demo",
      createdAt: TS,
      targetStack: "generic",
      pages: [home],
    };
    seedManifest(manifestBefore);

    const readSet: TurnReadSet = {
      manifest: fileImageOf(PROJECT_MANIFEST_FILENAME),
      canonicalPages: new Map([
        [home, fileImageOf(canonicalPagePath(home))],
        [about, fileImageOf(canonicalPagePath(about))], // expected-absent: about does not exist yet
      ]),
      chat: appendBaseOf(chatJsonlPath(chatId)),
      pins: new Map([[home, appendBaseOf(pageCommentsPath(home))]]),
    };

    const deps = wrapperDeps();
    const mutex = createWriteMutex();
    const permit = await mutex.acquire();

    const newHomeBytes = bytesOf(
      'export default function Home() { return <Gauge color="red" /> }\n',
    );
    const newAboutBytes = bytesOf("export default function About() {}\n");

    const result = await finalizeTurn(deps, {
      mutex,
      permit,
      transactionId: uuidv7(),
      turnId,
      targetChatId: chatId,
      changedPages: [
        { pageSlug: home, change: "replace", newBytes: newHomeBytes },
        { pageSlug: about, change: "replace", newBytes: newAboutBytes },
      ],
      validatedPageSlugs: [about, home], // reordered — triggers a project.toml operation
      manifestBefore,
      requestedActivePage: about,
      agentRecord: agentRecord(turnId, [about, home]),
      resolvedPins: [
        {
          pageSlug: home,
          event: {
            kind: "pin:status",
            recordId: uuidv7(),
            pinId,
            status: "resolved",
            turnId,
            ts: TS,
          },
        },
      ],
      readSet,
      createdAt: TS,
    });
    if (result instanceof Error) throw new Error(`unexpected error: ${result.message}`);

    // about(0) < home(1) by sorted slug, then manifest(2), workspace-local(3), agent(4), pins(5).
    expect(result.operations.map((op) => op.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(readManaged(canonicalPagePath(about))).toEqual(newAboutBytes);
    expect(readManaged(canonicalPagePath(home))).toEqual(newHomeBytes);

    const manifestNow = decodeProjectManifest(textOf(readManaged(PROJECT_MANIFEST_FILENAME)));
    if (manifestNow instanceof Error) throw new Error(`unexpected error: ${manifestNow.message}`);
    expect(manifestNow.pages).toEqual([about, home]);

    const workspaceNow = decodeWorkspaceLocalState(textOf(readManaged("workspace.local.toml")));
    if (workspaceNow instanceof Error) throw new Error(`unexpected error: ${workspaceNow.message}`);
    expect(workspaceNow.activePageSlug).toBe(about);

    expect(lineCount(chatJsonlPath(chatId))).toBe(2); // header + the one agent record
    expect(lineCount(pageCommentsPath(home))).toBe(3); // header + pin:created + pin:status resolved
    expect(textOf(readManaged(pageCommentsPath(home)))).toContain('"status":"resolved"');
  });
});

describe("finalizeTurn — mandatory pre-intent CAS (§7.5)", () => {
  test("canonical page drift yields a typed source_changed error and no overwrite", async () => {
    const chatId = uuidv7();
    const turnId = uuidv7();
    const home = slug("home");
    seedChatHeader(chatId);
    writeManaged(canonicalPagePath(home), bytesOf("original\n"));
    const manifestBefore: ProjectManifest = {
      formatVersion: 1,
      projectId: PROJECT_ID,
      name: "demo",
      createdAt: TS,
      targetStack: "generic",
      pages: [home],
    };
    seedManifest(manifestBefore);

    const readSet: TurnReadSet = {
      manifest: fileImageOf(PROJECT_MANIFEST_FILENAME),
      canonicalPages: new Map([[home, fileImageOf(canonicalPagePath(home))]]),
      chat: appendBaseOf(chatJsonlPath(chatId)),
      pins: new Map(),
    };

    // A hook (or any external writer) drifts the canonical source after the read set was captured.
    writeManaged(canonicalPagePath(home), bytesOf("hook-mutated\n"));

    const deps = wrapperDeps();
    const mutex = createWriteMutex();
    const permit = await mutex.acquire();

    const result = await finalizeTurn(deps, {
      mutex,
      permit,
      transactionId: uuidv7(),
      turnId,
      targetChatId: chatId,
      changedPages: [],
      validatedPageSlugs: [home],
      manifestBefore,
      agentRecord: agentRecord(turnId, []),
      resolvedPins: [],
      readSet,
      createdAt: TS,
    });

    expect(result).toBeInstanceOf(SourceChangedError);
    expect(result instanceof SourceChangedError && result.part).toBe(`canonical:${home}`);
    expect(textOf(readManaged(canonicalPagePath(home)))).toBe("hook-mutated\n"); // never overwritten
    expect(lineCount(chatJsonlPath(chatId))).toBe(1); // no agent record was appended
  });

  test("manifest drift yields a typed source_changed error and no overwrite", async () => {
    const chatId = uuidv7();
    const turnId = uuidv7();
    const home = slug("home");
    seedChatHeader(chatId);
    const manifestBefore: ProjectManifest = {
      formatVersion: 2,
      projectId: PROJECT_ID,
      name: "original",
      createdAt: TS,
      targetStack: "generic",
    };
    seedManifest(manifestBefore);

    const readSet = emptyReadSet(chatId);

    // A hook rewrites project.toml (e.g. a concurrent title edit) after the read set was captured.
    seedManifest({ ...manifestBefore, name: "tampered-by-a-hook" });

    const deps = wrapperDeps();
    const mutex = createWriteMutex();
    const permit = await mutex.acquire();

    const result = await finalizeTurn(deps, {
      mutex,
      permit,
      transactionId: uuidv7(),
      turnId,
      targetChatId: chatId,
      changedPages: [],
      validatedPageSlugs: [home],
      manifestBefore,
      agentRecord: agentRecord(turnId, []),
      resolvedPins: [],
      readSet,
      createdAt: TS,
    });

    expect(result).toBeInstanceOf(SourceChangedError);
    expect(result instanceof SourceChangedError && result.part).toBe("manifest");
    const manifestNow = decodeProjectManifest(textOf(readManaged(PROJECT_MANIFEST_FILENAME)));
    if (manifestNow instanceof Error) throw new Error(`unexpected error: ${manifestNow.message}`);
    expect(manifestNow.name).toBe("tampered-by-a-hook"); // never overwritten back
    expect(lineCount(chatJsonlPath(chatId))).toBe(1);
  });

  test("captured-chat drift yields a typed stale error and no overwrite", async () => {
    const chatId = uuidv7();
    const turnId = uuidv7();
    seedChatHeader(chatId);
    const readSet = emptyReadSet(chatId);

    // An external writer (e.g. a Git hook path, or a concurrent unrelated append) grows the chat.
    const strayTurnId = uuidv7();
    appendManaged(chatJsonlPath(chatId), encodeChatRecordLineOrThrow(cancelledRecord(strayTurnId)));

    const deps = wrapperDeps();
    const mutex = createWriteMutex();
    const permit = await mutex.acquire();

    const result = await finalizeTurn(deps, {
      mutex,
      permit,
      transactionId: uuidv7(),
      turnId,
      targetChatId: chatId,
      changedPages: [],
      validatedPageSlugs: [],
      manifestBefore: {
        formatVersion: 1,
        projectId: PROJECT_ID,
        name: "demo",
        createdAt: TS,
        targetStack: "generic",
        pages: [],
      },
      agentRecord: agentRecord(turnId, []),
      resolvedPins: [],
      readSet,
      createdAt: TS,
    });

    expect(result).toBeInstanceOf(StaleError);
    expect(result instanceof StaleError && result.part).toBe("chat");
    expect(lineCount(chatJsonlPath(chatId))).toBe(2); // header + the stray record only, no agent record
  });

  test("comments-log drift yields a typed stale error and no overwrite", async () => {
    const chatId = uuidv7();
    const turnId = uuidv7();
    const home = slug("home");
    seedChatHeader(chatId);
    const pinId = uuidv7();
    seedPinsFile(home, [
      {
        kind: "pin:created",
        recordId: uuidv7(),
        pinId,
        element: "cpu-gauge",
        fx: 0.5,
        fy: 0.5,
        text: "x",
        ts: TS,
      },
    ]);

    const readSet: TurnReadSet = {
      manifest: fileImageOf(PROJECT_MANIFEST_FILENAME),
      canonicalPages: new Map(),
      chat: appendBaseOf(chatJsonlPath(chatId)),
      pins: new Map([[home, appendBaseOf(pageCommentsPath(home))]]),
    };

    // A concurrent UI action (e.g. a fresh pin) grows the comments log after the read set was captured.
    appendManaged(
      pageCommentsPath(home),
      bytesOf(
        `${JSON.stringify({ kind: "pin:created", recordId: uuidv7(), pinId: uuidv7(), element: "y", fx: 0.1, fy: 0.1, text: "z", ts: TS })}\n`,
      ),
    );

    const deps = wrapperDeps();
    const mutex = createWriteMutex();
    const permit = await mutex.acquire();

    const result = await finalizeTurn(deps, {
      mutex,
      permit,
      transactionId: uuidv7(),
      turnId,
      targetChatId: chatId,
      changedPages: [],
      validatedPageSlugs: [],
      manifestBefore: {
        formatVersion: 1,
        projectId: PROJECT_ID,
        name: "demo",
        createdAt: TS,
        targetStack: "generic",
        pages: [],
      },
      agentRecord: agentRecord(turnId, []),
      resolvedPins: [],
      readSet,
      createdAt: TS,
    });

    expect(result).toBeInstanceOf(StaleError);
    expect(result instanceof StaleError && result.part).toBe(`pins:${home}`);
    expect(lineCount(chatJsonlPath(chatId))).toBe(1);
  });
});

describe("terminalizeTurn", () => {
  test("appends exactly one system record and never touches pins, for every terminal outcome", async () => {
    const deps = wrapperDeps();
    const mutex = createWriteMutex();

    const cases: Array<{ record: ChatSystemErrorRecord | ChatSystemCancelledRecord }> = [
      { record: errorRecord(uuidv7(), "error") },
      { record: errorRecord(uuidv7(), "stale") },
      { record: errorRecord(uuidv7(), "interrupted") },
      { record: cancelledRecord(uuidv7()) },
    ];

    for (const { record } of cases) {
      const chatId = uuidv7();
      const turnId = record.turnId;
      if (turnId === undefined) throw new Error("fixture bug: record has no turnId");
      seedChatWithUserRecord(chatId, turnId);
      const permit = await mutex.acquire();

      const result = await terminalizeTurn(deps, {
        mutex,
        permit,
        transactionId: uuidv7(),
        turnId,
        targetChatId: chatId,
        record,
        createdAt: TS,
      });
      if (result instanceof Error) throw new Error(`unexpected error: ${result.message}`);

      expect(result.operations).toHaveLength(1);
      expect(lineCount(chatJsonlPath(chatId))).toBe(3); // header + user + terminal
      expect(managedExists(pageCommentsPath(slug("home")))).toBe(false);
      mutex.release(permit);
    }
  });

  test("orphan-scan idempotency: a second terminalization for the same turn is refused, not duplicated", async () => {
    const chatId = uuidv7();
    const turnId = uuidv7();
    seedChatWithUserRecord(chatId, turnId);
    const deps = wrapperDeps();
    const mutex = createWriteMutex();

    const firstPermit = await mutex.acquire();
    const first = await terminalizeTurn(deps, {
      mutex,
      permit: firstPermit,
      transactionId: uuidv7(),
      turnId,
      targetChatId: chatId,
      record: errorRecord(turnId, "interrupted"),
      createdAt: TS,
    });
    if (first instanceof Error) throw new Error(`unexpected error: ${first.message}`);
    mutex.release(firstPermit);

    const secondPermit = await mutex.acquire();
    const second = await terminalizeTurn(deps, {
      mutex,
      permit: secondPermit,
      transactionId: uuidv7(),
      turnId,
      targetChatId: chatId,
      record: errorRecord(turnId, "interrupted"),
      createdAt: TS,
    });

    expect(second).toBeInstanceOf(TurnAlreadyTerminalError);
    expect(lineCount(chatJsonlPath(chatId))).toBe(3); // header + user + ONE terminal record, never two
  });

  test("rejects a turnId that has no user record in the target chat (a cross-chat mistake)", async () => {
    const chatId = uuidv7();
    const wrongTurnId = uuidv7(); // never admitted into this chat
    seedChatHeader(chatId);
    const deps = wrapperDeps();
    const mutex = createWriteMutex();
    const permit = await mutex.acquire();

    const result = await terminalizeTurn(deps, {
      mutex,
      permit,
      transactionId: uuidv7(),
      turnId: wrongTurnId,
      targetChatId: chatId,
      record: errorRecord(wrongTurnId, "interrupted"),
      createdAt: TS,
    });

    expect(result).toBeInstanceOf(TurnRecordNotFoundError);
    expect(lineCount(chatJsonlPath(chatId))).toBe(1); // header only — nothing written
    expect(fs.existsSync(path.join(termcraftDir, "transactions.local"))).toBe(false); // rejected before any journal write
  });
});

// ==========================================================================================
// project-mutation
// ==========================================================================================

describe("runProjectMutation", () => {
  test("runs a caller-built replace operation under kind project-mutation", async () => {
    const manifest: ProjectManifest = {
      formatVersion: 1,
      projectId: PROJECT_ID,
      name: "new project",
      createdAt: TS,
      targetStack: "generic",
      pages: [],
    };
    const bytes = bytesOf(encodeProjectManifest(manifest));
    const payloadId = uuidv7();
    const operation: TransactionOperation = {
      index: 0,
      target: PROJECT_MANIFEST_FILENAME,
      mode: "replace",
      oldImage: { state: "absent" },
      newImage: { state: "file", sha256: sha256Hex(bytes), size: bytes.byteLength },
      payloadId,
    };

    const deps = wrapperDeps();
    const mutex = createWriteMutex();
    const permit = await mutex.acquire();

    const result = await runProjectMutation(deps, {
      mutex,
      permit,
      transactionId: uuidv7(),
      actionId: uuidv7(),
      mutationKind: "project-creation",
      operations: [operation],
      payloads: new Map([[payloadId, bytes]]),
      createdAt: TS,
    });
    if (result instanceof Error) throw new Error(`unexpected error: ${result.message}`);

    expect(textOf(readManaged(PROJECT_MANIFEST_FILENAME))).toBe(encodeProjectManifest(manifest));
  });

  test("buildStandalonePinEventOperation + runProjectMutation lands a standalone pin:created event", async () => {
    const home = slug("home");
    seedPinsFile(home, []); // the page (and its empty comments log) already exists
    const deps = wrapperDeps();

    const built = buildStandalonePinEventOperation(deps, {
      pageSlug: home,
      event: {
        kind: "pin:created",
        recordId: uuidv7(),
        pinId: uuidv7(),
        element: "cpu-gauge",
        fx: 0.2,
        fy: 0.8,
        text: "note",
        ts: TS,
      },
    });
    if (built instanceof Error) throw new Error(`unexpected error: ${built.message}`);

    const mutex = createWriteMutex();
    const permit = await mutex.acquire();
    const result = await runProjectMutation(deps, {
      mutex,
      permit,
      transactionId: uuidv7(),
      actionId: uuidv7(),
      mutationKind: "pin-event",
      operations: [built.operation],
      payloads: built.payloads,
      createdAt: TS,
    });
    if (result instanceof Error) throw new Error(`unexpected error: ${result.message}`);

    expect(lineCount(pageCommentsPath(home))).toBe(2); // header + the created event
    expect(textOf(readManaged(pageCommentsPath(home)))).toContain('"kind":"pin:created"');
  });
});

// ==========================================================================================
// RestoreTransaction / ExportPublishTransaction / MigrationTransaction — infrastructure smoke
// ==========================================================================================

describe("buildRestoreTransaction (infrastructure only — no MVP caller)", () => {
  test("replaces the canonical source and appends exactly one system:restore record", async () => {
    const chatId = uuidv7();
    const home = slug("home");
    const restoreActionId = uuidv7();
    seedChatHeader(chatId);

    const bytes = bytesOf("restored content\n");
    const payloadId = uuidv7();
    const sourceOperation: TransactionOperation = {
      index: 0,
      target: canonicalPagePath(home),
      mode: "replace",
      oldImage: { state: "absent" },
      newImage: { state: "file", sha256: sha256Hex(bytes), size: bytes.byteLength },
      payloadId,
      releaseAfterApplied: true,
    };
    const chatRecord: ChatSystemRestoreRecord = {
      kind: "system:restore",
      recordId: uuidv7(),
      restoreActionId,
      pageSlug: home,
      sourceCommit: "a".repeat(40),
      ts: TS,
    };

    const deps = wrapperDeps();
    const mutex = createWriteMutex();
    const permit = await mutex.acquire();

    const result = await buildRestoreTransaction(deps, {
      mutex,
      permit,
      transactionId: uuidv7(),
      restoreActionId,
      targetChatId: chatId,
      pageSlug: home,
      sourceOperation,
      sourcePayload: bytes,
      chatRecord,
      createdAt: TS,
    });
    if (result instanceof Error) throw new Error(`unexpected error: ${result.message}`);

    expect(result.operations).toHaveLength(2);
    expect(readManaged(canonicalPagePath(home))).toEqual(bytes);
    expect(lineCount(chatJsonlPath(chatId))).toBe(2); // header + the one restore record
  });
});

describe("buildExportPublishTransaction (infrastructure only — no MVP caller)", () => {
  test("runs caller-built operations under kind export-publish", async () => {
    const bytes = bytesOf("{}\n");
    const payloadId = uuidv7();
    const operation: TransactionOperation = {
      index: 0,
      target: "export/generations/0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d10/pages/home.tsx",
      mode: "replace",
      oldImage: { state: "absent" },
      newImage: { state: "file", sha256: sha256Hex(bytes), size: bytes.byteLength },
      payloadId,
    };

    const deps = wrapperDeps();
    const mutex = createWriteMutex();
    const permit = await mutex.acquire();

    const result = await buildExportPublishTransaction(deps, {
      mutex,
      permit,
      transactionId: uuidv7(),
      generationId: "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d10",
      operations: [operation],
      payloads: new Map([[payloadId, bytes]]),
      createdAt: TS,
    });
    if (result instanceof Error) throw new Error(`unexpected error: ${result.message}`);

    expect(
      readManaged("export/generations/0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5d10/pages/home.tsx"),
    ).toEqual(bytes);
  });
});

describe("buildMigrationTransaction (infrastructure only — no shipped migration exists)", () => {
  test("runs caller-built operations under kind migration", async () => {
    const manifest: ProjectManifest = {
      formatVersion: 1,
      projectId: PROJECT_ID,
      name: "migrated",
      createdAt: TS,
      targetStack: "generic",
      pages: [],
    };
    const bytes = bytesOf(encodeProjectManifest(manifest));
    const payloadId = uuidv7();
    const operation: TransactionOperation = {
      index: 0,
      target: PROJECT_MANIFEST_FILENAME,
      mode: "replace",
      oldImage: { state: "absent" },
      newImage: { state: "file", sha256: sha256Hex(bytes), size: bytes.byteLength },
      payloadId,
    };

    const deps = wrapperDeps();
    const mutex = createWriteMutex();
    const permit = await mutex.acquire();

    const result = await buildMigrationTransaction(deps, {
      mutex,
      permit,
      transactionId: uuidv7(),
      migrationPlanId: uuidv7(),
      migrationActionId: uuidv7(),
      backupManifestDigest: sha256Hex(bytesOf("backup-manifest")),
      operations: [operation],
      payloads: new Map([[payloadId, bytes]]),
      createdAt: TS,
    });
    if (result instanceof Error) throw new Error(`unexpected error: ${result.message}`);

    expect(textOf(readManaged(PROJECT_MANIFEST_FILENAME))).toBe(encodeProjectManifest(manifest));
  });
});
