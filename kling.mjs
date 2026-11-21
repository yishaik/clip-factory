// Minimal Streamable-HTTP MCP client for Kling scene-video generation.
// Set KLING_MCP_ACCESS_TOKEN for headless pipeline runs; do not read Codex credentials.
import { writeFile } from 'node:fs/promises'

const endpoint = () => process.env.KLING_MCP_URL || 'https://kling.ai/mcp'
const token = () => process.env.KLING_MCP_ACCESS_TOKEN || ''
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function parseBody(text) {
  if (!text) return null
  if (text.trimStart().startsWith('{')) return JSON.parse(text)
  for (const line of text.split(/\r?\n/)) if (line.startsWith('data:')) try { return JSON.parse(line.slice(5).trim()) } catch {}
  throw new Error('Kling MCP returned an unreadable response')
}
function toolData(result) {
  const text = (result?.content || []).map((item) => item.text || '').join('\n')
  try { return JSON.parse(text) } catch {}
  const match = text.match(/\{[\s\S]*\}/)
  if (match) try { return JSON.parse(match[0]) } catch {}
  return result?.structuredContent || result || {}
}
function find(value, key) {
  if (!value || typeof value !== 'object') return null
  if (Array.isArray(value)) { for (const item of value) { const got = find(item, key); if (got) return got }; return null }
  for (const [name, item] of Object.entries(value)) {
    if (key.test(name) && typeof item === 'string') return item
    const got = find(item, key); if (got) return got
  }
  return null
}
function videoArgs(schema, prompt, duration) {
  const props = schema?.properties || {}, args = {}
  if ('prompt' in props) args.prompt = prompt
  else if ('text' in props) args.text = prompt
  else throw new Error('Kling text_to_video has no prompt parameter')
  const model = process.env.KLING_VIDEO_MODEL || props.model_name?.default || props.model?.default || props.model_name?.enum?.[0] || props.model?.enum?.[0]
  if (model) { if ('model_name' in props) args.model_name = model; else if ('model' in props) args.model = model }
  if ('aspect_ratio' in props) args.aspect_ratio = process.env.KLING_ASPECT_RATIO || '9:16'
  if ('duration' in props) args.duration = duration
  if ('duration_seconds' in props) args.duration_seconds = duration
  const missing = (schema?.required || []).filter((name) => args[name] == null)
  if (missing.length) throw new Error(`Kling requires ${missing.join(', ')}; configure the matching KLING_* variable`)
  return args
}

class Client {
  constructor() { this.sessionId = ''; this.id = 0 }
  async request(method, params, notification = false) {
    const headers = { accept: 'application/json, text/event-stream', 'content-type': 'application/json', authorization: `Bearer ${token()}`, 'mcp-protocol-version': '2025-03-26' }
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId
    const body = { jsonrpc: '2.0', method, params }; if (!notification) body.id = ++this.id
    const response = await fetch(endpoint(), { method: 'POST', headers, body: JSON.stringify(body) })
    if (!response.ok) throw new Error(`Kling MCP ${method}: HTTP ${response.status} ${String(await response.text()).slice(0, 240)}`)
    this.sessionId = response.headers.get('mcp-session-id') || this.sessionId
    if (notification) return null
    const message = parseBody(await response.text())
    if (message?.error) throw new Error(`Kling MCP ${method}: ${message.error.message || JSON.stringify(message.error)}`)
    return message?.result
  }
  async connect() {
    await this.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'clip-factory', version: '1.0.0' } })
    await this.request('notifications/initialized', {}, true)
  }
}

export async function generateKlingScene({ prompt, outPath, duration = Number(process.env.GEN_KLING_DURATION || 5) }) {
  if (!token()) throw new Error('KLING_MCP_ACCESS_TOKEN is missing')
  const client = new Client(); await client.connect()
  const tools = await client.request('tools/list', {})
  const video = (tools?.tools || []).find((tool) => tool.name === 'text_to_video')
  const query = (tools?.tools || []).find((tool) => tool.name === 'query_tasks')
  if (!video || !query) throw new Error('Kling MCP does not expose text_to_video and query_tasks')
  const created = toolData(await client.request('tools/call', { name: video.name, arguments: videoArgs(video.inputSchema, prompt, duration) }))
  const generationId = find(created, /generation_?id|task_?id/i)
  if (!generationId) throw new Error('Kling did not return a generation ID')
  const pollMs = Math.max(1000, Number(process.env.KLING_POLL_MS || 5000)), deadline = Date.now() + Math.max(pollMs, Number(process.env.KLING_TIMEOUT_MS || 360000))
  while (Date.now() < deadline) {
    await pause(pollMs)
    const task = toolData(await client.request('tools/call', { name: query.name, arguments: { generation_id: generationId } }))
    const url = find(task, /url/i)
    if (url && /^https:\/\//i.test(url)) {
      const asset = await fetch(url); if (!asset.ok) throw new Error(`Kling asset download: HTTP ${asset.status}`)
      await writeFile(outPath, Buffer.from(await asset.arrayBuffer()))
      return { generationId, path: outPath, url }
    }
    const status = String(task?.status || task?.task_status || '').toLowerCase()
    if (/fail|error|cancel/.test(status)) throw new Error(`Kling generation ${generationId}: ${status}`)
  }
  throw new Error(`Kling generation ${generationId} timed out`)
}
