import type { ParsedKey } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { type Atom, atom } from "@reatom/core";
import { reatomComponent, useWrap } from "@reatom/react";

import { UiRootError, defaultAdapters, mountRenderRoot } from "ui/app";
import type { UiRootAdapters } from "ui/app";

import type { MigratePromptViewV1 } from "../types";
import { MigratePrompt } from "../ui/MigratePrompt";

/** Which key the user pressed on the `migrate-80` offer (design §12.1). */
export type MigrationChoiceV1 = "migrate" | "later";

/**
 * The dialog's whole key contract, as a pure function so it is provable without a terminal.
 *
 * `ctrl+c` maps to `"later"`, not to nothing: `UI_RENDERER_CONFIG` sets `exitOnCtrlC: false`
 * (`ui/app/model/root.tsx`), so an unmapped chord would leave the user in a dialog whose only
 * working exit is the one that writes to their project. `null` means "ignored" — the offer has
 * exactly two answers and invents no third.
 */
export function migrationChoiceForKey(key: {
  readonly name: string;
  readonly ctrl?: boolean;
}): MigrationChoiceV1 | null {
  if (key.name === "return") return "migrate";
  if (key.name === "escape") return "later";
  if (key.ctrl === true && key.name === "c") return "later";
  return null;
}

/**
 * Mount the `migrate-80` offer as the ONLY thing on screen, before any Kernel exists
 * (design §12.1's original wording: "a version-1 project never opens ... the dialog is the only
 * thing the project produces" — design-systems §9 / plan P4 decision D8 made format 2 a SECOND
 * migratable origin that reaches this same dialog, so "a version-1 project" is no longer the only
 * project this offer can be drawn for). Returns a promise that settles on the first decisive key,
 * plus a `setWorking` the caller flips before running the migration so the key row becomes
 * `⠹ migrating…`.
 *
 * `ctrl+c` resolves `"later"`, not `"migrate"`: `UI_RENDERER_CONFIG` sets `exitOnCtrlC: false`, so
 * without this the chord would do nothing at all and the user would be stuck in a dialog with no
 * exit but the one that writes to their project.
 */
export async function createMigrationRoot(options: {
  readonly view: MigratePromptViewV1;
  readonly adapters?: UiRootAdapters;
}): Promise<
  | UiRootError
  | {
      readonly choice: Promise<MigrationChoiceV1>;
      setWorking(working: boolean): void;
      dispose(): void;
    }
> {
  const { promise: choice, resolve } = Promise.withResolvers<MigrationChoiceV1>();
  const working = atom(false, "ui.setup.migrationWorking");
  let settled = false;

  const mounted = await mountRenderRoot(options.adapters ?? defaultAdapters, (size) => (
    <MigrationSurface
      size={size}
      view={options.view}
      working={working}
      onChoice={(picked) => {
        // First key wins: a second Enter while the migration is running must not start a second.
        if (settled) return;
        settled = true;
        resolve(picked);
      }}
    />
  ));
  if (mounted instanceof Error) return mounted;

  return {
    choice,
    // `atom.set` directly, not a pass-through setter action (Reatom RTM-S01).
    setWorking: (next) => working.set(next),
    dispose: () => mounted.dispose(),
  };
}

/**
 * The keyboard handler and the one atom read, kept in a component so `useKeyboard` has a host.
 * Exported so `migration-root.test.tsx` can mount it directly through a real headless renderer
 * and drive real keypresses at `useKeyboard` — `createMigrationRoot`'s own adapters seam only
 * ever reaches `onChoice` synthetically (see `run-migration.test.ts`'s `answeringAdapters`),
 * never through a real key.
 */
export const MigrationSurface = reatomComponent<{
  readonly size: { readonly w: number; readonly h: number };
  readonly view: MigratePromptViewV1;
  readonly working: Atom<boolean>;
  readonly onChoice: (choice: MigrationChoiceV1) => void;
}>((props) => {
  // `useWrap`, not a bare `wrap` — `useKeyboard`'s handler is invoked later by @opentui's keyboard
  // event source, not a frame the component is already inside, so it needs the adapter-bound form
  // (RTM-A04's own exception list; the identical shape at `ui/app/ui/App.tsx`'s `onKey`).
  const onKey = useWrap((key: ParsedKey) => {
    if (props.working()) return; // the migration is running; both keys are spent
    const choice = migrationChoiceForKey(key);
    if (choice !== null) props.onChoice(choice);
  });
  useKeyboard(onKey);
  return (
    <MigratePrompt
      id="setup-migrate"
      width={props.size.w}
      height={props.size.h}
      view={props.view}
      working={props.working()}
    />
  );
}, "ui.setup.MigrationSurface");
