import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DESIGN_SYSTEM_MANIFEST_RELPATH,
  DESIGN_SYSTEM_TOKENS_RELPATH,
} from "entities/design-system";
import { PagesManifestInvalidError, encodePagesManifest } from "entities/design-tree";
import type { PagesManifestV1 } from "entities/design-tree";
import { parsePageSlug } from "entities/page";
import type { PageSlug } from "entities/page";
import type { PinCreatedEvent } from "entities/pin";
import { uuidv7 } from "infrastructure/uuid";
import { CURRENT_KIT_API_VERSION } from "runtime";
import { computeSessionPrefixHash, sha256Hex } from "store/jsonl";

import type { OpenProject, StoreDeps } from "../types";
import { PageEntryNotFoundError } from "./design-tree-store";
import {
  EntrySourceDriftedError,
  ManifestDriftedError,
  ReorderPagesInvalidOrderError,
  createStore,
  nodeStoreDeps,
} from "./factory";

// Blocker B3 (phase-6 plan §2): six MVP commands (`chat.create`, `page.renameTitle`,
// `page.reorder`, `page.removeConfirm`, `pin.setStatus`, `model.select`) plus active-page/
// active-chat writes and checkpoint persistence have no legal path while `store`'s public
// surface only exposes the four turn-shaped `TransactionEngine` methods. These tests prove
// each NAMED domain method actually round-trips through the real engine against a real
// project on disk — never a fake, since the whole point is proving the durable write lands.

const TS = "2026-07-21T10:00:00Z";

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

function slug(value: string): PageSlug {
  const parsed = parsePageSlug(value);
  if (parsed instanceof Error) throw new Error(`fixture bug: ${parsed.message}`);
  return parsed;
}

async function freshOpenProject() {
  const userStateRoot = freshScratch("tc-engine-methods-userstate-");
  const projectRoot = freshScratch("tc-engine-methods-project-");
  const store = createStore(testDeps(userStateRoot));
  const opened = await store.createProject({
    root: projectRoot,
    name: "Engine Methods",
    targetStack: "generic",
    kitApiVersion: CURRENT_KIT_API_VERSION,
  });
  if (opened instanceof Error)
    throw new Error(`fixture bug: createProject failed: ${opened.message}`);
  return opened;
}

// ---- design-tree seeding (design §3, §4) -----------------------------------------------
//
// `createProject` mints no `design/pages.json` (Task 16's own "tree-less project"
// territory, red-debt.md) and `reorderPages`/`removePage` only ever REORDER/DROP already-
// listed entries — neither ever invents a new one (`PageMutations.reorder`'s own port doc:
// "never a subset or an added/removed identity"). So every test below that needs an
// EXISTING manifest entry writes `design/pages.json` (and its entry files) directly on
// disk first, bypassing the transaction engine — this file's subject is the engine's named
// methods acting on an already-listed page, not how a page gets listed in the first place
// (that is the agent-turn/Gate path, out of this file's scope).

function designPath(opened: OpenProject, relPath: string): string {
  return path.join(opened.root, ".termcraft", "design", ...relPath.split("/"));
}

function seedDesignFile(opened: OpenProject, relPath: string, bytes: Uint8Array): void {
  const abs = designPath(opened, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);
}

function seedManifest(opened: OpenProject, manifest: PagesManifestV1): void {
  seedDesignFile(opened, "pages.json", new TextEncoder().encode(encodePagesManifest(manifest)));
}

describe("TransactionEngine — named domain methods (phase-6 blocker B3)", () => {
  test("createChat mints a new chat header — chat.create", async () => {
    const opened = await freshOpenProject();
    try {
      const manifest = await opened.manifest.read();
      if (manifest instanceof Error) throw new Error(`fixture bug: ${manifest.message}`);

      const chatId = uuidv7();
      const result = await opened.transactions.createChat({
        transactionId: uuidv7(),
        actionId: uuidv7(),
        chatId,
        projectId: manifest.projectId,
        createdAt: TS,
      });
      if (result instanceof Error) throw result;

      const handle = await opened.chats.open(chatId);
      if (handle instanceof Error)
        throw new Error(`fixture bug: chat unopenable: ${handle.message}`);
      expect(handle.header).toEqual({
        kind: "chat",
        formatVersion: 1,
        projectId: manifest.projectId,
        chatId,
        createdAt: TS,
      });
    } finally {
      await opened.close();
    }
  }, 20_000);

  test("createChat refuses to silently overwrite an existing chat at the same chatId", async () => {
    const opened = await freshOpenProject();
    try {
      const manifest = await opened.manifest.read();
      if (manifest instanceof Error) throw new Error(`fixture bug: ${manifest.message}`);
      const chatId = uuidv7();

      const first = await opened.transactions.createChat({
        transactionId: uuidv7(),
        actionId: uuidv7(),
        chatId,
        projectId: manifest.projectId,
        createdAt: TS,
      });
      if (first instanceof Error) throw first;

      // A genuinely DIFFERENT second header at the same chatId (a different createdAt) — a
      // byte-identical replay of the exact same plan is idempotent by design (turn-durability
      // §4.3), so the collision this proves must actually differ from what is already there.
      const second = await opened.transactions.createChat({
        transactionId: uuidv7(),
        actionId: uuidv7(),
        chatId,
        projectId: manifest.projectId,
        createdAt: "2026-07-21T11:00:00Z",
      });
      expect(second instanceof Error).toBe(true);
    } finally {
      await opened.close();
    }
  }, 20_000);

  test("setActiveChat writes workspace.local.toml's active_chat_id — active-chat writes", async () => {
    const opened = await freshOpenProject();
    try {
      const chatId = uuidv7();
      const result = await opened.transactions.setActiveChat({
        transactionId: uuidv7(),
        actionId: uuidv7(),
        activeChatId: chatId,
        createdAt: TS,
      });
      if (result instanceof Error) throw result;

      const state = await opened.workspaceState.read();
      if (state instanceof Error) throw new Error(`fixture bug: ${state.message}`);
      expect(state.state.activeChatId).toBe(chatId);

      const cleared = await opened.transactions.setActiveChat({
        transactionId: uuidv7(),
        actionId: uuidv7(),
        activeChatId: null,
        createdAt: TS,
      });
      if (cleared instanceof Error) throw cleared;
      const stateAfterClear = await opened.workspaceState.read();
      if (stateAfterClear instanceof Error)
        throw new Error(`fixture bug: ${stateAfterClear.message}`);
      expect(stateAfterClear.state.activeChatId).toBeNull();
    } finally {
      await opened.close();
    }
  }, 20_000);

  test("setActiveChat and setActivePage preserve every unrelated local field", async () => {
    // turn-durability §7.4: the workspace-local patch is "composed from the THEN-CURRENT
    // local file so unrelated preferences/session checkpoints are preserved". These two
    // methods ship a HARDCODED patch, so unlike setWorkspaceLocal they can silently
    // clobber siblings — and sessionCheckpoints drives 6F's resume-or-fresh decision, so
    // losing it would degrade every subsequent turn to a fresh session with no signal.
    const opened = await freshOpenProject();
    try {
      const seeded = await opened.transactions.setWorkspaceLocal({
        transactionId: uuidv7(),
        actionId: uuidv7(),
        patch: { backend: "claude-code", model: "sonnet-5" },
        createdAt: TS,
      });
      if (seeded instanceof Error) throw seeded;

      const before = await opened.workspaceState.read();
      if (before instanceof Error) throw new Error(`fixture bug: ${before.message}`);

      const chatId = uuidv7();
      const chatWrite = await opened.transactions.setActiveChat({
        transactionId: uuidv7(),
        actionId: uuidv7(),
        activeChatId: chatId,
        createdAt: TS,
      });
      if (chatWrite instanceof Error) throw chatWrite;

      const pageWrite = await opened.transactions.setActivePage({
        transactionId: uuidv7(),
        actionId: uuidv7(),
        activePageSlug: slug("home"),
        createdAt: TS,
      });
      if (pageWrite instanceof Error) throw pageWrite;

      const after = await opened.workspaceState.read();
      if (after instanceof Error) throw new Error(`fixture bug: ${after.message}`);

      // The two fields each method OWNS moved...
      expect(after.state.activeChatId).toBe(chatId);
      expect(after.state.activePageSlug).toBe(slug("home"));
      // ...and every sibling survived both writes.
      expect(after.state.backend).toBe(before.state.backend);
      expect(after.state.model).toBe(before.state.model);
      expect(after.state.sessionCheckpoints).toEqual(before.state.sessionCheckpoints);
    } finally {
      await opened.close();
    }
  }, 20_000);

  test("setActivePage writes workspace.local.toml's active_page_slug — active-page writes", async () => {
    const opened = await freshOpenProject();
    try {
      const home = slug("home");
      const result = await opened.transactions.setActivePage({
        transactionId: uuidv7(),
        actionId: uuidv7(),
        activePageSlug: home,
        createdAt: TS,
      });
      if (result instanceof Error) throw result;

      const state = await opened.workspaceState.read();
      if (state instanceof Error) throw new Error(`fixture bug: ${state.message}`);
      expect(state.state.activePageSlug).toBe(home);
    } finally {
      await opened.close();
    }
  }, 20_000);

  test("renamePageTitle replaces one design-tree page's source bytes at its manifest-resolved entryRelPath — page.renameTitle, both create and edit", async () => {
    const opened = await freshOpenProject();
    try {
      // Deliberately unrelated to the slug (design §3, §7's central rule) — an entry equal
      // to `pages/home.tsx` could never distinguish a manifest lookup from a slug guess. The
      // manifest must be seeded first: `renamePageTitle` now re-checks that it still binds
      // `pageSlug` to `entryRelPath` (review round 3), so a page unlisted anywhere would be
      // refused before ever reaching the write.
      const home = slug("home");
      const entryRelPath = "screens/home-view.tsx";
      seedManifest(opened, {
        schemaVersion: 1,
        pages: [{ slug: home, entry: entryRelPath }],
        requestedActivePage: null,
      });

      const v1 = new TextEncoder().encode("export const meta = { title: 'Home' }\n");
      const created = await opened.transactions.renamePageTitle({
        transactionId: uuidv7(),
        actionId: uuidv7(),
        pageSlug: home,
        entryRelPath,
        expectedSourceHash: null, // the entry file does not exist yet — a create-new intent
        newBytes: v1,
        createdAt: TS,
      });
      if (created instanceof Error) throw created;

      const readV1 = await opened.pages.readTreeFile(entryRelPath);
      if (readV1 instanceof Error) throw new Error(`fixture bug: ${readV1.message}`);
      expect(new TextDecoder().decode(readV1.bytes)).toBe(
        "export const meta = { title: 'Home' }\n",
      );

      // Edit: the SAME entry, new bytes — proves the oldImage CAS is observed fresh each
      // call, not merely a create-new that would conflict on a second write.
      const v2 = new TextEncoder().encode("export const meta = { title: 'Welcome Home' }\n");
      const edited = await opened.transactions.renamePageTitle({
        transactionId: uuidv7(),
        actionId: uuidv7(),
        pageSlug: home,
        entryRelPath,
        expectedSourceHash: sha256Hex(v1), // the entry file now holds v1
        newBytes: v2,
        createdAt: TS,
      });
      if (edited instanceof Error) throw edited;

      const readV2 = await opened.pages.readTreeFile(entryRelPath);
      if (readV2 instanceof Error) throw new Error(`fixture bug: ${readV2.message}`);
      expect(new TextDecoder().decode(readV2.bytes)).toBe(
        "export const meta = { title: 'Welcome Home' }\n",
      );
    } finally {
      await opened.close();
    }
  }, 20_000);

  // Important review finding, round 3: `renamePageTitle` carries the identical
  // unprotected-snapshot shape Important 1 (round 2) closed for `reorderPages`/`removePage`
  // — the CALLER (`store/adapters/design-store.ts`) resolves `entryRelPath` and reads the
  // entry file's bytes OUTSIDE the write permit, and the engine's own `oldImage` CAS
  // re-observes the SAME path fresh, inside the SAME permit, so it can never disagree with
  // itself. See `EntrySourceDriftedError`'s own doc comment (`store/model/factory.ts`).
  test("renamePageTitle refuses when the entry file's own bytes changed since they were read — never overwrites a concurrent writer's content with a stale rewrite", async () => {
    const opened = await freshOpenProject();
    try {
      const home = slug("home");
      const entryRelPath = "screens/home-view.tsx";
      seedManifest(opened, {
        schemaVersion: 1,
        pages: [{ slug: home, entry: entryRelPath }],
        requestedActivePage: null,
      });
      const v1 = new TextEncoder().encode("export const meta = { title: 'Home' }\n");
      seedDesignFile(opened, entryRelPath, v1);

      // Snapshot: what a caller would have read before computing a rewrite.
      const expectedSourceHash = sha256Hex(v1);

      // Simulate a concurrent writer (e.g. a turn finalize) replacing the entry file's
      // content, after the snapshot was captured but before the permit is acquired.
      const concurrentBytes = new TextEncoder().encode(
        "export const meta = { title: 'Concurrent' }\n",
      );
      seedDesignFile(opened, entryRelPath, concurrentBytes);

      const rejected = await opened.transactions.renamePageTitle({
        transactionId: uuidv7(),
        actionId: uuidv7(),
        pageSlug: home,
        entryRelPath,
        expectedSourceHash, // stale — the file's real hash has moved on
        newBytes: new TextEncoder().encode("export const meta = { title: 'Stale Rewrite' }\n"),
        createdAt: TS,
      });
      expect(rejected).toBeInstanceOf(EntrySourceDriftedError);

      // The concurrent writer's content survives untouched.
      const after = await opened.pages.readTreeFile(entryRelPath);
      if (after instanceof Error) throw new Error(`fixture bug: ${after.message}`);
      expect(new TextDecoder().decode(after.bytes)).toBe(
        "export const meta = { title: 'Concurrent' }\n",
      );
    } finally {
      await opened.close();
    }
  }, 20_000);

  test("renamePageTitle refuses when design/pages.json moved the page's entry since it was read — never resurrects the old, now-orphaned path", async () => {
    const opened = await freshOpenProject();
    try {
      const home = slug("home");
      const oldEntry = "screens/home-view.tsx";
      const newEntry = "screens/home-view-v2.tsx";
      seedManifest(opened, {
        schemaVersion: 1,
        pages: [{ slug: home, entry: oldEntry }],
        requestedActivePage: null,
      });
      const originalBytes = new TextEncoder().encode("export const meta = { title: 'Home' }\n");
      seedDesignFile(opened, oldEntry, originalBytes);
      const expectedSourceHash = sha256Hex(originalBytes);

      // Simulate a concurrent writer moving the page's entry to a NEW path. The OLD file's
      // bytes are left exactly as they were — nothing physically changed at `oldEntry` — so
      // a content-only check would miss this; only re-checking the manifest BINDING catches
      // it.
      seedManifest(opened, {
        schemaVersion: 1,
        pages: [{ slug: home, entry: newEntry }],
        requestedActivePage: null,
      });
      seedDesignFile(opened, newEntry, originalBytes);

      const rejected = await opened.transactions.renamePageTitle({
        transactionId: uuidv7(),
        actionId: uuidv7(),
        pageSlug: home,
        entryRelPath: oldEntry, // stale — the manifest no longer binds "home" to this path
        expectedSourceHash,
        newBytes: new TextEncoder().encode("export const meta = { title: 'Stale Rewrite' }\n"),
        createdAt: TS,
      });
      expect(rejected).toBeInstanceOf(EntrySourceDriftedError);

      // The old, now-orphaned path is untouched — never resurrected with the stale rewrite.
      const oldAfter = await opened.pages.readTreeFile(oldEntry);
      if (oldAfter instanceof Error) throw new Error(`fixture bug: ${oldAfter.message}`);
      expect(new TextDecoder().decode(oldAfter.bytes)).toBe(
        "export const meta = { title: 'Home' }\n",
      );
      // The real, current entry is also untouched by the refused call.
      const newAfter = await opened.pages.readTreeFile(newEntry);
      if (newAfter instanceof Error) throw new Error(`fixture bug: ${newAfter.message}`);
      expect(new TextDecoder().decode(newAfter.bytes)).toBe(
        "export const meta = { title: 'Home' }\n",
      );
    } finally {
      await opened.close();
    }
  }, 20_000);

  // Important review finding, round 2: `readSource` is a REAL production path
  // (`core/kernel/model/handlers/{page-descriptors,page-pin,preview-export}.ts` call it via
  // the adapter's own kept-for-compatibility `readSource`/`listSlugs`), but had no coverage
  // in this file at all — every other test here reads pages back through `readTreeFile`.
  test("readSource resolves the entry through the manifest, never a slug-computed path — and reports PageEntryNotFoundError for an unlisted slug", async () => {
    const opened = await freshOpenProject();
    try {
      const home = slug("home");
      const about = slug("about");
      // Deliberately unrelated to the slug (design §3, §7's central rule).
      const homeEntry = "screens/home-view.tsx";
      const sourceBytes = new TextEncoder().encode("export default home;\n");
      seedManifest(opened, {
        schemaVersion: 1,
        pages: [{ slug: home, entry: homeEntry }],
        requestedActivePage: null,
      });
      seedDesignFile(opened, homeEntry, sourceBytes);

      const source = await opened.pages.readSource(home);
      if (source instanceof Error) throw new Error(`fixture bug: ${source.message}`);
      expect(new TextDecoder().decode(source.bytes)).toBe("export default home;\n");
      expect(source.sourceHash).toBe(sha256Hex(sourceBytes));

      // `about` is genuinely unlisted — never a slug-computed path guess.
      const missing = await opened.pages.readSource(about);
      expect(missing).toBeInstanceOf(PageEntryNotFoundError);
    } finally {
      await opened.close();
    }
  }, 20_000);

  test("reorderPages rewrites design/pages.json, not project.toml — page.reorder, including the already-current no-op", async () => {
    const opened = await freshOpenProject();
    try {
      const home = slug("home");
      const about = slug("about");
      // Entries deliberately unrelated to their own slugs (design §3, §7).
      const homeEntry = "screens/home-view.tsx";
      const aboutEntry = "panels/about-panel.tsx";
      seedManifest(opened, {
        schemaVersion: 1,
        pages: [
          { slug: home, entry: homeEntry },
          { slug: about, entry: aboutEntry },
        ],
        requestedActivePage: null,
      });

      const projectTomlBefore = opened.safeFs.readFile("project.toml");

      const manifestBefore = await opened.pages.readManifest();
      if (manifestBefore instanceof Error)
        throw new Error(`fixture bug: ${manifestBefore.message}`);
      expect(manifestBefore.pages.map((page) => page.slug)).toEqual([home, about]);

      // Reorder to the opposite order.
      const reordered = await opened.transactions.reorderPages({
        transactionId: uuidv7(),
        actionId: uuidv7(),
        manifestBefore,
        orderedSlugs: [about, home],
        createdAt: TS,
      });
      if (reordered instanceof Error) throw reordered;
      const manifestReordered = await opened.pages.readManifest();
      if (manifestReordered instanceof Error)
        throw new Error(`fixture bug: ${manifestReordered.message}`);
      expect(manifestReordered.pages).toEqual([
        { slug: about, entry: aboutEntry },
        { slug: home, entry: homeEntry },
      ]);
      // `project.toml` never carries page order as of format_version 2 — untouched by the
      // rewrite above.
      expect(opened.safeFs.readFile("project.toml")).toEqual(projectTomlBefore);

      // Already-current order: a legal, zero-operation transaction, not a special-cased
      // rejection.
      const noop = await opened.transactions.reorderPages({
        transactionId: uuidv7(),
        actionId: uuidv7(),
        manifestBefore: manifestReordered,
        orderedSlugs: [about, home],
        createdAt: TS,
      });
      if (noop instanceof Error) throw noop;
      expect(noop.operations).toEqual([]);
      const manifestAfterNoop = await opened.pages.readManifest();
      if (manifestAfterNoop instanceof Error)
        throw new Error(`fixture bug: ${manifestAfterNoop.message}`);
      expect(manifestAfterNoop.pages).toEqual([
        { slug: about, entry: aboutEntry },
        { slug: home, entry: homeEntry },
      ]);
    } finally {
      await opened.close();
    }
  }, 20_000);

  test("reorderPages refuses an order naming an unknown pageSlug, without writing", async () => {
    const opened = await freshOpenProject();
    try {
      const home = slug("home");
      const about = slug("about");
      seedManifest(opened, {
        schemaVersion: 1,
        pages: [{ slug: home, entry: "screens/home-view.tsx" }],
        requestedActivePage: null,
      });
      const manifestBefore = await opened.pages.readManifest();
      if (manifestBefore instanceof Error)
        throw new Error(`fixture bug: ${manifestBefore.message}`);

      // Asserted against the CLASS this task introduced, not `instanceof Error` — the
      // permutation guard is the only thing this test claims to exercise, and a bare
      // `instanceof Error` cannot distinguish it from an unrelated CAS conflict or an
      // `FsAccessError` (review round 2).
      const rejected = await opened.transactions.reorderPages({
        transactionId: uuidv7(),
        actionId: uuidv7(),
        manifestBefore,
        orderedSlugs: [home, about], // `about` is not a listed slug
        createdAt: TS,
      });
      expect(rejected).toBeInstanceOf(ReorderPagesInvalidOrderError);

      const manifestAfter = await opened.pages.readManifest();
      if (manifestAfter instanceof Error) throw new Error(`fixture bug: ${manifestAfter.message}`);
      expect(manifestAfter.pages).toEqual(manifestBefore.pages); // untouched
    } finally {
      await opened.close();
    }
  }, 20_000);

  test("reorderPages refuses a duplicated pageSlug — same length as the manifest, but never a silent drop of the other tracked slug, without writing", async () => {
    const opened = await freshOpenProject();
    try {
      const home = slug("home");
      const about = slug("about");
      seedManifest(opened, {
        schemaVersion: 1,
        pages: [
          { slug: home, entry: "screens/home-view.tsx" },
          { slug: about, entry: "panels/about-panel.tsx" },
        ],
        requestedActivePage: null,
      });
      const manifestBefore = await opened.pages.readManifest();
      if (manifestBefore instanceof Error)
        throw new Error(`fixture bug: ${manifestBefore.message}`);

      // `[home, home]` is the SAME length as the 2-page manifest — a length-only check would
      // let this through and silently drop `about`; this is the exact class of bug the
      // real engine's own guard exists to close (`core/ports/fakes/design-store.ts` review
      // finding, mirrored here at the real engine, which previously had no coverage at all).
      const rejected = await opened.transactions.reorderPages({
        transactionId: uuidv7(),
        actionId: uuidv7(),
        manifestBefore,
        orderedSlugs: [home, home],
        createdAt: TS,
      });
      expect(rejected).toBeInstanceOf(ReorderPagesInvalidOrderError);

      const manifestAfter = await opened.pages.readManifest();
      if (manifestAfter instanceof Error) throw new Error(`fixture bug: ${manifestAfter.message}`);
      expect(manifestAfter.pages).toEqual(manifestBefore.pages); // untouched — `about` not dropped
    } finally {
      await opened.close();
    }
  }, 20_000);

  test("reorderPages refuses a genuine subset — never silently drops a tracked slug, without writing", async () => {
    const opened = await freshOpenProject();
    try {
      const home = slug("home");
      const about = slug("about");
      seedManifest(opened, {
        schemaVersion: 1,
        pages: [
          { slug: home, entry: "screens/home-view.tsx" },
          { slug: about, entry: "panels/about-panel.tsx" },
        ],
        requestedActivePage: null,
      });
      const manifestBefore = await opened.pages.readManifest();
      if (manifestBefore instanceof Error)
        throw new Error(`fixture bug: ${manifestBefore.message}`);

      const rejected = await opened.transactions.reorderPages({
        transactionId: uuidv7(),
        actionId: uuidv7(),
        manifestBefore,
        orderedSlugs: [home], // `about` silently dropped if unchecked
        createdAt: TS,
      });
      expect(rejected).toBeInstanceOf(ReorderPagesInvalidOrderError);

      const manifestAfter = await opened.pages.readManifest();
      if (manifestAfter instanceof Error) throw new Error(`fixture bug: ${manifestAfter.message}`);
      expect(manifestAfter.pages).toEqual(manifestBefore.pages); // untouched
    } finally {
      await opened.close();
    }
  }, 20_000);

  // Important review finding, round 2: `reorderPages`/`removePage` rebuild `design/pages.json`
  // WHOLESALE from `manifestBefore` — a snapshot the caller (`store/adapters/design-store.ts`)
  // reads BEFORE acquiring the write permit. `design/pages.json` has a second writer (turn
  // finalize), so that snapshot can go stale between the read and the permit. Without a
  // drift check, this would silently overwrite whatever the concurrent writer just landed
  // with content derived from the caller's outdated snapshot — see `ManifestDriftedError`'s
  // own doc comment (`store/model/factory.ts`) for the full mechanism.
  test("reorderPages refuses when design/pages.json drifted since manifestBefore was read — never overwrites a concurrent writer's page with stale content", async () => {
    const opened = await freshOpenProject();
    try {
      const home = slug("home");
      const about = slug("about");
      const pricing = slug("pricing");
      seedManifest(opened, {
        schemaVersion: 1,
        pages: [
          { slug: home, entry: "screens/home-view.tsx" },
          { slug: about, entry: "panels/about-panel.tsx" },
        ],
        requestedActivePage: null,
      });
      const manifestBefore = await opened.pages.readManifest();
      if (manifestBefore instanceof Error)
        throw new Error(`fixture bug: ${manifestBefore.message}`);

      // Simulate a concurrent writer (e.g. a turn finalize) landing a THIRD page directly on
      // disk, after `manifestBefore` was captured but before `reorderPages` acquires the
      // write permit.
      const drifted: PagesManifestV1 = {
        schemaVersion: 1,
        pages: [...manifestBefore.pages, { slug: pricing, entry: "screens/pricing-view.tsx" }],
        requestedActivePage: null,
      };
      seedManifest(opened, drifted);

      const rejected = await opened.transactions.reorderPages({
        transactionId: uuidv7(),
        actionId: uuidv7(),
        manifestBefore, // stale — the on-disk manifest now has 3 pages, not 2
        orderedSlugs: [about, home],
        createdAt: TS,
      });
      expect(rejected).toBeInstanceOf(ManifestDriftedError);

      // The concurrent writer's page survives — never silently overwritten with 2 stale entries.
      const manifestAfter = await opened.pages.readManifest();
      if (manifestAfter instanceof Error) throw new Error(`fixture bug: ${manifestAfter.message}`);
      expect(manifestAfter.pages).toEqual(drifted.pages);
    } finally {
      await opened.close();
    }
  }, 20_000);

  // Important review finding, round 3 (fixing round 2's own regression): the drift check
  // MUST compare `manifestBefore` STRUCTURALLY against the current on-disk manifest, never
  // by re-encoding it and diffing bytes — `design/pages.json` is an agent-authored file
  // `store/sandbox` stages verbatim and the system prompt tells the agent to edit directly,
  // so its on-disk bytes are never guaranteed to match `encodePagesManifest`'s own canonical
  // output (fixed indent, fixed key order, `requestedActivePage: null` OMITTED rather than
  // written explicitly). Round 2's original byte-comparison implementation reported drift
  // for this exact, semantically UNCHANGED manifest and permanently refused both
  // `reorderPages` and `removePage` — reproduced here directly, seeding the on-disk file by
  // hand rather than through `encodePagesManifest`, which is exactly why no earlier test
  // (every one of which seeds via that same encoder) ever caught it.
  test("reorderPages/removePage succeed against a valid but NON-CANONICAL pages.json — byte-identical is never required, only structurally equal", async () => {
    const opened = await freshOpenProject();
    try {
      const home = slug("home");
      const about = slug("about");
      // Deliberately NOT what `encodePagesManifest` would produce: 4-space indent, reversed
      // key order (both at the top level and within each entry), and an EXPLICIT
      // `"requestedActivePage": null` the encoder would have omitted entirely.
      const nonCanonicalBytes = new TextEncoder().encode(
        [
          "{",
          '    "requestedActivePage": null,',
          '    "pages": [',
          '        { "entry": "screens/home-view.tsx", "slug": "home" },',
          '        { "entry": "panels/about-panel.tsx", "slug": "about" }',
          "    ],",
          '    "schemaVersion": 1',
          "}",
        ].join("\n"),
      );
      seedDesignFile(opened, "pages.json", nonCanonicalBytes);

      const manifestBefore = await opened.pages.readManifest();
      if (manifestBefore instanceof Error)
        throw new Error(`fixture bug: ${manifestBefore.message}`);
      expect(manifestBefore.pages.map((page) => page.slug)).toEqual([home, about]);
      expect(manifestBefore.requestedActivePage).toBeNull();

      const reordered = await opened.transactions.reorderPages({
        transactionId: uuidv7(),
        actionId: uuidv7(),
        manifestBefore,
        orderedSlugs: [about, home],
        createdAt: TS,
      });
      if (reordered instanceof Error) throw reordered;
      const manifestAfterReorder = await opened.pages.readManifest();
      if (manifestAfterReorder instanceof Error)
        throw new Error(`fixture bug: ${manifestAfterReorder.message}`);
      expect(manifestAfterReorder.pages.map((page) => page.slug)).toEqual([about, home]);

      // Same non-canonical shape, seeded again, proves `removePage` independently.
      seedDesignFile(opened, "pages.json", nonCanonicalBytes);
      const manifestBeforeRemove = await opened.pages.readManifest();
      if (manifestBeforeRemove instanceof Error)
        throw new Error(`fixture bug: ${manifestBeforeRemove.message}`);

      const removed = await opened.transactions.removePage({
        transactionId: uuidv7(),
        actionId: uuidv7(),
        manifestBefore: manifestBeforeRemove,
        pageSlug: home,
        createdAt: TS,
      });
      if (removed instanceof Error) throw removed;
      const manifestAfterRemove = await opened.pages.readManifest();
      if (manifestAfterRemove instanceof Error)
        throw new Error(`fixture bug: ${manifestAfterRemove.message}`);
      expect(manifestAfterRemove.pages.map((page) => page.slug)).toEqual([about]);
    } finally {
      await opened.close();
    }
  }, 20_000);

  test("removePage drops the manifest entry, the entry FILE and the pin log — and nothing else", async () => {
    const opened = await freshOpenProject();
    try {
      const home = slug("home");
      const about = slug("about");
      // Entries deliberately unrelated to their own slugs — proves `removePage` deletes by
      // reading `manifest.entry`, never by guessing a slug-shaped path.
      const homeEntry = "screens/home-view.tsx";
      const aboutEntry = "panels/about-panel.tsx";
      seedManifest(opened, {
        schemaVersion: 1,
        pages: [
          { slug: home, entry: homeEntry },
          { slug: about, entry: aboutEntry },
        ],
        requestedActivePage: null,
      });
      seedDesignFile(opened, homeEntry, new TextEncoder().encode("export default home;\n"));
      seedDesignFile(opened, aboutEntry, new TextEncoder().encode("export default about;\n"));
      // Both pages import this — removePage must NEVER delete a shared module (design §8
      // step 3: the design refuses to auto-delete a dead module), even one the removed
      // page's own entry happened to reach.
      seedDesignFile(
        opened,
        "lib/theme.ts",
        new TextEncoder().encode("export const theme = {};\n"),
      );

      const manifest = await opened.manifest.read();
      if (manifest instanceof Error) throw new Error(`fixture bug: ${manifest.message}`);

      const event: PinCreatedEvent = {
        kind: "pin:created",
        recordId: uuidv7(),
        pinId: uuidv7(),
        element: "button-1",
        fx: 0.5,
        fy: 0.5,
        text: "note",
        ts: TS,
      };
      const pinned = await opened.transactions.appendPinEvent({
        transactionId: uuidv7(),
        actionId: uuidv7(),
        pageSlug: home,
        projectId: manifest.projectId,
        event,
        createdAt: TS,
      });
      if (pinned instanceof Error) throw pinned;

      const manifestBefore = await opened.pages.readManifest();
      if (manifestBefore instanceof Error)
        throw new Error(`fixture bug: ${manifestBefore.message}`);
      const removed = await opened.transactions.removePage({
        transactionId: uuidv7(),
        actionId: uuidv7(),
        manifestBefore,
        pageSlug: home,
        createdAt: TS,
      });
      if (removed instanceof Error) throw removed;

      const manifestAfter = await opened.pages.readManifest();
      if (manifestAfter instanceof Error) throw new Error(`fixture bug: ${manifestAfter.message}`);
      expect(manifestAfter.pages).toEqual([{ slug: about, entry: aboutEntry }]);

      const sourceAfter = await opened.pages.readTreeFile(homeEntry);
      expect(sourceAfter instanceof Error).toBe(true); // the entry file is gone

      const pinsAfter = await opened.pins.fold(home);
      expect(pinsAfter).toEqual([]); // comments log is gone too — folding an absent log is `[]`

      // A module the removed page shared is NEVER deleted.
      const themeAfter = await opened.pages.readTreeFile("lib/theme.ts");
      expect(themeAfter instanceof Error).toBe(false);

      // The sibling page's own entry is untouched.
      const aboutAfter = await opened.pages.readTreeFile(aboutEntry);
      expect(aboutAfter instanceof Error).toBe(false);
    } finally {
      await opened.close();
    }
  }, 20_000);

  test("removePage on a page with no entry file/comments yet is a clean no-op delete, not an error", async () => {
    const opened = await freshOpenProject();
    try {
      const home = slug("home");
      seedManifest(opened, {
        schemaVersion: 1,
        pages: [{ slug: home, entry: "screens/home-view.tsx" }],
        requestedActivePage: null,
      });

      const manifestBefore = await opened.pages.readManifest();
      if (manifestBefore instanceof Error)
        throw new Error(`fixture bug: ${manifestBefore.message}`);
      const removed = await opened.transactions.removePage({
        transactionId: uuidv7(),
        actionId: uuidv7(),
        manifestBefore,
        pageSlug: home,
        createdAt: TS,
      });
      if (removed instanceof Error) throw removed;

      const manifestAfter = await opened.pages.readManifest();
      if (manifestAfter instanceof Error) throw new Error(`fixture bug: ${manifestAfter.message}`);
      expect(manifestAfter.pages).toEqual([]);
    } finally {
      await opened.close();
    }
  }, 20_000);

  // Design decision (task-9-brief.md's own open question: "how removePage should treat a
  // slug absent from the manifest"): idempotent, matching the no-op-delete case just above —
  // a retry of an already-completed removal (or a plan built against a slug some OTHER path
  // already dropped) must not fail. The pin log is still cleaned up regardless, since pins
  // key by slug independently of manifest membership.
  test("removePage on a pageSlug already absent from the manifest is a legal no-op on the manifest, and still cleans up any stray pin log", async () => {
    const opened = await freshOpenProject();
    try {
      const home = slug("home");
      const ghost = slug("ghost"); // never listed
      seedManifest(opened, {
        schemaVersion: 1,
        pages: [{ slug: home, entry: "screens/home-view.tsx" }],
        requestedActivePage: null,
      });

      const manifest = await opened.manifest.read();
      if (manifest instanceof Error) throw new Error(`fixture bug: ${manifest.message}`);
      const event: PinCreatedEvent = {
        kind: "pin:created",
        recordId: uuidv7(),
        pinId: uuidv7(),
        element: "button-1",
        fx: 0.5,
        fy: 0.5,
        text: "note",
        ts: TS,
      };
      const pinned = await opened.transactions.appendPinEvent({
        transactionId: uuidv7(),
        actionId: uuidv7(),
        pageSlug: ghost,
        projectId: manifest.projectId,
        event,
        createdAt: TS,
      });
      if (pinned instanceof Error) throw pinned;

      const manifestBefore = await opened.pages.readManifest();
      if (manifestBefore instanceof Error)
        throw new Error(`fixture bug: ${manifestBefore.message}`);
      const removed = await opened.transactions.removePage({
        transactionId: uuidv7(),
        actionId: uuidv7(),
        manifestBefore,
        pageSlug: ghost,
        createdAt: TS,
      });
      if (removed instanceof Error) throw removed;

      const manifestAfter = await opened.pages.readManifest();
      if (manifestAfter instanceof Error) throw new Error(`fixture bug: ${manifestAfter.message}`);
      expect(manifestAfter.pages).toEqual([{ slug: home, entry: "screens/home-view.tsx" }]); // untouched

      const pinsAfter = await opened.pins.fold(ghost);
      expect(pinsAfter).toEqual([]); // the stray pin log is gone
    } finally {
      await opened.close();
    }
  }, 20_000);

  // Same mechanism as `reorderPages`'s own drift test above — `removePage` ALSO rebuilds
  // `design/pages.json` wholesale from `manifestBefore` (`ManifestDriftedError`'s doc
  // comment, `store/model/factory.ts`).
  test("removePage refuses when design/pages.json drifted since manifestBefore was read — never overwrites a concurrent writer's page with stale content", async () => {
    const opened = await freshOpenProject();
    try {
      const home = slug("home");
      const about = slug("about");
      const pricing = slug("pricing");
      seedManifest(opened, {
        schemaVersion: 1,
        pages: [
          { slug: home, entry: "screens/home-view.tsx" },
          { slug: about, entry: "panels/about-panel.tsx" },
        ],
        requestedActivePage: null,
      });
      const manifestBefore = await opened.pages.readManifest();
      if (manifestBefore instanceof Error)
        throw new Error(`fixture bug: ${manifestBefore.message}`);

      // Simulate a concurrent writer landing a THIRD page directly on disk, after
      // `manifestBefore` was captured but before `removePage` acquires the write permit.
      const drifted: PagesManifestV1 = {
        schemaVersion: 1,
        pages: [...manifestBefore.pages, { slug: pricing, entry: "screens/pricing-view.tsx" }],
        requestedActivePage: null,
      };
      seedManifest(opened, drifted);
      seedDesignFile(opened, "screens/pricing-view.tsx", new TextEncoder().encode("pricing"));

      const rejected = await opened.transactions.removePage({
        transactionId: uuidv7(),
        actionId: uuidv7(),
        manifestBefore, // stale — the on-disk manifest now has 3 pages, not 2
        pageSlug: home,
        createdAt: TS,
      });
      expect(rejected).toBeInstanceOf(ManifestDriftedError);

      // The concurrent writer's page survives untouched — never silently overwritten with a
      // 1-page manifest derived from the stale 2-page snapshot.
      const manifestAfter = await opened.pages.readManifest();
      if (manifestAfter instanceof Error) throw new Error(`fixture bug: ${manifestAfter.message}`);
      expect(manifestAfter.pages).toEqual(drifted.pages);
      const pricingAfter = await opened.pages.readTreeFile("screens/pricing-view.tsx");
      expect(pricingAfter instanceof Error).toBe(false);
    } finally {
      await opened.close();
    }
  }, 20_000);

  // Important review finding, round 2: deleting `removePage`'s `requestedActivePage`-clearing
  // branch (`store/model/factory.ts`) would write a manifest whose `requestedActivePage`
  // still names the just-removed slug — which `decodePagesManifest`'s own `ACTIVE_NOT_LISTED`
  // check rejects on the very next read. Pinned with REAL bytes on disk, read back through
  // the REAL decoder (`readManifest()`), not a constructed value — a successful decode here
  // is only possible if the clearing genuinely happened, not merely that some in-memory
  // computation looked right.
  test("removePage clears requestedActivePage when it named the removed page — otherwise the manifest would fail its own decoder on the next read", async () => {
    const opened = await freshOpenProject();
    try {
      const home = slug("home");
      const about = slug("about");
      seedManifest(opened, {
        schemaVersion: 1,
        pages: [
          { slug: home, entry: "screens/home-view.tsx" },
          { slug: about, entry: "panels/about-panel.tsx" },
        ],
        requestedActivePage: home,
      });
      const manifestBefore = await opened.pages.readManifest();
      if (manifestBefore instanceof Error)
        throw new Error(`fixture bug: ${manifestBefore.message}`);
      expect(manifestBefore.requestedActivePage).toBe(home);

      const removed = await opened.transactions.removePage({
        transactionId: uuidv7(),
        actionId: uuidv7(),
        manifestBefore,
        pageSlug: home,
        createdAt: TS,
      });
      if (removed instanceof Error) throw removed;

      const manifestAfter = await opened.pages.readManifest();
      if (manifestAfter instanceof Error) throw new Error(`fixture bug: ${manifestAfter.message}`);
      expect(manifestAfter.requestedActivePage).toBeNull();
      expect(manifestAfter.pages).toEqual([{ slug: about, entry: "panels/about-panel.tsx" }]);
    } finally {
      await opened.close();
    }
  }, 20_000);

  test("listTree enumerates every design-tree file with its hash, sorted by relPath — [] when design/ does not exist yet", async () => {
    const opened = await freshOpenProject();
    try {
      // A FRESHLY CREATED project is no longer tree-less: task 16 seeds `design/pages.json`
      // with an empty `pages` array, and task 10 (design-systems §4.4) seeds the design
      // system's two files, all as part of the same creation transaction (design §3, §10). So
      // the "absent design/" case is reached by REMOVING the seeded tree, not by taking a new
      // project as-is — the honest-empty contract still has to hold for a project whose
      // `design/` was deleted outside the product.
      const seeded = await opened.pages.listTree();
      if (seeded instanceof Error) throw new Error(`fixture bug: ${seeded.message}`);
      expect(seeded.map((file) => file.relPath)).toEqual([
        "pages.json",
        DESIGN_SYSTEM_MANIFEST_RELPATH,
        DESIGN_SYSTEM_TOKENS_RELPATH,
      ]);

      fs.rmSync(designPath(opened, ""), { recursive: true, force: true });
      const empty = await opened.pages.listTree();
      if (empty instanceof Error) throw new Error(`fixture bug: ${empty.message}`);
      expect(empty).toEqual([]); // an absent `design/` is an honest empty tree, not a failure

      const home = slug("home");
      seedManifest(opened, {
        schemaVersion: 1,
        pages: [{ slug: home, entry: "screens/home-view.tsx" }],
        requestedActivePage: null,
      });
      seedDesignFile(opened, "screens/home-view.tsx", new TextEncoder().encode("home"));
      seedDesignFile(opened, "lib/theme.ts", new TextEncoder().encode("theme"));

      const inventory = await opened.pages.listTree();
      if (inventory instanceof Error) throw new Error(`fixture bug: ${inventory.message}`);
      expect(inventory.map((file) => file.relPath).sort()).toEqual([
        "lib/theme.ts",
        "pages.json",
        "screens/home-view.tsx",
      ]);
      expect(inventory.every((file) => file.size > 0)).toBe(true);
    } finally {
      await opened.close();
    }
  }, 20_000);

  // Important review finding, round 2: `listSlugs()`'s ENOENT-only exception (an ABSENT
  // `design/pages.json` resolves `[]`, `store/model/design-tree-store.ts`) is the entire contract this
  // task's ambiguity resolution rests on. Without a test proving a PRESENT-but-invalid file
  // still refuses, a future refactor to a blanket `catch -> []` would pass the whole suite
  // and silently paper over real corruption. Both pinned with REAL bytes on disk, not a
  // constructed error in a fake.
  describe("listSlugs() — the ENOENT-only exception, pinned both ways", () => {
    test("refuses a genuinely EMPTY design/pages.json — present-but-empty is not the same as absent", async () => {
      const opened = await freshOpenProject();
      try {
        seedDesignFile(opened, "pages.json", new Uint8Array(0));
        const slugs = await opened.pages.listSlugs();
        expect(slugs).toBeInstanceOf(PagesManifestInvalidError);
      } finally {
        await opened.close();
      }
    }, 20_000);

    test("refuses a genuinely CORRUPT (malformed JSON) design/pages.json", async () => {
      const opened = await freshOpenProject();
      try {
        seedDesignFile(opened, "pages.json", new TextEncoder().encode("{not valid json"));
        const slugs = await opened.pages.listSlugs();
        expect(slugs).toBeInstanceOf(PagesManifestInvalidError);
      } finally {
        await opened.close();
      }
    }, 20_000);

    test("still resolves [] when design/pages.json is genuinely ABSENT — the one case this exception covers", async () => {
      const opened = await freshOpenProject();
      try {
        const slugs = await opened.pages.listSlugs();
        expect(slugs).toEqual([]);
      } finally {
        await opened.close();
      }
    }, 20_000);
  });

  test("appendPinEvent appends one comments-log event — pin.setStatus and standalone pin:created", async () => {
    const opened = await freshOpenProject();
    try {
      const manifest = await opened.manifest.read();
      if (manifest instanceof Error) throw new Error(`fixture bug: ${manifest.message}`);
      const home = slug("home");
      const pinId = uuidv7();
      const created: PinCreatedEvent = {
        kind: "pin:created",
        recordId: uuidv7(),
        pinId,
        element: "button-1",
        fx: 0.25,
        fy: 0.75,
        text: "looks off",
        ts: TS,
      };
      const createdResult = await opened.transactions.appendPinEvent({
        transactionId: uuidv7(),
        actionId: uuidv7(),
        pageSlug: home,
        projectId: manifest.projectId,
        event: created,
        createdAt: TS,
      });
      if (createdResult instanceof Error) throw createdResult;

      const pinsAfterCreate = await opened.pins.fold(home);
      if (pinsAfterCreate instanceof Error)
        throw new Error(`fixture bug: ${pinsAfterCreate.message}`);
      expect(pinsAfterCreate).toEqual([
        { pinId, element: "button-1", fx: 0.25, fy: 0.75, text: "looks off", status: "open" },
      ]);

      // pin.setStatus: a user-driven resolve, `actionId` set (not `turnId`). The log already
      // exists after the create above, so this exercises the single-operation append branch.
      const resolved = await opened.transactions.appendPinEvent({
        transactionId: uuidv7(),
        actionId: uuidv7(),
        pageSlug: home,
        projectId: manifest.projectId,
        event: {
          kind: "pin:status",
          recordId: uuidv7(),
          pinId,
          status: "resolved",
          actionId: uuidv7(),
          ts: TS,
        },
        createdAt: TS,
      });
      if (resolved instanceof Error) throw resolved;

      const pinsAfterResolve = await opened.pins.fold(home);
      if (pinsAfterResolve instanceof Error)
        throw new Error(`fixture bug: ${pinsAfterResolve.message}`);
      expect(pinsAfterResolve).toEqual([
        { pinId, element: "button-1", fx: 0.25, fy: 0.75, text: "looks off", status: "resolved" },
      ]);
    } finally {
      await opened.close();
    }
  }, 20_000);

  test("setWorkspaceLocal shallow-merges onto current state — model.select and every other local field", async () => {
    const opened = await freshOpenProject();
    try {
      const first = await opened.transactions.setWorkspaceLocal({
        transactionId: uuidv7(),
        actionId: uuidv7(),
        patch: { backend: "claude-code" },
        createdAt: TS,
      });
      if (first instanceof Error) throw first;

      // model.select: a SECOND call naming only `model` must not clobber the FIRST call's `backend`.
      const second = await opened.transactions.setWorkspaceLocal({
        transactionId: uuidv7(),
        actionId: uuidv7(),
        patch: { model: "sonnet-5" },
        createdAt: TS,
      });
      if (second instanceof Error) throw second;

      const state = await opened.workspaceState.read();
      if (state instanceof Error) throw new Error(`fixture bug: ${state.message}`);
      expect(state.state.backend).toBe("claude-code");
      expect(state.state.model).toBe("sonnet-5");
    } finally {
      await opened.close();
    }
  }, 20_000);

  test("advanceSessionCheckpoint hashes the target chat's current prefix and durably records it — checkpoint persistence", async () => {
    const opened = await freshOpenProject();
    try {
      const chatFiles = fs.readdirSync(path.join(opened.root, ".termcraft", "chats"));
      const chatId = chatFiles[0]?.replace(/\.jsonl$/, "");
      if (chatId === undefined) throw new Error("fixture bug: no chat file");

      const userRecord = {
        kind: "user" as const,
        recordId: uuidv7(),
        turnId: uuidv7(),
        text: "hello",
        ts: TS,
      };
      const admitted = await opened.transactions.admitTurn({
        transactionId: uuidv7(),
        turnId: userRecord.turnId,
        targetChatId: chatId,
        userRecord,
        createdAt: TS,
      });
      if (admitted instanceof Error) throw admitted;

      const sessionScopeId = "scope-a";
      const sessionId = uuidv7();
      const result = await opened.transactions.advanceSessionCheckpoint({
        transactionId: uuidv7(),
        actionId: uuidv7(),
        chatId,
        sessionScopeId,
        sessionId,
        recordCount: 1,
        createdAt: TS,
      });
      if (result instanceof Error) throw result;

      const chatBytes = fs.readFileSync(
        path.join(opened.root, ".termcraft", "chats", `${chatId}.jsonl`),
      );
      const expectedHash = computeSessionPrefixHash({ chunks: [chatBytes], recordCount: 1 });
      if (expectedHash instanceof Error) throw new Error(`fixture bug: ${expectedHash.message}`);

      const state = await opened.workspaceState.read();
      if (state instanceof Error) throw new Error(`fixture bug: ${state.message}`);
      expect(state.state.sessionCheckpoints).toEqual([
        { chatId, sessionScopeId, sessionId, recordCount: 1, prefixHash: expectedHash.prefixHash },
      ]);

      // A second, DIFFERENT session scope on the same chat coexists alongside the first.
      const otherScopeId = "scope-b";
      const otherSessionId = uuidv7();
      const secondResult = await opened.transactions.advanceSessionCheckpoint({
        transactionId: uuidv7(),
        actionId: uuidv7(),
        chatId,
        sessionScopeId: otherScopeId,
        sessionId: otherSessionId,
        recordCount: 1,
        createdAt: TS,
      });
      if (secondResult instanceof Error) throw secondResult;
      const stateAfterSecond = await opened.workspaceState.read();
      if (stateAfterSecond instanceof Error)
        throw new Error(`fixture bug: ${stateAfterSecond.message}`);
      expect(stateAfterSecond.state.sessionCheckpoints).toHaveLength(2);

      // Re-advancing the FIRST scope replaces its entry rather than appending a duplicate.
      const secondUserRecord = {
        kind: "user" as const,
        recordId: uuidv7(),
        turnId: uuidv7(),
        text: "again",
        ts: TS,
      };
      const admittedAgain = await opened.transactions.admitTurn({
        transactionId: uuidv7(),
        turnId: secondUserRecord.turnId,
        targetChatId: chatId,
        userRecord: secondUserRecord,
        createdAt: TS,
      });
      if (admittedAgain instanceof Error) throw admittedAgain;

      const readvanced = await opened.transactions.advanceSessionCheckpoint({
        transactionId: uuidv7(),
        actionId: uuidv7(),
        chatId,
        sessionScopeId,
        sessionId,
        recordCount: 2,
        createdAt: TS,
      });
      if (readvanced instanceof Error) throw readvanced;
      const finalState = await opened.workspaceState.read();
      if (finalState instanceof Error) throw new Error(`fixture bug: ${finalState.message}`);
      expect(finalState.state.sessionCheckpoints).toHaveLength(2);
      const scopeAEntry = finalState.state.sessionCheckpoints.find(
        (entry) => entry.sessionScopeId === sessionScopeId,
      );
      expect(scopeAEntry?.recordCount).toBe(2);
    } finally {
      await opened.close();
    }
  }, 20_000);
});
