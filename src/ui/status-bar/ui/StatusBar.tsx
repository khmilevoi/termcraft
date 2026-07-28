import { SHELL_PALETTE, shellAttrs } from "ui/theme";

import type { StatusBarHintKey, StatusBarProps, StatusBarSize } from "../types";

/** Glyphs `hintKeys()` (design `wsStatus`/`hintKeys`, `design/termcraft-engine.js:413-416`) always drops. */
const HIDDEN_HINT_GLYPHS: ReadonlySet<string> = new Set(["m", "^E", "/"]);

/** Label shortenings `hintKeys()` applies (design `hintKeys`, `design/termcraft-engine.js:499`). */
const SHORT_HINT_LABELS: Readonly<Record<string, string>> = {
  fullscreen: "full",
  interact: "act",
  versions: "vers",
};

/** Applies the design's own shortening; a label the design does not shorten passes through. */
function shortHintLabel(label: string): string {
  return SHORT_HINT_LABELS[label] ?? label;
}

/** One resolved left-cluster segment, ready to render as a single `<text>` run. */
interface LeftSegment {
  readonly id: string;
  readonly text: string;
  readonly fg: `#${string}`;
  readonly bg: `#${string}`;
  readonly bold: boolean;
}

/** `w<min.w || h<min.h` — design `wsStatus`'s `sizeErr` condition for the size segment. */
function isBelowMinimum(size: StatusBarSize): boolean {
  return size.min != null && (size.w < size.min.w || size.h < size.min.h);
}

function buildLeftSegments(props: StatusBarProps): readonly LeftSegment[] {
  // design `wsStatus` (`design/termcraft-engine.js:489-496`) assembles its `left` array in
  // this exact order: version -> size -> hint -> MODE -> ctx. CORRECTED: this used to push
  // the mode chip FIRST, citing `:403-412` — a stale range that now lands in
  // `gitHistoryInset`. The dead `combo` chip stays dropped (every workspace screen after §07
  // passes `combo:false`).
  const segments: LeftSegment[] = [];

  if (props.page) {
    segments.push({
      id: "page",
      text: `  ${props.page.text} `,
      fg: SHELL_PALETTE[props.page.fg],
      bg: SHELL_PALETTE.statusBg,
      bold: props.page.bold === true,
    });
  }

  if (props.size) {
    const belowMin = isBelowMinimum(props.size);
    const label =
      belowMin && props.size.min != null
        ? `${props.size.w}×${props.size.h} < ${props.size.min.w}×${props.size.min.h}`
        : `${props.size.w}×${props.size.h}`;
    segments.push({
      id: "size",
      text: ` ${label} `,
      fg: belowMin ? SHELL_PALETTE.bg : SHELL_PALETTE.dim,
      bg: belowMin ? SHELL_PALETTE.red : SHELL_PALETTE.statusBg,
      bold: belowMin,
    });
  }

  if (props.hint) {
    segments.push({
      id: "hint",
      text: ` ${props.hint.text} `,
      fg: SHELL_PALETTE[props.hint.fg],
      bg: SHELL_PALETTE[props.hint.bg],
      bold: true,
    });
  }

  segments.push({
    id: "mode",
    text: ` ${props.mode.text} `,
    fg: SHELL_PALETTE[props.mode.fg],
    bg: SHELL_PALETTE[props.mode.bg],
    bold: true,
  });

  const showCtx = props.ctx != null && (props.width >= 100 || props.ctxCaution === true);
  if (showCtx) {
    segments.push({
      id: "ctx",
      text: ` ctx ${props.ctx}% `,
      fg: props.ctxCaution === true ? SHELL_PALETTE.amberHi : SHELL_PALETTE.faint,
      bg: SHELL_PALETTE.statusBg,
      bold: props.ctxCaution === true,
    });
  }

  return segments;
}

// divergence: the design's `statusBar()` fit check compares against canvas-measured glyph
// pixel widths (`engine.measure()`); OpenTUI has no per-glyph measurement at layout time, so
// this uses a JS-string-length cell estimate per key (glyph+label+4) — the same kind of
// `.length`-based approximation `statusBar()` itself falls back to for its own fit loop.
function hintKeyWidth(key: StatusBarHintKey): number {
  return key[0].length + key[1].length + 4;
}

/** Drops trailing keys until the right-aligned hint row fits `width`, keeping at least one. */
function fitHintKeys(
  keys: readonly StatusBarHintKey[],
  width: number,
  leftWidth: number,
): readonly StatusBarHintKey[] {
  let fitted = keys;
  while (fitted.length > 1) {
    const total = fitted.reduce((sum, key) => sum + hintKeyWidth(key), 0);
    if (leftWidth + 2 + total <= width) break;
    fitted = fitted.slice(0, -1);
  }
  return fitted;
}

/**
 * The bottom status bar (design `statusBar`/`wsStatus`, `design/02-workspace-idle.dc.html`).
 * Segment order, left to right: page/version -> size -> optional hint badge -> mode chip ->
 * ctx%, then a flexible spacer, then the right-aligned key hints (`^E`/`m`/`/` are always
 * filtered per `hintKeys()`). Every hex, glyph, and literal below is taken verbatim from the
 * design engine; a flexGrow spacer stands in for the engine's manual `rx` right-alignment
 * math (the closest faithful OpenTUI-flexbox mapping of that canvas-absolute positioning).
 */
export function StatusBar(props: StatusBarProps) {
  const leftSegments = buildLeftSegments(props);
  const leftWidth = 1 + leftSegments.reduce((sum, seg) => sum + seg.text.length, 0);
  const visibleKeys = (props.hintKeys ?? [])
    .filter((key) => !HIDDEN_HINT_GLYPHS.has(key[0]))
    .map((key): StatusBarHintKey => [key[0], shortHintLabel(key[1]), key[2]]);
  const fittedKeys = fitHintKeys(visibleKeys, props.width, leftWidth);

  return (
    <box
      id={props.id}
      flexDirection="row"
      width={props.width}
      backgroundColor={SHELL_PALETTE.statusBg}
    >
      {leftSegments.map((segment) => (
        <text
          key={segment.id}
          id={`${props.id}-${segment.id}`}
          fg={segment.fg}
          bg={segment.bg}
          attributes={shellAttrs({ bold: segment.bold })}
        >
          {segment.text}
        </text>
      ))}
      <box id={`${props.id}-spacer`} flexGrow={1} />
      {fittedKeys.map((key, index) => {
        const disabled = key[2] === "dis";
        const active = key[2] === true;
        return (
          <box key={`${key[0]}-${index}`} id={`${props.id}-key-${index}`} flexDirection="row">
            <text
              id={`${props.id}-key-${index}-glyph`}
              fg={disabled ? SHELL_PALETTE.faint : active ? SHELL_PALETTE.bg : SHELL_PALETTE.amber}
              bg={active ? SHELL_PALETTE.amber : SHELL_PALETTE.statusBg}
              attributes={shellAttrs({ bold: !disabled })}
            >
              {` ${key[0]} `}
            </text>
            <text
              id={`${props.id}-key-${index}-label`}
              fg={disabled ? SHELL_PALETTE.faint : SHELL_PALETTE.dim}
            >
              {` ${key[1]} `}
            </text>
          </box>
        );
      })}
    </box>
  );
}
