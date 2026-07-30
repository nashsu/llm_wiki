#!/usr/bin/env node
// v2 Express + Zod server entry point (Phase 2.1 foundation).
//
// This is a parallel implementation alongside the existing index.js. It mounts:
//   - cors, helmet, JSON parser
//   - auth middleware (token-based, decision #14)
//   - /api/v2/health + /api/v2/version (public)
//   - /api/invoke/:command (legacy bridge → dispatch from invoke.js)
//   - global error handler (normalizes to { error: { code, message, details } })
//
// The SQLite store, worker pool, and route groups are added in Phase 2.2+.

import "./zod-setup.js" // MUST be first: extends Zod with .openapi() before any schemas are created
import fs from "node:fs"
import path from "node:path"
import express from "express"
import cors from "cors"
import helmet from "helmet"
import { PORT, HOST, WEB_DIST, ensureDataDirs } from "./config.js"
import { authMiddleware } from "./middleware/auth.js"
import { errorHandler } from "./middleware/error.js"
import { projectLookup } from "./middleware/project-lookup.js"
import { dispatch, hasCommand, commandNames } from "./invoke.js"
import { ApiError, ErrorCode } from "./errors.js"
import { getDb } from "./store/db.js"
import { projectsRouter } from "./api/projects.js"
import filesRouter from "./api/files.js"
import searchRouter from "./api/search.js"
import graphRouter from "./api/graph.js"
import settingsRouter from "./api/settings.js"
import authRouter from "./api/auth.js"
import reviewsRouter from "./api/reviews.js"
import eventsRouter from "./api/events.js"
import maintenanceRouter from "./api/maintenance.js"
import chatRouter from "./api/chat.js"
import ingestRouter from "./api/ingest.js"
import { generateOpenApiDocument } from "./openapi.js"

// Initialize data directories and database (runs migrations on first boot)
ensureDataDirs()
getDb()

const app = express()

// ── middleware chain ──────────────────────────────────────────────────────
app.use(cors())
app.use(helmet({ contentSecurityPolicy: false })) // CSP disabled for dev; enable in prod
app.use(express.json({ limit: "64mb" }))
app.use(authMiddleware)

// ── public routes ─────────────────────────────────────────────────────────
app.get("/api/v2/health", (req, res) => {
  res.json({ ok: true, version: "0.6.6", commands: commandNames().length })
})

app.get("/api/v2/version", (req, res) => {
  res.json({ version: "0.6.6", node: process.version, platform: process.platform })
})

app.get("/api/v2/openapi.json", (req, res) => {
  res.json(generateOpenApiDocument())
})

// ── legacy bridge: /api/invoke/:command (deprecated) ──────────────────────
// Reuses the existing command registry so the unmodified frontend works during
// migration. Flagged deprecated (RFC 8594) with a Link to the v2 API docs; the
// web client migrates to /api/v2/* in Phase 3, after which this bridge can be
// removed.
app.post("/api/invoke/:command", async (req, res, next) => {
  res.setHeader("Deprecation", "true")
  res.setHeader("Warning", '299 - "This endpoint is deprecated; use /api/v2/*"')
  res.setHeader("Link", '</api/v2/openapi.json>; rel="successor-version"')
  try {
    const { command } = req.params
    if (!hasCommand(command)) {
      throw new ApiError(ErrorCode.NOT_FOUND, `Unknown command: ${command}`)
    }
    const result = await dispatch(command, req.body)
    res.json({ ok: true, result })
  } catch (err) {
    next(err)
  }
})

// ── v2 route groups ───────────────────────────────────────────────────────
// All /api/v2/projects/:id/* routes share a project lookup middleware that
// resolves req.params.id → req.projectId / req.projectRoot / req.project,
// eliminating the duplicated parseInt+resolveProjectRoot in every handler.
app.use("/api/v2/projects", projectsRouter)
app.use("/api/v2/projects", chatRouter)
app.use("/api/v2/projects/:id/files", projectLookup(), filesRouter)
app.use("/api/v2/projects/:id/search", projectLookup(), searchRouter)
app.use("/api/v2/projects/:id/graph", projectLookup(), graphRouter)
app.use("/api/v2/projects/:id/reviews", projectLookup(), reviewsRouter)
app.use("/api/v2/projects/:id/maintenance", projectLookup(), maintenanceRouter)
app.use("/api/v2/projects/:id/ingest", projectLookup(), ingestRouter)
app.use("/api/v2/events", eventsRouter)
app.use("/api/v2/settings", settingsRouter)
app.use("/api/v2/auth", authRouter)

// ── static web client (SPA) ───────────────────────────────────────────────
// Serves the built web client from WEB_DIST (dist-web/), mirroring the
// original index.js: static assets are served directly and any non-/api GET
// that doesn't match a file falls back to index.html for client-side routing.
// Mounted AFTER the API routes and BEFORE the error handler so /api/* 404s
// still return JSON envelopes.
const WEB_INDEX = path.join(WEB_DIST, "index.html")
app.use(
  express.static(WEB_DIST, {
    index: "index.html",
    extensions: ["html"],
    setHeaders(res, filePath) {
      if (filePath === WEB_INDEX) {
        // The SPA entry point must not be cached so new deploys take effect.
        res.setHeader("Cache-Control", "no-cache")
      }
    },
  }),
)

// SPA fallback: any GET that isn't an API route renders the client app.
app.get("*splat", (req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({
      error: { code: "NOT_FOUND", message: "Not found", details: null },
    })
  }
  if (!fs.existsSync(WEB_INDEX)) {
    return res.status(503).type("txt").send(
      `Web client build not found.\nRun: npm run build:web   (then restart the server)\nExpected at: ${WEB_DIST}`,
    )
  }
  res.setHeader("Cache-Control", "no-cache")
  res.sendFile(WEB_INDEX)
})

// ── error handler (must be last) ──────────────────────────────────────────
app.use(errorHandler)

// ── boot ──────────────────────────────────────────────────────────────────
// Only start the server when this module is run directly (not when imported by tests)
let server = null
if (import.meta.url === `file://${process.argv[1]}`) {
  server = app.listen(PORT, HOST, () => {
    console.log(`\n  LLM Wiki server v2 (Express + Zod)`)
    console.log(`  ▸ Local:    http://${HOST}:${PORT}`)
    console.log(`  ▸ Commands: ${commandNames().length} registered`)
    console.log(`  ▸ API:      /api/v2/* (new) + /api/invoke/* (legacy)`)
    console.log(`  ▸ Web build: ${fs.existsSync(WEB_INDEX) ? WEB_DIST : "MISSING — run: npm run build:web"}\n`)
  })
}

export { app, server }
