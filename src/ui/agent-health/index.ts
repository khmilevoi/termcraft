/**
 * `ui/agent-health` — the agent CLI's health reading. Consumed by `ui/home` (its panels and its
 * submit policy), by `ui/workspace` (the status-bar badge), by `ui/app` (the atom, the probe
 * injection point and the key context) and by `entrypoint` (the real probe that produces it).
 */
export type { AgentHealth } from "./types";
