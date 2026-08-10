export { createLogger, log, resumeConsolePassthrough, suspendConsolePassthrough } from "./model/logger";
export { beginTraceRun, trace, traceEnabled, tracePath } from "./model/sink";
export type { TeeSink, TraceLine } from "./types";
