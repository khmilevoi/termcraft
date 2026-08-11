import {
  definePage,
  reatomComponent,
  atom,
  action,
  wrap,
  Column,
  Row,
  Box,
  Text,
  Button,
  Input,
  Separator,
} from "@termcraft/runtime"
import { pad2, WEEKDAYS_RU, fullTime, SEEDED_NOW } from "../lib/time"
import { PageShell } from "../components/PageShell"

export const meta = definePage({
  kitApiVersion: 1,
  title: "Будильник",
  minSize: { w: 60, h: 28 },
  theme: "dark-default",
})

// ── pure helpers (no timers, no randomness — safe for a deterministic export frame) ──

function minutesOfDay(hour: number, minute: number): number {
  return hour * 60 + minute
}

function wrapAround(value: number, size: number): number {
  return ((value % size) + size) % size
}

// ── domain ──

interface Alarm {
  readonly id: string
  readonly hour: number
  readonly minute: number
  readonly label: string
  readonly enabled: boolean
}

// Sample data seeding the list on first render — colocated here, owned by this page.
const INITIAL_ALARMS: readonly Alarm[] = [
  { id: "a1", hour: 7, minute: 0, label: "Подъём", enabled: true },
  { id: "a2", hour: 8, minute: 30, label: "Тренировка", enabled: false },
  { id: "a3", hour: 22, minute: 45, label: "Отбой", enabled: true },
]

// ── state ──

const alarmsAtom = atom<readonly Alarm[]>(INITIAL_ALARMS, "alarmsAtom")
const nextAlarmIdAtom = atom(4, "nextAlarmIdAtom")

const draftHourAtom = atom(7, "draftHourAtom")
const draftMinuteAtom = atom(0, "draftMinuteAtom")
const draftLabelAtom = atom("", "draftLabelAtom")

const adjustDraftHour = action((delta: number) => {
  draftHourAtom.set(wrapAround(draftHourAtom() + delta, 24))
}, "adjustDraftHour")

const adjustDraftMinute = action((delta: number) => {
  draftMinuteAtom.set(wrapAround(draftMinuteAtom() + delta, 60))
}, "adjustDraftMinute")

const addAlarm = action(() => {
  const id = `a${nextAlarmIdAtom()}`
  nextAlarmIdAtom.set(nextAlarmIdAtom() + 1)
  const label = draftLabelAtom().trim() || "Будильник"
  alarmsAtom.set([
    ...alarmsAtom(),
    { id, hour: draftHourAtom(), minute: draftMinuteAtom(), label, enabled: true },
  ])
  draftLabelAtom.set("")
}, "addAlarm")

const toggleAlarm = action((id: string) => {
  alarmsAtom.set(
    alarmsAtom().map((a: Alarm) => (a.id === id ? { ...a, enabled: !a.enabled } : a)),
  )
}, "toggleAlarm")

const removeAlarm = action((id: string) => {
  alarmsAtom.set(alarmsAtom().filter((a: Alarm) => a.id !== id))
}, "removeAlarm")

// ── component ──
// `now` is a fixed, seeded instant (`SEEDED_NOW`, `lib/time.ts`), not a live wall-clock read —
// a page renders once per commit; see RUNTIME.md's "Time and the sealed render". All the
// interactive controls below stay correct on this first, un-clicked render: the seed alarms
// already sorted and displayed, the draft picker at a sane default.

export default reatomComponent(function Page() {
  const now = SEEDED_NOW
  const nowMinutes = minutesOfDay(now.getHours(), now.getMinutes())

  const alarms = [...alarmsAtom()].sort(
    (a, b) => minutesOfDay(a.hour, a.minute) - minutesOfDay(b.hour, b.minute),
  )

  const enabledAlarms = alarms.filter((a) => a.enabled)
  const nextAlarm =
    enabledAlarms.find((a) => minutesOfDay(a.hour, a.minute) > nowMinutes) ?? enabledAlarms[0]

  const draftHour = draftHourAtom()
  const draftMinute = draftMinuteAtom()
  const draftLabel = draftLabelAtom()

  return (
    <PageShell title="Будильник">
      <Row id="clock-row" gap={1} justify="between" align="center">
        <Text id="current-time" bold color="accent">
          {fullTime(now)}
        </Text>
        <Text id="current-weekday" dim color="foregroundMuted">
          {WEEKDAYS_RU[now.getDay()]}
        </Text>
      </Row>

      <Text id="next-alarm-line" color={nextAlarm ? "success" : "foregroundFaint"}>
        {nextAlarm
          ? `Ближайший будильник: ${pad2(nextAlarm.hour)}:${pad2(nextAlarm.minute)} — ${nextAlarm.label}`
          : "Нет активных будильников"}
      </Text>

      <Separator id="sep-header" />

      <Column id="alarms-col" gap={0} align="stretch">
        <Text id="alarms-title" dim color="foregroundMuted">
          {`Будильники (${alarms.length}):`}
        </Text>
        {alarms.map((a) => (
          <Row id={`alarm-row-${a.id}`} gap={1} align="center">
            <Box id={`alarm-time-box-${a.id}`} width={5} justify="start">
              <Text id={`alarm-time-${a.id}`} bold color={a.enabled ? "accent" : "foregroundFaint"}>
                {`${pad2(a.hour)}:${pad2(a.minute)}`}
              </Text>
            </Box>
            <Box id={`alarm-label-box-${a.id}`} grow={1} justify="start">
              <Text id={`alarm-label-${a.id}`} color={a.enabled ? "foreground" : "foregroundFaint"}>
                {a.label}
              </Text>
            </Box>
            <Row id={`alarm-actions-${a.id}`} gap={1}>
              <Button id={`alarm-toggle-${a.id}`} onPress={wrap(() => toggleAlarm(a.id))}>
                {a.enabled ? "Выкл" : "Вкл"}
              </Button>
              <Button id={`alarm-remove-${a.id}`} onPress={wrap(() => removeAlarm(a.id))}>
                Удалить
              </Button>
            </Row>
          </Row>
        ))}
      </Column>

      <Separator id="sep-add" />

      <Column id="add-alarm-col" gap={1} align="stretch">
        <Text id="add-title" dim color="foregroundMuted">
          Новый будильник:
        </Text>
        <Row id="time-picker-row" gap={1} align="center" justify="center">
          <Button id="btn-hour-down" onPress={wrap(() => adjustDraftHour(-1))}>
            {"−"}
          </Button>
          <Text id="draft-hour" bold color="accent">
            {pad2(draftHour)}
          </Text>
          <Button id="btn-hour-up" onPress={wrap(() => adjustDraftHour(1))}>
            {"+"}
          </Button>
          <Text id="time-picker-colon" color="foregroundMuted">
            {":"}
          </Text>
          <Button id="btn-minute-down" onPress={wrap(() => adjustDraftMinute(-1))}>
            {"−"}
          </Button>
          <Text id="draft-minute" bold color="accent">
            {pad2(draftMinute)}
          </Text>
          <Button id="btn-minute-up" onPress={wrap(() => adjustDraftMinute(1))}>
            {"+"}
          </Button>
        </Row>
        <Input
          id="draft-label-input"
          value={draftLabel}
          placeholder="Название будильника"
          onChange={wrap((value: string) => draftLabelAtom.set(value))}
        />
        <Row id="add-row" justify="center">
          <Button id="btn-add-alarm" onPress={wrap(() => addAlarm())}>
            Добавить будильник
          </Button>
        </Row>
      </Column>
    </PageShell>
  )
})
