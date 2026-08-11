import {
  definePage,
  reatomComponent,
  atom,
  action,
  wrap,
  Row,
  Column,
  Text,
  Button,
  Input,
  Separator,
} from "@termcraft/runtime"
import { pad2 } from "../lib/time"
import { makeTick } from "../lib/elapsed"
import { PageShell } from "../components/PageShell"

export const meta = definePage({
  kitApiVersion: 1,
  title: "Таймер",
  minSize: { w: 60, h: 26 },
  theme: "dark-default",
})

// ── pure helpers (no timers, no randomness — safe for a deterministic export frame) ──

/** `ms` -> "MM:SS", clamped to zero. Pure function of the value. */
function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${pad2(minutes)}:${pad2(seconds)}`
}

/**
 * Parses a custom-duration draft into whole milliseconds, or `null` when the text isn't a
 * recognized shape. Accepts "MM:SS" (seconds 0-59) or a bare integer count of minutes.
 * Pure — no clock, no randomness.
 */
function parseDurationInput(raw: string): number | null {
  const text = raw.trim()
  if (text.length === 0) return null

  const clock = /^(\d{1,3}):([0-5]\d)$/.exec(text)
  if (clock) {
    const minutes = Number(clock[1])
    const seconds = Number(clock[2])
    const ms = (minutes * 60 + seconds) * 1000
    return ms > 0 ? ms : null
  }

  const plainMinutes = /^\d{1,4}$/.exec(text)
  if (plainMinutes) {
    const ms = Number(text) * 60_000
    return ms > 0 ? ms : null
  }

  return null
}

// ── the ring: a character-grid circle, built once from pure trig, filled clockwise by
// progress fraction and carrying the countdown label in its own interior cells. Terminal
// cells are roughly twice as tall as wide, so the horizontal radius is set well above the
// vertical one to read as round rather than egg-shaped. ──

const RING_RADIUS_X = 10
const RING_RADIUS_Y = 4
const RING_SEGMENTS = 48
const RING_WIDTH = RING_RADIUS_X * 2 + 1
const RING_HEIGHT = RING_RADIUS_Y * 2 + 1

interface RingPoint {
  readonly row: number
  readonly col: number
}

/** Samples `segments` points clockwise from the top around an ellipse, deduped onto the
 * integer character grid so each grid cell is owned by the first (earliest-angle) sample
 * that lands on it — that insertion order is what "progress along the circumference" fills
 * through. Pure math (`Math.sin`/`Math.cos`/`Math.round`); no clock, no randomness. */
function buildRingPoints(segments: number, radiusX: number, radiusY: number): readonly RingPoint[] {
  const seen = new Set<string>()
  const points: RingPoint[] = []
  for (let i = 0; i < segments; i++) {
    const angle = (i / segments) * Math.PI * 2
    const col = Math.round(radiusX + radiusX * Math.sin(angle))
    const row = Math.round(radiusY - radiusY * Math.cos(angle))
    const key = `${row},${col}`
    if (seen.has(key)) continue
    seen.add(key)
    points.push({ row, col })
  }
  return points
}

const RING_POINTS = buildRingPoints(RING_SEGMENTS, RING_RADIUS_X, RING_RADIUS_Y)

type ColorToken = "accent" | "success" | "danger" | "line" | "foregroundFaint" | "accentHi"

interface RingCell {
  readonly ch: string
  readonly color: ColorToken
  readonly bold: boolean
}

interface RingRun {
  readonly text: string
  readonly color: ColorToken
  readonly bold: boolean
  readonly startCol: number
}

/** Builds the ring's character grid for one render: ring cells before `filledCount` (in
 * circumference order) render filled in `filledColor`, the rest render as a dim outline, and
 * `centerLabel` is stamped into the interior of the middle row. */
function buildRingRows(
  filledCount: number,
  filledColor: ColorToken,
  centerLabel: string,
): readonly (readonly RingRun[])[] {
  const blank: RingCell = { ch: " ", color: "line", bold: false }
  const grid: RingCell[][] = Array.from({ length: RING_HEIGHT }, () =>
    Array.from({ length: RING_WIDTH }, () => blank),
  )

  RING_POINTS.forEach((point, index) => {
    const filled = index < filledCount
    grid[point.row][point.col] = {
      ch: filled ? "●" : "·",
      color: filled ? filledColor : "foregroundFaint",
      bold: filled,
    }
  })

  const centerRow = RING_RADIUS_Y
  const startCol = Math.max(1, Math.floor((RING_WIDTH - centerLabel.length) / 2))
  for (let i = 0; i < centerLabel.length; i++) {
    const col = startCol + i
    if (col <= 0 || col >= RING_WIDTH - 1) continue
    grid[centerRow][col] = { ch: centerLabel[i], color: "accentHi", bold: true }
  }

  return grid.map((row) => groupRingRuns(row))
}

/** Collapses a row of cells into contiguous same-style runs, so the row renders as a handful
 * of `Text` spans instead of one per character. */
function groupRingRuns(row: readonly RingCell[]): readonly RingRun[] {
  const runs: RingRun[] = []
  row.forEach((cell, col) => {
    const last = runs[runs.length - 1]
    if (last && last.color === cell.color && last.bold === cell.bold) {
      runs[runs.length - 1] = { ...last, text: last.text + cell.ch }
    } else {
      runs.push({ text: cell.ch, color: cell.color, bold: cell.bold, startCol: col })
    }
  })
  return runs
}

// ── state ──
// Same sealed-render contract as the stopwatch page: the first, un-clicked render must be
// correct on its own — stopped, full duration remaining. `elapsedMsAtom` only ever changes
// from an action, never from a wall-clock read; see RUNTIME.md's "Time and the sealed
// render". `tick` (below) is the model-level hook a future interactive driver calls to
// advance it, matching this MVP's other `onPress` handlers staying inert until the
// interactive path lands.

const DEFAULT_DURATION_MS = 5 * 60_000

const durationMsAtom = atom(DEFAULT_DURATION_MS, "durationMsAtom")
const elapsedMsAtom = atom(0, "elapsedMsAtom")
const runningAtom = atom(false, "runningAtom")
const customDurationInputAtom = atom(formatCountdown(DEFAULT_DURATION_MS), "customDurationInputAtom")
const customDurationErrorAtom = atom("", "customDurationErrorAtom")

const tick = makeTick(elapsedMsAtom, "tick")

const start = action(() => {
  if (runningAtom()) return
  if (elapsedMsAtom() >= durationMsAtom()) return
  runningAtom.set(true)
}, "start")

const pause = action(() => {
  if (!runningAtom()) return
  runningAtom.set(false)
}, "pause")

const reset = action(() => {
  runningAtom.set(false)
  elapsedMsAtom.set(0)
}, "reset")

const applyCustomDuration = action(() => {
  if (runningAtom()) return
  const parsed = parseDurationInput(customDurationInputAtom())
  if (parsed === null) {
    customDurationErrorAtom.set("Формат: минуты или мм:сс, например 07:30")
    return
  }
  customDurationErrorAtom.set("")
  runningAtom.set(false)
  elapsedMsAtom.set(0)
  durationMsAtom.set(parsed)
  customDurationInputAtom.set(formatCountdown(parsed))
}, "applyCustomDuration")

// ── component ──

export default reatomComponent(function Page() {
  const running = runningAtom()
  const duration = durationMsAtom()
  const elapsed = Math.min(elapsedMsAtom(), duration)
  const remaining = Math.max(0, duration - elapsed)
  const finished = remaining <= 0
  const fraction = duration > 0 ? elapsed / duration : 0
  const filledCount = Math.round(fraction * RING_POINTS.length)

  const accentToken: ColorToken = finished ? "danger" : running ? "success" : "accent"
  const ringRows = buildRingRows(filledCount, accentToken, formatCountdown(remaining))
  const customError = customDurationErrorAtom()

  return (
    <PageShell title="Таймер" borderColor={accentToken} align="center">
      <Text id="status-line" dim color="foregroundMuted">
        {finished ? "Время вышло" : running ? "Идёт отсчёт" : "На паузе"}
      </Text>

      <Column id="ring-display" gap={0} align="center">
        {ringRows.map((runs, r) => (
          <Row id={`ring-row-${r}`} gap={0} justify="center">
            {runs.map((run) => (
              <Text id={`ring-row-${r}-c${run.startCol}`} color={run.color} bold={run.bold}>
                {run.text}
              </Text>
            ))}
          </Row>
        ))}
      </Column>

      <Row id="controls-row" gap={1} justify="center">
        <Button
          id="btn-start-pause"
          onPress={wrap(() => (running ? pause() : start()))}
          disabled={finished && !running}
        >
          {running ? "Пауза" : elapsed > 0 ? "Продолжить" : "Старт"}
        </Button>
        <Button id="btn-reset" onPress={wrap(() => reset())} disabled={!running && elapsed === 0}>
          Сброс
        </Button>
      </Row>

      <Separator id="sep-footer" />

      <Row id="custom-duration-row" gap={1} justify="center" align="center">
        <Text id="custom-duration-label" dim color="foregroundMuted">
          Своя длительность (мм:сс или мин):
        </Text>
        <Input
          id="custom-duration-input"
          value={customDurationInputAtom()}
          placeholder="05:00"
          onChange={wrap((value: string) => customDurationInputAtom.set(value))}
        />
        <Button id="btn-set-custom-duration" onPress={wrap(() => applyCustomDuration())} disabled={running}>
          Задать
        </Button>
      </Row>

      <Text id="custom-duration-error" color="danger">
        {customError}
      </Text>
    </PageShell>
  )
})
