/** Injectable time source; production uses `systemClock`, tests use fakes. */
export interface Clock {
  readonly now: () => Date
}
