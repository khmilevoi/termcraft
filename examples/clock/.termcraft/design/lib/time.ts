// Shared pure date/time formatting helpers used across pages. No timers, no
// randomness — safe to call from a deterministic export render.

/** Zero-pads a non-negative number to 2 digits: `7` -> `"07"`. */
export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** Full Russian weekday names, Sunday-first — matches `Date#getDay()` indexing. */
export const WEEKDAYS_RU = [
  "Воскресенье",
  "Понедельник",
  "Вторник",
  "Среда",
  "Четверг",
  "Пятница",
  "Суббота",
] as const

/** `HH:MM:SS` for a given instant. */
export function fullTime(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}
