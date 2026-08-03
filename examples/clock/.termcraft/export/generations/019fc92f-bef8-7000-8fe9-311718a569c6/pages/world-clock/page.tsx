import {
  definePage,
  reatomComponent,
  Panel,
  Column,
  Row,
  Box,
  Text,
  Separator,
} from "@termcraft/runtime"

export const meta = definePage({
  kitApiVersion: 1,
  title: "Мировые часы",
  minSize: { w: 74, h: 28 },
  theme: "dark-default",
})

// ── pure helpers (no timers, no randomness — safe for a deterministic export frame) ──

interface TimezoneSpec {
  readonly id: string
  readonly city: string
  readonly tz: string
}

// Exactly 9 zones — laid out as a fixed 3x3 grid below.
const TIMEZONES: readonly TimezoneSpec[] = [
  { id: "lax", city: "Лос-Анджелес", tz: "America/Los_Angeles" },
  { id: "nyc", city: "Нью-Йорк", tz: "America/New_York" },
  { id: "lon", city: "Лондон", tz: "Europe/London" },
  { id: "par", city: "Париж", tz: "Europe/Paris" },
  { id: "msk", city: "Москва", tz: "Europe/Moscow" },
  { id: "dxb", city: "Дубай", tz: "Asia/Dubai" },
  { id: "del", city: "Дели", tz: "Asia/Kolkata" },
  { id: "tok", city: "Токио", tz: "Asia/Tokyo" },
  { id: "syd", city: "Сидней", tz: "Australia/Sydney" },
]

interface ZoneReading {
  readonly time: string
  readonly offset: string
}

/** Formats `now` in `tz` as an HH:mm:ss readout plus its GMT offset label. */
function readZone(now: Date, tz: string): ZoneReading {
  const time = new Intl.DateTimeFormat("ru-RU", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(now)

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    timeZoneName: "shortOffset",
  }).formatToParts(now)
  const offsetPart = parts.find((p) => p.type === "timeZoneName")

  return { time, offset: offsetPart ? offsetPart.value : "" }
}

/** Splits a flat list into fixed-size rows (last row padded by the caller's own bounds). */
function chunk<T>(items: readonly T[], size: number): readonly (readonly T[])[] {
  const rows: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    rows.push(items.slice(i, i + size) as T[])
  }
  return rows
}

// ── component ──
// `now` is read once per render (no timer driving re-renders), matching the dashboard
// and calendar pages: a static/export render is sealed at whatever instant it was invoked.

export default reatomComponent(function Page() {
  const now = new Date()
  const rows = chunk(TIMEZONES, 3)

  const localTime = new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(now)

  return (
    <Box id="app-bg" direction="column" grow={1} background="background">
      <Panel id="root" title="Мировые часы" padding={1}>
        <Column id="layout" gap={1} align="stretch">
          <Text id="subtitle" dim color="foregroundMuted">
            {`Локальное время: ${localTime}`}
          </Text>

          <Separator id="sep-header" />

          <Column id="grid" gap={1} align="stretch">
            {rows.map((row, r) => (
              <Row id={`tz-row-${r}`} gap={1} justify="around">
                {row.map((zone) => {
                  const reading = readZone(now, zone.tz)
                  return (
                    <Panel id={`tz-cell-${zone.id}`} title={zone.city} padding={1} borderColor="line">
                      <Column id={`tz-col-${zone.id}`} gap={0} align="center">
                        <Text id={`tz-time-${zone.id}`} bold color="accent">
                          {reading.time}
                        </Text>
                        <Text id={`tz-offset-${zone.id}`} dim color="foregroundMuted">
                          {reading.offset}
                        </Text>
                      </Column>
                    </Panel>
                  )
                })}
              </Row>
            ))}
          </Column>
        </Column>
      </Panel>
    </Box>
  )
})
