import { spawn } from "node:child_process"

// The "no domain" trick: Cloudflare Quick Tunnels need no account, no DNS,
// no config file — `cloudflared tunnel --url <local-url>` prints a random
// https://<words>.trycloudflare.com URL on stderr within a few seconds and
// proxies it to the local port for as long as the process runs. Traded off
// against a named tunnel (what taskio.it uses): the URL changes every
// restart, so this is for personal/demo use, not a link you'd paste into a
// permanent integration.
const URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/

export interface QuickTunnel {
  url: string
  stop(): void
}

export async function startQuickTunnel(localPort: number, timeoutMs = 20_000): Promise<QuickTunnel> {
  const bin = process.env.CLOUDFLARED_PATH ?? "cloudflared"
  const child = spawn(bin, ["tunnel", "--url", `http://127.0.0.1:${localPort}`], { stdio: ["ignore", "pipe", "pipe"] })

  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`cloudflared did not print a trycloudflare.com URL within ${timeoutMs}ms`))
    }, timeoutMs)

    const onData = (chunk: Buffer) => {
      const match = URL_PATTERN.exec(chunk.toString("utf8"))
      if (match) {
        clearTimeout(timer)
        resolve(match[0])
      }
    }
    child.stdout.on("data", onData)
    child.stderr.on("data", onData) // cloudflared logs the URL to stderr, not stdout
    child.once("error", (err) => {
      clearTimeout(timer)
      reject(new Error(`Failed to start cloudflared (is it installed and on PATH? set CLOUDFLARED_PATH otherwise): ${err.message}`))
    })
    child.once("exit", (code) => {
      clearTimeout(timer)
      reject(new Error(`cloudflared exited early (code ${code}) before printing a tunnel URL`))
    })
  })

  return {
    url,
    stop: () => child.kill(),
  }
}
