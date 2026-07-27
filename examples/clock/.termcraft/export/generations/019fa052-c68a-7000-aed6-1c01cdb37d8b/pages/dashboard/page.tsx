import {
  definePage,
  reatomComponent,
  Panel,
  Column,
  Text,
  Separator,
} from "@termcraft/runtime"

export const meta = definePage({
  kitApiVersion: 1,
  title: "Дашборд · Время",
  minSize: { w: 60, h: 26 },
  theme: "dark-default",
})

// ── pure helpers (no timers, no randomness — safe for a deterministic export frame) ──

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

const WEEKDAYS_RU = [
  "Воскресенье",
  "Понедельник",
  "Вторник",
  "Среда",
  "Четверг",
  "Пятница",
  "Суббота",
]

const MONTHS_RU = [
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря",
]

function fullTime(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

function fullDate(d: Date): string {
  return `${d.getDate()} ${MONTHS_RU[d.getMonth()]} ${d.getFullYear()}`
}

function weekday(d: Date): string {
  return WEEKDAYS_RU[d.getDay()]
}

// ── analog clock face, rendered as a grid of monospace characters ──
// Pure function of `now`: no timers, no randomness — same deterministic
// single-render contract as the rest of the page.

const CLOCK_RADIUS = 7
/** Terminal cells are roughly twice as tall as wide; scale x so the face reads as round. */
const CLOCK_X_SCALE = 2
const CLOCK_CX = CLOCK_RADIUS * CLOCK_X_SCALE
const CLOCK_CY = CLOCK_RADIUS
const CLOCK_WIDTH = CLOCK_CX * 2 + 1
const CLOCK_HEIGHT = CLOCK_CY * 2 + 1
const CLOCK_TICK_ANGLES = [-Math.PI / 2, 0, Math.PI / 2, Math.PI]

/** Renders the analog face as one newline-joined string (single stable Text node). */
function buildAnalogClockFace(d: Date): string {
  const grid: string[][] = Array.from({ length: CLOCK_HEIGHT }, () =>
    Array<string>(CLOCK_WIDTH).fill(" "),
  )

  // face outline (an ellipse in character space so it reads as a circle)
  for (let row = 0; row < CLOCK_HEIGHT; row++) {
    for (let col = 0; col < CLOCK_WIDTH; col++) {
      const dx = (col - CLOCK_CX) / CLOCK_X_SCALE
      const dy = row - CLOCK_CY
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist <= CLOCK_RADIUS && dist >= CLOCK_RADIUS - 0.6) {
        grid[row][col] = "·"
      }
    }
  }

  // hour ticks at 12 / 3 / 6 / 9
  for (const angle of CLOCK_TICK_ANGLES) {
    const col = Math.round(CLOCK_CX + Math.cos(angle) * CLOCK_RADIUS * CLOCK_X_SCALE)
    const row = Math.round(CLOCK_CY + Math.sin(angle) * CLOCK_RADIUS)
    if (row >= 0 && row < CLOCK_HEIGHT && col >= 0 && col < CLOCK_WIDTH) {
      grid[row][col] = "•"
    }
  }

  function drawHand(angle: number, length: number, glyph: string): void {
    const steps = Math.max(CLOCK_WIDTH, CLOCK_HEIGHT) * 2
    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      const col = Math.round(CLOCK_CX + Math.cos(angle) * length * CLOCK_X_SCALE * t)
      const row = Math.round(CLOCK_CY + Math.sin(angle) * length * t)
      if (row >= 0 && row < CLOCK_HEIGHT && col >= 0 && col < CLOCK_WIDTH) {
        grid[row][col] = glyph
      }
    }
  }

  const hours12 = d.getHours() % 12
  const minutes = d.getMinutes()
  const seconds = d.getSeconds()

  const hourAngle = ((hours12 + minutes / 60) / 12) * 2 * Math.PI - Math.PI / 2
  const minuteAngle = ((minutes + seconds / 60) / 60) * 2 * Math.PI - Math.PI / 2
  const secondAngle = (seconds / 60) * 2 * Math.PI - Math.PI / 2

  drawHand(hourAngle, CLOCK_RADIUS * 0.5, "█")
  drawHand(minuteAngle, CLOCK_RADIUS * 0.8, "█")
  drawHand(secondAngle, CLOCK_RADIUS * 0.95, "•")

  grid[CLOCK_CY][CLOCK_CX] = "●"

  return grid.map((row) => row.join("")).join("\n")
}

// ── component ──
// The clock reads `new Date()` once per render. There is no timer driving re-renders,
// so a static/export render is sealed at whatever instant it was invoked — fully
// deterministic, no setInterval/setTimeout/randomness involved.

export default reatomComponent(function Page() {
  const now = new Date()
  const analogFace = buildAnalogClockFace(now)

  return (
    <Panel id="root" title="Часы" padding={1}>
      <Column id="layout" gap={1} align="center">
        <Text id="digital-time" bold color="accentHi">
          {fullTime(now)}
        </Text>
        <Text id="date-line" dim color="foregroundMuted">
          {`${weekday(now)}, ${fullDate(now)}`}
        </Text>

        <Separator id="sep-header" />

        <Panel id="panel-analog" title="Аналоговые часы" padding={1}>
          <Column id="analog-col" gap={0} align="center">
            <Text id="analog-face" color="accent">
              {analogFace}
            </Text>
          </Column>
        </Panel>
      </Column>
    </Panel>
  )
})
