import { computeStructuralLint, type StructuralLintPage } from "./lint-structural-core"

interface WorkerRequest {
  pages: StructuralLintPage[]
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const findings = computeStructuralLint(event.data.pages, (completed, total) => {
    self.postMessage({ type: "progress", completed, total })
  })
  self.postMessage({ type: "done", findings })
}
