#!/usr/bin/env node
// studio.mjs — Clip Factory Studio: a local web UI wrapping both methods (CLIP a real video / GENERATE
// an original short) with controls over content + editing. Zero-dep Node http. (branch: studio)
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discover } from './source.mjs'
import { listLibrary } from './music.mjs'
import { recordFeedback } from './feedback.mjs'
import { loadEnv } from './env.mjs'
import { allowedFile, serveVideo } from './studio-files.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
loadEnv(join(ROOT, '.env'))
const PORT = Number(process.env.PORT || 8013)
const TOKEN = process.env.STUDIO_TOKEN || (existsSync(join(ROOT, '.studio-token')) ? readFileSync(join(ROOT, '.studio-token'), 'utf8').trim() : '') // ?t=TOKEN gate for public tunnels
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

const body = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => b += c); req.on('end', () => { try { r(JSON.parse(b || '{}')) } catch { r({}) } }) })

const server = createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://localhost:${PORT}`)
    const p = u.pathname
    if (TOKEN && u.searchParams.get('t') !== TOKEN) return json(res, 401, { error: 'unauthorized — open the URL with ?t=YOUR_TOKEN' })
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
      const { url, n = 3, frame = 'smart', head = 10, lang = '' } = await body(req)
      if (!url) return json(res, 400, { error: 'url required' })
      return json(res, 200, { id: startJob('clip', ['clipone.mjs', url, String(n)], { CLIP_FRAME: frame, PIPE_HEAD: String(head), WHISPER_LANG: lang }) })
    }
    if (req.method === 'POST' && p === '/api/generate') {
      const { topic = '', voice = 'Charon', lang = 'en', music = '', musvol = '', musprompt = '', mustrack = '' } = await body(req)
      const env = { GEN_TOPIC: topic, GEN_VOICE: voice, GEN_LANG: lang }
      if (music && music !== 'none') env.GEN_MUSIC_MODE = music
      if (musvol) env.GEN_MUSIC_VOL = String(musvol)
      if (musprompt) env.GEN_MUSIC_PROMPT = musprompt
      const track = allowedFile(join(ROOT, 'music'), mustrack, /\.(mp3|m4a|wav|ogg|aac)$/i)
      if (track) env.GEN_MUSIC = track // explicit library track
      return json(res, 200, { id: startJob('generate', ['generate.mjs'], env) })
    }
    if (req.method === 'GET' && p === '/api/music') {
      return json(res, 200, { tracks: listLibrary().map((f) => ({ name: f.split(/[\\/]/).pop(), path: f })), aiReady: !!process.env.REPLICATE_API_TOKEN })
    }
    if (req.method === 'POST' && p === '/api/music-upload') {
      const name = (u.searchParams.get('name') || 'track').replace(/[^A-Za-z0-9._-]/g, '_')
      if (!/\.(mp3|m4a|wav|ogg|aac)$/i.test(name)) return json(res, 400, { error: 'audio files only (mp3/m4a/wav/ogg/aac)' })
      const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => { try { const d = join(ROOT, 'music'); mkdirSync(d, { recursive: true }); writeFileSync(join(d, name), Buffer.concat(chunks)); json(res, 200, { ok: true, name, path: join(d, name) }) } catch (e) { json(res, 500, { error: String(e.message) }) } })
      return
    }
    if (req.method === 'POST' && p === '/api/publish') {
      const { file = '', title = 'Short', privacy = 'unlisted' } = await body(req)
      const video = allowedFile(ROOT, file, /\.mp4$/i)
      if (!video) return json(res, 400, { error: 'bad file' })
      return json(res, 200, { id: startJob('publish', ['publish.mjs', video, title.slice(0, 95) || 'Short', 'Auto-clipped by Clip Factory.', privacy], {}) })
    }
    if (req.method === 'POST' && p === '/api/feedback') {
      // record your taste verdict on a produced clip, for kappa calibration (kappa-feedback.mjs)
      const { run = '', id = '', human = '' } = await body(req)
      if (!run || !id || !['good', 'bad'].includes(human)) return json(res, 400, { error: 'need run, id, human=good|bad' })
      recordFeedback(run, id, human)
      return json(res, 200, { ok: true })
    }
    if (req.method === 'GET' && p === '/api/job') {
      const job = jobs.get(u.searchParams.get('id')); if (!job) return json(res, 404, { error: 'no job' })
      return json(res, 200, { status: job.status, log: job.log.slice(-40), result: job.result })
    }
    if (req.method === 'GET' && p === '/file') {
      const path = allowedFile(ROOT, u.searchParams.get('p'), /\.mp4$/i)
      if (!path) return json(res, 403, { error: 'forbidden' })
      return serveVideo(req, res, path)
    }
    json(res, 404, { error: 'not found' })
  } catch (e) { json(res, 500, { error: String(e.message || e) }) }
})
server.listen(PORT, () => console.log(`Clip Factory Studio → http://localhost:${PORT}`))
