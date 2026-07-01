/**
 * Tier 6 — property tests for path-utils.
 */
import { describe, it, expect } from "vitest"
import fc from "fast-check"
import { normalizePath, joinPath, getFileName, getFileStem } from "./path-utils"

describe("normalizePath — properties", () => {
  it("is idempotent", () => {
    fc.assert(
      fc.property(fc.string(), (p) => {
        expect(normalizePath(normalizePath(p))).toBe(normalizePath(p))
      }),
    )
  })

  it("output contains no backslashes", () => {
    fc.assert(
      fc.property(fc.string(), (p) => {
        expect(normalizePath(p)).not.toMatch(/\\/)
      }),
    )
  })

  it("only changes backslashes — length is preserved", () => {
    fc.assert(
      fc.property(fc.string(), (p) => {
        expect(normalizePath(p).length).toBe(p.length)
      }),
    )
  })
})

describe("getFileName / getFileStem — properties", () => {
  it("getFileName of a path ending in /foo is 'foo'", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((s) => !s.includes("/") && !s.includes("\\") && s.length > 0),
        (name) => {
          expect(getFileName(`/some/path/${name}`)).toBe(name)
          expect(getFileName(`C:\\a\\b\\${name}`)).toBe(name)
        },
      ),
    )
  })

  it("getFileStem strips at the LAST dot (if one exists past position 0)", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((s) => !s.includes("/") && !s.includes("\\") && !s.includes(".")),
        fc.string({ minLength: 1 }).filter((s) => !s.includes("/") && !s.includes("\\") && !s.includes(".")),
        (stem, ext) => {
          expect(getFileStem(`${stem}.${ext}`)).toBe(stem)
        },
      ),
    )
  })
})

describe("joinPath — properties", () => {
  it("contains no double-slashes in output", () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 10 }), { minLength: 1, maxLength: 5 }), (segs) => {
        const joined = joinPath(...segs)
        expect(joined).not.toMatch(/\/\//)
      }),
    )
  })

  it("contains no backslashes in output", () => {
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 10 }), { minLength: 1, maxLength: 5 }), (segs) => {
        expect(joinPath(...segs)).not.toMatch(/\\/)
      }),
    )
  })
})
