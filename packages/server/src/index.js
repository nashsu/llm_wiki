#!/usr/bin/env node
import http from "node:http"
import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { PORT, HOST, WEB_DIST, SHARED_STORE_NAME, ensureDataDirs } from "./config.js"
import { dispatch, hasCommand, commandNames } from "./invoke.js"
import { readStore, writeStore, readStoreKey, writeStoreKey, deleteStoreKey, getStoreDiagnostics } from "./store.js"
import { addSseClient, clientCount, emit } from "./events.js"
import { EventTypes } from "./events/bus.js"
import { handleProxy } from "./proxy.js"
import { handleApiV1 } from "./api-v1.js"

ensureDataDirs()

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
  ".map": "application/json", ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8", ".pdf": "application/pdf",
  ".wasm": "application/wasm",
}

const MAX_BODY_BYTES = 64 * 1024 * 1024 // 64 MB (base64 file writes, archives)

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  })
  res.end(body)
}

// Writes to the shared settings store (app-state.json) are settings changes:
// emit settings:changed so sse-sync refetches settings in every connected
// tab. Other store names are not settings and emit nothing
// (plans/sse-taxonomy.md). Same gate as the v2 shim (api/store.js).
function emitSettingsChanged(name, keys) {
  if (name !== SHARED_STORE_NAME) return
  emit(EventTypes.SETTINGS_CHANGED, { keys })
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on("data", (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) { reject(new Error("Request body too large")); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")))
    req.on("error", reject)
  })
}

async function serveStatic(req, res, pathname) {
  // Map URL path to a file under WEB_DIST, falling back to index.html for
  // client-side routes (SPA). Reject path traversal.
  const safeRel = decodeURIComponent(pathname).replace(/\?.*$/, "")
  let filePath = path.normalize(path.join(WEB_DIST, safeRel))
  if (!filePath.startsWith(path.normalize(WEB_DIST))) {
    res.writeHead(403); res.end("Forbidden"); return
  }
  let stat = null
  try { stat = await fsp.stat(filePath) } catch { /* fall through to SPA */ }
  if (!stat || stat.isDirectory()) {
    if (stat?.isDirectory()) {
      const indexPath = path.join(filePath, "index.html")
      if (fs.existsSync(indexPath)) filePath = indexPath
      else filePath = path.join(WEB_DIST, "index.html")
    } else {
      filePath = path.join(WEB_DIST, "index.html")
    }
    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { "Content-Type": "text/plain" })
      res.end(`Web client build not found.\nRun: npm run build:web   (then restart the server)\nExpected at: ${WEB_DIST}`)
      return
    }
  }
  const ext = path.extname(filePath).toLowerCase()
  const type = MIME[ext] || "application/octet-stream"
  res.writeHead(200, { "Content-Type": type, "Access-Control-Allow-Origin": "*" })
  fs.createReadStream(filePath).pipe(res)
}

async function streamRawFile(res, rawPath) {
  if (!rawPath || rawPath.includes("\0")) { res.writeHead(400); res.end("Bad path"); return }
  let stat
  try { stat = await fsp.stat(rawPath) } catch { res.writeHead(404); res.end("Not found"); return }
  if (stat.isDirectory()) { res.writeHead(400); res.end("Is a directory"); return }
  const ext = path.extname(rawPath).toLowerCase()
  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Content-Length": stat.size,
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "private, max-age=3600",
  })
  fs.createReadStream(rawPath).pipe(res)
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`)
  const pathname = url.pathname

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization,x-llm-wiki-token",
    })
    res.end()
    return
  }

  try {
    if (pathname === "/api/health") {
      sendJson(res, 200, { ok: true, name: "llm-wiki-server", commands: commandNames().length, sseClients: clientCount(), webDist: WEB_DIST, webBuilt: fs.existsSync(path.join(WEB_DIST, "index.html")), store: getStoreDiagnostics() })
      return
    }
    if (pathname === "/api/commands") { sendJson(res, 200, commandNames()); return }
    if (pathname === "/api/home") {
      sendJson(res, 200, { home: os.homedir(), cwd: process.cwd(), separator: path.sep, platform: process.platform })
      return
    }
    if (pathname === "/api/events") { addSseClient(res); return }
    if (pathname === "/api/raw") { await streamRawFile(res, url.searchParams.get("path") || ""); return }

    if (pathname.startsWith("/api/invoke/")) {
      const command = decodeURIComponent(pathname.slice("/api/invoke/".length))
      if (!hasCommand(command)) { sendJson(res, 404, { error: `Unknown command: ${command}` }); return }
      let args = {}
      if (req.method === "POST") {
        const raw = await readBody(req)
        if (raw.trim()) { try { args = JSON.parse(raw) } catch { sendJson(res, 400, { error: "Invalid JSON body" }); return } }
      }
      try {
        const result = await dispatch(command, args)
        sendJson(res, 200, result ?? null)
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
      }
      return
    }

    if (pathname.startsWith("/api/store/")) {
      const rest = pathname.slice("/api/store/".length)
      const slash = rest.indexOf("/")
      const name = decodeURIComponent(slash < 0 ? rest : rest.slice(0, slash))
      const hasKey = slash >= 0
      const key = hasKey ? decodeURIComponent(rest.slice(slash + 1)) : null
      try {
        if (!hasKey) {
          if (req.method === "GET") { sendJson(res, 200, readStore(name)); return }
          if (req.method === "PUT" || req.method === "POST") {
            const raw = await readBody(req)
            let value = {}
            try { value = raw.trim() ? JSON.parse(raw) : {} } catch { sendJson(res, 400, { error: "Invalid JSON body" }); return }
            const merged = writeStore(name, value)
            emitSettingsChanged(name, value && typeof value === "object" ? Object.keys(value) : [])
            sendJson(res, 200, merged); return
          }
        } else {
          if (req.method === "GET") {
            const v = readStoreKey(name, key)
            sendJson(res, 200, v === undefined ? null : v); return
          }
          if (req.method === "PUT" || req.method === "POST") {
            const raw = await readBody(req)
            let value = null
            if (raw.trim()) { try { value = JSON.parse(raw) } catch { sendJson(res, 400, { error: "Invalid JSON body" }); return } }
            const result = writeStoreKey(name, key, value)
            emitSettingsChanged(name, [key])
            sendJson(res, 200, result); return
          }
          if (req.method === "DELETE") {
            const existed = deleteStoreKey(name, key)
            emitSettingsChanged(name, [key])
            sendJson(res, 200, existed); return
          }
        }
      } catch (err) { sendJson(res, 400, { error: err.message }); return }
    }

    if (pathname === "/api/proxy" && req.method === "POST") { await handleProxy(req, res); return }

    // Static web client (SPA)
    if (pathname.startsWith("/api/v1/")) {
      const needsBody = req.method === "POST" || req.method === "PUT" || req.method === "PATCH"
      const body = needsBody ? await readBody(req) : null
      await handleApiV1({ method: req.method, pathname, searchParams: url.searchParams, headers: req.headers, body, sendJson: (st, val) => sendJson(res, st, val) })
      return
    }
    if (req.method === "GET") { await serveStatic(req, res, pathname); return }

    sendJson(res, 404, { error: "Not found" })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
})

server.listen(PORT, HOST, () => {
  const shown = HOST === "0.0.0.0" ? "localhost" : HOST
  console.log(`\n  LLM Wiki server (web client + backend)`)
  console.log(`  ▸ Local:    http://${shown}:${PORT}`)
  if (HOST === "0.0.0.0") console.log(`  ▸ Network:  http://<your-ip>:${PORT}`)
  console.log(`  ▸ Commands: ${commandNames().length} registered`)
  console.log(`  ▸ Web build: ${fs.existsSync(path.join(WEB_DIST, "index.html")) ? WEB_DIST : "MISSING — run: npm run build:web"}`)
  console.log(`  ▸ Data dir:  ${process.env.LLM_WIKI_DATA_DIR || path.join(os.homedir(), ".llm-wiki-server")}\n`)
})
