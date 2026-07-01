import { createElement, isValidElement } from "react"
import { describe, expect, it } from "vitest"
import { MermaidDiagram, unwrapMermaidPre } from "./mermaid-diagram"

describe("unwrapMermaidPre", () => {
  it("returns a MermaidDiagram element so markdown renderers can avoid nesting it in pre", () => {
    const mermaid = createElement(MermaidDiagram, { code: "graph TD; A-->B;" })

    const unwrapped = unwrapMermaidPre(mermaid)
    expect(isValidElement(unwrapped)).toBe(true)
    expect(isValidElement(unwrapped) ? unwrapped.type : null).toBe(MermaidDiagram)
  })

  it("leaves normal code children wrapped in pre", () => {
    const code = createElement("code", { className: "language-ts" }, "const x = 1")

    expect(unwrapMermaidPre(code)).toBeNull()
  })

  it("does not unwrap multiple children", () => {
    const mermaid = createElement(MermaidDiagram, { code: "graph TD; A-->B;" })

    expect(unwrapMermaidPre([mermaid, "extra"])).toBeNull()
  })
})
