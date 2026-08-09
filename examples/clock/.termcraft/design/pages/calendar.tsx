import {
  definePage,
  reatomComponent,
  atom,
  action,
  wrap,
  Panel,
  Column,
  Row,
  Box,
  Text,
  Button,
  Separator,
} from "@termcraft/runtime"
import { pad2, SEEDED_NOW } from "../lib/time"

export const meta = definePage({
  kitApiVersion: 1,
  title: "Календарь",
  minSize: { w: 60, h: 26 },
  theme: "dark-default",
})

// ── pure helpers (no timers, no randomness — safe for a deterministic export frame) ──

const WEEKDAYS_SHORT_RU = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]

const MONTHS_RU = [
  "Январь",
  "Февраль",
  "Март",
  "Апрель",
  "Май",
  "Июнь",
  "Июль",
  "Август",
  "Сентябрь",
  "Октябрь",
  "Ноябрь",
  "Декабрь",
]

interface MonthDayCell {
  readonly day: number
  readonly inMonth: boolean
  readonly isToday: boolean
}

interface DisplayedMonth {
  readonly year: number
  readonly month: number
}

/** Normalizes `baseMonth + offset` into a year/month pair (offset may be negative). */
function addMonths(baseYear: number, baseMonth: number, offset: number): DisplayedMonth {
  const combined = baseMonth + offset
  const year = baseYear + Math.floor(combined / 12)
  const month = ((combined % 12) + 12) % 12
  return { year, month }
}

/** Builds full weeks (Monday-first) covering the month, padded with adjacent-month days. */
function buildMonthGrid(
  year: number,
  month: number,
  today: { year: number; month: number; day: number },
): readonly (readonly MonthDayCell[])[] {
  const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7 // Monday = 0
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const daysInPrevMonth = new Date(year, month, 0).getDate()
  const totalCells = Math.ceil((firstWeekday + daysInMonth) / 7) * 7

  const isCurrentMonth = year === today.year && month === today.month

  const cells: MonthDayCell[] = []
  for (let i = 0; i < totalCells; i++) {
    const offset = i - firstWeekday
    if (offset < 0) {
      cells.push({ day: daysInPrevMonth + offset + 1, inMonth: false, isToday: false })
    } else if (offset >= daysInMonth) {
      cells.push({ day: offset - daysInMonth + 1, inMonth: false, isToday: false })
    } else {
      const day = offset + 1
      cells.push({ day, inMonth: true, isToday: isCurrentMonth && day === today.day })
    }
  }

  const weeks: MonthDayCell[][] = []
  for (let i = 0; i < cells.length; i += 7) {
    weeks.push(cells.slice(i, i + 7))
  }
  return weeks
}

// ── state ──

const monthOffsetAtom = atom(0, "monthOffsetAtom")

const shiftMonth = action((delta: number) => {
  monthOffsetAtom.set(monthOffsetAtom() + delta)
}, "shiftMonth")

const resetToToday = action(() => {
  monthOffsetAtom.set(0)
}, "resetToToday")

// ── component ──
// `now` is a fixed, seeded instant (`SEEDED_NOW`, `lib/time.ts`) — a page renders once per
// commit and there is no wall clock to read `new Date()` against; see RUNTIME.md's "Time and
// the sealed render".

export default reatomComponent(function Page() {
  const now = SEEDED_NOW
  const today = { year: now.getFullYear(), month: now.getMonth(), day: now.getDate() }

  const offset = monthOffsetAtom()
  const displayed = addMonths(today.year, today.month, offset)
  const weeks = buildMonthGrid(displayed.year, displayed.month, today)

  return (
    <Box id="app-bg" direction="column" grow={1} background="background">
      <Panel id="root" title="Календарь" padding={1}>
        <Column id="layout" gap={1} align="stretch">
          <Row id="nav-row" gap={1} align="center" justify="between">
            <Button id="btn-prev" onPress={wrap(() => shiftMonth(-1))}>
              {"◀ Пред"}
            </Button>
            <Text id="month-label" bold color="accent">
              {`${MONTHS_RU[displayed.month]} ${displayed.year}`}
            </Text>
            <Button id="btn-next" onPress={wrap(() => shiftMonth(1))}>
              {"След ▶"}
            </Button>
          </Row>

          <Row id="today-row" justify="center">
            <Button id="btn-today" onPress={wrap(() => resetToToday())}>
              Сегодня
            </Button>
          </Row>

          <Separator id="sep-header" />

          <Row id="weekday-header" gap={1} justify="between">
            {WEEKDAYS_SHORT_RU.map((label, i) => (
              <Box id={`weekday-${i}`} width={4} justify="center">
                <Text id={`weekday-label-${i}`} dim color="foregroundMuted">
                  {label}
                </Text>
              </Box>
            ))}
          </Row>

          <Column id="weeks-col" gap={0} align="stretch">
            {weeks.map((week, w) => (
              <Row id={`week-${w}`} gap={1} justify="between">
                {week.map((cell, d) => (
                  <Box
                    id={`day-${w}-${d}`}
                    width={4}
                    justify="center"
                    background={cell.isToday ? "selection" : undefined}
                  >
                    <Text
                      id={`day-label-${w}-${d}`}
                      color={cell.isToday ? "selectionFg" : cell.inMonth ? "foreground" : "foregroundFaint"}
                      bold={cell.isToday}
                    >
                      {pad2(cell.day)}
                    </Text>
                  </Box>
                ))}
              </Row>
            ))}
          </Column>

          <Separator id="sep-footer" />

          <Text id="today-line" dim color="foregroundMuted">
            {`Сегодня: ${pad2(today.day)}.${pad2(today.month + 1)}.${today.year}`}
          </Text>
        </Column>
      </Panel>
    </Box>
  )
})
