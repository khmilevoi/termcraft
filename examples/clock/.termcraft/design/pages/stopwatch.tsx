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
import { pad2 } from "../lib/time"
import { makeTick } from "../lib/elapsed"

export const meta = definePage({
  kitApiVersion: 1,
  title: "Секундомер",
  minSize: { w: 60, h: 26 },
  theme: "dark-default",
})

// ── pure helpers (no timers, no randomness — safe for a deterministic export frame) ──

/** `ms` -> "MM:SS.CC" (centiseconds). Pure function of the value, no timers involved. */
function formatStopwatch(ms: number): string {
  const clamped = Math.max(0, Math.round(ms))
  const minutes = Math.floor(clamped / 60_000)
  const seconds = Math.floor((clamped % 60_000) / 1000)
  const centis = Math.floor((clamped % 1000) / 10)
  return `${pad2(minutes)}:${pad2(seconds)}.${pad2(centis)}`
}

// ── state ──
// A page renders once per commit — no tick, no animation frame, no interval, no clock — so
// `elapsedMsAtom` only ever changes from an action, never from a wall-clock read; see
// RUNTIME.md's "Time and the sealed render". `tick` (below) is the model-level hook a future
// interactive driver calls to advance it; nothing calls it yet, matching this MVP's other
// `onPress` handlers staying inert until the interactive path lands. This page must still
// read correctly on its first, un-clicked render: stopped at zero, no laps.

const runningAtom = atom(false, "runningAtom")
const elapsedMsAtom = atom(0, "elapsedMsAtom")
const lapsAtom = atom<readonly number[]>([], "lapsAtom")

const tick = makeTick(elapsedMsAtom, "tick")

const start = action(() => {
  if (runningAtom()) return
  runningAtom.set(true)
}, "start")

const stop = action(() => {
  if (!runningAtom()) return
  runningAtom.set(false)
}, "stop")

const reset = action(() => {
  runningAtom.set(false)
  elapsedMsAtom.set(0)
  lapsAtom.set([])
}, "reset")

const recordLap = action(() => {
  if (!runningAtom()) return
  lapsAtom.set([elapsedMsAtom(), ...lapsAtom()])
}, "recordLap")

// ── component ──

export default reatomComponent(function Page() {
  const running = runningAtom()
  const elapsed = elapsedMsAtom()
  const laps = lapsAtom()

  return (
    <Box id="app-bg" direction="column" grow={1} background="background">
      <Panel id="root" title="Секундомер" padding={1} borderColor={running ? "success" : "border"}>
        <Column id="layout" gap={1} align="center">
          <Text id="status-line" dim color="foregroundMuted">
            {running ? "Идёт отсчёт" : elapsed > 0 ? "Остановлен" : "Готов"}
          </Text>

          <Text id="elapsed-time" bold color={running ? "success" : "accent"}>
            {formatStopwatch(elapsed)}
          </Text>

          <Row id="controls-row" gap={1} justify="center">
            <Button id="btn-start-stop" onPress={wrap(() => (running ? stop() : start()))}>
              {running ? "Стоп" : elapsed > 0 ? "Продолжить" : "Старт"}
            </Button>
            <Button id="btn-lap" onPress={wrap(() => recordLap())} disabled={!running}>
              Круг
            </Button>
            <Button
              id="btn-reset"
              onPress={wrap(() => reset())}
              disabled={running || (elapsed === 0 && laps.length === 0)}
            >
              Сброс
            </Button>
          </Row>

          <Separator id="sep-laps" />

          <Column id="laps-col" gap={0} align="stretch">
            <Text id="laps-title" dim color="foregroundMuted">
              {laps.length > 0 ? `Круги (${laps.length}):` : "Кругов пока нет"}
            </Text>
            {laps.map((lapMs: number, i: number) => {
              const lapNumber = laps.length - i
              return (
                <Row id={`lap-row-${lapNumber}`} gap={1} justify="between">
                  <Text id={`lap-index-${lapNumber}`} dim color="foregroundFaint">
                    {`Круг ${lapNumber}`}
                  </Text>
                  <Text id={`lap-time-${lapNumber}`} color="foreground">
                    {formatStopwatch(lapMs)}
                  </Text>
                </Row>
              )
            })}
          </Column>
        </Column>
      </Panel>
    </Box>
  )
})
