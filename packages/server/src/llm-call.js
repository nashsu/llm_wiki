// Provider wire adapters for the agent runtime. Supports the OpenAI
// chat-completions wire (openai/google/azure/ollama/custom+chat_completions)
// and the Anthropic messages wire (anthropic/custom+anthropic_messages), each
// in streaming and non-streaming form, including function/tool calling.
// Streaming returns an async iterator of internal events:
//   { type: "delta", text }
//   { type: "tool_call", id, name, args }   // emitted once per complete tool call
//   { type: "finish" }

function toOpenAIMessages(messages) {
  const out = []
  for (const m of messages) {
    if (m.role === "tool") {
      out.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content })
    } else if (m.role === "assistant" && m.toolCalls?.length) {
      out.push({
        role: "assistant",
        content: m.content ?? null,
        tool_calls: m.toolCalls.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: typeof t.args === "string" ? t.args : JSON.stringify(t.args ?? {}) } })),
      })
    } else {
      out.push({ role: m.role, content: m.content })
    }
  }
  return out
}
function toOpenAITools(tools) {
  return tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }))
}
function toAnthropicMessages(messages) {
  const out = []
  for (const m of messages) {
    if (m.role === "system") continue
    if (m.role === "tool") {
      out.push({ role: "user", content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }] })
    } else if (m.role === "assistant" && m.toolCalls?.length) {
      const blocks = []
      if (m.content) blocks.push({ type: "text", text: m.content })
      for (const t of m.toolCalls) blocks.push({ type: "tool_use", id: t.id, name: t.name, input: typeof t.args === "string" ? safeParse(t.args) : (t.args ?? {}) })
      out.push({ role: "assistant", content: blocks })
    } else {
      out.push({ role: m.role === "assistant" ? "assistant" : "user", content: m.content })
    }
  }
  return out
}
function toAnthropicTools(tools) {
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
}
function safeParse(s) { try { return JSON.parse(s) } catch { return {} } }
function systemText(messages) {
  return messages.filter((m) => m.role === "system").map((m) => typeof m.content === "string" ? m.content : "").join("\n\n")
}

async function* readSSE(response) {
  const reader = response.body.getReader()
  const dec = new TextDecoder()
  let buf = ""
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "")
      buf = buf.slice(idx + 1)
      yield line
    }
  }
  if (buf.trim()) yield buf.replace(/\r$/, "")
}

async function* streamOpenAI({ url, headers, model, messages, tools, signal }) {
  const body = { model, messages: toOpenAIMessages(messages), stream: true, stream_options: { include_usage: false } }
  if (tools?.length) { body.tools = toOpenAITools(tools); body.tool_choice = "auto" }
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal })
  if (!res.ok) throw new Error(`LLM request failed: ${res.status} ${await res.text().catch(() => "")}`)
  const pending = new Map() // index -> {id,name,args}
  for await (const line of readSSE(res)) {
    if (!line.startsWith("data:")) continue
    const data = line.slice(5).trim()
    if (data === "[DONE]") break
    let chunk
    try { chunk = JSON.parse(data) } catch { continue }
    const delta = chunk?.choices?.[0]?.delta
    if (!delta) continue
    if (delta.content) yield { type: "delta", text: delta.content }
    for (const tc of delta.tool_calls ?? []) {
      const i = tc.index ?? 0
      let acc = pending.get(i)
      if (!acc) { acc = { id: "", name: "", args: "" }; pending.set(i, acc) }
      if (tc.id) acc.id = tc.id
      if (tc.function?.name) acc.name += tc.function.name
      if (tc.function?.arguments) acc.args += tc.function.arguments
    }
    if (chunk?.choices?.[0]?.finish_reason) {
      for (const [, acc] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
        yield { type: "tool_call", id: acc.id || `call_${Math.random().toString(36).slice(2)}`, name: acc.name, args: safeParse(acc.args) }
      }
      pending.clear()
      yield { type: "finish" }
    }
  }
  // flush any tool calls if stream ended without finish_reason
  for (const [, acc] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
    yield { type: "tool_call", id: acc.id || `call_${Math.random().toString(36).slice(2)}`, name: acc.name, args: safeParse(acc.args) }
  }
}

async function* streamAnthropic({ url, headers, model, messages, tools, signal }) {
  const body = { model, max_tokens: 8192, messages: toAnthropicMessages(messages), stream: true }
  const sys = systemText(messages)
  if (sys) body.system = sys
  if (tools?.length) { body.tools = toAnthropicTools(tools); body.tool_choice = { type: "auto" } }
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal })
  if (!res.ok) throw new Error(`LLM request failed: ${res.status} ${await res.text().catch(() => "")}`)
  const blocks = new Map() // index -> {id,name,args}
  for await (const line of readSSE(res)) {
    if (!line.startsWith("data:")) continue
    const data = line.slice(5).trim()
    if (!data) continue
    let ev
    try { ev = JSON.parse(data) } catch { continue }
    if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") {
      blocks.set(ev.index, { id: ev.content_block.id, name: ev.content_block.name, args: "" })
    } else if (ev.type === "content_block_delta") {
      if (ev.delta?.type === "text_delta" && ev.delta.text) yield { type: "delta", text: ev.delta.text }
      else if (ev.delta?.type === "input_json_delta" && blocks.has(ev.index)) blocks.get(ev.index).args += ev.delta.partial_json ?? ""
    } else if (ev.type === "content_block_stop" && blocks.has(ev.index)) {
      const b = blocks.get(ev.index)
      yield { type: "tool_call", id: b.id, name: b.name, args: safeParse(b.args) }
      blocks.delete(ev.index)
    } else if (ev.type === "message_stop") {
      yield { type: "finish" }
    }
  }
}

async function nonStreamOpenAI({ url, headers, model, messages, tools, signal }) {
  const body = { model, messages: toOpenAIMessages(messages) }
  if (tools?.length) { body.tools = toOpenAITools(tools); body.tool_choice = "auto" }
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal })
  if (!res.ok) throw new Error(`LLM request failed: ${res.status} ${await res.text().catch(() => "")}`)
  const json = await res.json()
  const msg = json?.choices?.[0]?.message
  const toolCalls = (msg?.tool_calls ?? []).map((t) => ({ id: t.id, name: t.function.name, args: safeParse(t.function.arguments) }))
  return { content: msg?.content ?? "", toolCalls }
}

async function nonStreamAnthropic({ url, headers, model, messages, tools, signal }) {
  const body = { model, max_tokens: 8192, messages: toAnthropicMessages(messages) }
  const sys = systemText(messages)
  if (sys) body.system = sys
  if (tools?.length) { body.tools = toAnthropicTools(tools); body.tool_choice = { type: "auto" } }
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal })
  if (!res.ok) throw new Error(`LLM request failed: ${res.status} ${await res.text().catch(() => "")}`)
  const json = await res.json()
  let content = ""
  const toolCalls = []
  for (const b of json?.content ?? []) {
    if (b.type === "text") content += b.text
    else if (b.type === "tool_use") toolCalls.push({ id: b.id, name: b.name, args: b.input ?? {} })
  }
  return { content, toolCalls }
}

export function streamCall(opts) {
  return opts.wire === "anthropic" ? streamAnthropic(opts) : streamOpenAI(opts)
}
export async function blockingCall(opts) {
  return opts.wire === "anthropic" ? nonStreamAnthropic(opts) : nonStreamOpenAI(opts)
}
