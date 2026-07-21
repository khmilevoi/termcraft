import * as errore from "errore";

/**
 * A managed relative path violated the turn-durability §5.1 grammar. `code` names the
 * rejection class so callers (and the hostile test matrix) can assert *which* rule fired
 * rather than merely that something was refused.
 */
export class PathRuleError extends errore.createTaggedError({
  name: "PathRuleError",
  message: "rejected managed path [$code]: $reason",
}) {}

/**
 * Two discovered names collide under Unicode NFC plus case folding (§5.1). Either name
 * alone is legal; the pair is not, because a normalizing or case-insensitive volume
 * cannot keep them distinct and a managed tree must mean the same thing everywhere.
 */
export class NameCollisionError extends errore.createTaggedError({
  name: "NameCollisionError",
  message: "names $first and $second collide under NFC + case folding in $directory",
}) {}

/** §5.1: "a path longer than 240 UTF-8 bytes". */
export const MAX_PATH_BYTES = 240;
/** §5.1: "more than 16 components". */
export const MAX_PATH_COMPONENTS = 16;
/** §5.1: "a component longer than 120 UTF-8 bytes". */
export const MAX_COMPONENT_BYTES = 120;

/**
 * Windows reserved device names (§5.1). Same set `entities/page` excludes from the slug
 * mask; repeated here because path rules apply to every component, not only page slugs.
 */
export const WINDOWS_RESERVED_DEVICE_NAMES: ReadonlySet<string> = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
]);

function reject(code: string, reason: string): PathRuleError {
  return new PathRuleError({ code, reason });
}

/** True for NUL and every other C0/C1-adjacent control character §5.1 forbids. */
function hasControlCharacter(raw: string): boolean {
  for (const char of raw) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * The §5.1 component rules: no empty/dot components, no colon (which is what excludes
 * NTFS alternate data streams), no trailing dot or space, no reserved device name, and
 * the 120-byte ceiling.
 */
function validateComponent(component: string): PathRuleError | null {
  if (component === "")
    return reject("EMPTY_COMPONENT", "a managed path may not contain an empty component");
  if (component === "." || component === "..") {
    return reject("DOT_COMPONENT", `\`${component}\` is not a legal managed path component`);
  }
  if (component.includes(":")) {
    return reject(
      "COLON",
      `\`${component}\` contains a colon (an alternate data stream is never a managed leaf)`,
    );
  }
  if (component.endsWith(".") || component.endsWith(" ")) {
    return reject("TRAILING_DOT_OR_SPACE", `\`${component}\` ends in a dot or a space`);
  }
  // A device name is reserved with or without an extension: `NUL.tsx` opens the null
  // device on Windows exactly as `NUL` does, so the stem before the first dot decides.
  const stem = component.split(".")[0] ?? component;
  if (WINDOWS_RESERVED_DEVICE_NAMES.has(stem.toLowerCase())) {
    return reject("RESERVED_DEVICE_NAME", `\`${component}\` is a Windows reserved device name`);
  }
  if (Buffer.byteLength(component, "utf8") > MAX_COMPONENT_BYTES) {
    return reject(
      "COMPONENT_TOO_LONG",
      `\`${component}\` exceeds ${MAX_COMPONENT_BYTES} UTF-8 bytes`,
    );
  }
  return null;
}

/**
 * Validate a canonical managed relative path against turn-durability §5.1 and return its
 * components. Canonical managed paths use `/` separators; every rejection class the spec
 * enumerates has its own `code`.
 *
 * This is a PURE grammar check — it never touches the filesystem, so a hostile path is
 * refused before a single syscall. The no-follow walk and the escape check run after it.
 */
export function validateRelativePath(raw: string): PathRuleError | readonly string[] {
  if (raw === "") return reject("EMPTY", "a managed path may not be empty");
  if (hasControlCharacter(raw))
    return reject("CONTROL_CHAR", "a managed path may not contain NUL or control characters");

  // The device-namespace and UNC prefixes are checked before the general backslash rule
  // so each spec-named class reports itself rather than collapsing into "BACKSLASH".
  const prefix = raw.slice(0, 4);
  if (prefix === "\\\\?\\" || prefix === "\\\\.\\" || prefix === "//?/" || prefix === "//./") {
    return reject("DEVICE_NAMESPACE", "a Windows device namespace is never a managed path");
  }
  if (raw.startsWith("\\\\") || raw.startsWith("//"))
    return reject("UNC", "a UNC path is never a managed path");
  if (raw.startsWith("/"))
    return reject("ABSOLUTE_POSIX", "a POSIX absolute path is never a managed path");
  if (/^[A-Za-z]:/.test(raw)) {
    return reject(
      "DRIVE_PATH",
      "a drive-rooted or drive-relative Windows path is never a managed path",
    );
  }
  if (raw.includes("\\"))
    return reject("BACKSLASH", "canonical managed paths use `/` separators only");

  if (Buffer.byteLength(raw, "utf8") > MAX_PATH_BYTES) {
    return reject("PATH_TOO_LONG", `the path exceeds ${MAX_PATH_BYTES} UTF-8 bytes`);
  }

  const components = raw.split("/");
  if (components.length > MAX_PATH_COMPONENTS) {
    return reject(
      "TOO_MANY_COMPONENTS",
      `the path has more than ${MAX_PATH_COMPONENTS} components`,
    );
  }
  for (const component of components) {
    const violation = validateComponent(component);
    if (violation instanceof Error) return violation;
  }
  return components;
}

/**
 * The comparison key for §5.1's collision rule: Unicode NFC, then case folding. Folding
 * is applied on every platform, not only case-insensitive ones — a name pair that would
 * collide on Windows must be refused everywhere, or a managed tree stops meaning the same
 * thing when it moves. `toLowerCase` is the locale-independent Unicode default mapping.
 */
export function foldName(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

/**
 * Reject any two discovered names in one directory that collide under {@link foldName}
 * (§5.1). Returns the first colliding pair; `null` when every name is distinct.
 */
export function detectNameCollisions(
  directory: string,
  names: readonly string[],
): NameCollisionError | null {
  const seen = new Map<string, string>();
  for (const name of names) {
    const folded = foldName(name);
    const first = seen.get(folded);
    if (first !== undefined) return new NameCollisionError({ directory, first, second: name });
    seen.set(folded, name);
  }
  return null;
}
