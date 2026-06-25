import { describe, expect, it } from "vitest"

import { API_ENDPOINTS } from "./api-server-section"

describe("API server endpoint documentation", () => {
  it("lists the project review endpoint", () => {
    expect(API_ENDPOINTS).toContainEqual({
      method: "GET",
      path: "/api/v1/projects/{id}/reviews",
      noteKey: "endpointReviewsNote",
    })
  })
})
