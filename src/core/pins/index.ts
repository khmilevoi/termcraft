// `core/pins` — the standalone pin surface (kernel-command-contract §8.2, §9): `pin.setStatus`
// (a user-action pin-status append) and the pin-event fold that produces complete `PinDtoV1`s
// (including the record ids `entities/pin`'s own `Pin`/`foldPins` cannot carry — see
// `pin-projection.ts`'s header for the named divergence this resolves). `pin.create` is out of
// scope here (6G, needs a `GeometryTokenV1`) — see `types.ts`'s note on its seam.

export { PinProjectionError, projectPinEvents } from "./model/pin-projection"

export type { SetPinStatusDeps, SetPinStatusInputV1, SetPinStatusResultV1 } from "./model/set-status"
export { setPinStatus } from "./model/set-status"
