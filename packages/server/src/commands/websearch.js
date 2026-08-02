// Server-side web search providers (Node port of the subset of
// src-tauri/src/agent/tools web search used by Deep Research). Running the
// HTTP calls on the server avoids browser CORS restrictions entirely.
// SearXNG, Tavily and SerpApi are implemented; other providers report a
// clear, actionable error so the UI degrades gracefully.

function hostnameLabel(url) {
  try { return new URL(url).hostname.replace(/^www\./, "") } catch { return "web" }
}

function providerApiKey(config, provider) {
  return config?.providerConfigs?.[provider]?.apiKey ?? config?.apiKey ?? ""
}

async function searxngSearch(query, config, maxResults) {
  const baseUrl = (config?.providerConfigs?.searxng?.searXngUrl ?? config?.searXngUrl ?? "").replace(/\/+$/, "")
  if (!baseUrl) throw new Error("SearXNG instance URL not configured")
  const categories = (config?.providerConfigs?.searxng?.searXngCategories ?? config?.searXngCategories ?? ["general"]).join(",")
  const url = `${baseUrl}/search?q=${encodeURIComponent(query)}&format=json&categories=${encodeURIComponent(categories)}`
  const res = await fetch(url, { headers: { Accept: "application/json" } })
  if (!res.ok) throw new Error(`SearXNG request failed: ${res.status}`)
  const json = await res.json()
  return (json.results || []).slice(0, maxResults).map((r) => ({
    title: r.title || r.url || "",
    url: r.url || "",
    snippet: r.content || "",
    source: hostnameLabel(r.url || ""),
  }))
}

async function tavilySearch(query, config, maxResults) {
  const apiKey = providerApiKey(config, "tavily")
  if (!apiKey) throw new Error("Tavily API key not configured")
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey, query, max_results: maxResults, include_answer: false }),
  })
  if (!res.ok) throw new Error(`Tavily request failed: ${res.status}`)
  const json = await res.json()
  return (json.results || []).slice(0, maxResults).map((r) => ({
    title: r.title || r.url || "",
    url: r.url || "",
    snippet: r.content || "",
    source: hostnameLabel(r.url || ""),
  }))
}

async function serpApiSearch(query, config, maxResults) {
  const apiKey = providerApiKey(config, "serpapi")
  if (!apiKey) throw new Error("SerpApi API key not configured")
  const engine = config?.serpApiEngine ?? config?.providerConfigs?.serpapi?.serpApiEngine ?? "google"
  const url = `https://serpapi.com/search.json?q=${encodeURIComponent(query)}&api_key=${encodeURIComponent(apiKey)}&engine=${encodeURIComponent(engine)}&num=${maxResults}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`SerpApi request failed: ${res.status}`)
  const json = await res.json()
  const organic = json.organic_results || json.results || []
  return organic.slice(0, maxResults).map((r) => ({
    title: r.title || r.link || "",
    url: r.link || "",
    snippet: r.snippet || "",
    source: hostnameLabel(r.link || ""),
  }))
}

async function webSearch({ query, config, maxResults }) {
  const limit = Math.max(1, maxResults ?? 10)
  const provider = config?.provider ?? "none"
  switch (provider) {
    case "searxng": return await searxngSearch(query, config, limit)
    case "tavily": return await tavilySearch(query, config, limit)
    case "serpapi": return await serpApiSearch(query, config, limit)
    case "none":
      throw new Error("Web search not configured. Select a search provider in Settings.")
    default:
      throw new Error(`Web search provider '${provider}' is not yet supported in web-server mode. Use SearXNG, Tavily, or SerpApi.`)
  }
}

// AnyTXT is a local desktop search service; the web server proxies to it
// when reachable and otherwise reports that it is unavailable.
async function anytxtSearch({ query, config, maxResults }) {
  const limit = Math.max(1, maxResults ?? 20)
  const endpoint = (config?.endpoint ?? "http://127.0.0.1:9920").replace(/\/+$/, "")
  let json
  try {
    const res = await fetch(`${endpoint}/api/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keyword: query, limit }),
    })
    if (!res.ok) throw new Error(`AnyTXT request failed: ${res.status}`)
    json = await res.json()
  } catch (e) {
    throw new Error(`AnyTXT local search is unavailable in web-server mode (${e.message}).`)
  }
  const items = json?.data || json?.results || []
  return items.slice(0, limit).map((r) => ({
    title: r.title || r.name || r.path || "",
    url: r.url || (r.path ? `file://${r.path}` : ""),
    snippet: r.snippet || r.content || "",
    source: "AnyTXT",
  }))
}

export const webSearchCommands = {
  web_search: webSearch,
  anytxt_search: anytxtSearch,
}
