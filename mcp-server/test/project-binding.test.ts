import assert from "node:assert/strict"
import { test } from "node:test"
import { McpProjectBinding, withActiveProject } from "../src/project-binding.js"

const alpha = { id: "p1", name: "Alpha", path: "/wiki/alpha", current: true }
const beta = { id: "p2", name: "Beta", path: "/wiki/beta", current: false }

test("pin resolves current to a stable project id", () => {
  const binding = new McpProjectBinding()
  binding.pin("current", [alpha, beta], alpha)
  assert.equal(binding.resolve(), "p1")
  assert.equal(binding.resolve("current"), "p1")
})

test("pinned sessions reject cross-project overrides", () => {
  const binding = new McpProjectBinding()
  binding.pin("p1", [alpha, beta], alpha)
  assert.equal(binding.resolve("/wiki/alpha"), "p1")
  assert.throws(() => binding.resolve("p2"), /override p2 was rejected/)
})

test("unbound sessions preserve the current-project compatibility default", () => {
  const binding = new McpProjectBinding()
  assert.equal(binding.resolve(), "current")
  assert.equal(binding.resolve("p2"), "p2")
})

test("responses carry a structural active-project reminder", () => {
  assert.match(withActiveProject("result", alpha, "p1"), /^\[activeProject: Alpha \(p1\)\]/)
})
