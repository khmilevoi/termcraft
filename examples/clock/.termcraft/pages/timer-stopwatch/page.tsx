import {
  definePage,
  reatomComponent,
  atom,
  computed,
  action,
  wrap,
  Panel,
  Column,
  Row,
  Box,
  Text,
  Separator,
  Tabs,
  Button,
  Gauge,
} from "@termcraft/runtime"

export const meta = definePage({
  kitApiVersion: 1,
  title: "Таймер и секундомер",
  minSize: { w: 66, h: 28 },
  theme: "dark-default",
})

// ── pure helpers (no timers, no randomness — safe for a deterministic export frame) ──

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** mm:ss(.cc) — hh:mm:ss once past an hour. Pure function of a millisecond count. */
function formatClock(ms: number, withCentis: boolean): string {
  const total = Math.max(0, Math.round(ms))
  const hours = Math.floor(total / 3_600_000)
  const minutes = Math.floor((total % 3_600_000) / 60_000)
  const seconds = Math.floor((total % 60_000) / 1000)
  const centis = Math.floor((total % 1000) / 10)

  const core = hours > 0 ? `${hours}:${pad2(minutes)}:${pad2(seconds)}` : `${pad2(minutes)}:${pad2(seconds)}`
  return withCentis ? `${core}.${pad2(centis)}` : core
}

// ── mode switch ──

const MODE_TABS = [
  { id: "stopwatch", label: "Секундомер" },
  { id: "timer", label: "Таймер" },
] as const

const modeAtom = atom<string>("stopwatch", "modeAtom")

// ── stopwatch state ──
// `swStartAtAtom` holds the wall-clock instant (ms) the current run began; elapsed time
// already banked from earlier runs lives in `swAccumulatedMsAtom`. Reading elapsed time
// calls `Date.now()` once per evaluation — a plain clock read, not a timer/interval — so
// the first render (running = false) stays fully deterministic without touching it at all.

const swRunningAtom = atom(false, "swRunningAtom")
const swStartAtAtom = atom<number | null>(null, "swStartAtAtom")
const swAccumulatedMsAtom = atom(0, "swAccumulatedMsAtom")

const swElapsedMsAtom = computed(() => {
  const running = swRunningAtom()
  const banked = swAccumulatedMsAtom()
  if (!running) return banked
  const startAt = swStartAtAtom()
  return startAt == null ? banked : banked + (Date.now() - startAt)
}, "swElapsedMsAtom")

const swStart = action(() => {
  if (swRunningAtom()) return
  swStartAtAtom.set(Date.now())
  swRunningAtom.set(true)
}, "swStart")

const swPause = action(() => {
  if (!swRunningAtom()) return
  const startAt = swStartAtAtom()
  if (startAt != null) swAccumulatedMsAtom.set(swAccumulatedMsAtom() + (Date.now() - startAt))
  swRunningAtom.set(false)
  swStartAtAtom.set(null)
}, "swPause")

const swReset = action(() => {
  swRunningAtom.set(false)
  swStartAtAtom.set(null)
  swAccumulatedMsAtom.set(0)
}, "swReset")

// ── timer (countdown) state ──
// `timerRemainingMsAtom` is the frozen remaining duration whenever the timer is not
// running; while running, the live remaining time is derived from it plus the current
// run's start instant, the same start/accumulate split as the stopwatch above.

interface TimerPreset {
  readonly id: string
  readonly label: string
  readonly ms: number
}

const TIMER_PRESETS: readonly TimerPreset[] = [
  { id: "1m", label: "1 мин", ms: 60_000 },
  { id: "5m", label: "5 мин", ms: 300_000 },
  { id: "10m", label: "10 мин", ms: 600_000 },
  { id: "25m", label: "25 мин", ms: 1_500_000 },
]

const timerPresetMsAtom = atom(TIMER_PRESETS[1].ms, "timerPresetMsAtom")
const timerRemainingMsAtom = atom(TIMER_PRESETS[1].ms, "timerRemainingMsAtom")
const timerRunningAtom = atom(false, "timerRunningAtom")
const timerStartAtAtom = atom<number | null>(null, "timerStartAtAtom")

const timerDisplayMsAtom = computed(() => {
  const running = timerRunningAtom()
  const remaining = timerRemainingMsAtom()
  if (!running) return remaining
  const startAt = timerStartAtAtom()
  const elapsed = startAt == null ? 0 : Date.now() - startAt
  return Math.max(0, remaining - elapsed)
}, "timerDisplayMsAtom")

const setTimerPreset = action((ms: number) => {
  if (timerRunningAtom()) return
  timerPresetMsAtom.set(ms)
  timerRemainingMsAtom.set(ms)
}, "setTimerPreset")

const timerStart = action(() => {
  if (timerRunningAtom() || timerRemainingMsAtom() <= 0) return
  timerStartAtAtom.set(Date.now())
  timerRunningAtom.set(true)
}, "timerStart")

const timerPause = action(() => {
  if (!timerRunningAtom()) return
  const startAt = timerStartAtAtom()
  const elapsed = startAt == null ? 0 : Date.now() - startAt
  timerRemainingMsAtom.set(Math.max(0, timerRemainingMsAtom() - elapsed))
  timerRunningAtom.set(false)
  timerStartAtAtom.set(null)
}, "timerPause")

const timerReset = action(() => {
  timerRunningAtom.set(false)
  timerStartAtAtom.set(null)
  timerRemainingMsAtom.set(timerPresetMsAtom())
}, "timerReset")

// ── component ──

export default reatomComponent(function Page() {
  const mode = modeAtom()

  const swElapsed = swElapsedMsAtom()
  const swRunning = swRunningAtom()

  const timerDisplay = timerDisplayMsAtom()
  const timerRunning = timerRunningAtom()
  const timerPreset = timerPresetMsAtom()
  const timerDone = timerDisplay <= 0

  return (
    <Box id="app-bg" direction="column" grow={1} background="background">
      <Panel id="root" title={meta.title} padding={1}>
        <Column id="layout" gap={1} align="stretch">
          <Row id="mode-row" gap={1} align="center">
            <Text id="mode-label" dim color="foregroundMuted">
              Режим:
            </Text>
            <Tabs id="mode-tabs" tabs={MODE_TABS} activeId={mode} onSelect={wrap((id: string) => modeAtom.set(id))} />
          </Row>

          <Separator id="sep-header" />

          {mode === "stopwatch" ? (
            <Column id="stopwatch-panel" gap={1} align="center">
              <Text id="sw-display" bold color="accent">
                {formatClock(swElapsed, true)}
              </Text>
              <Text id="sw-status" dim color="foregroundMuted">
                {swRunning ? "Идёт" : swElapsed > 0 ? "На паузе" : "Остановлен"}
              </Text>

              <Row id="sw-controls" gap={1} justify="center">
                <Button id="sw-start-btn" onPress={swStart} disabled={swRunning}>
                  Старт
                </Button>
                <Button id="sw-pause-btn" onPress={swPause} disabled={!swRunning}>
                  Пауза
                </Button>
                <Button id="sw-reset-btn" onPress={swReset} disabled={!swRunning && swElapsed === 0}>
                  Сброс
                </Button>
              </Row>
            </Column>
          ) : (
            <Column id="timer-panel" gap={1} align="center">
              <Row id="timer-presets" gap={1} justify="center">
                {TIMER_PRESETS.map((preset) => (
                  <Button
                    id={`timer-preset-${preset.id}`}
                    onPress={wrap(() => setTimerPreset(preset.ms))}
                    disabled={timerRunning || timerPreset === preset.ms}
                  >
                    {preset.label}
                  </Button>
                ))}
              </Row>

              <Text id="timer-display" bold color={timerDone ? "danger" : "accent"}>
                {formatClock(timerDisplay, false)}
              </Text>

              <Gauge
                id="timer-gauge"
                value={timerPreset > 0 ? timerDisplay / timerPreset : 0}
                label={`${Math.round((timerPreset > 0 ? timerDisplay / timerPreset : 0) * 100)}%`}
                width={24}
              />

              <Text id="timer-status" dim color={timerDone ? "danger" : "foregroundMuted"}>
                {timerDone ? "Время вышло!" : timerRunning ? "Идёт" : "На паузе"}
              </Text>

              <Row id="timer-controls" gap={1} justify="center">
                <Button id="timer-start-btn" onPress={timerStart} disabled={timerRunning || timerDone}>
                  Старт
                </Button>
                <Button id="timer-pause-btn" onPress={timerPause} disabled={!timerRunning}>
                  Пауза
                </Button>
                <Button
                  id="timer-reset-btn"
                  onPress={timerReset}
                  disabled={!timerRunning && timerRemainingMsAtom() === timerPreset}
                >
                  Сброс
                </Button>
              </Row>
            </Column>
          )}
        </Column>
      </Panel>
    </Box>
  )
}, "Page")
