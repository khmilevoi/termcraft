import { SHELL_PALETTE, shellAttrs } from "ui/theme";

import { computeChatListViewport } from "../model/chat-list";
import type { DesignSystemPickerProps, DesignSystemRow } from "../model/design-system-picker";
import {
  DESIGN_SYSTEM_VIEWPORT_CAP,
  SWATCH_GLYPH,
  formatContents,
  truncateColumn,
  visibleSwatches,
} from "../model/design-system-picker";

const BOLD = shellAttrs({ bold: true });

/**
 * Column budgets. No `.dc.html` screen gives exact figures for this picker (D8's flagged gap
 * covers layout, not just colour) — these are a reasonable implementation-level choice sized off
 * the header text below, not an invented COLOUR, GLYPH, or STATE, which is what CLAUDE.md's rule
 * is about.
 */
const NAME_WIDTH = 14;
const VERSION_WIDTH = 9;
const SWATCH_CELLS = 8;
const CONTENTS_WIDTH = 24;
const RULE_WIDTH = 60;

/** The header row's own column labels — `SOURCE` is implicit in `sourceLabel`/grouping. */
const HEADER_TEXT = "    SOURCE  SYSTEM  VERSION  COLORS  CONTENTS";

/** The footer's action hint for the SELECTED row's state — `null` draws nothing (D6/D9). */
function actionHintFor(row: DesignSystemRow | undefined): string | null {
  if (row === undefined) return null;
  if (row.state === "installable") return "install";
  if (row.state === "ungranted") return "add source";
  return null;
}

/**
 * The design-system picker overlay (P10 plan §10.1 Wave 3, task 11). See
 * `../model/design-system-picker.ts`'s header comment for the full D8 gap/divergence record —
 * this component only realizes that vocabulary; it invents nothing of its own. A pure
 * presentational function component reading no atoms, mirroring `ChatListPopup.tsx`'s structure.
 */
export function DesignSystemPicker(props: DesignSystemPickerProps) {
  const total = props.rows.length;
  const viewport = computeChatListViewport({
    total,
    selectedIndex: props.selectedIndex,
    cap: DESIGN_SYSTEM_VIEWPORT_CAP,
  });
  const visibleRows = props.rows.slice(viewport.start, viewport.start + viewport.visibleCount);
  const selectedRow = props.rows[props.selectedIndex];
  const actionHint = props.busy ? null : actionHintFor(selectedRow);

  return (
    <box
      id={props.id}
      border
      borderStyle="rounded"
      borderColor={SHELL_PALETTE.amber}
      title="design systems"
      titleColor={SHELL_PALETTE.amberHi}
      backgroundColor={SHELL_PALETTE.bg}
      flexDirection="column"
    >
      {props.updateNote !== null && (
        <text id={`${props.id}-update`} fg={SHELL_PALETTE.amberHi} attributes={BOLD}>
          {props.updateNote}
        </text>
      )}
      <text id={`${props.id}-header`} fg={SHELL_PALETTE.faint} attributes={BOLD}>
        {HEADER_TEXT}
      </text>
      {viewport.before > 0 && (
        <text id={`${props.id}-before`} fg={SHELL_PALETTE.amberDim}>
          {`  ▲ ${viewport.before} earlier`}
        </text>
      )}
      {visibleRows.map((row, i) => {
        const index = viewport.start + i;
        const selected = index === props.selectedIndex;
        const rowId = `ds-picker-row-${row.key}`;
        const nameFg = selected ? SHELL_PALETTE.selFg : SHELL_PALETTE.fg;
        const dimFg = selected ? SHELL_PALETTE.selFg : SHELL_PALETTE.dim;
        return (
          <box
            key={row.key}
            id={rowId}
            flexDirection="row"
            backgroundColor={selected ? SHELL_PALETTE.sel : undefined}
          >
            <text id={`${rowId}-marker`} fg={SHELL_PALETTE.amber} attributes={BOLD}>
              {selected ? "▸ " : "  "}
            </text>
            <text id={`${rowId}-dot`} fg={selected ? SHELL_PALETTE.amber : SHELL_PALETTE.dim}>
              {row.state === "installable" ? (selected ? "● " : "○ ") : "  "}
            </text>
            <text id={`${rowId}-name`} fg={nameFg} attributes={shellAttrs({ bold: selected })}>
              {truncateColumn(row.name, NAME_WIDTH).padEnd(NAME_WIDTH, " ")}
            </text>
            <text id={`${rowId}-version`} fg={dimFg}>
              {truncateColumn(row.version, VERSION_WIDTH).padEnd(VERSION_WIDTH, " ")}
            </text>
            {visibleSwatches(row.swatches, SWATCH_CELLS).map((swatch, swatchIndex) => (
              <text
                key={`${row.key}-swatch-${swatchIndex}`}
                id={`${rowId}-swatch-${swatchIndex}`}
                fg={swatch.value}
              >
                {SWATCH_GLYPH}
              </text>
            ))}
            <text
              id={`${rowId}-contents`}
              fg={row.state === "unavailable" ? SHELL_PALETTE.amberHi : dimFg}
            >
              {row.systemId !== null
                ? ` ${formatContents(row.contents, CONTENTS_WIDTH)}`
                : ` ${row.note ?? ""}`}
            </text>
          </box>
        );
      })}
      {viewport.after > 0 && (
        <text id={`${props.id}-after`} fg={SHELL_PALETTE.amberDim}>
          {`  ▼ ${viewport.after} more`}
        </text>
      )}
      {/* DIVERGENCE (same as `HostCrashPanel`/`HostUnavailablePanel`): `agentPicker` draws its
          `├`…`┤` rule by writing into the modal box's OWN border cells, which a flex child cannot
          reach — a full-width `─` line inside the box is the closest faithful mapping. */}
      <text id={`${props.id}-rule`} fg={SHELL_PALETTE.line}>
        {"─".repeat(RULE_WIDTH)}
      </text>
      <box id={`${props.id}-footer`} flexDirection="row">
        <text id={`${props.id}-footer-nav-key`} fg={SHELL_PALETTE.amber} attributes={BOLD}>
          {"↑↓"}
        </text>
        <text id={`${props.id}-footer-nav-label`} fg={SHELL_PALETTE.dim}>
          {" select "}
        </text>
        {props.busy ? (
          <text id={`${props.id}-footer-busy`} fg={SHELL_PALETTE.amber} attributes={BOLD}>
            {"· ⠹ checking… "}
          </text>
        ) : (
          actionHint !== null && (
            <>
              <text id={`${props.id}-footer-action-key`} fg={SHELL_PALETTE.amber} attributes={BOLD}>
                {"· ⏎"}
              </text>
              <text id={`${props.id}-footer-action-label`} fg={SHELL_PALETTE.dim}>
                {` ${actionHint} `}
              </text>
            </>
          )
        )}
        {/* SUPPRESSED WHILE BUSY (fix round 1, Minor 1): the brief states "p publish only when
            canPublishSelected" and, separately, "checking… in place of the action hint when
            busy" — it does not say what publish does during a check. Busy means a Gate pass is
            in flight (D7): the row's own installability is not yet re-confirmed, so offering to
            publish a system whose OWN check has not settled would advertise an action the shell
            cannot honestly promise is safe right now. Suppressing it keeps the busy footer to
            exactly the vocabulary D7 licenses ("checking…" in place of the action hint) rather
            than a mix of "still deciding" and "go ahead, publish". */}
        {props.canPublishSelected && !props.busy && (
          <>
            <text id={`${props.id}-footer-publish-key`} fg={SHELL_PALETTE.amber} attributes={BOLD}>
              {"· p"}
            </text>
            <text id={`${props.id}-footer-publish-label`} fg={SHELL_PALETTE.dim}>
              {" publish "}
            </text>
          </>
        )}
        <text id={`${props.id}-footer-esc-key`} fg={SHELL_PALETTE.amber} attributes={BOLD}>
          {"· esc"}
        </text>
        <text id={`${props.id}-footer-esc-label`} fg={SHELL_PALETTE.dim}>
          {" close"}
        </text>
      </box>
    </box>
  );
}
