import type {
  DesignSystemBreakageDtoV1,
  DesignSystemPreviewDtoV1,
  DesignSystemSummaryDtoV1,
  FailureDtoV1,
} from "core/protocol";
import { SHELL_PALETTE, shellAttrs } from "ui/theme";

const BOLD = shellAttrs({ bold: true });

const RULE_WIDTH = 60;

export type DesignSystemPromptKind = "install" | "publish";

/**
 * What is in flight, or `null` while nothing is. A single `busy: boolean` (this prop's shape
 * before task-13 fix round 1) could not tell D7's Gate-check freeze (`"checking"`) apart from a
 * confirmed `designSystem.install` dispatch (`"installing"`) — both are `kind === "install"`, so
 * the dialog read "⠹ installing…" during the CHECK, before the user had even confirmed anything,
 * which is factually wrong at that moment. The caller (`App.tsx`) now passes the exact verb
 * straight off the mirror's own phase rather than a bare flag this component would have to
 * re-derive a verb for. `"publishing"` exists for the symmetrical future case — no `Design
 * SystemPhase` currently represents "a publish is in flight" (`core/protocol`'s union has no
 * `"publishing"` member), so no caller passes it today; kept in the union rather than added later
 * so the render branch below never needs a second shape change to grow it.
 */
export type DesignSystemBusyPhase = "checking" | "installing" | "publishing";

export interface DesignSystemInstallPromptProps {
  readonly id: string;
  readonly kind: DesignSystemPromptKind;
  readonly ref: string;
  readonly summary: DesignSystemSummaryDtoV1 | null;
  readonly preview: DesignSystemPreviewDtoV1 | null;
  readonly failure: FailureDtoV1 | null;
  readonly busyPhase: DesignSystemBusyPhase | null;
}

/** One `• ` bullet's diagnostic attribution: the file it names, or "the whole tree" when the Gate
 * raised it unattributed — the same absence D6 treats as a whole-tree fatal, not a page-scoped one. */
function formatBreakageItem(item: DesignSystemBreakageDtoV1): string {
  return `${item.file ?? "the whole tree"}: ${item.message}`;
}

export const MAX_RENDERED_BULLETS = 8;

/** Bounds a diagnostic list to `max` lines, appending one truncation line naming how many were
 * elided rather than silently dropping them — the count stays true even when not every line is
 * drawn (D6: "the designer sees the list and decides"). */
function boundedBullets(
  items: readonly DesignSystemBreakageDtoV1[],
  max: number,
): readonly string[] {
  if (items.length <= max) return items.map(formatBreakageItem);
  return [...items.slice(0, max).map(formatBreakageItem), `… and ${items.length - max} more`];
}

/**
 * The `• ` lines for a preview's FATAL diagnostics only. Warnings are rendered by the component
 * itself, bounded the same way but painted `SHELL_PALETTE.faint` instead of `SHELL_PALETTE.fg` —
 * folding them into this function would lose the colour split D8's vocabulary requires.
 */
export function breakageBullets(preview: DesignSystemPreviewDtoV1): readonly string[] {
  return boundedBullets(preview.errors, MAX_RENDERED_BULLETS);
}

function verdictHeadline(verdict: DesignSystemPreviewDtoV1["verdict"]): string {
  if (verdict === "clean") return "nothing breaks";
  if (verdict === "breaks-pages") return "this will break pages";
  return "this package can't be installed";
}

/** `midnight 1.3.0` from the loaded summary, or the raw ref text when no summary landed yet. */
function targetLabel(props: Pick<DesignSystemInstallPromptProps, "ref" | "summary">): string {
  if (props.summary === null) return props.ref;
  return `${props.summary.name} ${props.summary.version}`;
}

function dialogTitle(kind: DesignSystemPromptKind): string {
  return kind === "install" ? "install design system" : "publish design system";
}

/**
 * The breakage-preview / install-confirm dialog, and the publish confirmation that shares its
 * frame (P10 plan §10.1 Wave 3, task 12). §12's rule for this screen: "Replacing a design system
 * can break pages. Surfaced before commit; not prevented." — the designer sees the complete list
 * (D6) and decides; a `blocked` preview is the one case that refuses instead of asking.
 *
 * **Design source of truth (D8's second vocabulary):** `design/16-wizard-migration.dc.html`,
 * engine `migrate(w,h)` (`design/termcraft-engine.js:880`-892) — a `⚠ …` headline in
 * `pal.amberHi` bold, a `dim` "will … :" lead-in, `• ` bullets in `pal.fg`, a `pal.faint`
 * consequence line, a `├`…`┤` rule, and a footer of `⏎ <verb>` in `pal.amber` bold followed by
 * `· esc <alternative>` in `pal.dim`. `src/ui/setup/ui/MigratePrompt.tsx` already realizes that
 * vocabulary in code; this component mirrors its structure rather than deriving a layout afresh.
 * Every colour is `ui/theme`'s `SHELL_PALETTE`, transcribed verbatim from `termcraft-engine.js`'s
 * `pal` — none is invented.
 *
 * DIVERGENCE 1 — two extra states the mock's single dialog never had to represent: `failure`
 * (a terminal operation error) and `busyPhase` (a command in flight, D7's "the picker has already
 * painted 'checking…' when the thread freezes" applied to THIS dialog's own submit — see {@link
 * DesignSystemBusyPhase}'s own doc comment for why this is a verb, not a bare flag). Both borrow
 * established vocabulary rather than inventing new colour or glyph rules: the failure band is the
 * same `SHELL_PALETTE.red` bold headline `ExportFailurePopup` uses, and the busy line is the same
 * `⠹ <verb>…` static-spinner pattern `MigratePrompt`'s own `working` divergence uses for the
 * identical reason — leaving the `⏎` key on screen while the thread is frozen would present a key
 * that does nothing.
 *
 * DIVERGENCE 2 — no `.dc.html` screen shows a PUBLISH confirmation (`local` publish has no Gate
 * preview to classify — it is the project's OWN already-passing system, so there is nothing to
 * classify). The `kind === "publish"` branch reuses the same frame with a shorter, preview-free
 * body instead of inventing a second dialog family.
 *
 * DIVERGENCE 3 — same as `DesignSystemPicker`'s own recorded divergence: `migrate()` draws its
 * `├`…`┤` rule into the box's own border cells, which a flex child cannot reach; a full-width `─`
 * line inside the box is the closest faithful mapping (matches `DesignSystemPicker`'s identical
 * choice, not a fresh one).
 */
export function DesignSystemInstallPrompt(props: DesignSystemInstallPromptProps) {
  if (props.busyPhase !== null) {
    return (
      <box
        id={props.id}
        border
        borderStyle="rounded"
        borderColor={SHELL_PALETTE.amber}
        title={dialogTitle(props.kind)}
        titleColor={SHELL_PALETTE.amberHi}
        backgroundColor={SHELL_PALETTE.bg}
        flexDirection="column"
        padding={0}
      >
        {/* The verb IS the phase — no `kind`-keyed ternary to keep in sync with it. `"checking"`
            (D7's Gate-freeze window, BEFORE the user has confirmed anything) and `"installing"`
            (after the confirm dispatched `designSystem.install`) are both `kind === "install"`,
            which a `kind`-only ternary could not tell apart (fix round 1, Important 1). */}
        <text id={`${props.id}-working`} fg={SHELL_PALETTE.amber} attributes={BOLD}>
          {`⠹ ${props.busyPhase}…`}
        </text>
      </box>
    );
  }

  if (props.failure !== null) {
    const failure = props.failure;
    return (
      <box
        id={props.id}
        border
        borderStyle="rounded"
        borderColor={SHELL_PALETTE.amber}
        title={dialogTitle(props.kind)}
        titleColor={SHELL_PALETTE.amberHi}
        backgroundColor={SHELL_PALETTE.bg}
        flexDirection="column"
        padding={0}
      >
        <text id={`${props.id}-failure`} fg={SHELL_PALETTE.red} attributes={BOLD}>
          {`✗ ${failure.safeMessage}`}
        </text>
        <text id={`${props.id}-failure-dismiss`} fg={SHELL_PALETTE.dim} marginTop={1}>
          esc dismiss
        </text>
      </box>
    );
  }

  if (props.kind === "publish") {
    return (
      <box
        id={props.id}
        border
        borderStyle="rounded"
        borderColor={SHELL_PALETTE.amber}
        title={dialogTitle(props.kind)}
        titleColor={SHELL_PALETTE.amberHi}
        backgroundColor={SHELL_PALETTE.bg}
        flexDirection="column"
        padding={0}
      >
        <text id={`${props.id}-headline`} fg={SHELL_PALETTE.amberHi} attributes={BOLD}>
          {`⚠ publish ${targetLabel(props)} to the local library`}
        </text>
        <text id={`${props.id}-lead`} fg={SHELL_PALETTE.dim} marginTop={1}>
          will publish design/system/ to the local library:
        </text>
        <text id={`${props.id}-consequence`} fg={SHELL_PALETTE.faint} marginTop={1}>
          other projects reading this source will see this version next
        </text>
        <box id={`${props.id}-keys`} flexDirection="row" marginTop={1}>
          <text id={`${props.id}-publish-key`} fg={SHELL_PALETTE.amber} attributes={BOLD}>
            ⏎ publish
          </text>
          <text id={`${props.id}-cancel`} fg={SHELL_PALETTE.dim}>
            {"  · esc cancel"}
          </text>
        </box>
      </box>
    );
  }

  if (props.preview === null) {
    return (
      <box
        id={props.id}
        border
        borderStyle="rounded"
        borderColor={SHELL_PALETTE.amber}
        title={dialogTitle(props.kind)}
        titleColor={SHELL_PALETTE.amberHi}
        backgroundColor={SHELL_PALETTE.bg}
        flexDirection="column"
        padding={0}
      >
        <text id={`${props.id}-pending`} fg={SHELL_PALETTE.dim}>
          checking design/system/…
        </text>
      </box>
    );
  }

  const preview = props.preview;
  const fatals = breakageBullets(preview);
  const warnings = boundedBullets(preview.warnings, MAX_RENDERED_BULLETS);
  const installOffered = preview.verdict !== "blocked";

  return (
    <box
      id={props.id}
      border
      borderStyle="rounded"
      borderColor={SHELL_PALETTE.amber}
      title={dialogTitle(props.kind)}
      titleColor={SHELL_PALETTE.amberHi}
      backgroundColor={SHELL_PALETTE.bg}
      flexDirection="column"
      padding={0}
    >
      <text id={`${props.id}-headline`} fg={SHELL_PALETTE.amberHi} attributes={BOLD}>
        {`⚠ ${verdictHeadline(preview.verdict)}`}
      </text>
      <text id={`${props.id}-lead`} fg={SHELL_PALETTE.dim} marginTop={1}>
        {`will replace design/system/ with ${targetLabel(props)}:`}
      </text>
      {fatals.map((bullet, index) => (
        <text
          key={`fatal-${index}`}
          id={`${props.id}-fatal-${index}`}
          fg={SHELL_PALETTE.fg}
          marginLeft={2}
        >
          {`• ${bullet}`}
        </text>
      ))}
      {warnings.map((bullet, index) => (
        <text
          key={`warning-${index}`}
          id={`${props.id}-warning-${index}`}
          fg={SHELL_PALETTE.faint}
          marginLeft={2}
        >
          {`• ${bullet}`}
        </text>
      ))}
      <text id={`${props.id}-consequence`} fg={SHELL_PALETTE.faint} marginTop={1}>
        pages that fail keep their last good render until they are fixed
      </text>
      <text id={`${props.id}-rule`} fg={SHELL_PALETTE.line} marginTop={1}>
        {"─".repeat(RULE_WIDTH)}
      </text>
      <box id={`${props.id}-keys`} flexDirection="row">
        {installOffered ? (
          <>
            <text id={`${props.id}-install-key`} fg={SHELL_PALETTE.amber} attributes={BOLD}>
              ⏎ install
            </text>
            <text id={`${props.id}-cancel`} fg={SHELL_PALETTE.dim}>
              {"  · esc cancel"}
            </text>
          </>
        ) : (
          <text id={`${props.id}-cancel-only`} fg={SHELL_PALETTE.dim}>
            esc cancel
          </text>
        )}
      </box>
    </box>
  );
}
