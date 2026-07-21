// Domain-free Windows filesystem-fact primitives (Spike F,
// `docs/spikes/06-win-fs-identity/FINDINGS.md`): the tag-agnostic reparse-point
// backstop for the no-follow writable-parent check, and the canonical filesystem
// identity string. `store/safe-fs` consumes the reparse check; `store/trust` consumes
// the identity string. This ring knows nothing about pages, chats, or projects.
export type { FsGuardError } from "./types";
export { FileAttributesError, FsGuardUnavailableError, FsIdentityError } from "./model/errors";
export { isReparsePoint } from "./model/reparse-check";
export { formatFsIdentity } from "./model/fs-identity";
export { FILE_ATTRIBUTE_REPARSE_POINT } from "./model/kernel32";
