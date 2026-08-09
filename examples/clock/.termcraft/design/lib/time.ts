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

/**
 * The example's "current moment" — a SEEDED constructor, not a live wall-clock read. A page
 * renders once per commit: there is no tick, no clock to read `new Date()` against. Every page
 * that would otherwise call `new Date()` for "now" reads this shared, fixed instant instead;
 * see RUNTIME.md's "Time and the sealed render".
 */
export const SEEDED_NOW = new Date(2026, 0, 1, 9, 41, 0)
