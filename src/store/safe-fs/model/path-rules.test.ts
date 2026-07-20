import { describe, expect, test } from "bun:test"

import {
  MAX_COMPONENT_BYTES,
  MAX_PATH_BYTES,
  MAX_PATH_COMPONENTS,
  NameCollisionError,
  PathRuleError,
  detectNameCollisions,
  foldName,
  validateRelativePath,
} from "./path-rules"

/** Assert a path is rejected and return the rejection so the class code can be asserted. */
function reject(raw: string): PathRuleError {
  const result = validateRelativePath(raw)
  if (!(result instanceof PathRuleError)) throw new Error(`expected rejection for ${JSON.stringify(raw)}`)
  return result
}

/** Assert a path is accepted and return its components. */
function accept(raw: string): readonly string[] {
  const result = validateRelativePath(raw)
  if (result instanceof Error) throw new Error(`expected acceptance for ${JSON.stringify(raw)}: ${result.message}`)
  return result
}

describe("validateRelativePath — turn-durability §5.1 rejection classes", () => {
  test("accepts a canonical managed relative path", () => {
    expect(accept("pages/home/page.tsx")).toEqual(["pages", "home", "page.tsx"])
  })

  test("rejects an empty path", () => {
    expect(reject("").code).toBe("EMPTY")
  })

  test("rejects a NUL character", () => {
    expect(reject(`pages/ho${String.fromCharCode(0)}me.tsx`).code).toBe("CONTROL_CHAR")
  })

  test("rejects every other control-character class", () => {
    for (const code of [0x01, 0x09, 0x0a, 0x0d, 0x1f, 0x7f]) {
      expect(reject(`pages/home${String.fromCharCode(code)}.tsx`).code).toBe("CONTROL_CHAR")
    }
  })

  test("rejects the Windows device namespaces", () => {
    expect(reject("\\\\?\\C:\\x").code).toBe("DEVICE_NAMESPACE")
    expect(reject("\\\\.\\PhysicalDrive0").code).toBe("DEVICE_NAMESPACE")
    expect(reject("//?/C:/x").code).toBe("DEVICE_NAMESPACE")
  })

  test("rejects UNC paths", () => {
    expect(reject("\\\\server\\share\\x").code).toBe("UNC")
    expect(reject("//server/share/x").code).toBe("UNC")
  })

  test("rejects POSIX absolute paths", () => {
    expect(reject("/etc/passwd").code).toBe("ABSOLUTE_POSIX")
  })

  test("rejects drive-rooted and drive-relative Windows paths", () => {
    expect(reject("C:\\Windows\\system32").code).toBe("DRIVE_PATH")
    expect(reject("C:/Windows/system32").code).toBe("DRIVE_PATH")
    expect(reject("C:relative.txt").code).toBe("DRIVE_PATH")
  })

  test("rejects backslashes and alternate separators inside a relative path", () => {
    expect(reject("pages\\home.tsx").code).toBe("BACKSLASH")
  })

  test("rejects a colon anywhere in a component (NTFS alternate data streams)", () => {
    expect(reject("pages/home.tsx:secret").code).toBe("COLON")
    expect(reject("pages/home.tsx:$DATA").code).toBe("COLON")
  })

  test("rejects `.` and `..` components", () => {
    expect(reject("..").code).toBe("DOT_COMPONENT")
    expect(reject("pages/../../escape.tsx").code).toBe("DOT_COMPONENT")
    expect(reject("./pages.json").code).toBe("DOT_COMPONENT")
  })

  test("rejects empty components", () => {
    expect(reject("pages//home.tsx").code).toBe("EMPTY_COMPONENT")
    expect(reject("pages/").code).toBe("EMPTY_COMPONENT")
  })

  test("rejects components ending in a dot or a space", () => {
    expect(reject("pages/home.").code).toBe("TRAILING_DOT_OR_SPACE")
    expect(reject("pages/home ").code).toBe("TRAILING_DOT_OR_SPACE")
    expect(reject("pages./home.tsx").code).toBe("TRAILING_DOT_OR_SPACE")
  })

  test("rejects Windows reserved device names, including with an extension", () => {
    expect(reject("con").code).toBe("RESERVED_DEVICE_NAME")
    expect(reject("pages/NUL.tsx").code).toBe("RESERVED_DEVICE_NAME")
    expect(reject("pages/com1.tsx").code).toBe("RESERVED_DEVICE_NAME")
    expect(reject("LPT9").code).toBe("RESERVED_DEVICE_NAME")
    expect(reject("aux/x.tsx").code).toBe("RESERVED_DEVICE_NAME")
  })

  test("`console.tsx` is not reserved — only the exact device stem is", () => {
    expect(accept("console.tsx")).toEqual(["console.tsx"])
  })
})

describe("validateRelativePath — §5.1 size limits at the boundary and one over", () => {
  test(`accepts exactly ${MAX_PATH_BYTES} UTF-8 bytes and rejects one more`, () => {
    const at = `${"a".repeat(120)}/${"b".repeat(119)}`
    expect(Buffer.byteLength(at, "utf8")).toBe(MAX_PATH_BYTES)
    expect(accept(at)).toHaveLength(2)

    const over = `${"a".repeat(120)}/${"b".repeat(120)}`
    expect(Buffer.byteLength(over, "utf8")).toBe(MAX_PATH_BYTES + 1)
    expect(reject(over).code).toBe("PATH_TOO_LONG")
  })

  test("path length is measured in UTF-8 bytes, not UTF-16 code units", () => {
    // "é" is 2 UTF-8 bytes: 121 of them are 242 bytes — over the limit — but only
    // 121 JS string units, which a naive `.length` check would wave through.
    const over = "é".repeat(121)
    expect(over.length).toBe(121)
    expect(Buffer.byteLength(over, "utf8")).toBe(242)
    expect(reject(over).code).toBe("PATH_TOO_LONG")
  })

  test(`accepts exactly ${MAX_PATH_COMPONENTS} components and rejects one more`, () => {
    const at = Array.from({ length: MAX_PATH_COMPONENTS }, () => "a").join("/")
    expect(accept(at)).toHaveLength(MAX_PATH_COMPONENTS)

    const over = Array.from({ length: MAX_PATH_COMPONENTS + 1 }, () => "a").join("/")
    expect(reject(over).code).toBe("TOO_MANY_COMPONENTS")
  })

  test(`accepts a ${MAX_COMPONENT_BYTES}-byte component and rejects one byte more`, () => {
    expect(accept("x".repeat(MAX_COMPONENT_BYTES))).toHaveLength(1)
    expect(reject("x".repeat(MAX_COMPONENT_BYTES + 1)).code).toBe("COMPONENT_TOO_LONG")
  })
})

describe("detectNameCollisions — §5.1 NFC + case-fold collisions", () => {
  test("folds to NFC and lower case", () => {
    expect(foldName("Café.tsx")).toBe(foldName("café.tsx"))
  })

  test("rejects two names that differ only by Unicode normalization", () => {
    // "café" decomposed (e + U+0301 combining acute) vs. the precomposed spelling:
    // two distinct byte strings that name one file on a normalizing filesystem.
    const decomposed = `cafe${String.fromCharCode(0x301)}.tsx`
    const precomposed = "café.tsx"
    expect(decomposed).not.toBe(precomposed)
    expect(detectNameCollisions("pages", [decomposed, precomposed])).toBeInstanceOf(NameCollisionError)
  })

  test("rejects two names that differ only by case", () => {
    const collision = detectNameCollisions("pages", ["Home.tsx", "home.tsx"])
    expect(collision).toBeInstanceOf(NameCollisionError)
  })

  test("accepts genuinely distinct names", () => {
    expect(detectNameCollisions("pages", ["home.tsx", "about.tsx", "café.tsx"])).toBeNull()
  })
})
