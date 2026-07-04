#!/usr/bin/env node
// news.mjs — X-timeline → original AI-news short, published public.
// Sources the freshest high-velocity AI tweets from x-reader's history.json, composes a
// quick-bits news brief, renders it with generate.mjs (GEN_TOPIC), uploads public, and
// records kind:'news' in .published.json. Items are marked used so briefs never repeat.
//
//   node news.mjs [--dry]        (--dry = pick items + print topic, no render/upload)
// Env: NEWS_HOURS (default 12 — The AI Pulse covers the LAST 12 HOURS only) · NEWS_ITEMS (default 3) · NEWS_SECONDS (default 42)
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NICHE_RE } from './source.mjs'
import { uploadShort, recordPublished } from './publish.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
const HISTORY = 'D:/projects/x-reader/history.json'
const USEDF = join(ROOT, '.news-used.json')
const HOURS = Number(process.env.NEWS_HOURS || 12)
const N = Number(process.env.NEWS_ITEMS || 3)
const SECONDS = Number(process.env.NEWS_SECONDS || 42)
const DRY = process.argv.includes('--dry')

const used = new Set(existsSync(USEDF) ? JSON.parse(readFileSync(USEDF, 'utf8')) : [])
const hist = JSON.parse(readFileSync(HISTORY, 'utf8'))

const now = Date.now()
const items = []
for (const [id, t] of Object.entries(hist)) {
  if (used.has(id) || !t.text || t.text.length < 40) continue
  const ts = new Date(t.time || t.firstSeen).getTime()
  const ageH = (now - ts) / 36e5
  if (!(ageH >= 0) || ageH > HOURS) continue
  if (!NICHE_RE.test(t.text)) continue
  const s = (t.samples || [])[t.samples?.length - 1] || {}
  const engagement = (s.likes || 0) + 2 * (s.reposts || 0) + (s.replies || 0) + (s.views || 0) / 100
  items.push({ id, text: t.text.replace(/\s+/g, ' ').trim(), link: t.link, handle: t.handle, ageH: +ageH.toFixed(1), velocity: +(engagement / Math.max(0.5, ageH)).toFixed(2) })
}
items.sort((a, b) => b.velocity - a.velocity)
const picks = items.slice(0, N)

if (!picks.length) { console.log('no fresh AI news items in the last ' + HOURS + 'h — nothing to publish'); process.exit(0) }
console.error(`${items.length} fresh AI items, using top ${picks.length}:`)
for (const p of picks) console.error(`  [v${p.velocity} · ${p.ageH}h] ${p.handle}: ${p.text.slice(0, 90)}`)

const clean = (s) => s.replace(/"/g, "'").replace(/https?:\/\/\S+/g, '').trim()
const topic = `AI NEWS FLASH — a rapid roundup of ${picks.length} real AI stories breaking right now. Cover each in 1-2 punchy sentences, in this order: ${picks.map((p, i) => `${i + 1}) ${clean(p.text).slice(0, 220)}`).join(' ')}  Neutral, energetic news-anchor tone; stick strictly to these items, no invented details; open with the single most striking fact, end by teasing that more is coming tomorrow.`

if (DRY) { console.log('[dry] topic:\n' + topic); process.exit(0) }

// render via generate.mjs (its stdout's last line is the result JSON)
const gen = await new Promise((res, rej) => execFile('node', [join(ROOT, 'generate.mjs')], {
  maxBuffer: 1 << 26, env: { ...process.env, GEN_TOPIC: topic, GEN_SECONDS: String(SECONDS), GEN_NICHE: 'ai' },
}, (e, so, se) => e ? rej(new Error((se || e.message).slice(-400))) : res(so)))
const out = JSON.parse(gen.trim().split('\n').pop())
const clip = out.clips[0]
console.error(`rendered: ${clip.file} (${clip.dur}s) "${clip.hook}"`)

const title = (clip.hook || 'AI News Flash').slice(0, 95)
const desc = ['Today in AI — quick bits.', '', 'Sources:', ...picks.map((p) => `• ${clean(p.text).slice(0, 100)} ${p.link}`), '', 'New AI updates every day on The AI Pulse.'].join('\n')
const r = await uploadShort(clip.file, title, desc, 'public', ['AI', 'ainews', 'artificialintelligence', 'tech'])
recordPublished({ file: clip.file, id: r.id, url: r.url, title, score: null, privacy: 'public', kind: 'news' })

picks.forEach((p) => used.add(p.id))
writeFileSync(USEDF, JSON.stringify([...used].slice(-400)))
console.log(JSON.stringify({ url: r.url, title, items: picks.map((p) => p.link) }))
console.error(`\n✅ news short live: ${r.url}`)
