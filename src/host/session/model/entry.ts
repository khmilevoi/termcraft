import fs from "node:fs/promises";

import {
  installThirdPartyConsoleBridge,
  uninstallThirdPartyConsoleBridge,
} from "infrastructure/debug-log";
import { FrameDecoder } from "infrastructure/framing";

import {
  PROTOCOL_HARD_LIMITS,
  ProtocolError,
  type RuntimeDeclarationBundleV1,
  encodeControlEnvelope,
  encodeFrameEnvelope,
  encodeHostHello,
} from "../../protocol";
import { createHeadlessRenderer } from "../../render";
import type { ExitRequest, HostSessionDeps, OutboundMessage } from "../types";
import { denyDynamicCodeCapability } from "./capability-denial";
import { createHostSession } from "./host-state-machine";
import { registerRuntimeResolver } from "./resolver";
import { createPageLoader, createThemeSeedLoader, warmPageMetaValidator } from "./source-mount";

const HEARTBEAT_INTERVAL_MS = 1000;

/** True iff argv requests `_host --stdio` (compiled or `bun run`; Spike E). */
export function parseHostArgs(argv: string[]): boolean {
  const hostIndex = argv.indexOf("_host");
  if (hostIndex === -1) return false;
  return argv.indexOf("--stdio") > hostIndex;
}

/** The transport-and-lifecycle dependencies of the `_host` child. */
export interface HostStdioIo {
  readonly argv: string[];
  readonly input: AsyncIterable<Uint8Array>;
  readonly output: (bytes: Uint8Array) => void;
  readonly now: () => number;
  readonly exit: (code: number) => void;
  readonly deps: {
    readonly runtimeDeclaration: RuntimeDeclarationBundleV1;
    readonly limits: typeof PROTOCOL_HARD_LIMITS;
    readonly createRenderer?: HostSessionDeps["createRenderer"];
  };
}

/**
 * Run the host-side protocol loop over an injected byte transport. It feeds a
 * `FrameDecoder` from `io.input`, drives a `HostSession`, encodes each outbound
 * logical message with the 2A codecs and writes it via `io.output`, ticks the
 * heartbeat on `io.now`, and on the session's `ExitRequest` stops the heartbeat,
 * destroys the live renderer, flushes, and calls `io.exit` (Spike D — the child
 * never self-exits). A framing/decoder failure terminates the incarnation.
 */
export async function runHostStdio(io: HostStdioIo): Promise<void> {
  registerRuntimeResolver();

  // `@opentui/core` reports highlight failures with `console.warn` and worker/init failures with
  // `console.error`. The renderer runs with `consoleMode: "disabled"`, which RESTORES the real
  // `console` rather than silencing it, so those calls reach it — and `console.warn`/`console.error`
  // write to STDERR, a pipe separate from `io.output`'s stdout protocol frames, which the
  // supervisor drains independently. So there is no framing-corruption path here to guard against:
  // nothing in `src/host/**` ever calls `suspendConsolePassthrough()` (the only call site is
  // `ui/app/model/render-root.tsx`, the interactive shell, where stdout and stderr ARE the same
  // tty), so a bridged line still reaches stderr exactly as an unbridged one would. What this
  // bridge buys HERE is recoverability, not protection: the line also lands in this incarnation's
  // debug trace file, so a dependency diagnostic that would otherwise vanish the moment this
  // process exits can be read back after the fact.
  installThirdPartyConsoleBridge();

  let liveRenderer: { destroy(): void } | null = null;
  let exited = false;
  const { promise: done, resolve: resolveDone } = Promise.withResolvers<void>();

  const performExit = (request: ExitRequest) => {
    if (exited) return;
    exited = true;
    clearInterval(heartbeat);
    liveRenderer?.destroy();
    liveRenderer = null;
    uninstallThirdPartyConsoleBridge();
    io.exit(request.code);
    resolveDone();
  };

  const encodeOutbound = (message: OutboundMessage): ProtocolError | Uint8Array => {
    if (message.type === "host-hello") return encodeHostHello(message.payload);
    if (message.type === "frame") return encodeFrameEnvelope(message.payload);
    return encodeControlEnvelope(message.payload);
  };

  // ONE LOADER PER PROCESS = one per incarnation (design §9.2): its verified-file set and its
  // symlink memo are facts about THIS tree revision, and this process serves exactly one. Built
  // once here, outside `createHostSession`, so it survives every mount this incarnation accepts
  // (task 1's repeated-`mount` state-machine change) rather than being rebuilt per call.
  //
  // ONE SHARED `pageLoaderDeps` FOR BOTH LOADERS (design-systems §4.6, task 5): the page loader
  // and the theme-seed loader both read the same mounted tree through the same `link`/`lstat`
  // boundary, so they share one dependency object rather than two independently-typed copies.
  const pageLoaderDeps = {
    link: (absolutePath: string) => import(absolutePath),
    lstat: fs.lstat,
  };
  const load = createPageLoader(pageLoaderDeps);
  const loadThemeSeed = createThemeSeedLoader(pageLoaderDeps);

  const session = createHostSession({
    runtimeDeclaration: io.deps.runtimeDeclaration,
    limits: io.deps.limits,
    loadPage: (args) => {
      // MUST fire exactly HERE — as the first statements of the ONE function that turns a
      // mount request into `import()`ing a page's actual source, which is the first point
      // UNTRUSTED page code executes at all, including code placed at module scope (task-10
      // Step 6). Everything before this call is either boot (module graph linking) or WIRE
      // PROTOCOL the host's own trusted code decodes — and neither turned out to be free of
      // the capability being denied: MEASURED, not assumed (task-10-report.md, real spawned
      // `_host --stdio` processes, not the loadPage-only Step 1 probe, which had its own
      // measured blind spot — see the report). Zod v4's `$ZodObjectJIT` builds each object
      // schema's fast-path validator with `new Function` the FIRST time that SPECIFIC schema
      // is parsed in THIS process — a per-schema, lazily-built, then-cached closure, distinct
      // from the shared `Function`-availability probe. `clientHelloSchema` (the handshake) and
      // `controlEnvelopeSchema` (the OUTER shape of every inbound mount/resize/query envelope,
      // including the very mount request that reaches this closure) both hit that path on
      // their own first use and are ALREADY warmed by real traffic by the time `loadPage` is
      // ever called (hello, then this envelope). `pageMetaSchema` — the PAGE's own meta,
      // `source-mount.ts` — hits the SAME path but is NOT warmed by anything before this point
      // (`loadPage` reaches it only AFTER `import()`, i.e., after the page's own code already
      // ran), so it is warmed EXPLICITLY, one line below, before denial installs.
      warmPageMetaValidator();
      denyDynamicCodeCapability();
      return load(args);
    },
    loadThemeSeed,
    createRenderer: async (size) => {
      const renderer = await (io.deps.createRenderer ?? createHeadlessRenderer)(size);
      liveRenderer = renderer;
      return renderer;
    },
    now: io.now,
    send: (message) => {
      const bytes = encodeOutbound(message);
      if (bytes instanceof ProtocolError) {
        performExit({ code: 1, reason: String(bytes.reason) });
        return;
      }
      io.output(bytes);
    },
    requestExit: performExit,
  });

  const heartbeat = setInterval(() => session.emitHeartbeat(), HEARTBEAT_INTERVAL_MS);

  const decoder = new FrameDecoder();
  const pump = (async () => {
    try {
      for await (const chunk of io.input) {
        if (exited) break;
        const frames = decoder.feed(chunk);
        if (frames instanceof Error) {
          performExit({ code: 1, reason: frames.message });
          return;
        }
        for (const frame of frames) {
          if (exited) break;
          // stdout is protocol-only; the child only receives control-class inbound.
          await session.receiveControlPayload(frame.payload);
        }
      }
    } catch (cause) {
      // A live stdin stream can throw mid-iteration; route it to a typed exit so
      // the heartbeat interval is never leaked (the error is not swallowed — it
      // drives termination and surfaces in the exit reason).
      performExit({ code: 1, reason: `stdin iteration failed: ${String(cause)}` });
    }
  })();

  // The race ends on either signal (input closed, or an exit requested). The
  // `finally` guarantees the heartbeat interval is cleared on every path, so a
  // pump rejection can never leak it.
  try {
    await Promise.race([done, pump]);
  } finally {
    clearInterval(heartbeat);
  }
  // `pump` can finish two ways: an explicit ExitRequest already ran `performExit` (the
  // `done` half of the race resolved it), or `io.input` simply ended — the parent's pipe
  // closed with no ExitRequest ever sent. Spike D: a Reatom + OpenTUI process does not exit
  // on its own once its renderer is destroyed, so the "stdin closed" case needs the SAME
  // explicit-exit guarantee as every other termination path, or the child is orphaned with a
  // live headless renderer and no supervisor left to kill it. `performExit` is idempotent
  // (its own `exited` guard), so this is a no-op on the already-exited path and the missing
  // guarantee on the stdin-closed path.
  performExit({ code: 0, reason: "stdin closed" });
  await done;
}
