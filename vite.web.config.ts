import path from "path"
import { readFileSync } from "fs"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

// Web (browser client + backend server) build configuration.
//
// This swaps every `@tauri-apps/*` import for a browser shim under src/web
// that talks to the llm-wiki-server backend over HTTP/SSE, and emits a
// static SPA into dist-web/ that the server serves. The desktop Tauri build
// keeps using vite.config.ts unchanged.

const pkgJson = JSON.parse(readFileSync(path.resolve(__dirname, "package.json"), "utf-8"))
const web = (file: string) => path.resolve(__dirname, `src/web/${file}`)

// Backend the dev server proxies API/SSE calls to. In production the built
// SPA is served by the same backend, so these are same-origin and the proxy
// is only used during `npm run dev:web`.
const BACKEND = process.env.LLM_WIKI_BACKEND || "http://127.0.0.1:19828"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: /^@tauri-apps\/api\/core$/, replacement: web("core.ts") },
      { find: /^@tauri-apps\/api\/event$/, replacement: web("event.ts") },
      { find: /^@tauri-apps\/api\/window$/, replacement: web("window.ts") },
      { find: /^@tauri-apps\/plugin-dialog$/, replacement: web("dialog.ts") },
      { find: /^@tauri-apps\/plugin-store$/, replacement: web("store.ts") },
      { find: /^@tauri-apps\/plugin-opener$/, replacement: web("opener.ts") },
      { find: /^@tauri-apps\/plugin-autostart$/, replacement: web("autostart.ts") },
      { find: /^@tauri-apps\/plugin-http$/, replacement: web("http.ts") },
      { find: "@", replacement: path.resolve(__dirname, "./src") },
    ],
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkgJson.version),
  },
  clearScreen: false,
  server: {
    port: 1421,
    strictPort: false,
    proxy: {
      "/api": { target: BACKEND, changeOrigin: true, ws: false },
    },
  },
  build: {
    outDir: "dist-web",
    emptyOutDir: true,
    // The web client never needs the Tauri-only asset protocol etc.
    target: "es2020",
  },
})
