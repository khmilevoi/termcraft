import { ProtocolError } from "../../protocol";
import type { ControlEnvelope } from "../../protocol";
import type { HostSessionSpec } from "../../types";

/**
 * Build the `mount` request body both drivers send (host-supervision §6.5), and enforce the one
 * invariant that ties this session's IDENTITY to what the host will actually verify.
 *
 * WHY THE CHECK LIVES HERE (task 15). `HostSessionSpec.sourceHash` is identity: `mintIdentity`
 * stamps it into `HostSessionIdentity`, every `FrameEnvelope` carries it, and
 * `session.ts`'s `checkFrameIdentity` kills the child on a mismatch. The bytes, meanwhile, are
 * verified by `loadPage` against `expectedFiles`. If the two ever described different bytes, the
 * host would mount the file its inventory names, stamp ITS hash into the frames, and the
 * supervisor would terminate a perfectly healthy incarnation with `MALFORMED_PROTOCOL` — a loud
 * failure with a wrong diagnosis. Asking the question once, before the mount goes out, turns
 * that into an honest refusal naming the real disagreement.
 *
 * `expectedFiles` crosses the wire as plain `{relPath, sha256}` objects — `ControlEnvelope.body`
 * is a generic JSON object (`decodeControlEnvelope`'s `body: jsonObjectSchema`), so no protocol
 * schema change is needed on either side; `host-state-machine.ts`'s `parseExpectedFiles` is the
 * receiving validator.
 */
export function buildMountBody(
  spec: HostSessionSpec,
  deterministic: boolean,
): ProtocolError | ControlEnvelope["body"] {
  const entry = spec.expectedFiles.find((file) => file.relPath === spec.entryRelPath);
  if (entry === undefined) {
    return new ProtocolError({
      code: "MALFORMED_PROTOCOL",
      reason: `the session's entry "${spec.entryRelPath}" is absent from its own expected design-tree inventory`,
    });
  }
  if (entry.sha256 !== spec.sourceHash) {
    return new ProtocolError({
      code: "SOURCE_HASH_MISMATCH",
      reason: `the session's identity hash ${spec.sourceHash} disagrees with the inventory's hash ${entry.sha256} for "${spec.entryRelPath}"`,
    });
  }

  return {
    treeRoot: spec.treeRoot,
    entryRelPath: spec.entryRelPath,
    expectedFiles: spec.expectedFiles.map((file) => ({
      relPath: file.relPath,
      sha256: file.sha256,
    })),
    mode: spec.mode,
    interactionMode: spec.interactionMode,
    size: { w: spec.size.w, h: spec.size.h },
    theme: spec.theme,
    capabilities: { colorDepth: spec.capabilities.colorDepth },
    deterministic,
  };
}
