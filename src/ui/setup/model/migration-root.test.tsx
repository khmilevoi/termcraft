import { afterEach, describe, expect, test } from "bun:test";

import { atom } from "@reatom/core";

import type { ReactTestRenderer } from "ui/testing";
import { createReactTestRenderer } from "ui/testing";

import type { MigratePromptViewV1 } from "../types";
import type { MigrationChoiceV1 } from "./migration-root";
import { MigrationSurface, migrationChoiceForKey } from "./migration-root";

const key = (over: { name?: string; ctrl?: boolean }) => ({
  name: over.name ?? "",
  ctrl: over.ctrl ?? false,
});

describe("migrationChoiceForKey (design §12.1's `⏎ migrate` / `esc later`)", () => {
  test("enter confirms", () => {
    expect(migrationChoiceForKey(key({ name: "return" }))).toBe("migrate");
  });

  test("escape declines", () => {
    expect(migrationChoiceForKey(key({ name: "escape" }))).toBe("later");
  });

  test("ctrl-c declines rather than confirming", () => {
    expect(migrationChoiceForKey(key({ name: "c", ctrl: true }))).toBe("later");
  });

  test("a bare c is not ctrl-c", () => {
    expect(migrationChoiceForKey(key({ name: "c" }))).toBeNull();
  });

  test("every other key is ignored", () => {
    for (const name of ["a", "space", "up", "tab", "y", "n"])
      expect(migrationChoiceForKey(key({ name }))).toBeNull();
  });
});

const VIEW: MigratePromptViewV1 = {
  pageCount: 2,
  pinLogCount: 0,
  backupsDir: "C:\\Users\\dev\\AppData\\Local\\termcraft\\backups\\019fa002",
};

// `migrationChoiceForKey` above is proven in isolation, and `run-migration.test.ts`'s
// `answeringAdapters` proves `runMigrationPrompt` reacts to whatever `onChoice` reports — but
// neither ever mounts `MigrationSurface`, so neither exercises the real
// `useKeyboard` -> `migrationChoiceForKey` -> `onChoice` wire. A real `CliRenderer` and a real
// keypress (`mockInput`, the same seam `App.test.tsx` uses for its own `useKeyboard` coverage)
// close that gap: if `MigrationSurface` stopped calling `onChoice` correctly, every other
// existing test would stay green, but the tests below would not.
describe("MigrationSurface (the real useKeyboard -> migrationChoiceForKey -> onChoice wire)", () => {
  let open: ReactTestRenderer | null = null;
  afterEach(async () => {
    await open?.destroy();
    open = null;
  });

  async function mountSurface(onChoice: (choice: MigrationChoiceV1) => void) {
    const working = atom(false, "test.ui.setup.migrationWorking");
    const renderer = await createReactTestRenderer(
      <MigrationSurface
        size={{ w: 80, h: 24 }}
        view={VIEW}
        working={working}
        onChoice={onChoice}
      />,
      // `kittyKeyboard: true`, matching `App.test.tsx`'s own `pressEscape` calls — without it the
      // mock's escape sequence never reaches `useKeyboard` as `key.name === "escape"`.
      { width: 80, height: 24, kittyKeyboard: true },
    );
    open = renderer;
    // Confirms the surface actually painted (and so `useKeyboard` registered its handler)
    // before a key is sent — the same title `MigratePrompt.test.tsx` asserts on.
    await renderer.waitForFrame((frame) => frame.includes("migrate project"));
    return renderer;
  }

  test("a real Enter keypress reaches useKeyboard and fires onChoice('migrate')", async () => {
    const choices: MigrationChoiceV1[] = [];
    const renderer = await mountSurface((choice) => choices.push(choice));

    await renderer.act(() => renderer.mockInput.pressEnter());

    expect(choices).toEqual(["migrate"]);
  });

  test("a real Escape keypress reaches useKeyboard and fires onChoice('later')", async () => {
    const choices: MigrationChoiceV1[] = [];
    const renderer = await mountSurface((choice) => choices.push(choice));

    await renderer.act(() => renderer.mockInput.pressEscape());

    expect(choices).toEqual(["later"]);
  });
});
