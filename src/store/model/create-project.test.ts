import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { decodeDesignSystemManifest } from "entities/design-system";
import { decodePagesManifest } from "entities/design-tree";
import { uuidv7 } from "infrastructure/uuid";
import { CURRENT_KIT_API_VERSION } from "runtime";
import { encodeChatHeaderLine, sha256Hex } from "store/jsonl";
import {
  PROJECT_GITIGNORE_FILENAME,
  PROJECT_MANIFEST_FILENAME,
  PROJECT_MANIFEST_FORMAT_VERSION,
  WORKSPACE_STATE_FILENAME,
  decodeWorkspaceLocalState,
  defaultWorkspaceLocalState,
  encodeProjectManifest,
  encodeWorkspaceLocalState,
  renderProjectGitignore,
} from "store/toml";
import type {
  ChildPayload,
  TransactionBoundary,
  TransactionOperation,
  TransactionPlan,
} from "store/transaction";
import { TRANSACTIONS_LOCAL_DIR, chatJsonlPath, decodePlan, runCrashCase } from "store/transaction";

import type { StoreDeps } from "../types";
import { ProjectAlreadyExistsError, createStore, nodeStoreDeps } from "./factory";

// Integration coverage for the new-project creation sequence (storage-identity §14.2): ONE
// `project-mutation` transaction mints `projectId`, the format-1 layout, the generated
// `.gitignore`, the workspace file, and the first chat header — then the implicit trust
// grant is recorded. Plus a crash-injection sweep (reusing T14's `runCrashCase` harness)
// across every physical boundary of that same transaction shape.

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

/**
 * One project-creation transaction's `mutationKind` and `operations`, read back from the
 * committed `plan.json` the engine leaves on disk (it is never cleaned up — turn-durability's
 * own recovery classification needs it). `createProject` writes exactly one project's own
 * `.termcraft/transactions.local/` directory (the implicit trust grant, a separate write,
 * lands in `userStateRoot`, never here), so this always reads back the single transaction
 * `createProject` itself ran.
 */
function readRecordedMutations(projectRoot: string): readonly {
  readonly mutationKind: unknown;
  readonly operations: readonly TransactionOperation[];
}[] {
  const txRoot = path.join(projectRoot, ".termcraft", TRANSACTIONS_LOCAL_DIR);
  return fs
    .readdirSync(txRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const bytes = fs.readFileSync(path.join(txRoot, entry.name, "plan.json"));
      const plan = decodePlan(new Uint8Array(bytes));
      if (plan instanceof Error)
        throw new Error(`fixture bug: undecodable plan.json: ${plan.message}`);
      return { mutationKind: plan.domain.mutationKind, operations: plan.operations };
    });
}

describe("createProject — new-project creation (storage-identity §14.2)", () => {
  test("mints projectId, the format-2 layout, the gitignore, the workspace file, the seeded design tree, the first chat header, and the implicit trust grant", async () => {
    const userStateRoot = freshScratch("tc-create-userstate-");
    const projectRoot = freshScratch("tc-create-project-");
    const deps = testDeps(userStateRoot);

    const store = createStore(deps);
    const opened = await store.createProject({
      root: projectRoot,
      name: "My Project",
      targetStack: "generic",
      kitApiVersion: CURRENT_KIT_API_VERSION,
    });
    if (opened instanceof Error)
      throw new Error(`fixture bug: createProject failed: ${opened.message}`);

    try {
      // ---- project.toml: portable, format-1, exactly the five semantic fields ----
      const manifest = await opened.manifest.read();
      if (manifest instanceof Error)
        throw new Error(`fixture bug: manifest unreadable: ${manifest.message}`);
      // `pages` is gone from `ProjectManifest` as of format_version 2 (Task 5) — it is not
      // re-asserted here (there is nothing left on this type to assert): page order lives in
      // `design/pages.json` instead, which `opened.pages.listSlugs()` below still needs
      // `DesignTreeStore` to read (Task 9) — the still-failing part of this test.
      expect(manifest.formatVersion).toBe(PROJECT_MANIFEST_FORMAT_VERSION);
      expect(manifest.name).toBe("My Project");
      expect(manifest.targetStack).toBe("generic");
      expect(() => new Date(manifest.createdAt).toISOString()).not.toThrow(); // sanity: createdAt is a real RFC 3339 string

      const manifestOnDisk = fs.readFileSync(
        path.join(projectRoot, ".termcraft", PROJECT_MANIFEST_FILENAME),
        "utf8",
      );
      expect(manifestOnDisk).toBe(encodeProjectManifest(manifest));

      // ---- .gitignore: byte-deterministic generated content ----
      const gitignoreOnDisk = fs.readFileSync(
        path.join(projectRoot, ".termcraft", PROJECT_GITIGNORE_FILENAME),
        "utf8",
      );
      expect(gitignoreOnDisk).toBe(renderProjectGitignore());

      // ---- workspace.local.toml: machine-local defaults, EXCEPT the active-chat pointer ----
      const workspaceOnDisk = fs.readFileSync(
        path.join(projectRoot, ".termcraft", WORKSPACE_STATE_FILENAME),
        "utf8",
      );
      const decodedWorkspace = decodeWorkspaceLocalState(workspaceOnDisk);
      if (decodedWorkspace instanceof Error)
        throw new Error(`fixture bug: workspace state undecodable: ${decodedWorkspace.message}`);

      // ---- the seeded design tree (multi-file design tree §3, §10; task 16) ----
      // `project.toml` carries no page order at format_version 2 — `design/pages.json` is the
      // sole page-identity authority, and it must EXIST from creation, because a project whose
      // manifest is absent cannot be read as "no pages yet" without guessing.
      const manifestSource = fs.readFileSync(
        path.join(projectRoot, ".termcraft", PROJECT_MANIFEST_FILENAME),
        "utf8",
      );
      expect(manifestSource).toContain("format_version = 3");
      expect(manifestSource).not.toContain("pages");

      const pagesJson = fs.readFileSync(
        path.join(projectRoot, ".termcraft", "design", "pages.json"),
        "utf8",
      );
      const seededTree = decodePagesManifest(pagesJson);
      if (seededTree instanceof Error)
        throw new Error(`fixture bug: seeded pages.json undecodable: ${seededTree.message}`);
      expect(seededTree.schemaVersion).toBe(1);
      // NO STARTER PAGE, deliberately (design §10): a page the user never asked for would be a
      // fabricated design, and the first turn is what creates one.
      expect(seededTree.pages).toEqual([]);
      expect(seededTree.requestedActivePage).toBeNull();
      // And the seed is the ONLY thing in the tree beyond the design system (design-systems
      // §4.4) — no invented `lib/`, no example component.
      expect(fs.readdirSync(path.join(projectRoot, ".termcraft", "design"))).toEqual([
        "pages.json",
        "system",
      ]);

      // ---- the first chat header ----
      const chatFiles = fs.readdirSync(path.join(projectRoot, ".termcraft", "chats"));
      expect(chatFiles).toHaveLength(1);
      const chatId = chatFiles[0]?.replace(/\.jsonl$/, "");
      if (chatId === undefined) throw new Error("fixture bug: no chat file");

      // Creation mints the first chat AND points `activeChatId` at it, in the one
      // project-creation transaction. This assertion previously compared against a bare
      // `defaultWorkspaceLocalState()`, which pinned `activeChatId: null` — the state in which
      // `turn.start` refuses every turn with "no active chat yet" and publishes nothing, so a
      // brand-new project could never run its first turn. Asserted against the chat file
      // actually on disk, not a remembered id, so a pointer aimed at the wrong chat also fails.
      expect(decodedWorkspace).toEqual({ ...defaultWorkspaceLocalState(), activeChatId: chatId });
      const handle = await opened.chats.open(chatId);
      if (handle instanceof Error)
        throw new Error(`fixture bug: chat unopenable: ${handle.message}`);
      expect(handle.header).toEqual({
        kind: "chat",
        formatVersion: 1,
        projectId: manifest.projectId,
        chatId,
        createdAt: manifest.createdAt,
      });
      const tail = await handle.loadTail();
      if (tail instanceof Error) throw new Error(`fixture bug: loadTail failed: ${tail.message}`);
      expect(tail.records).toEqual([]);

      // ---- the implicit trust grant ----
      const subject = await opened.trust.buildSubject(projectRoot, manifest.projectId, null);
      if (subject instanceof Error)
        throw new Error(`fixture bug: buildSubject failed: ${subject.message}`);
      expect(await opened.trust.isGranted(subject)).toBe(true);

      // ---- load stores: every port on the open handle is present and minimally functional ----
      expect(opened.recovery).toEqual({ ok: true, recovered: 0, discarded: 0, alreadyComplete: 0 });
      expect(opened.orphanTurns).toEqual([]);
      const slugs = await opened.pages.listSlugs();
      if (slugs instanceof Error)
        throw new Error(`fixture bug: listSlugs failed: ${slugs.message}`);
      expect(slugs).toEqual([]);
    } finally {
      await opened.close();
    }
  }, 20_000);

  test("a new project is created with a working design system (design-systems §4.4)", async () => {
    // "a new project has a working design system before its first page exists, so no page is
    // ever authored against a missing token map."
    const userStateRoot = freshScratch("tc-create-userstate-");
    const projectRoot = freshScratch("tc-create-project-");
    const deps = testDeps(userStateRoot);
    const store = createStore(deps);

    const opened = await store.createProject({
      root: projectRoot,
      name: "Design System Project",
      targetStack: "generic",
      kitApiVersion: CURRENT_KIT_API_VERSION,
    });
    if (opened instanceof Error)
      throw new Error(`fixture bug: createProject failed: ${opened.message}`);

    try {
      const manifest = fs.readFileSync(
        path.join(projectRoot, ".termcraft/design/system/design-system.json"),
        "utf8",
      );
      const decoded = decodeDesignSystemManifest(manifest);
      expect(decoded).not.toBeInstanceOf(Error);
      if (decoded instanceof Error) return;
      expect(decoded.defaultTheme).toBe("dark-default");
      expect(decoded.kitApiVersion).toBe(CURRENT_KIT_API_VERSION);
      expect(decoded.components).toEqual([]);

      const tokens = fs.readFileSync(
        path.join(projectRoot, ".termcraft/design/system/tokens.ts"),
        "utf8",
      );
      expect(tokens).toContain('import ds from "./design-system.json"');
    } finally {
      await opened.close();
    }
  }, 20_000);

  test("the whole creation is still ONE transaction", async () => {
    // The seed files ride the SAME `project-creation` transaction as `project.toml` and
    // `design/pages.json` — a second write could be interrupted between the two and leave a
    // project whose manifest says format 2 and whose tree has no design system.
    const userStateRoot = freshScratch("tc-create-userstate-");
    const projectRoot = freshScratch("tc-create-project-");
    const deps = testDeps(userStateRoot);
    const store = createStore(deps);

    const opened = await store.createProject({
      root: projectRoot,
      name: "One Transaction Project",
      targetStack: "generic",
      kitApiVersion: CURRENT_KIT_API_VERSION,
    });
    if (opened instanceof Error)
      throw new Error(`fixture bug: createProject failed: ${opened.message}`);

    try {
      const recordedMutations = readRecordedMutations(projectRoot);
      expect(recordedMutations.map((m) => m.mutationKind)).toEqual(["project-creation"]);
      expect(recordedMutations[0]?.operations).toHaveLength(7);
    } finally {
      await opened.close();
    }
  }, 20_000);

  test("refuses to create a second project over an existing .termcraft directory", async () => {
    const userStateRoot = freshScratch("tc-create-userstate-");
    const projectRoot = freshScratch("tc-create-exists-");
    const deps = testDeps(userStateRoot);
    const store = createStore(deps);

    const first = await store.createProject({
      root: projectRoot,
      name: "First",
      targetStack: "generic",
      kitApiVersion: CURRENT_KIT_API_VERSION,
    });
    if (first instanceof Error) throw new Error(`fixture bug: ${first.message}`);
    await first.close();

    const second = await store.createProject({
      root: projectRoot,
      name: "Second",
      targetStack: "generic",
      kitApiVersion: CURRENT_KIT_API_VERSION,
    });
    expect(second instanceof Error).toBe(true);
    expect(ProjectAlreadyExistsError.is(second)).toBe(true);
  }, 20_000);
});

// ---- crash-injection sweep: the exact project-creation operation shape --------------------

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
function base64Of(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/** Mirrors `./factory.ts`'s `createProject`: one project-mutation plan replacing `project.toml`/`.gitignore`/`workspace.local.toml`/the first chat header, every operation a create-new `replace`. */
function projectCreationPlan(transactionId: string): {
  readonly plan: TransactionPlan;
  readonly payloads: readonly ChildPayload[];
} {
  const projectId = uuidv7();
  const chatId = uuidv7();

  const manifestBytes = bytesOf(
    encodeProjectManifest({
      formatVersion: PROJECT_MANIFEST_FORMAT_VERSION,
      projectId,
      name: "Crash Sweep Project",
      createdAt: TS,
      targetStack: "generic",
    }),
  );
  const gitignoreBytes = bytesOf(renderProjectGitignore());
  const workspaceBytes = bytesOf(encodeWorkspaceLocalState(defaultWorkspaceLocalState()));
  const chatHeaderLine = encodeChatHeaderLine({
    kind: "chat",
    formatVersion: 1,
    projectId,
    chatId,
    createdAt: TS,
  });
  if (chatHeaderLine instanceof Error) throw new Error(`fixture bug: ${chatHeaderLine.message}`);

  function op(
    index: number,
    target: string,
    bytes: Uint8Array,
    payloadId: string,
  ): TransactionOperation {
    return {
      index,
      target,
      mode: "replace",
      oldImage: { state: "absent" },
      newImage: { state: "file", sha256: sha256Hex(bytes), size: bytes.byteLength },
      payloadId,
    };
  }

  const manifestPayloadId = uuidv7();
  const gitignorePayloadId = uuidv7();
  const workspacePayloadId = uuidv7();
  const chatPayloadId = uuidv7();

  const plan: TransactionPlan = {
    journalVersion: 1,
    transactionId,
    kind: "project-mutation",
    domain: { actionId: uuidv7(), mutationKind: "project-creation" },
    createdAt: TS,
    operations: [
      op(0, PROJECT_MANIFEST_FILENAME, manifestBytes, manifestPayloadId),
      op(1, PROJECT_GITIGNORE_FILENAME, gitignoreBytes, gitignorePayloadId),
      op(2, WORKSPACE_STATE_FILENAME, workspaceBytes, workspacePayloadId),
      op(3, chatJsonlPath(chatId), chatHeaderLine, chatPayloadId),
    ],
  };
  const payloads: ChildPayload[] = [
    { payloadId: manifestPayloadId, bytesBase64: base64Of(manifestBytes) },
    { payloadId: gitignorePayloadId, bytesBase64: base64Of(gitignoreBytes) },
    { payloadId: workspacePayloadId, bytesBase64: base64Of(workspaceBytes) },
    { payloadId: chatPayloadId, bytesBase64: base64Of(chatHeaderLine) },
  ];
  return { plan, payloads };
}

const SWEPT_BOUNDARIES: readonly TransactionBoundary[] = [
  "plan-installed",
  "intent-installed",
  "operation-target-applied",
  "committed-installed",
];

describe("createProject — crash-injection sweep (turn-durability §14.1, project-creation shape)", () => {
  for (const boundary of SWEPT_BOUNDARIES) {
    test(`a real child killed right after "${boundary}" recovers to exactly pre-intent or exactly committed — never mixed`, async () => {
      const scratch = freshScratch("tc-create-crash-");
      const termcraftDir = path.join(scratch, ".termcraft");
      fs.mkdirSync(termcraftDir);
      const { plan, payloads } = projectCreationPlan(uuidv7());

      const outcome = await runCrashCase({
        termcraftDir,
        plan,
        payloads,
        crash: { kind: "boundary", boundary },
      });
      if (!outcome.ok) throw new Error(`fixture bug: ${outcome.error.message}`);

      expect(outcome.recovery.ok).toBe(true);
      expect(outcome.targetsState === "all-old" || outcome.targetsState === "all-new").toBe(true);
      expect(outcome.noDuplicateIdentity).toBe(true);
    }, 20_000);
  }
});
