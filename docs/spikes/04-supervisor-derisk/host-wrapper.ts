// D1/D2/D3 probe: a `main`-lite that wires the real 2C `runHostStdio` child to
// Bun.stdin/stdout so the supervisor de-risking probes can spawn a genuine host
// incarnation. NOT production code — the real argv dispatch + execPath/dev branch
// is the phase-8 composition root's job (Spike E). Throwaway spike evidence.
import { PROTOCOL_HARD_LIMITS } from "../../../src/host/protocol"
import type { RuntimeDeclarationBundleV1 } from "../../../src/host/protocol"
import { parseHostArgs, runHostStdio } from "../../../src/host/session"
import { CURRENT_KIT_API_VERSION } from "../../../src/runtime"

const runtimeDeclaration: RuntimeDeclarationBundleV1 = {
  module: "@termcraft/runtime",
  currentKitApiVersion: CURRENT_KIT_API_VERSION,
  supportedKitApiVersions: [CURRENT_KIT_API_VERSION],
  publicCapabilityIds: [],
}

if (!parseHostArgs(process.argv)) {
  process.stderr.write("wrapper: not a `_host --stdio` invocation\n")
  process.exit(2)
}

const writer = Bun.stdout.writer()

await runHostStdio({
  argv: process.argv,
  input: Bun.stdin.stream() as AsyncIterable<Uint8Array>,
  output: (bytes) => {
    writer.write(bytes)
    writer.flush()
  },
  now: () => Math.trunc(Bun.nanoseconds() / 1e6),
  exit: (code) => process.exit(code),
  deps: { runtimeDeclaration, limits: PROTOCOL_HARD_LIMITS },
})
