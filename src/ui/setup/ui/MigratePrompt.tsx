import { SHELL_PALETTE, shellAttrs } from "ui/theme";

import type { MigratePromptViewV1 } from "../types";

export interface MigratePromptProps {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly view: MigratePromptViewV1;
  /** `true` between `⏎` and the migration's result — see the working-state divergence below. */
  readonly working: boolean;
}

const BOLD = shellAttrs({ bold: true });

/** design `migrate()`: `pw = min(64, w-4)`, `ph = min(16, h-2)` (`termcraft-engine.js:824`). */
const BOX_WIDTH = (width: number) => Math.min(64, width - 4);
const BOX_HEIGHT = (height: number) => Math.min(16, height - 2);

/** The inner text column's budget: `pw` less the border, the `lx = px+3` indent and the bullet's own. */
const bulletBudget = (width: number) => BOX_WIDTH(width) - 6;

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * The bullets, populated with THIS migration's real plan (design §12.1: "the bullet list is
 * populated for this migration with the real plan: pages moved into `design/`, `pages.json`
 * synthesized from the existing order, pin logs relocated, `project.toml` rewritten"; design-
 * systems §9 extends this to the version-2 origin, which relocates nothing and seeds
 * `design/system/` instead).
 *
 * DIVERGENCE (recorded, not silent): the mock's own three bullets are its sample content for a
 * different migration (`3 pages → current page.tsx`, `kit 2.1 · tweaks · pins · agent choice`).
 * §12.1's four facts are carried on the mock's three lines rather than growing the 16-row box,
 * because the box height is design and the sample copy is not: the third line pairs the pin logs
 * with the manifest rewrite, and states the rewrite alone when the project has no pin logs.
 *
 * `view.fromVersion === 2` draws the version-2 -> 3 bullets instead: no moves at all (ruling 1's
 * "no page source byte is edited" applies doubly here — a version-2 project's sources were
 * already in `design/`), so the bullets must not claim any.
 */
export function migrateBullets(view: MigratePromptViewV1): readonly string[] {
  const versionBullet = `project.toml → format_version ${view.toVersion}`;
  if (view.fromVersion === 2) {
    return [
      `${plural(view.pageCount, "page")} — sources untouched`,
      view.seedsDesignSystem
        ? "design/system/ ← the default design system"
        : "design/system/ — already present",
      versionBullet,
    ];
  }
  return [
    `${plural(view.pageCount, "page")} → design/pages/<slug>.tsx`,
    "design/pages.json ← the order in project.toml",
    view.pinLogCount === 0
      ? versionBullet
      : `${plural(view.pinLogCount, "pin log")} → pins/<slug>.jsonl · ${versionBullet}`,
    ...(view.seedsDesignSystem ? ["design/system/ ← the default design system"] : []),
  ];
}

/**
 * Truncate from the LEFT with a leading `…`, keeping the tail. A backup path's identifying part is
 * its end (`backups/<projectId>`); truncating the tail would show the same user-state prefix for
 * every project. The mock's own path is short enough never to need this — this exists because the
 * REAL path (see the component's divergence note) is not.
 */
function fitPathFromRight(value: string, budget: number): string {
  if (value.length <= budget) return value;
  return `…${value.slice(value.length - (budget - 1))}`;
}

/**
 * The `migrate-80` migration offer (design/16-wizard-migration.dc.html; `migrate()` in
 * design/termcraft-engine.js:823-834). A SETUP-TIER dialog: it is shown before the workspace
 * exists, never layered over it (§12.1), which is why it lives in `ui/setup` rather than beside
 * the Workspace popups.
 *
 * DIVERGENCE 1 — the bullet strings: see {@link migrateBullets}.
 *
 * DIVERGENCE 2 — the backup path: the mock draws `.termcraft/backup-2026-07-13/`, inside the
 * project. `docs/architecture/storage.md` item 17 and the implemented backup store place backups
 * at `{userStateRoot}/backups/<projectId>/<migrationActionId>/`, OUTSIDE `.termcraft`, so a Git
 * operation cannot clobber them. Design §12.3 records this explicitly: "the storage design wins;
 * the dialog shows the real path, and the divergence is documented at the render site." This is
 * that site. The per-action subdirectory is absent because `migrationActionId` is minted at
 * confirm time — naming it here would draw a path that does not exist yet.
 *
 * DIVERGENCE 3 — the working state: the mock has none, and the mechanical migration takes real
 * time. Leaving `⏎ migrate` on screen while it runs would present a key that does nothing. The
 * key row is therefore replaced by `⠹ migrating…`, transferred from the design's own
 * `home('checking')` state (`termcraft-engine.js:148`,`:158`) — existing design vocabulary for
 * "this is working", not an invented indicator. Like design's own, the glyph is static.
 *
 * DIVERGENCE 4 — no rule, no bottom anchor: `migrate()` (`termcraft-engine.js:832-833`) draws an
 * `hline` with `├`/`┤` connectors at `py+ph-3`, then the key row at the fixed offset `py+ph-2` —
 * two rows up from the box's own bottom border, regardless of how tall the content above it is.
 * This component draws neither: no rule is rendered, and the key/working row sits wherever
 * ordinary column flex flow puts it, directly under the backup-path text. Any leftover height
 * from the box's fixed budget (`BOX_HEIGHT`, same formula as the mock's `ph`) ends up as blank
 * space below the key row instead of between the backup path and it. The mock's canvas draws by
 * absolute (x, y) coordinate, so "two rows above the border" costs nothing extra; reproducing
 * that here would need an explicit spacer (e.g. a flex-grow filler row) this component does not
 * have. That is a plausible reason, not a confirmed one — no design note or task record says the
 * anchor was deliberately dropped, so this is recorded as an unreconciled gap, not a verified
 * tradeoff.
 */
export function MigratePrompt(props: MigratePromptProps) {
  const bullets = migrateBullets(props.view);
  return (
    <box
      id={props.id}
      width={props.width}
      height={props.height}
      backgroundColor={SHELL_PALETTE.bg}
      position="absolute"
      top={0}
      left={0}
      alignItems="center"
      justifyContent="center"
    >
      <box
        id={`${props.id}-box`}
        width={BOX_WIDTH(props.width)}
        height={BOX_HEIGHT(props.height)}
        border
        borderStyle="rounded"
        borderColor={SHELL_PALETTE.amber}
        title="migrate project"
        titleColor={SHELL_PALETTE.amberHi}
        backgroundColor={SHELL_PALETTE.bg}
        flexDirection="column"
        paddingLeft={2}
        paddingTop={1}
      >
        <text id={`${props.id}-warning`} fg={SHELL_PALETTE.amberHi} attributes={BOLD}>
          ⚠ opened a project from an older termcraft
        </text>
        <text id={`${props.id}-lead`} fg={SHELL_PALETTE.dim} marginTop={1}>
          will migrate to the current format:
        </text>
        {bullets.map((bullet, index) => (
          <text
            id={`${props.id}-bullet-${index}`}
            key={bullet}
            fg={SHELL_PALETTE.fg}
            marginLeft={2}
          >
            {`• ${bullet}`}
          </text>
        ))}
        <text id={`${props.id}-git`} fg={SHELL_PALETTE.faint} marginTop={1}>
          git history is left untouched — only current sources migrate
        </text>
        <text id={`${props.id}-backup`} fg={SHELL_PALETTE.amberHi} marginLeft={2}>
          {fitPathFromRight(props.view.backupsDir, bulletBudget(props.width))}
        </text>
        {props.working ? (
          <box id={`${props.id}-working`} flexDirection="row" marginTop={1}>
            <text id={`${props.id}-working-text`} fg={SHELL_PALETTE.amber} attributes={BOLD}>
              ⠹ migrating…
            </text>
          </box>
        ) : (
          <box id={`${props.id}-keys`} flexDirection="row" marginTop={1}>
            <text id={`${props.id}-migrate`} fg={SHELL_PALETTE.amber} attributes={BOLD}>
              ⏎ migrate
            </text>
            <text id={`${props.id}-later`} fg={SHELL_PALETTE.dim}>
              {"  · esc later"}
            </text>
          </box>
        )}
      </box>
    </box>
  );
}
