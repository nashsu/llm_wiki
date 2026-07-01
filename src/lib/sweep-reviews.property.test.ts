/**
 * Tier 6 — property tests for extractJsonObject.
 */
import { describe, it, expect } from "vitest"
import fc from "fast-check"
import { extractJsonObject } from "./sweep-reviews"

/** A valid JSON value. */
const jsonValueArb: fc.Arbitrary<unknown> = fc.jsonValue()

/** A JSON object (top-level {}). */
const jsonObjectArb = fc.dictionary(fc.string(), jsonValueArb)

describe("extractJsonObject — properties", () => {
  // Compare through JSON round-trip so edge cases like -0 vs +0 (which JSON
  // doesn't preserve) don't trip up the property. We care that the object
  // survives a round-trip through our extractor, not that -0 stays negative.
  function jsonRoundTrip(x: unknown): unknown {
    return JSON.parse(JSON.stringify(x))
  }

  it("extracts a bare JSON object unchanged (round-trip parses to same value)", () => {
    fc.assert(
      fc.property(jsonObjectArb, (obj) => {
        const serialized = JSON.stringify(obj)
        const extracted = extractJsonObject(serialized)
        expect(extracted).toBeTruthy()
        expect(JSON.parse(extracted)).toEqual(jsonRoundTrip(obj))
      }),
    )
  })

  it("extracts a fenced JSON object", () => {
    fc.assert(
      fc.property(jsonObjectArb, (obj) => {
        const serialized = JSON.stringify(obj)
        const wrapped = "```json\n" + serialized + "\n```"
        const extracted = extractJsonObject(wrapped)
        expect(JSON.parse(extracted)).toEqual(jsonRoundTrip(obj))
      }),
    )
  })

  it("finds a JSON object trailing after prose (no-brace prose)", () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !s.includes("{") && !s.includes("}")),
        jsonObjectArb,
        (prose, obj) => {
          const input = prose + " " + JSON.stringify(obj)
          const extracted = extractJsonObject(input)
          expect(JSON.parse(extracted)).toEqual(jsonRoundTrip(obj))
        },
      ),
    )
  })

  it("returns a balanced {...} substring — depth returns to 0", () => {
    fc.assert(
      fc.property(jsonObjectArb, (obj) => {
        const input = "prose " + JSON.stringify(obj) + " trailing"
        const extracted = extractJsonObject(input)
        if (!extracted) return
        // Count braces outside strings — must balance
        let depth = 0
        let inString = false
        let escape = false
        for (const ch of extracted) {
          if (escape) {
            escape = false
            continue
          }
          if (ch === "\\" && inString) {
            escape = true
            continue
          }
          if (ch === '"') inString = !inString
          else if (!inString) {
            if (ch === "{") depth++
            else if (ch === "}") depth--
          }
        }
        expect(depth).toBe(0)
      }),
    )
  })

  it("never throws, even on random garbage", () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        expect(() => extractJsonObject(input)).not.toThrow()
      }),
    )
  })
})
