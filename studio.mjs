#!/usr/bin/env node
// studio.mjs — Clip Factory Studio: a local web UI wrapping both methods (CLIP a real video / GENERATE
// an original short) with controls over content + editing. Zero-dep Node http. (branch: studio)
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createReadStream, statSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discover } from './source.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
try { // .env loader (GEMINI_API_KEY etc.)
  const e = join(ROOT, '.env'); if (existsSync(e)) for (const l of readFileSync(e, 'utf8').split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '') }
} catch {}
const PORT = Number(process.env.PORT || 8013)
const jobs = new Map()
let seq = 0
const json = (res, code, o) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(o))

function startJob(type, args, env) {
  const id = `${type}-${++seq}-${(seq * 2654435761 % 1e6) | 0}`
  const job = { id, type, status: 'running', log: [], result: null }
  jobs.set(id, job)
  const child = spawn('node', args, { cwd: ROOT, env: { ...process.env, ...env } })
  let out = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => d.toString().split('\n').forEach((l) => l.trim() && job.log.push(l.trim())))
  child.on('error', (e) => { job.status = 'error'; job.log.push('spawn error: ' + e.message) })
  child.on('close', (code) => {
    if (code === 0) { try { job.result = JSON.parse((out.trim().split('\n').pop() || '{}')) } catch { job.result = { raw: out.slice(-400) } } job.status = 'done' }
    else { job.status = 'error'; job.log.push('exited ' + code) }
  })
  return id
}

function serveVideo(req, res, path) {
  if (!existsSync(path)) return json(res, 404, { error: 'not found' })
  const size = statSync(path).size, range = req.headers.range
  if (range) {
    const m = range.replace(/bytes=/, '').split('-'); const start = parseInt(m[0]) || 0; const end = m[1] ? parseInt(m[1]) : size - 1
    res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes', 'content-length': end - start + 1, 'content-type': 'video/mp4' })
    createReadStream(path, { start, end }).pipe(res)
  } else {
    res.writeHead(200, { 'content-length': size, 'content-type': 'video/mp4', 'accept-ranges': 'bytes' })
    createReadStream(path).pipe(res)
  }
}

const body = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => b += c); req.on('end', () => { try { r(JSON.parse(b || '{}')) } catch { r({}) } }) })

const server = createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://localhost:${PORT}`)
    const p = u.pathname
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(await readFile(join(ROOT, 'studio', 'index.html')))

    if (req.method === 'GET' && p === '/api/discover') {
      const f = join(ROOT, 'sources.json'); const src = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : []
      const vids = (await discover(src, { days: 14, skipSeen: true })).slice(0, 25)
      return json(res, 200, { vids })
    }
    if (req.method === 'GET' && p === '/api/trends') {
      try { const xml = await (await fetch('https://trends.google.com/trending/rss?geo=US')).text(); return json(res, 200, { topics: [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1].match(/<title>([^<]+)/)?.[1]).filter(Boolean).slice(0, 18) }) }
      catch { return json(res, 200, { topics: [] }) }
    }
    if (req.method === 'POST' && p === '/api/clip') {
      const { url, n = 3, frame = 'smart', head = 10 } = await body(req)
      if (!url) return json(res, 400, { error: 'url required' })
      return json(res, 200, { id: startJob('clip', ['clipone.mjs', url, String(n)], { CLIP_FRAME: frame, PIPE_HEAD: String(head) }) })
    }
    if (req.method === 'POST' && p === '/api/generate') {
      const { topic = '', voice = 'Charon' } = await body(req)
      return json(res, 200, { id: startJob('generate', ['generate.mjs'], { GEN_TOPIC: topic, GEN_VOICE: voice }) })
    }
    if (req.method === 'GET' && p === '/api/job') {
      const job = jobs.get(u.searchParams.get('id')); if (!job) return json(res, 404, { error: 'no job' })
      return json(res, 200, { status: job.status, log: job.log.slice(-40), result: job.result })
    }
    if (req.method === 'GET' && p === '/file') {
      const path = u.searchParams.get('p') || ''
      if (!path.startsWith(ROOT) || !path.endsWith('.mp4')) return json(res, 403, { error: 'forbidden' })
      return serveVideo(req, res, path)
    }
    json(res, 404, { error: 'not found' })
  } catch (e) { json(res, 500, { error: String(e.message || e) }) }
})
server.listen(PORT, () => console.log(`Clip Factory Studio → http://localhost:${PORT}`))
