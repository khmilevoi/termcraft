import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ChatUserRecord } from "entities/chat";
import { parsePageSlug } from "entities/page";
import type { PageSlug } from "entities/page";
import type { PinCreatedEvent } from "entities/pin";
import { uuidv7 } from "infrastructure/uuid";
import {
  buildChatAppend,
  buildPinAppend,
  computeAfterImage,
  encodeChatHeaderLine,
  encodeChatRecordLine,
  encodeCommentsHeaderLine,
  sha256Hex,
} from "store/jsonl";
import type { AppendBase, AppendBuilderDeps } from "store/jsonl";
import { DataFormatTooNewError as MigrationDataFormatTooNewError } from "store/migration";
import {
  PROJECT_MANIFEST_FILENAME,
  WORKSPACE_STATE_FILENAME,
  defaultWorkspaceLocalState,
  encodeProjectManifest,
  encodeWorkspaceLocalState,
} from "store/toml";
import type { ProjectManifest } from "store/toml";
import {
  CRASH_EXIT_CODE,
  JournalTooNewError,
  canonicalPagePath,
  chatJsonlPath,
  computePlanHash,
  encodeCanonicalJson,
  intentPath,
  pageCommentsPath,
  payloadPath,
  planPath,
  runCrashCase,
} from "store/transaction";
import type {
  ChildPayload,
  FileImage,
  TransactionBoundary,
  TransactionOperation,
  TransactionPlan,
} from "store/transaction";

import type { StoreDeps } from "../types";
import { JsonlOpenError, ProjectAlreadyExistsError, createStore, nodeStoreDeps } from "./factory";

// Integration coverage for the existing-project launch sequence (storage-identity §14.1 /
// turn-durability §12), in this exact order: lease -> durability adapter + SafeProjectFs ->
// journal format -> recover transactions -> migrations -> schemas -> orphan turn scan ->
// load stores -> open. Each ordering claim is proven by an OBSERVABLE effect a wrong order
// could not produce (never by reading the implementation's control flow). Plus a
// crash-injection sweep (reusing T14's `runCrashCase` harness) across one-file-replace,
// multi-page-finalization, chat-append, pin-append, local-state-update, and the
// infra-only export/migration operation shapes.

const TS = "2026-07-20T10:00:00Z";

const scratchRoots: string[] = [];

function freshScratch(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratchRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratchRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function testDeps(userStateRoot: string): StoreDeps {
  return nodeStoreDeps({ userStateRoot });
}

function absOf(termcraftDir: string, relPath: string): string {
  return path.join(termcraftDir, ...relPath.split("/"));
}

function writeManaged(termcraftDir: string, relPath: string, bytes: Uint8Array): void {
  const abs = absOf(termcraftDir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);
}

function slug(value: string): PageSlug {
  const parsed = parsePageSlug(value);
  if (parsed instanceof Error) throw new Error(`fixture bug: ${parsed.message}`);
  return parsed;
}

// ---- ordering proofs ------------------------------------------------------------------

describe("openProject — existing-project launch ordering (storage-identity §14.1 / turn-durability §12)", () => {
  test("recover transactions runs before schemas: a leftover intended-but-uncommitted transaction is rolled forward and the manifest reflects the ROLLED-FORWARD state, not the stale one", async () => {
    const userStateRoot = freshScratch("tc-launch-userstate-");
    const projectRoot = freshScratch("tc-launch-recover-");
    const deps = testDeps(userStateRoot);
    const store = createStore(deps);

    const created = await store.createProject({
      root: projectRoot,
      name: "Original",
      targetStack: "generic",
    });
    if (created instanceof Error) throw new Error(`fixture bug: ${created.message}`);
    const originalManifest = await created.manifest.read();
    if (originalManifest instanceof Error)
      throw new Error(`fixture bug: ${originalManifest.message}`);
    await created.close();

    const termcraftDir = path.join(projectRoot, ".termcraft");

    // Plant a stray transaction: valid plan + valid intent, no committed.json — exactly
    // turn-durability §4.6's "roll forward" branch.
    const oldBytes = new Uint8Array(
      fs.readFileSync(absOf(termcraftDir, PROJECT_MANIFEST_FILENAME)),
    );
    const oldImage: FileImage = {
      state: "file",
      sha256: sha256Hex(oldBytes),
      size: oldBytes.byteLength,
    };
    const recoveredManifest: ProjectManifest = { ...originalManifest, name: "Recovered Name" };
    const newBytes = new TextEncoder().encode(encodeProjectManifest(recoveredManifest));
    const payloadId = uuidv7();
    const transactionId = uuidv7();

    const plan: TransactionPlan = {
      journalVersion: 1,
      transactionId,
      kind: "project-mutation",
      domain: { actionId: uuidv7(), mutationKind: "title-edit" },
      createdAt: TS,
      operations: [
        {
          index: 0,
          target: PROJECT_MANIFEST_FILENAME,
          mode: "replace",
          oldImage,
          newImage: { state: "file", sha256: sha256Hex(newBytes), size: newBytes.byteLength },
          payloadId,
        },
      ],
    };
    writeManaged(termcraftDir, planPath(transactionId), encodeCanonicalJson(plan));
    writeManaged(termcraftDir, payloadPath(transactionId, payloadId), newBytes);
    writeManaged(
      termcraftDir,
      intentPath(transactionId),
      encodeCanonicalJson({ planHash: computePlanHash(plan) }),
    );

    const reopened = await store.openProject(projectRoot);
    if (reopened instanceof Error) throw new Error(`openProject failed: ${reopened.message}`);
    try {
      // `alreadyComplete: 1` is `createProject`'s own committed transaction, re-scanned and
      // recognized as already complete — the planted leftover is the `recovered: 1`.
      expect(reopened.recovery).toEqual({
        ok: true,
        recovered: 1,
        discarded: 0,
        alreadyComplete: 1,
      });

      // If schemas had run before recovery, this would still read "Original".
      const manifest = await reopened.manifest.read();
      if (manifest instanceof Error) throw new Error(`fixture bug: ${manifest.message}`);
      expect(manifest.name).toBe("Recovered Name");

      const onDisk = fs.readFileSync(absOf(termcraftDir, PROJECT_MANIFEST_FILENAME), "utf8");
      expect(onDisk).toBe(encodeProjectManifest(recoveredManifest));
    } finally {
      await reopened.close();
    }
  }, 20_000);

  test("the migrations gate fires before schemas: a too-new format_version is reported as DataFormatTooNewError (store/migration), not the schemas step's own ManifestTooNewError", async () => {
    const userStateRoot = freshScratch("tc-launch-userstate-");
    const projectRoot = freshScratch("tc-launch-migrations-");
    const deps = testDeps(userStateRoot);
    const store = createStore(deps);

    const created = await store.createProject({
      root: projectRoot,
      name: "Original",
      targetStack: "generic",
    });
    if (created instanceof Error) throw new Error(`fixture bug: ${created.message}`);
    await created.close();

    const termcraftDir = path.join(projectRoot, ".termcraft");
    const manifestPath = absOf(termcraftDir, PROJECT_MANIFEST_FILENAME);
    const bumped = fs
      .readFileSync(manifestPath, "utf8")
      .replace("format_version = 1", "format_version = 2");
    fs.writeFileSync(manifestPath, bumped);

    const reopened = await store.openProject(projectRoot);
    expect(reopened instanceof Error).toBe(true);
    expect(MigrationDataFormatTooNewError.is(reopened)).toBe(true);
  }, 20_000);

  test("a hard journal_too_new transaction blocks the whole launch, and the lease is still released for a later attempt", async () => {
    const userStateRoot = freshScratch("tc-launch-userstate-");
    const projectRoot = freshScratch("tc-launch-journal-too-new-");
    const deps = testDeps(userStateRoot);
    const store = createStore(deps);

    const created = await store.createProject({
      root: projectRoot,
      name: "Original",
      targetStack: "generic",
    });
    if (created instanceof Error) throw new Error(`fixture bug: ${created.message}`);
    await created.close();

    const termcraftDir = path.join(projectRoot, ".termcraft");
    const transactionId = uuidv7();
    writeManaged(
      termcraftDir,
      planPath(transactionId),
      new TextEncoder().encode(JSON.stringify({ journalVersion: 2 })),
    );

    const first = await store.openProject(projectRoot);
    expect(first instanceof Error).toBe(true);
    expect(JournalTooNewError.is(first)).toBe(true);

    // A second attempt reaches the SAME journal_too_new failure rather than a LeaseHeldError
    // — proof the first attempt released the lease even though a later step failed.
    const second = await store.openProject(projectRoot);
    expect(second instanceof Error).toBe(true);
    expect(JournalTooNewError.is(second)).toBe(true);
  }, 20_000);

  test("createProject durably writes transactions.local/format.json at the current journal version (storage-identity §3.1, blocker finding #1)", async () => {
    const userStateRoot = freshScratch("tc-launch-userstate-");
    const projectRoot = freshScratch("tc-launch-format-json-");
    const deps = testDeps(userStateRoot);
    const store = createStore(deps);

    const created = await store.createProject({
      root: projectRoot,
      name: "Original",
      targetStack: "generic",
    });
    if (created instanceof Error) throw new Error(`fixture bug: ${created.message}`);
    await created.close();

    const termcraftDir = path.join(projectRoot, ".termcraft");
    const bytes = fs.readFileSync(absOf(termcraftDir, "transactions.local/format.json"), "utf8");
    expect(JSON.parse(bytes)).toEqual({ journalVersion: 1 });
  }, 20_000);

  test("a transactions.local/format.json naming a journalVersion newer than the binary blocks the whole launch — even when a transaction directory has no readable plan.json (blocker finding #1)", async () => {
    const userStateRoot = freshScratch("tc-launch-userstate-");
    const projectRoot = freshScratch("tc-launch-journal-format-too-new-");
    const deps = testDeps(userStateRoot);
    const store = createStore(deps);

    const created = await store.createProject({
      root: projectRoot,
      name: "Original",
      targetStack: "generic",
    });
    if (created instanceof Error) throw new Error(`fixture bug: ${created.message}`);
    await created.close();

    const termcraftDir = path.join(projectRoot, ".termcraft");
    // Bump the WHOLE-JOURNAL format — distinct from the per-plan `journalVersion` field the
    // "hard journal_too_new transaction" test above exercises.
    fs.writeFileSync(
      absOf(termcraftDir, "transactions.local/format.json"),
      JSON.stringify({ journalVersion: 2 }),
    );

    // A future binary's incompatible layout: a transaction directory that does NOT contain a
    // readable plan.json at all (the finding's exact failing scenario — "no plan.json, or a
    // renamed marker set"). Before this fix, `classifyTransaction` would read `plan===null`,
    // fall through to "discard", and `recoverOneTransaction` would `rmSync` this directory.
    const futureTxId = "0190fc4a-8b5c-7d3e-8a91-6f2e4c7b5dff";
    const futureTxDir = absOf(termcraftDir, `transactions.local/${futureTxId}`);
    fs.mkdirSync(futureTxDir, { recursive: true });
    fs.writeFileSync(
      path.join(futureTxDir, "unknown-v2-marker.json"),
      JSON.stringify({ someFutureShape: true }),
    );

    const first = await store.openProject(projectRoot);
    expect(first instanceof Error).toBe(true);
    expect(JournalTooNewError.is(first)).toBe(true);

    // Never touched by a discard — the format gate fires before `transactions.local/` is ever
    // listed, so the unrecognized directory survives byte-for-byte.
    expect(fs.existsSync(futureTxDir)).toBe(true);
    expect(fs.existsSync(path.join(futureTxDir, "unknown-v2-marker.json"))).toBe(true);

    // A second attempt reaches the SAME journal_too_new failure rather than a LeaseHeldError —
    // proof the first attempt released the lease even though this step failed (mirrors the
    // per-plan journal_too_new test's own lease-release proof above).
    const second = await store.openProject(projectRoot);
    expect(second instanceof Error).toBe(true);
    expect(JournalTooNewError.is(second)).toBe(true);
  }, 20_000);

  test("the orphan turn scan runs as part of open: a user turn with no terminal record is terminalized, and the result is visible on the opened chat", async () => {
    const userStateRoot = freshScratch("tc-launch-userstate-");
    const projectRoot = freshScratch("tc-launch-orphan-");
    const deps = testDeps(userStateRoot);
    const store = createStore(deps);

    const created = await store.createProject({
      root: projectRoot,
      name: "Original",
      targetStack: "generic",
    });
    if (created instanceof Error) throw new Error(`fixture bug: ${created.message}`);
    const manifest = await created.manifest.read();
    if (manifest instanceof Error) throw new Error(`fixture bug: ${manifest.message}`);
    const chatFiles = fs.readdirSync(absOf(path.join(projectRoot, ".termcraft"), "chats"));
    const chatId = chatFiles[0]?.replace(/\.jsonl$/, "");
    if (chatId === undefined) throw new Error("fixture bug: no chat file");
    await created.close();

    const termcraftDir = path.join(projectRoot, ".termcraft");
    const turnId = uuidv7();
    const userRecord: ChatUserRecord = {
      kind: "user",
      recordId: uuidv7(),
      turnId,
      text: "hello",
      ts: TS,
    };
    const userLine = encodeChatRecordLine(userRecord);
    if (userLine instanceof Error) throw new Error(`fixture bug: ${userLine.message}`);
    fs.appendFileSync(absOf(termcraftDir, chatJsonlPath(chatId)), userLine);

    const reopened = await store.openProject(projectRoot);
    if (reopened instanceof Error) throw new Error(`openProject failed: ${reopened.message}`);
    try {
      expect(reopened.orphanTurns).toEqual([{ chatId, turnId, terminalized: true }]);

      const handle = await reopened.chats.open(chatId);
      if (handle instanceof Error) throw new Error(`fixture bug: ${handle.message}`);
      const tail = await handle.loadTail();
      if (tail instanceof Error) throw new Error(`fixture bug: ${tail.message}`);
      const terminal = tail.records.find(
        (record) => record.kind === "system:error" && record.turnId === turnId,
      );
      expect(terminal).toBeDefined();
      if (terminal !== undefined && terminal.kind === "system:error") {
        expect(terminal.outcome).toBe("interrupted");
      }
    } finally {
      await reopened.close();
    }
  }, 20_000);

  test("load stores + open: every port on the returned handle is present and minimally functional", async () => {
    const userStateRoot = freshScratch("tc-launch-userstate-");
    const projectRoot = freshScratch("tc-launch-smoke-");
    const deps = testDeps(userStateRoot);
    const store = createStore(deps);

    const created = await store.createProject({
      root: projectRoot,
      name: "Smoke",
      targetStack: "generic",
    });
    if (created instanceof Error) throw new Error(`fixture bug: ${created.message}`);
    await created.close();

    const reopened = await store.openProject(projectRoot);
    if (reopened instanceof Error) throw new Error(`openProject failed: ${reopened.message}`);
    try {
      // `alreadyComplete: 1` is `createProject`'s own committed transaction, re-scanned and
      // recognized as already complete (turn-durability §4.6: "recognize complete, do not
      // compare targets") on this later launch.
      expect(reopened.recovery).toEqual({
        ok: true,
        recovered: 0,
        discarded: 0,
        alreadyComplete: 1,
      });
      expect(reopened.orphanTurns).toEqual([]);

      const manifest = await reopened.manifest.read();
      if (manifest instanceof Error) throw new Error(`fixture bug: ${manifest.message}`);
      expect(manifest.name).toBe("Smoke");

      const workspace = await reopened.workspaceState.read();
      if (workspace instanceof Error) throw new Error(`fixture bug: ${workspace.message}`);
      expect(workspace.state).toEqual(defaultWorkspaceLocalState());

      const slugs = await reopened.pages.listSlugs();
      if (slugs instanceof Error) throw new Error(`fixture bug: ${slugs.message}`);
      expect(slugs).toEqual([]);

      const subject = await reopened.trust.buildSubject(projectRoot, manifest.projectId, null);
      if (subject instanceof Error) throw new Error(`fixture bug: ${subject.message}`);
      expect(await reopened.trust.isGranted(subject)).toBe(true);

      expect(
        await reopened.projections.pageMetaGet({
          pageSlug: "home",
          sourceHash: sha256Hex(new Uint8Array()),
          extractorVersion: 1,
        }),
      ).toBeNull();
      expect(reopened.migrations.chain).toEqual([]);
    } finally {
      await reopened.close();
    }
  }, 20_000);

  test("openProject on a root with no .termcraft layout fails rather than fabricating an empty project", async () => {
    const userStateRoot = freshScratch("tc-launch-userstate-");
    const projectRoot = freshScratch("tc-launch-missing-");
    const deps = testDeps(userStateRoot);
    const store = createStore(deps);

    const result = await store.openProject(projectRoot);
    expect(result instanceof Error).toBe(true);
  }, 20_000);

  test("createProject still refuses an existing layout even after a successful openProject/close cycle", async () => {
    const userStateRoot = freshScratch("tc-launch-userstate-");
    const projectRoot = freshScratch("tc-launch-recreate-");
    const deps = testDeps(userStateRoot);
    const store = createStore(deps);

    const created = await store.createProject({
      root: projectRoot,
      name: "Once",
      targetStack: "generic",
    });
    if (created instanceof Error) throw new Error(`fixture bug: ${created.message}`);
    await created.close();

    const reopened = await store.openProject(projectRoot);
    if (reopened instanceof Error) throw new Error(`fixture bug: ${reopened.message}`);
    await reopened.close();

    const recreated = await store.createProject({
      root: projectRoot,
      name: "Twice",
      targetStack: "generic",
    });
    expect(ProjectAlreadyExistsError.is(recreated)).toBe(true);
  }, 20_000);
});

// ---- identity checks (storage-identity §5.2, major finding #2) ---------------------------
// "The chat filename must equal the chatId in its header. A chat header's projectId must
// equal project.toml. A comments header's projectId and pageSlug must equal its containing
// project and directory. Mismatch is corruption; readers do not repair identity by renaming
// files or rewriting headers."

describe("identity checks (storage-identity §5.2)", () => {
  test("ChatStore.open refuses a chat whose header names a different chatId than its filename", async () => {
    const userStateRoot = freshScratch("tc-launch-userstate-");
    const projectRoot = freshScratch("tc-launch-identity-chat-id-");
    const deps = testDeps(userStateRoot);
    const store = createStore(deps);

    const created = await store.createProject({
      root: projectRoot,
      name: "Original",
      targetStack: "generic",
    });
    if (created instanceof Error) throw new Error(`fixture bug: ${created.message}`);
    const manifest = await created.manifest.read();
    if (manifest instanceof Error) throw new Error(`fixture bug: ${manifest.message}`);
    const termcraftDir = path.join(projectRoot, ".termcraft");
    const chatFiles = fs.readdirSync(absOf(termcraftDir, "chats"));
    const chatId = chatFiles[0]?.replace(/\.jsonl$/, "");
    if (chatId === undefined) throw new Error("fixture bug: no chat file");
    await created.close();

    // Same filename, but the header now names a DIFFERENT chatId — e.g. a chat log restored
    // or copied from elsewhere onto this filename.
    const otherChatId = uuidv7();
    const tamperedHeader = encodeChatHeaderLine({
      kind: "chat",
      formatVersion: 1,
      projectId: manifest.projectId,
      chatId: otherChatId,
      createdAt: TS,
    });
    if (tamperedHeader instanceof Error) throw new Error(`fixture bug: ${tamperedHeader.message}`);
    fs.writeFileSync(absOf(termcraftDir, chatJsonlPath(chatId)), tamperedHeader);

    const reopened = await store.openProject(projectRoot);
    if (reopened instanceof Error) throw new Error(`openProject failed: ${reopened.message}`);
    try {
      const handle = await reopened.chats.open(chatId);
      expect(handle).toBeInstanceOf(JsonlOpenError);
    } finally {
      await reopened.close();
    }
  }, 20_000);

  test("ChatStore.open refuses a chat whose header names a different projectId than project.toml", async () => {
    const userStateRoot = freshScratch("tc-launch-userstate-");
    const projectRoot = freshScratch("tc-launch-identity-chat-project-");
    const deps = testDeps(userStateRoot);
    const store = createStore(deps);

    const created = await store.createProject({
      root: projectRoot,
      name: "Original",
      targetStack: "generic",
    });
    if (created instanceof Error) throw new Error(`fixture bug: ${created.message}`);
    const termcraftDir = path.join(projectRoot, ".termcraft");
    const chatFiles = fs.readdirSync(absOf(termcraftDir, "chats"));
    const chatId = chatFiles[0]?.replace(/\.jsonl$/, "");
    if (chatId === undefined) throw new Error("fixture bug: no chat file");
    await created.close();

    const otherProjectId = uuidv7();
    const tamperedHeader = encodeChatHeaderLine({
      kind: "chat",
      formatVersion: 1,
      projectId: otherProjectId,
      chatId,
      createdAt: TS,
    });
    if (tamperedHeader instanceof Error) throw new Error(`fixture bug: ${tamperedHeader.message}`);
    fs.writeFileSync(absOf(termcraftDir, chatJsonlPath(chatId)), tamperedHeader);

    const reopened = await store.openProject(projectRoot);
    if (reopened instanceof Error) throw new Error(`openProject failed: ${reopened.message}`);
    try {
      const handle = await reopened.chats.open(chatId);
      expect(handle).toBeInstanceOf(JsonlOpenError);
    } finally {
      await reopened.close();
    }
  }, 20_000);

  test("the orphan turn scan skips (never mutates) a chat file whose header identity does not match its filename — the exact scenario a misplaced/copied chat log produces", async () => {
    const userStateRoot = freshScratch("tc-launch-userstate-");
    const projectRoot = freshScratch("tc-launch-identity-orphan-");
    const deps = testDeps(userStateRoot);
    const store = createStore(deps);

    const created = await store.createProject({
      root: projectRoot,
      name: "Original",
      targetStack: "generic",
    });
    if (created instanceof Error) throw new Error(`fixture bug: ${created.message}`);
    const manifest = await created.manifest.read();
    if (manifest instanceof Error) throw new Error(`fixture bug: ${manifest.message}`);
    await created.close();

    const termcraftDir = path.join(projectRoot, ".termcraft");
    // A second chat file whose HEADER names one chatId (`realChatId`) but whose FILENAME is
    // another (`misplacedFilename`) — exactly "copy chats/<B>.jsonl to chats/<A>.jsonl" from
    // the finding. It carries an orphan `user` record, which — absent the identity check —
    // `scanOrphanTurns` would durably terminalize into this mislabeled file.
    const realChatId = uuidv7();
    const misplacedFilename = uuidv7();
    const headerLine = encodeChatHeaderLine({
      kind: "chat",
      formatVersion: 1,
      projectId: manifest.projectId,
      chatId: realChatId,
      createdAt: TS,
    });
    if (headerLine instanceof Error) throw new Error(`fixture bug: ${headerLine.message}`);
    const orphanTurnId = uuidv7();
    const userRecord: ChatUserRecord = {
      kind: "user",
      recordId: uuidv7(),
      turnId: orphanTurnId,
      text: "hello",
      ts: TS,
    };
    const userLine = encodeChatRecordLine(userRecord);
    if (userLine instanceof Error) throw new Error(`fixture bug: ${userLine.message}`);
    const misplacedBytes = Buffer.concat([Buffer.from(headerLine), Buffer.from(userLine)]);
    writeManaged(termcraftDir, chatJsonlPath(misplacedFilename), misplacedBytes);

    const reopened = await store.openProject(projectRoot);
    if (reopened instanceof Error) throw new Error(`openProject failed: ${reopened.message}`);
    try {
      // Never terminalized, under EITHER id — the scan refused to touch the mislabeled file.
      expect(reopened.orphanTurns.some((o) => o.turnId === orphanTurnId)).toBe(false);
      // The file itself is byte-for-byte untouched — no durable system:error append landed.
      expect(fs.readFileSync(absOf(termcraftDir, chatJsonlPath(misplacedFilename)))).toEqual(
        misplacedBytes,
      );
    } finally {
      await reopened.close();
    }
  }, 20_000);

  test("PinStore.fold refuses a comments log whose header names a different projectId or pageSlug than its containing project/directory", async () => {
    const userStateRoot = freshScratch("tc-launch-userstate-");
    const projectRoot = freshScratch("tc-launch-identity-pins-");
    const deps = testDeps(userStateRoot);
    const store = createStore(deps);

    const created = await store.createProject({
      root: projectRoot,
      name: "Original",
      targetStack: "generic",
    });
    if (created instanceof Error) throw new Error(`fixture bug: ${created.message}`);
    const manifest = await created.manifest.read();
    if (manifest instanceof Error) throw new Error(`fixture bug: ${manifest.message}`);
    await created.close();

    const termcraftDir = path.join(projectRoot, ".termcraft");
    const pageSlug = slug("gamma");

    // Case 1: projectId mismatch.
    const wrongProjectHeader = encodeCommentsHeaderLine({
      kind: "pins",
      formatVersion: 1,
      projectId: uuidv7(),
      pageSlug,
    });
    if (wrongProjectHeader instanceof Error)
      throw new Error(`fixture bug: ${wrongProjectHeader.message}`);
    writeManaged(termcraftDir, pageCommentsPath(pageSlug), wrongProjectHeader);

    const reopenedForProjectCase = await store.openProject(projectRoot);
    if (reopenedForProjectCase instanceof Error)
      throw new Error(`openProject failed: ${reopenedForProjectCase.message}`);
    const projectCaseResult = await reopenedForProjectCase.pins.fold(pageSlug);
    await reopenedForProjectCase.close();
    expect(projectCaseResult).toBeInstanceOf(JsonlOpenError);

    // Case 2: pageSlug mismatch — the header names a DIFFERENT page than the directory it sits in.
    const otherSlug = slug("delta");
    const wrongSlugHeader = encodeCommentsHeaderLine({
      kind: "pins",
      formatVersion: 1,
      projectId: manifest.projectId,
      pageSlug: otherSlug,
    });
    if (wrongSlugHeader instanceof Error)
      throw new Error(`fixture bug: ${wrongSlugHeader.message}`);
    writeManaged(termcraftDir, pageCommentsPath(pageSlug), wrongSlugHeader);

    const reopenedForSlugCase = await store.openProject(projectRoot);
    if (reopenedForSlugCase instanceof Error)
      throw new Error(`openProject failed: ${reopenedForSlugCase.message}`);
    const slugCaseResult = await reopenedForSlugCase.pins.fold(pageSlug);
    await reopenedForSlugCase.close();
    expect(slugCaseResult).toBeInstanceOf(JsonlOpenError);
  }, 20_000);
});

// ---- chat index persistence (projections §7.1/§16.1/§16.3, major finding #3) -------------
// Before this fix, `ChatStore.open` had no `ChatIndexPageStore` implementation that ever
// wrote to disk — every open rebuilt a fresh in-memory index from a full-file read, discarded
// the instant the call returned. These prove the index now survives a project close/reopen.

describe("chat index persistence (projections §7.1, major finding #3)", () => {
  test("the chat index is durably persisted to cache/chat-index/ and survives a full project close/reopen", async () => {
    const userStateRoot = freshScratch("tc-launch-userstate-");
    const projectRoot = freshScratch("tc-launch-chat-index-persist-");
    const deps = testDeps(userStateRoot);
    const store = createStore(deps);

    const created = await store.createProject({
      root: projectRoot,
      name: "Original",
      targetStack: "generic",
    });
    if (created instanceof Error) throw new Error(`fixture bug: ${created.message}`);
    const termcraftDir = path.join(projectRoot, ".termcraft");
    const chatFiles = fs.readdirSync(absOf(termcraftDir, "chats"));
    const chatId = chatFiles[0]?.replace(/\.jsonl$/, "");
    if (chatId === undefined) throw new Error("fixture bug: no chat file");

    // A handful of real records, appended directly to the managed file (no transaction
    // needed — this test only cares about the READ side).
    const recordIds: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const record: ChatUserRecord = {
        kind: "user",
        recordId: uuidv7(),
        turnId: uuidv7(),
        text: `message ${i}`,
        ts: TS,
      };
      recordIds.push(record.recordId);
      const line = encodeChatRecordLine(record);
      if (line instanceof Error) throw new Error(`fixture bug: ${line.message}`);
      fs.appendFileSync(absOf(termcraftDir, chatJsonlPath(chatId)), line);
    }
    await created.close();

    // First open: no cache yet — a cold build. (The orphan turn scan also runs here and
    // terminalizes these 5 now-orphan user records with its own `system:error` appends —
    // expected and irrelevant to this test, so the assertion below filters to `user` kind.)
    const first = await store.openProject(projectRoot);
    if (first instanceof Error) throw new Error(`openProject failed: ${first.message}`);
    try {
      const handle1 = await first.chats.open(chatId);
      if (handle1 instanceof Error) throw new Error(`fixture bug: ${handle1.message}`);
      const tail1 = await handle1.loadTail();
      if (tail1 instanceof Error) throw new Error(`fixture bug: ${tail1.message}`);
      expect(tail1.records.filter((r) => r.kind === "user").map((r) => r.recordId)).toEqual(
        recordIds,
      );
    } finally {
      await first.close();
    }

    // The index landed on disk under this project's OWN cache root — never a portable path.
    const cacheStatePath = path.join(termcraftDir, "cache", "chat-index", chatId, "state.json");
    expect(fs.existsSync(cacheStatePath)).toBe(true);
    const persistedState = JSON.parse(fs.readFileSync(cacheStatePath, "utf8")) as {
      chatId: string;
      generation: number;
    };
    expect(persistedState.chatId).toBe(chatId);
    expect(persistedState.generation).toBe(1);

    // Second open — a FRESH `openProject`, i.e. a full close/reopen cycle (the closest this
    // test harness comes to a process restart). The tail must be byte-identical, proving the
    // persisted cache (not a discarded in-memory rebuild) is what served the read.
    const second = await store.openProject(projectRoot);
    if (second instanceof Error) throw new Error(`openProject failed: ${second.message}`);
    try {
      const handle2 = await second.chats.open(chatId);
      if (handle2 instanceof Error) throw new Error(`fixture bug: ${handle2.message}`);
      const tail2 = await handle2.loadTail();
      if (tail2 instanceof Error) throw new Error(`fixture bug: ${tail2.message}`);
      expect(tail2.records.filter((r) => r.kind === "user").map((r) => r.recordId)).toEqual(
        recordIds,
      );
    } finally {
      await second.close();
    }
  }, 20_000);

  test("re-opening after new records were appended takes the incremental update path (generation stays 1) rather than a fresh rebuild", async () => {
    const userStateRoot = freshScratch("tc-launch-userstate-");
    const projectRoot = freshScratch("tc-launch-chat-index-incremental-");
    const deps = testDeps(userStateRoot);
    const store = createStore(deps);

    const created = await store.createProject({
      root: projectRoot,
      name: "Original",
      targetStack: "generic",
    });
    if (created instanceof Error) throw new Error(`fixture bug: ${created.message}`);
    const termcraftDir = path.join(projectRoot, ".termcraft");
    const chatFiles = fs.readdirSync(absOf(termcraftDir, "chats"));
    const chatId = chatFiles[0]?.replace(/\.jsonl$/, "");
    if (chatId === undefined) throw new Error("fixture bug: no chat file");

    const firstRecord: ChatUserRecord = {
      kind: "user",
      recordId: uuidv7(),
      turnId: uuidv7(),
      text: "first",
      ts: TS,
    };
    const firstLine = encodeChatRecordLine(firstRecord);
    if (firstLine instanceof Error) throw new Error(`fixture bug: ${firstLine.message}`);
    fs.appendFileSync(absOf(termcraftDir, chatJsonlPath(chatId)), firstLine);
    await created.close();

    // The launch's own orphan-turn scan (running INSIDE `openProject`, before this handle is
    // even returned) already terminalizes `firstRecord` here, since it is a fresh orphan.
    const opened1 = await store.openProject(projectRoot);
    if (opened1 instanceof Error) throw new Error(`openProject failed: ${opened1.message}`);
    try {
      const handle1 = await opened1.chats.open(chatId);
      if (handle1 instanceof Error) throw new Error(`fixture bug: ${handle1.message}`);
    } finally {
      await opened1.close();
    }

    const cacheStatePath = path.join(termcraftDir, "cache", "chat-index", chatId, "state.json");
    const stateAfterFirst = JSON.parse(fs.readFileSync(cacheStatePath, "utf8")) as {
      generation: number;
    };
    expect(stateAfterFirst.generation).toBe(1); // the cold build

    // Reopen the project (its own orphan scan finds nothing new — `firstRecord` already has
    // its terminal record) and append a SECOND record directly AFTER that scan has already
    // run, then open the chat once more.
    const opened2 = await store.openProject(projectRoot);
    if (opened2 instanceof Error) throw new Error(`openProject failed: ${opened2.message}`);
    try {
      const secondRecord: ChatUserRecord = {
        kind: "user",
        recordId: uuidv7(),
        turnId: uuidv7(),
        text: "second",
        ts: TS,
      };
      const secondLine = encodeChatRecordLine(secondRecord);
      if (secondLine instanceof Error) throw new Error(`fixture bug: ${secondLine.message}`);
      fs.appendFileSync(absOf(termcraftDir, chatJsonlPath(chatId)), secondLine);

      const handle2 = await opened2.chats.open(chatId);
      if (handle2 instanceof Error) throw new Error(`fixture bug: ${handle2.message}`);
      const tail2 = await handle2.loadTail();
      if (tail2 instanceof Error) throw new Error(`fixture bug: ${tail2.message}`);
      expect(tail2.records.filter((r) => r.kind === "user").map((r) => r.recordId)).toEqual([
        firstRecord.recordId,
        secondRecord.recordId,
      ]);

      const stateAfterSecond = JSON.parse(fs.readFileSync(cacheStatePath, "utf8")) as {
        generation: number;
      };
      // Fast-path append, not a rebuild — the whole point of persisting the cache.
      expect(stateAfterSecond.generation).toBe(1);
    } finally {
      await opened2.close();
    }
  }, 20_000);

  test("a chat spanning more than one scan chunk (>1 MiB) still builds and reads correctly through the disk-backed cold-build path", async () => {
    const userStateRoot = freshScratch("tc-launch-userstate-");
    const projectRoot = freshScratch("tc-launch-chat-index-multichunk-");
    const deps = testDeps(userStateRoot);
    const store = createStore(deps);

    const created = await store.createProject({
      root: projectRoot,
      name: "Original",
      targetStack: "generic",
    });
    if (created instanceof Error) throw new Error(`fixture bug: ${created.message}`);
    const termcraftDir = path.join(projectRoot, ".termcraft");
    const chatFiles = fs.readdirSync(absOf(termcraftDir, "chats"));
    const chatId = chatFiles[0]?.replace(/\.jsonl$/, "");
    if (chatId === undefined) throw new Error("fixture bug: no chat file");

    // ~1500 records of ~800 bytes each — comfortably past the 1 MiB single-chunk boundary
    // `diskChatIndexSource`'s cold-build generator reads (CHAT_INDEX_SCAN_CHUNK_BYTES). All
    // 1500 share ONE turnId, terminated by one trailing agent record for that same turnId —
    // deliberately NOT 1500 distinct turnIds, which would make the launch's orphan-turn scan
    // (unrelated to what this test checks) fire 1500 separate terminalization transactions.
    const sharedTurnId = uuidv7();
    const recordIds: string[] = [];
    const chatPath = absOf(termcraftDir, chatJsonlPath(chatId));
    const chunks: Buffer[] = [];
    for (let i = 0; i < 1500; i += 1) {
      const record: ChatUserRecord = {
        kind: "user",
        recordId: uuidv7(),
        turnId: sharedTurnId,
        text: "x".repeat(700),
        ts: TS,
      };
      recordIds.push(record.recordId);
      const line = encodeChatRecordLine(record);
      if (line instanceof Error) throw new Error(`fixture bug: ${line.message}`);
      chunks.push(Buffer.from(line));
    }
    const terminalLine = encodeChatRecordLine({
      kind: "agent",
      recordId: uuidv7(),
      turnId: sharedTurnId,
      text: "done",
      changedPages: [],
      warnings: [],
      ts: TS,
    });
    if (terminalLine instanceof Error) throw new Error(`fixture bug: ${terminalLine.message}`);
    chunks.push(Buffer.from(terminalLine));
    fs.appendFileSync(chatPath, Buffer.concat(chunks));
    expect(fs.statSync(chatPath).size).toBeGreaterThan(1 * 1024 * 1024);
    await created.close();

    const reopened = await store.openProject(projectRoot);
    if (reopened instanceof Error) throw new Error(`openProject failed: ${reopened.message}`);
    try {
      const handle = await reopened.chats.open(chatId);
      if (handle instanceof Error) throw new Error(`fixture bug: ${handle.message}`);
      const tail = await handle.loadTail(200);
      if (tail instanceof Error) throw new Error(`fixture bug: ${tail.message}`);
      expect(tail.records).toHaveLength(200);
      expect(tail.records[tail.records.length - 1]?.kind).toBe("agent"); // the trailing terminal record
      expect(tail.records.filter((r) => r.kind === "user").map((r) => r.recordId)).toEqual(
        recordIds.slice(-199),
      );
    } finally {
      await reopened.close();
    }
  }, 20_000);
});

// ---- crash-injection sweep: one-file replace, multi-page finalization, chat/pin append, --
// ---- local-state update, and the infra-only export/migration operation shapes ------------

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
function base64Of(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}
function freshTermcraftDir(): string {
  const scratch = freshScratch("tc-launch-crash-");
  const termcraftDir = path.join(scratch, ".termcraft");
  fs.mkdirSync(termcraftDir);
  return termcraftDir;
}

const APPEND_DEPS: AppendBuilderDeps = { newPayloadId: uuidv7 };

interface PlanFixture {
  readonly plan: TransactionPlan;
  readonly payloads: readonly ChildPayload[];
}

/** One-file replace: `project.toml` rewritten in place. */
function oneFileReplacePlan(termcraftDir: string, transactionId: string): PlanFixture {
  const oldBytes = bytesOf(
    encodeProjectManifest({
      formatVersion: 1,
      projectId: uuidv7(),
      name: "Old",
      createdAt: TS,
      targetStack: "generic",
      pages: [],
    }),
  );
  writeManaged(termcraftDir, PROJECT_MANIFEST_FILENAME, oldBytes);
  const newBytes = bytesOf(
    encodeProjectManifest({
      formatVersion: 1,
      projectId: uuidv7(),
      name: "New",
      createdAt: TS,
      targetStack: "generic",
      pages: [],
    }),
  );
  const payloadId = uuidv7();

  const operations: TransactionOperation[] = [
    {
      index: 0,
      target: PROJECT_MANIFEST_FILENAME,
      mode: "replace",
      oldImage: { state: "file", sha256: sha256Hex(oldBytes), size: oldBytes.byteLength },
      newImage: { state: "file", sha256: sha256Hex(newBytes), size: newBytes.byteLength },
      payloadId,
    },
  ];
  return {
    plan: {
      journalVersion: 1,
      transactionId,
      kind: "project-mutation",
      domain: { mutationKind: "title-edit" },
      createdAt: TS,
      operations,
    },
    payloads: [{ payloadId, bytesBase64: base64Of(newBytes) }],
  };
}

/** Multi-page finalization: two canonical pages created at once (turn-durability §7.4's changed-pages step, sorted by slug). */
function multiPageFinalizationPlan(transactionId: string): PlanFixture {
  const slugA = slug("alpha");
  const slugB = slug("beta");
  const bytesA = bytesOf("export default function Alpha() { return null }\n");
  const bytesB = bytesOf("export default function Beta() { return null }\n");
  const payloadA = uuidv7();
  const payloadB = uuidv7();

  const operations: TransactionOperation[] = [
    {
      index: 0,
      target: canonicalPagePath(slugA),
      mode: "replace",
      oldImage: { state: "absent" },
      newImage: { state: "file", sha256: sha256Hex(bytesA), size: bytesA.byteLength },
      payloadId: payloadA,
    },
    {
      index: 1,
      target: canonicalPagePath(slugB),
      mode: "replace",
      oldImage: { state: "absent" },
      newImage: { state: "file", sha256: sha256Hex(bytesB), size: bytesB.byteLength },
      payloadId: payloadB,
    },
  ];
  return {
    plan: {
      journalVersion: 1,
      transactionId,
      kind: "turn",
      domain: { turnId: uuidv7(), phase: "finalization" },
      createdAt: TS,
      operations,
    },
    payloads: [
      { payloadId: payloadA, bytesBase64: base64Of(bytesA) },
      { payloadId: payloadB, bytesBase64: base64Of(bytesB) },
    ],
  };
}

/** Chat append: one `user` record appended after an existing header, via the real `buildChatAppend`. */
function chatAppendPlan(termcraftDir: string, transactionId: string): PlanFixture {
  const chatId = uuidv7();
  const headerLine = encodeChatHeaderLine({
    kind: "chat",
    formatVersion: 1,
    projectId: uuidv7(),
    chatId,
    createdAt: TS,
  });
  if (headerLine instanceof Error) throw new Error(`fixture bug: ${headerLine.message}`);
  writeManaged(termcraftDir, chatJsonlPath(chatId), headerLine);

  const before: AppendBase = { length: headerLine.byteLength, prefixSha256: sha256Hex(headerLine) };
  const record: ChatUserRecord = {
    kind: "user",
    recordId: uuidv7(),
    turnId: uuidv7(),
    text: "hi",
    ts: TS,
  };
  const appended = buildChatAppend({
    before,
    records: [record],
    domainIdentity: record.turnId,
    deps: APPEND_DEPS,
  });
  if (appended instanceof Error) throw new Error(`fixture bug: ${appended.message}`);
  const after = computeAfterImage({
    chunks: [headerLine],
    beforeLength: before.length,
    append: appended.bytes,
  });
  if (after instanceof Error) throw new Error(`fixture bug: ${after.message}`);

  const operations: TransactionOperation[] = [
    {
      index: 0,
      target: chatJsonlPath(chatId),
      mode: "append-jsonl",
      oldImage: { state: "file", sha256: before.prefixSha256, size: before.length },
      newImage: { state: "file", sha256: after.sha256, size: after.size },
      append: appended.descriptor,
    },
  ];
  return {
    plan: {
      journalVersion: 1,
      transactionId,
      kind: "turn",
      domain: { turnId: record.turnId, phase: "admission" },
      createdAt: TS,
      operations,
    },
    payloads: [
      { payloadId: appended.descriptor.appendedPayloadId, bytesBase64: base64Of(appended.bytes) },
    ],
  };
}

/** Pin append: one `pin:created` event appended after an existing comments header, via the real `buildPinAppend`. */
function pinAppendPlan(termcraftDir: string, transactionId: string): PlanFixture {
  const pageSlug = slug("gamma");
  const headerLine = encodeCommentsHeaderLine({
    kind: "pins",
    formatVersion: 1,
    projectId: uuidv7(),
    pageSlug,
  });
  if (headerLine instanceof Error) throw new Error(`fixture bug: ${headerLine.message}`);
  writeManaged(termcraftDir, pageCommentsPath(pageSlug), headerLine);

  const before: AppendBase = { length: headerLine.byteLength, prefixSha256: sha256Hex(headerLine) };
  const event: PinCreatedEvent = {
    kind: "pin:created",
    recordId: uuidv7(),
    pinId: uuidv7(),
    element: "button-1",
    fx: 0.5,
    fy: 0.5,
    text: "looks off",
    ts: TS,
  };
  const appended = buildPinAppend({ before, events: [event], deps: APPEND_DEPS });
  if (appended instanceof Error) throw new Error(`fixture bug: ${appended.message}`);
  const after = computeAfterImage({
    chunks: [headerLine],
    beforeLength: before.length,
    append: appended.bytes,
  });
  if (after instanceof Error) throw new Error(`fixture bug: ${after.message}`);

  const operations: TransactionOperation[] = [
    {
      index: 0,
      target: pageCommentsPath(pageSlug),
      mode: "append-jsonl",
      oldImage: { state: "file", sha256: before.prefixSha256, size: before.length },
      newImage: { state: "file", sha256: after.sha256, size: after.size },
      append: appended.descriptor,
    },
  ];
  return {
    plan: {
      journalVersion: 1,
      transactionId,
      kind: "project-mutation",
      domain: { mutationKind: "pin-event" },
      createdAt: TS,
      operations,
    },
    payloads: [
      { payloadId: appended.descriptor.appendedPayloadId, bytesBase64: base64Of(appended.bytes) },
    ],
  };
}

/** Local-state update: `workspace.local.toml` rewritten with a different active page. */
function localStateUpdatePlan(termcraftDir: string, transactionId: string): PlanFixture {
  const oldBytes = bytesOf(encodeWorkspaceLocalState(defaultWorkspaceLocalState()));
  writeManaged(termcraftDir, WORKSPACE_STATE_FILENAME, oldBytes);
  const newBytes = bytesOf(
    encodeWorkspaceLocalState({ ...defaultWorkspaceLocalState(), activePageSlug: slug("home") }),
  );
  const payloadId = uuidv7();

  const operations: TransactionOperation[] = [
    {
      index: 0,
      target: WORKSPACE_STATE_FILENAME,
      mode: "replace",
      oldImage: { state: "file", sha256: sha256Hex(oldBytes), size: oldBytes.byteLength },
      newImage: { state: "file", sha256: sha256Hex(newBytes), size: newBytes.byteLength },
      payloadId,
    },
  ];
  return {
    plan: {
      journalVersion: 1,
      transactionId,
      kind: "project-mutation",
      domain: { mutationKind: "local-state-write" },
      createdAt: TS,
      operations,
    },
    payloads: [{ payloadId, bytesBase64: base64Of(newBytes) }],
  };
}

/** Infra-only export publication (turn-durability §10): a new generation artifact + `export/current.json`, both created fresh — MVP wires no caller, but the engine must still survive a crash mid-publish. */
function exportPublishPlan(transactionId: string): PlanFixture {
  const generationId = uuidv7();
  const artifactBytes = bytesOf("styled export frame bytes");
  const currentBytes = bytesOf(JSON.stringify({ generationId }));
  const artifactPayload = uuidv7();
  const currentPayload = uuidv7();

  const operations: TransactionOperation[] = [
    {
      index: 0,
      target: `export/generations/${generationId}/frame.bin`,
      mode: "replace",
      oldImage: { state: "absent" },
      newImage: { state: "file", sha256: sha256Hex(artifactBytes), size: artifactBytes.byteLength },
      payloadId: artifactPayload,
    },
    {
      index: 1,
      target: "export/current.json",
      mode: "replace",
      oldImage: { state: "absent" },
      newImage: { state: "file", sha256: sha256Hex(currentBytes), size: currentBytes.byteLength },
      payloadId: currentPayload,
    },
  ];
  return {
    plan: {
      journalVersion: 1,
      transactionId,
      kind: "export-publish",
      domain: { generationId },
      createdAt: TS,
      operations,
    },
    payloads: [
      { payloadId: artifactPayload, bytesBase64: base64Of(artifactBytes) },
      { payloadId: currentPayload, bytesBase64: base64Of(currentBytes) },
    ],
  };
}

/** Infra-only migration (storage-identity §12): a thin `kind: "migration"` plan — no shipped migration exists, but the engine/recovery protocol must already be proven for this kind (T14's own scope note). */
function migrationPlan(transactionId: string): PlanFixture {
  const bytes = bytesOf(
    encodeProjectManifest({
      formatVersion: 1,
      projectId: uuidv7(),
      name: "Migrated",
      createdAt: TS,
      targetStack: "generic",
      pages: [],
    }),
  );
  const payloadId = uuidv7();
  const operations: TransactionOperation[] = [
    {
      index: 0,
      target: PROJECT_MANIFEST_FILENAME,
      mode: "replace",
      oldImage: { state: "absent" },
      newImage: { state: "file", sha256: sha256Hex(bytes), size: bytes.byteLength },
      payloadId,
    },
  ];
  return {
    plan: {
      journalVersion: 1,
      transactionId,
      kind: "migration",
      domain: { migrationPlanId: uuidv7(), migrationActionId: uuidv7() },
      createdAt: TS,
      operations,
    },
    payloads: [{ payloadId, bytesBase64: base64Of(bytes) }],
  };
}

const SWEPT_BOUNDARIES: readonly TransactionBoundary[] = [
  "intent-installed",
  "operation-target-applied",
  "committed-installed",
];

const SWEEP_CASES: ReadonlyArray<{
  readonly name: string;
  readonly build: (termcraftDir: string) => PlanFixture;
}> = [
  { name: "one-file replace", build: (dir) => oneFileReplacePlan(dir, uuidv7()) },
  { name: "multi-page finalization", build: () => multiPageFinalizationPlan(uuidv7()) },
  { name: "chat append", build: (dir) => chatAppendPlan(dir, uuidv7()) },
  { name: "pin append", build: (dir) => pinAppendPlan(dir, uuidv7()) },
  { name: "local-state update", build: (dir) => localStateUpdatePlan(dir, uuidv7()) },
  { name: "export publish (infra-only)", build: () => exportPublishPlan(uuidv7()) },
  { name: "migration (infra-only)", build: () => migrationPlan(uuidv7()) },
];

describe("crash-injection sweep — every named store operation shape (turn-durability §14.1)", () => {
  for (const sweepCase of SWEEP_CASES) {
    for (const boundary of SWEPT_BOUNDARIES) {
      test(`${sweepCase.name}: a real child killed right after "${boundary}" recovers to exactly pre-intent or exactly committed — never mixed`, async () => {
        const termcraftDir = freshTermcraftDir();
        const { plan, payloads } = sweepCase.build(termcraftDir);

        const outcome = await runCrashCase({
          termcraftDir,
          plan,
          payloads,
          crash: { kind: "boundary", boundary },
        });
        if (!outcome.ok) throw new Error(`fixture bug: ${outcome.error.message}`);

        // Proves the child actually reached the injected boundary before dying (finding #8):
        // without this, a child that fails setup or rejects the plan BEFORE any boundary
        // (e.g. CHILD_TX_ERROR_EXIT_CODE) would silently pass the assertions below on an
        // untouched "all-old" tree, covering none of the crash-injection boundary it claims to.
        expect(outcome.child.exitCode).toBe(CRASH_EXIT_CODE);
        expect(outcome.recovery.ok).toBe(true);
        expect(outcome.targetsState === "all-old" || outcome.targetsState === "all-new").toBe(true);
        expect(outcome.noDuplicateIdentity).toBe(true);
      }, 20_000);
    }
  }
});
