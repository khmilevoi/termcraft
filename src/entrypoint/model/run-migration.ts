import * as errore from "errore";

import type { MigrationOutcomeV1, Store } from "store";
import type { UiRootAdapters } from "ui";
import { createMigrationRoot } from "ui/setup";

import type { MigrationRequiredV1 } from "../types";

/**
 * The user chose `esc later`. NOT a failure: nothing is broken and nothing was written — the
 * project simply stays on its old format. `main.tsx` prints this as one plain line and exits 0,
 * which is why it is a distinct class rather than a generic `Error`.
 *
 * RECORDED DIVERGENCE from design §12.1, which says `esc later` "returns to Home": Home renders
 * inside an app whose Kernel is built from an `OpenProject` (`entrypoint/model/create-shell.ts`),
 * and a project on an old format cannot produce one — that is §12.1's own premise. termcraft also
 * opens exactly one root per process, so there is no other project to return to. Exiting with the
 * root named is the closest honest behaviour; the alternative (a project-less Kernel mode) is a
 * structural change larger than the migration itself, and was ruled out when this plan was written.
 *
 * `$found` (design-systems §9 Step 8) generalizes the message from the hard-coded "format_version
 * 1": the offer now also fires for a version-2 project, and the declined message must name
 * whichever format the user actually declined to migrate off of.
 */
export class MigrationDeclinedError extends errore.createTaggedError({
  name: "MigrationDeclinedError",
  message:
    "$root is a format_version $found project and was not migrated — nothing was written. Run termcraft again to be offered the migration.",
}) {}

/**
 * Draw the `migrate-80` offer and act on the one key it answers (design §12.1; design-systems
 * §9). Returns the completed migration's outcome, the user's declination, or the migration's own
 * failure.
 *
 * `kitApiVersion` is threaded straight to `store.migrateProject` — this function never imports
 * `runtime` itself (`store` must not, and `entrypoint` keeps the same routing precedent
 * `CreateProjectInput.kitApiVersion` set: `bootstrap.ts` supplies
 * `EMBEDDED_RUNTIME_DECLARATION.currentKitApiVersion`).
 */
export async function runMigrationPrompt(input: {
  readonly required: MigrationRequiredV1;
  readonly store: Store;
  readonly kitApiVersion: number;
  readonly adapters?: UiRootAdapters;
}): Promise<MigrationDeclinedError | Error | MigrationOutcomeV1> {
  const root = await createMigrationRoot({
    view: {
      fromVersion: input.required.plan.fromVersion,
      toVersion: input.required.plan.toVersion,
      pageCount: input.required.plan.pageCount,
      pinLogCount: input.required.plan.pinLogCount,
      seedsDesignSystem: input.required.plan.seedsDesignSystem,
      backupsDir: input.required.plan.backupsDir,
    },
    adapters: input.adapters,
  });
  if (root instanceof Error) return root;

  const choice = await root.choice;
  if (choice === "later") {
    root.dispose();
    return new MigrationDeclinedError({
      root: input.required.root,
      found: input.required.plan.fromVersion,
    });
  }

  // The dialog stays mounted while track 1 runs — there is nothing else to draw, and the key row
  // says so. `try`/`finally`, not a following statement, so `dispose()` runs even if
  // `migrateProject` throws instead of returning its error as a value (errore discipline means it
  // shouldn't, but this makes "never leaves the terminal in raw mode" structurally true rather
  // than merely likely — the same shape `mountRenderRoot` itself uses on its own release paths,
  // `ui/app/model/render-root.tsx`).
  root.setWorking(true);
  try {
    return await input.store.migrateProject(input.required.root, {
      kitApiVersion: input.kitApiVersion,
    });
  } finally {
    root.dispose();
  }
}
