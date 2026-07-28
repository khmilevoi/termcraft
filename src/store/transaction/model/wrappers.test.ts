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
  PROJECT_MANIFEST_FORMAT_VERSION,
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
  chatJsonlPath,
  designFilePath,
  finalizeTurn,
  pinsJsonlPath,
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
  writeManaged(pinsJsonlPath(pageSlug), concatBytes([headerLine, ...eventLines]));
}

function seedManifest(manifest: ProjectManifest): void {
  writeManaged(PROJECT_MANIFEST_FILENAME, bytesOf(encodeProjectManifest(manifest)));
}

/** A minimal valid `project.toml` — format_version 2 (Task 5): no `pages` field, page order lives in `design/pages.json` instead. */
function defaultManifest(name = "demo"): ProjectManifest {
  return {
    formatVersion: PROJECT_MANIFEST_FORMAT_VERSION,
    projectId: PROJECT_ID,
    name,
    createdAt: TS,
    targetStack: "generic",
  };
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
    designFiles: new Map(),
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
  test("changedFiles: [], exactly one agent record, and no pin resolved even if candidates were passed", async () => {
    const chatId = uuidv7();
    const turnId = uuidv7();
    const home = slug("home");
    seedChatHeader(chatId);
    seedManifest(defaultManifest());

    const deps = wrapperDeps();
    const mutex = createWriteMutex();
    const permit = await mutex.acquire();

    const result = await finalizeTurn(deps, {
      mutex,
      permit,
      transactionId: uuidv7(),
      turnId,
      targetChatId: chatId,
      changedFiles: [],
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
      // home's CLOSURE did change — proves the gate below is the empty FILE diff, not this set.
      changedPageSlugs: [home],
      readSet: emptyReadSet(chatId),
      createdAt: TS,
    });
    if (result instanceof Error) throw new Error(`unexpected error: ${result.message}`);

    expect(result.operations).toHaveLength(1); // only the agent record
    expect(lineCount(chatJsonlPath(chatId))).toBe(2); // header + the one agent record
    expect(managedExists(pinsJsonlPath(home))).toBe(false); // the pin candidate's page was never touched
  });
});

describe("finalizeTurn — full successful finalization", () => {
  test("design files (sorted by tree-relative path), workspace-local switch, agent record, then pin resolution — in that order", async () => {
    const chatId = uuidv7();
    const turnId = uuidv7();
    const home = slug("home");
    const about = slug("about");
    const pinId = uuidv7();
    const homeRelPath = "pages/home.tsx";
    const aboutRelPath = "pages/about.tsx";

    seedChatHeader(chatId);
    writeManaged(designFilePath(homeRelPath), bytesOf("export default function Home() {}\n"));
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
    seedManifest(defaultManifest());
    const manifestBytesBefore = readManaged(PROJECT_MANIFEST_FILENAME);

    const readSet: TurnReadSet = {
      manifest: fileImageOf(PROJECT_MANIFEST_FILENAME),
      designFiles: new Map([
        [homeRelPath, fileImageOf(designFilePath(homeRelPath))],
        [aboutRelPath, fileImageOf(designFilePath(aboutRelPath))], // expected-absent: about does not exist yet
      ]),
      chat: appendBaseOf(chatJsonlPath(chatId)),
      pins: new Map([[home, appendBaseOf(pinsJsonlPath(home))]]),
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
      changedFiles: [
        { relPath: homeRelPath, change: "replace", newBytes: newHomeBytes },
        { relPath: aboutRelPath, change: "replace", newBytes: newAboutBytes },
      ],
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
      changedPageSlugs: [about, home],
      readSet,
      createdAt: TS,
    });
    if (result instanceof Error) throw new Error(`unexpected error: ${result.message}`);

    // "pages/about.tsx"(0) < "pages/home.tsx"(1) by sorted relPath — no manifest op any more
    // (project.toml carries no page order, Task 5) — then workspace-local(2), agent(3), pins(4).
    expect(result.operations.map((op) => op.index)).toEqual([0, 1, 2, 3, 4]);
    expect(readManaged(designFilePath(aboutRelPath))).toEqual(newAboutBytes);
    expect(readManaged(designFilePath(homeRelPath))).toEqual(newHomeBytes);

    // project.toml is NOT rewritten by a turn any more — page order lives in the tree.
    expect(readManaged(PROJECT_MANIFEST_FILENAME)).toEqual(manifestBytesBefore);

    const workspaceNow = decodeWorkspaceLocalState(textOf(readManaged("workspace.local.toml")));
    if (workspaceNow instanceof Error) throw new Error(`unexpected error: ${workspaceNow.message}`);
    expect(workspaceNow.activePageSlug).toBe(about);

    expect(lineCount(chatJsonlPath(chatId))).toBe(2); // header + the one agent record
    expect(lineCount(pinsJsonlPath(home))).toBe(3); // header + pin:created + pin:status resolved
    expect(textOf(readManaged(pinsJsonlPath(home)))).toContain('"status":"resolved"');
  });

  test("writes tree files under design/ and resolves pins under pins/, including a brand-new file and a no-op delete of an already-absent one", async () => {
    const chatId = uuidv7();
    const turnId = uuidv7();
    const home = slug("home");
    seedChatHeader(chatId);
    seedManifest(defaultManifest());
    writeManaged("design/pages.json", bytesOf('{"schemaVersion":1,"pages":[]}\n'));
    writeManaged(designFilePath("pages/home.tsx"), bytesOf("export default function Home() {}\n"));
    const manifestBytesBefore = readManaged(PROJECT_MANIFEST_FILENAME);

    const homeV2 = bytesOf(
      'export default function Home() { return <Gauge color="red" /> }\n',
    );
    const themeBytes = bytesOf("export const theme = { accent: 'red' };\n");

    const readSet: TurnReadSet = {
      manifest: fileImageOf(PROJECT_MANIFEST_FILENAME),
      designFiles: new Map([
        ["pages.json", fileImageOf("design/pages.json")],
        ["pages/home.tsx", fileImageOf(designFilePath("pages/home.tsx"))],
        ["lib/theme.ts", fileImageOf(designFilePath("lib/theme.ts"))], // expected-absent
      ]),
      chat: appendBaseOf(chatJsonlPath(chatId)),
      pins: new Map(),
    };

    const deps = wrapperDeps();
    const mutex = createWriteMutex();
    const permit = await mutex.acquire();

    const result = await finalizeTurn(deps, {
      mutex,
      permit,
      transactionId: uuidv7(),
      turnId,
      targetChatId: chatId,
      changedFiles: [
        { relPath: "pages/home.tsx", change: "replace", newBytes: homeV2 },
        { relPath: "lib/theme.ts", change: "replace", newBytes: themeBytes },
        { relPath: "pages/gone.tsx", change: "delete" }, // never existed — a legal no-op delete
      ],
      agentRecord: agentRecord(turnId, [home]),
      resolvedPins: [],
      changedPageSlugs: [home],
      readSet,
      createdAt: TS,
    });
    if (result instanceof Error) throw new Error(`unexpected error: ${result.message}`);

    expect(readManaged(designFilePath("pages/home.tsx"))).toEqual(homeV2);
    expect(readManaged(designFilePath("lib/theme.ts"))).toEqual(themeBytes);
    expect(managedExists(designFilePath("pages/gone.tsx"))).toBe(false);
    expect(managedExists(PROJECT_MANIFEST_FILENAME)).toBe(true);
    // project.toml is NOT rewritten by a turn any more — page order lives in the tree.
    expect(readManaged(PROJECT_MANIFEST_FILENAME)).toEqual(manifestBytesBefore);
  });
});

describe("finalizeTurn — mandatory pre-intent CAS (§7.5)", () => {
  test("design file drift yields a typed source_changed error and no overwrite", async () => {
    const chatId = uuidv7();
    const turnId = uuidv7();
    const homeRelPath = "pages/home.tsx";
    seedChatHeader(chatId);
    writeManaged(designFilePath(homeRelPath), bytesOf("original\n"));
    seedManifest(defaultManifest());

    const readSet: TurnReadSet = {
      manifest: fileImageOf(PROJECT_MANIFEST_FILENAME),
      designFiles: new Map([[homeRelPath, fileImageOf(designFilePath(homeRelPath))]]),
      chat: appendBaseOf(chatJsonlPath(chatId)),
      pins: new Map(),
    };

    // A hook (or any external writer) drifts the design source after the read set was captured.
    writeManaged(designFilePath(homeRelPath), bytesOf("hook-mutated\n"));

    const deps = wrapperDeps();
    const mutex = createWriteMutex();
    const permit = await mutex.acquire();

    const result = await finalizeTurn(deps, {
      mutex,
      permit,
      transactionId: uuidv7(),
      turnId,
      targetChatId: chatId,
      changedFiles: [],
      agentRecord: agentRecord(turnId, []),
      resolvedPins: [],
      changedPageSlugs: [],
      readSet,
      createdAt: TS,
    });

    expect(result).toBeInstanceOf(SourceChangedError);
    expect(result instanceof SourceChangedError && result.part).toBe(`design:${homeRelPath}`);
    expect(textOf(readManaged(designFilePath(homeRelPath)))).toBe("hook-mutated\n"); // never overwritten
    expect(lineCount(chatJsonlPath(chatId))).toBe(1); // no agent record was appended
  });

  test("the finalize CAS reports source_changed when any read-set tree file drifted, even a shared module no `changedFiles` entry touches", async () => {
    const chatId = uuidv7();
    const turnId = uuidv7();
    seedChatHeader(chatId);
    seedManifest(defaultManifest());
    writeManaged(designFilePath("lib/theme.ts"), bytesOf("export const theme = { accent: 'blue' };\n"));

    const readSet: TurnReadSet = {
      manifest: fileImageOf(PROJECT_MANIFEST_FILENAME),
      designFiles: new Map([["lib/theme.ts", fileImageOf(designFilePath("lib/theme.ts"))]]),
      chat: appendBaseOf(chatJsonlPath(chatId)),
      pins: new Map(),
    };

    // Drifts after the read set was captured — nothing in `changedFiles` below touches it.
    writeManaged(designFilePath("lib/theme.ts"), bytesOf("export const theme = { accent: 'green' };\n"));

    const deps = wrapperDeps();
    const mutex = createWriteMutex();
    const permit = await mutex.acquire();

    const result = await finalizeTurn(deps, {
      mutex,
      permit,
      transactionId: uuidv7(),
      turnId,
      targetChatId: chatId,
      changedFiles: [{ relPath: "pages/home.tsx", change: "replace", newBytes: bytesOf("x\n") }],
      agentRecord: agentRecord(turnId, []),
      resolvedPins: [],
      changedPageSlugs: [],
      readSet,
      createdAt: TS,
    });

    expect(result).toBeInstanceOf(SourceChangedError);
    expect(result instanceof SourceChangedError && result.part).toBe("design:lib/theme.ts");
    expect(textOf(readManaged(designFilePath("lib/theme.ts")))).toContain("green"); // never overwritten
    expect(managedExists(designFilePath("pages/home.tsx"))).toBe(false); // no partial commit either
  });

  test("a read-set entry for a file no page's closure reaches is still CAS'd — treeRevision covers the whole design/ inventory, not just reachable files", async () => {
    const chatId = uuidv7();
    const turnId = uuidv7();
    seedChatHeader(chatId);
    seedManifest(defaultManifest());
    // An orphaned asset: no page's closure imports it, but it is still part of the tree
    // inventory (and therefore of `treeRevision`) — the CAS must still notice it drifting.
    writeManaged(designFilePath("assets/unused-icon.svg"), bytesOf("<svg/>\n"));

    const readSet: TurnReadSet = {
      manifest: fileImageOf(PROJECT_MANIFEST_FILENAME),
      designFiles: new Map([
        ["assets/unused-icon.svg", fileImageOf(designFilePath("assets/unused-icon.svg"))],
      ]),
      chat: appendBaseOf(chatJsonlPath(chatId)),
      pins: new Map(),
    };

    writeManaged(designFilePath("assets/unused-icon.svg"), bytesOf("<svg class='new'/>\n"));

    const deps = wrapperDeps();
    const mutex = createWriteMutex();
    const permit = await mutex.acquire();

    const result = await finalizeTurn(deps, {
      mutex,
      permit,
      transactionId: uuidv7(),
      turnId,
      targetChatId: chatId,
      changedFiles: [],
      agentRecord: agentRecord(turnId, []),
      resolvedPins: [],
      changedPageSlugs: [],
      readSet,
      createdAt: TS,
    });

    expect(result).toBeInstanceOf(SourceChangedError);
    expect(result instanceof SourceChangedError && result.part).toBe(
      "design:assets/unused-icon.svg",
    );
  });

  test("manifest drift yields a typed source_changed error and no overwrite", async () => {
    const chatId = uuidv7();
    const turnId = uuidv7();
    seedChatHeader(chatId);
    const manifestBefore = defaultManifest("original");
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
      changedFiles: [],
      agentRecord: agentRecord(turnId, []),
      resolvedPins: [],
      changedPageSlugs: [],
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
      changedFiles: [],
      agentRecord: agentRecord(turnId, []),
      resolvedPins: [],
      changedPageSlugs: [],
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
      designFiles: new Map(),
      chat: appendBaseOf(chatJsonlPath(chatId)),
      pins: new Map([[home, appendBaseOf(pinsJsonlPath(home))]]),
    };

    // A concurrent UI action (e.g. a fresh pin) grows the comments log after the read set was captured.
    appendManaged(
      pinsJsonlPath(home),
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
      changedFiles: [],
      agentRecord: agentRecord(turnId, []),
      resolvedPins: [],
      changedPageSlugs: [],
      readSet,
      createdAt: TS,
    });

    expect(result).toBeInstanceOf(StaleError);
    expect(result instanceof StaleError && result.part).toBe(`pins:${home}`);
    expect(lineCount(chatJsonlPath(chatId))).toBe(1);
  });
});

describe("designFilePath / pinsJsonlPath — path helpers", () => {
  test("designFilePath lifts a deeply nested tree-relative path to its project-relative form", () => {
    expect(designFilePath("components/ui/buttons/PrimaryButton.tsx")).toBe(
      "design/components/ui/buttons/PrimaryButton.tsx",
    );
  });

  test("designFilePath's double-prefix case is impossible by construction, not by runtime validation", () => {
    // `designFilePath`'s signature is a plain `string -> string` (no `Error` union), so it has
    // no room to reject a caller-supplied value that already carries the `design/` prefix —
    // demonstrated here by the raw (undesirable) output such a call WOULD produce.
    expect(designFilePath("design/pages/home.tsx")).toBe("design/design/pages/home.tsx");
    // The guarantee instead lives at the data's only real source: `entities/design-tree`'s
    // `entry` field (`model/manifest.ts`'s `entryPathSchema`) and its closure walk
    // (`model/closure.ts`'s `resolveClosure`) both work purely in TREE-relative space and
    // never themselves emit a `design/`-prefixed string, so no legitimate caller of
    // `designFilePath` can produce this input in the first place.
  });

  test("pinsJsonlPath is unaffected by the design-tree migration — still slug-keyed, same value the retired pageCommentsPath produced", () => {
    expect(pinsJsonlPath(slug("home"))).toBe("pins/home.jsonl");
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
      expect(managedExists(pinsJsonlPath(slug("home")))).toBe(false);
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

    expect(lineCount(pinsJsonlPath(home))).toBe(2); // header + the created event
    expect(textOf(readManaged(pinsJsonlPath(home)))).toContain('"kind":"pin:created"');
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
    const homeRelPath = "pages/home.tsx";
    seedChatHeader(chatId);

    const bytes = bytesOf("restored content\n");
    const payloadId = uuidv7();
    const sourceOperation: TransactionOperation = {
      index: 0,
      target: designFilePath(homeRelPath),
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
    expect(readManaged(designFilePath(homeRelPath))).toEqual(bytes);
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
