import {
  definePage,
  reatomComponent,
  atom,
  action,
  wrap,
  isExport,
  Panel,
  Column,
  Row,
  Box,
  Text,
  Button,
  Separator,
  Gauge,
} from "@termcraft/runtime"
import { pad2 } from "../lib/time"
import { makeElapsedMsReader } from "../lib/elapsed"

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

interface DurationPreset {
  readonly id: string
  readonly label: string
  readonly ms: number
}

const DURATION_PRESETS: readonly DurationPreset[] = [
  { id: "1m", label: "1 мин", ms: 60_000 },
  { id: "5m", label: "5 мин", ms: 5 * 60_000 },
  { id: "10m", label: "10 мин", ms: 10 * 60_000 },
  { id: "15m", label: "15 мин", ms: 15 * 60_000 },
  { id: "25m", label: "25 мин", ms: 25 * 60_000 },
]

// ── state ──
// Same static-render contract as the stopwatch page: the first, un-clicked render must
// be correct on its own — stopped, full duration remaining. Wall-clock reads
// (`Date.now()`) only happen inside actions, i.e. in response to a real interaction once
// the interactive path lands; there is no setInterval/setTimeout anywhere.

const durationMsAtom = atom(DURATION_PRESETS[1].ms, "durationMsAtom")
const elapsedMsAtom = atom(0, "elapsedMsAtom")
const runningAtom = atom(false, "runningAtom")
const startedAtAtom = atom<number | null>(null, "startedAtAtom")

/** Elapsed time since the timer was (re)started, frozen while stopped. */
const currentElapsedMs = makeElapsedMsReader(runningAtom, startedAtAtom, elapsedMsAtom)

const selectDuration = action((ms: number) => {
  runningAtom.set(false)
  startedAtAtom.set(null)
  elapsedMsAtom.set(0)
  durationMsAtom.set(ms)
}, "selectDuration")

const start = action(() => {
  if (runningAtom()) return
  if (elapsedMsAtom() >= durationMsAtom()) return
  runningAtom.set(true)
  startedAtAtom.set(isExport() ? null : Date.now())
}, "start")

const pause = action(() => {
  if (!runningAtom()) return
  elapsedMsAtom.set(Math.min(currentElapsedMs(), durationMsAtom()))
  runningAtom.set(false)
  startedAtAtom.set(null)
}, "pause")

const reset = action(() => {
  runningAtom.set(false)
  startedAtAtom.set(null)
  elapsedMsAtom.set(0)
}, "reset")

// ── component ──

export default reatomComponent(function Page() {
  const running = runningAtom()
  const duration = durationMsAtom()
  const elapsed = Math.min(currentElapsedMs(), duration)
  const remaining = Math.max(0, duration - elapsed)
  const finished = remaining <= 0
  const fraction = duration > 0 ? elapsed / duration : 0
  const activePresetId = DURATION_PRESETS.find((p) => p.ms === duration)?.id

  const accentToken = finished ? "danger" : running ? "success" : "accent"

  return (
    <Box id="app-bg" direction="column" grow={1} background="background">
      <Panel id="root" title="Таймер" padding={1} borderColor={accentToken}>
        <Column id="layout" gap={1} align="center">
          <Row id="preset-row" gap={1} justify="center">
            {DURATION_PRESETS.map((preset) => (
              <Button
                id={`preset-${preset.id}`}
                onPress={wrap(() => selectDuration(preset.ms))}
                disabled={running}
              >
                {preset.id === activePresetId ? `[ ${preset.label} ]` : preset.label}
              </Button>
            ))}
          </Row>

          <Text id="status-line" dim color="foregroundMuted">
            {finished ? "Время вышло" : running ? "Идёт отсчёт" : "На паузе"}
          </Text>

          <Text id="countdown-time" bold color={accentToken}>
            {formatCountdown(remaining)}
          </Text>

          <Gauge id="progress-gauge" value={fraction} width={30} label={`${Math.round(fraction * 100)}%`} />

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

          <Text id="duration-line" dim color="foregroundMuted">
            {`Длительность: ${formatCountdown(duration)}`}
          </Text>
        </Column>
      </Panel>
    </Box>
  )
})
