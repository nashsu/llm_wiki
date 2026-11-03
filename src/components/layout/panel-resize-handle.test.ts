import { describe, expect, it } from "vitest"
import { nextPanelWidth, panelOuterWidth, panelReserve } from "./panel-resize-handle"

const base = { startWidth: 300, min: 150, containerWidth: 1000, reserve: 126 }

describe("nextPanelWidth", () => {
  it("grows a left panel when dragged right", () => {
    expect(nextPanelWidth({ ...base, side: "left", deltaX: 50 })).toBe(350)
  })

  it("grows a right panel when dragged left", () => {
    expect(nextPanelWidth({ ...base, side: "right", deltaX: -50 })).toBe(350)
  })

  it("has no fixed upper limit, only the room left in the container", () => {
    expect(nextPanelWidth({ ...base, side: "left", deltaX: 500 })).toBe(800)
    expect(nextPanelWidth({ ...base, side: "left", deltaX: 500, containerWidth: 3000 })).toBe(800)
  })

  it("stops so the handle and center stay on screen", () => {
    expect(nextPanelWidth({ ...base, side: "left", deltaX: 5000 })).toBe(874)
  })

  it("keeps the minimum width", () => {
    expect(nextPanelWidth({ ...base, side: "left", deltaX: -5000 })).toBe(150)
  })

  it("leaves room for an open panel on the other side", () => {
    const reserve = panelReserve(panelOuterWidth(400))
    expect(nextPanelWidth({ ...base, reserve, side: "left", deltaX: 5000 })).toBe(468)
  })
})
