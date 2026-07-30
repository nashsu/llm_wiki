// Search API router (Phase 2.3.5)
// Hybrid search: keyword + vector + graph, bridging to the existing
// search_project command. Embedding config is read from the shared store so
// vector search activates when the user has configured an embedding provider.

import { Router } from "express"
import { validate } from "../middleware/validate.js"
import { SearchRequestSchema } from "../schemas/search.js"
import { resolveProjectRoot } from "../store/project-paths.js"
import { searchCommands } from "../commands/search.js"
import { readStore } from "../store.js"
import { SHARED_STORE_NAME } from "../config.js"

const router = Router({ mergeParams: true })

// POST /api/v2/projects/:id/search
router.post("/", validate({ body: SearchRequestSchema }), async (req, res, next) => {
  try {
    const projectId = parseInt(req.params.id, 10)
    const projectPath = resolveProjectRoot(projectId)
    const { query, topK, includeContent } = req.validated.body
    const store = readStore(SHARED_STORE_NAME)
    const embCfg = store?.embeddingConfig
    const r = await searchCommands.search_project({
      projectPath,
      query,
      topK,
      includeContent,
      queryEmbedding: null,
      embeddingConfig: embCfg && embCfg.enabled ? embCfg : null,
    })
    res.json({
      results: r.results,
      mode: r.mode,
      tokenHits: r.tokenHits,
      vectorHits: r.vectorHits,
      graphHits: r.graphHits,
    })
  } catch (err) {
    next(err)
  }
})

export default router
