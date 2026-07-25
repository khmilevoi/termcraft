import {
  definePage,
  reatomComponent,
  Panel,
  Row,
  Column,
  Text,
  Separator,
  Gauge,
  Table,
  Spacer,
  Button,
  atom,
  action,
} from "@termcraft/runtime"

export const meta = definePage({
  kitApiVersion: 1,
  title: "Дашборд времени",
  minSize: { w: 74, h: 22 },
  theme: "dark-default",
})

const WEEKDAYS = [
  "воскресенье",
  "понедельник",
  "вторник",
  "среда",
  "четверг",
  "пятница",
  "суббота",
]

const MONTHS = [
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

const WORLD_CLOCKS = [
  { id: "msk", label: "Москва", offset: 3 },
  { id: "lon", label: "Лондон", offset: 1 },
  { id: "nyc", label: "Нью-Йорк", offset: -4 },
  { id: "tok", label: "Токио", offset: 9 },
]

function pad(value: number) {
  return value.toString().padStart(2, "0")
}

// Fixed deterministic seed so the first (export) frame never depends on the
// wall clock. There is no timer here — the clock only advances when the
// user presses the "+1 сек" button, keeping every render reproducible.
const nowAtom = atom(new Date(2026, 6, 25, 12, 0, 0), "nowAtom")

const tickSecond = action(() => {
  const current = nowAtom()
  nowAtom(new Date(current.getTime() + 1000))
}, "tickSecond")

const tickMinute = action(() => {
  const current = nowAtom()
  nowAtom(new Date(current.getTime() + 60000))
}, "tickMinute")

export default reatomComponent(function Page() {
  const now = nowAtom()

  const hh = now.getHours()
  const mm = now.getMinutes()
  const ss = now.getSeconds()
  const timeLabel = `${pad(hh)}:${pad(mm)}:${pad(ss)}`
  const dateLabel = `${now.getDate()} ${MONTHS[now.getMonth()]} ${now.getFullYear()}, ${WEEKDAYS[now.getDay()]}`

  const secondsSinceMidnight = hh * 3600 + mm * 60 + ss
  const dayFraction = secondsSinceMidnight / 86400

  const worldRows = WORLD_CLOCKS.map((city) => {
    const shifted = new Date(now.getTime() + city.offset * 3600000)
    const cellTime = `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`
    return { id: city.id, cells: [city.label, cellTime] }
  })

  return (
    <Panel id="root" title="Дашборд времени" padding={1}>
      <Row id="main-row" gap={3}>
        <Column id="clock-col" gap={1}>
          <Text id="time-label" bold color="accentHi">
            {timeLabel}
          </Text>
          <Text id="date-label" color="foregroundMuted">
            {dateLabel}
          </Text>
          <Spacer id="clock-spacer" size={1} />
          <Text id="gauge-caption" dim>
            Прошло дня
          </Text>
          <Gauge
            id="day-gauge"
            value={dayFraction}
            label={`${Math.round(dayFraction * 100)}%`}
            width={24}
          />
          <Spacer id="controls-spacer" size={1} />
          <Row id="controls-row" gap={1}>
            <Button id="tick-second-btn" onPress={() => tickSecond()}>
              +1 сек
            </Button>
            <Button id="tick-minute-btn" onPress={() => tickMinute()}>
              +1 мин
            </Button>
          </Row>
        </Column>
        <Separator id="mid-sep" direction="vertical" />
        <Column id="world-col" gap={1}>
          <Text id="world-title" bold>
            Время в мире
          </Text>
          <Table
            id="world-table"
            columns={[
              { id: "city", label: "Город", width: 14 },
              { id: "time", label: "Время", width: 10, align: "right" },
            ]}
            rows={worldRows}
          />
        </Column>
      </Row>
    </Panel>
  )
})
