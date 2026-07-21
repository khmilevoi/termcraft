import type { Clock } from "../types";

export const systemClock: Clock = {
  now: () => new Date(),
};
