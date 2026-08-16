import {
  computeStructuralLint,
  type StructuralLintConfig,
  type StructuralLintPage,
} from "./lint-structural-core"

interface WorkerRequest {
  pages: StructuralLintPage[]
  config: StructuralLintConfig
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const findings = computeStructuralLint(event.data.pages, (completed, total) => {
    self.postMessage({ type: "progress", completed, total })
  }, event.data.config)
  self.postMessage({ type: "done", findings })
}
