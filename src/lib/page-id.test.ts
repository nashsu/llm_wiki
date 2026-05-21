/**
 * ADR 0003 Tier A: pageId / dedupKey invariants.
 *
 * The catalogued duplicate-page defects (eval/wiki-defect-patterns.jsonl)
 * collapse to two properties failing — pageId not idempotent, and no
 * dedupKey to bucket orthographic variants. These tests pin both.
 */
import { describe, it, expect } from "vitest"
import { pageId, dedupKey } from "./page-id"

describe("pageId", () => {
  it("hyphenates camelCase via the heuristic split", () => {
    expect(pageId("MapReduce")).toBe("map-reduce")
    expect(pageId("WriteAheadLog")).toBe("write-ahead-log")
  })

  it("leaves acronym runs intact (no lower→upper boundary)", () => {
    expect(pageId("OLAP")).toBe("olap")
    expect(pageId("NTP")).toBe("ntp")
  })

  it("folds punctuation, slashes and spaces to single hyphens", () => {
    expect(pageId("Publish/Subscribe")).toBe("publish-subscribe")
    expect(pageId("two-phase commit")).toBe("two-phase-commit")
    expect(pageId("X/Open XA")).toBe("x-open-xa")
  })

  it("lower-cases — case-only variants collapse to one id", () => {
    expect(pageId("Dynamo")).toBe("dynamo")
    expect(pageId("DYNAMO")).toBe("dynamo")
  })

  it("keeps CJK characters intact", () => {
    expect(pageId("分布式系统")).toBe("分布式系统")
  })

  it("is idempotent: pageId(pageId(x)) === pageId(x)", () => {
    const inputs = [
      "MapReduce",
      "Publish/Subscribe (Pub/Sub)",
      "  Spanner's   synchronized clocks  ",
      "DynamoDB",
      "99.9% availability",
      "a".repeat(200),
      "分布式 MapReduce",
    ]
    for (const x of inputs) {
      expect(pageId(pageId(x))).toBe(pageId(x))
    }
  })

  it("truncates on a hyphen boundary, never mid-word", () => {
    const long = pageId(Array.from({ length: 30 }, (_, i) => `word${i}`).join(" "))
    expect(long.length).toBeLessThanOrEqual(80)
    expect(long.endsWith("-")).toBe(false)
    expect(long.startsWith("-")).toBe(false)
  })

  it("returns empty string when nothing usable remains", () => {
    expect(pageId("🎉🔥")).toBe("")
    expect(pageId("   ")).toBe("")
  })
})

describe("dedupKey", () => {
  it("strips all non-alphanumeric characters", () => {
    expect(dedupKey("map-reduce")).toBe("mapreduce")
    expect(dedupKey("x-open-xa")).toBe("xopenxa")
  })

  it("buckets a pageId heuristic misfire with its collapsed twin", () => {
    // pageId("DynamoDB") may yield `dynamo-db`; the bare `dynamodb`
    // page must land in the same bucket so the Dedup pass catches it.
    expect(dedupKey(pageId("DynamoDB"))).toBe(dedupKey("dynamodb"))
    expect(dedupKey("publish-subscribe")).toBe(dedupKey("publishsubscribe"))
  })

  it("keeps genuinely different version numbers in different buckets", () => {
    // 99.9% vs 99.99% are not duplicates.
    expect(dedupKey(pageId("99.9% availability"))).not.toBe(
      dedupKey(pageId("99.99% availability")),
    )
  })

  it("is idempotent: dedupKey(dedupKey(x)) === dedupKey(x)", () => {
    for (const x of ["Map-Reduce", "riak-2.x-datatypes", "分布式系统", ""]) {
      expect(dedupKey(dedupKey(x))).toBe(dedupKey(x))
    }
  })
})
