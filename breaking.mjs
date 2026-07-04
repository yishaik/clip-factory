#!/usr/bin/env node
// breaking.mjs — LLM breaking-news editor for The AI Pulse.
// Runs every 3h (Task Scheduler, right after each x-reader scrape): looks at BRAND-NEW
// AI items, asks a judge LLM whether any story justifies interrupting the schedule
// (score >= BREAK_MIN), and if so renders + publishes a BREAKING short immediately and
// pings Yishai on Telegram. Quiet exit otherwise. Max BREAK_MAX breaking shorts per day.
//
//   node breaking.mjs [--dry]     (--dry = judge only, no render/publish/notify)
// Env: BREAK_HOURS (4) · BREAK_MIN (85) · BREAK_MAX (2) · BREAK_SECONDS (30)
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NICHE_RE } from './source.mjs'
import { uploadShort, recordPublished } from './publish.mjs'
import { loadEnv } from './env.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
loadEnv(join(ROOT, '.env'), 'D:/Projects/telegram-claude-bridge/.env')

const HISTORY = 'D:/projects/x-reader/history.json'
const USEDF = join(ROOT, '.news-used.json')
const STATEF = join(ROOT, '.breaking-state.json')
const LOGF = join(ROOT, '.breaking.log')
const HOURS = Number(process.env.BREAK_HOURS || 4)
const MIN = Number(process.env.BREAK_MIN || 85)
const MAX = Number(process.env.BREAK_MAX || 2)
const SECONDS = Number(process.env.BREAK_SECONDS || 30)
const DRY = process.argv.includes('--dry')

const today = new Date().toISOString().slice(0, 10)
const state = existsSync(STATEF) ? JSON.parse(readFileSync(STATEF, 'utf8')) : { date: today, count: 0, judged: [] }
if (state.date !== today) { state.date = today; state.count = 0 }
const log = (m) => { console.log(m); try { appendFileSync(LOGF, `${new Date().toISOString()} ${m}\n`) } catch {} }
const saveState = () => writeFileSync(STATEF, JSON.stringify({ ...state, judged: state.judged.slice(-300) }))

if (state.count >= MAX) { log(`daily cap reached (${state.count}/${MAX}) — skipping`); process.exit(0) }

const used = new Set(existsSync(USEDF) ? JSON.parse(readFileSync(USEDF, 'utf8')) : [])
const judged = new Set(state.judged)
const hist = JSON.parse(readFileSync(HISTORY, 'utf8'))
const now = Date.now()
const cands = []
for (const [id, t] of Object.entries(hist)) {
  if (used.has(id) || judged.has(id) || !t.text || t.text.length < 40) continue
  const ageH = (now - new Date(t.time || t.firstSeen).getTime()) / 36e5
  if (!(ageH >= 0) || ageH > HOURS) continue
  if (!NICHE_RE.test(t.text)) continue
  const s = (t.samples || [])[t.samples?.length - 1] || {}
  const vel = ((s.likes || 0) + 2 * (s.reposts || 0) + (s.replies || 0) + (s.views || 0) / 100) / Math.max(0.5, ageH)
  cands.push({ id, text: t.text.replace(/\s+/g, ' ').slice(0, 260), link: t.link, handle: t.handle, ageH: +ageH.toFixed(1), velocity: +vel.toFixed(1) })
}
cands.sort((a, b) => b.velocity - a.velocity)
const top = cands.slice(0, 12)
if (!top.length) { log('no new AI items to judge'); process.exit(0) }

// ── judge LLM: Gemini flash → OpenAI fallback ──
const judgePrompt = `You are the breaking-news editor of "The AI Pulse", a YouTube Shorts channel for the latest AI news. Below are fresh X posts (age in hours + engagement velocity). Decide if ANY single story (or 2 tightly-related posts) is genuinely BREAKING — worth interrupting the schedule to publish within the hour. BREAKING means: major model/product launch by a leading lab, major acquisition/funding/leadership change at a top AI company, major outage/safety incident, or landmark regulation. NOT breaking: routine feature updates, benchmarks, opinions/threads, hiring, tutorials, product promos, rumors from small accounts.
Items:
${top.map((c) => `id=${c.id} · ${c.ageH}h · vel=${c.velocity} · @${(c.handle || '').replace('@', '')}: ${c.text}`).join('\n')}
Return ONLY JSON: {"breaking": true|false, "score": 0-100, "ids": ["<id>", ...], "headline": "<max 8 words>", "reason": "<one line>"} — score >= ${MIN} ONLY for true must-publish-now stories; be conservative, most runs should be breaking:false.`

async function judge() {
  const KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${KEY}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: judgePrompt }] }], generationConfig: { temperature: 0.2, responseMimeType: 'application/json', maxOutputTokens: 1024 } }),
    })
    const j = await r.json()
    if (j.error) throw new Error(j.error.message)
    return JSON.parse(j.candidates[0].content.parts[0].text.match(/\{[\s\S]*\}/)[0])
  } catch (e) {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST', headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini', temperature: 0.2, response_format: { type: 'json_object' }, messages: [{ role: 'user', content: judgePrompt }] }),
    })
    const j = await r.json()
    if (j.error) throw new Error('judge failed twice: ' + e.message + ' / ' + j.error.message)
    return JSON.parse(j.choices[0].message.content)
  }
}

const v = await judge()
top.forEach((c) => judged.add(c.id)); state.judged = [...judged]
log(`judged ${top.length} items -> breaking=${v.breaking} score=${v.score} "${v.headline || ''}" (${v.reason || ''})`)
if (!v.breaking || (v.score || 0) < MIN) { saveState(); process.exit(0) }

const picks = top.filter((c) => (v.ids || []).includes(c.id))
if (!picks.length) { saveState(); log('judge returned no matching ids — skipping'); process.exit(0) }
if (DRY) { saveState(); log('[dry] WOULD publish BREAKING: ' + picks.map((p) => p.link).join(' ')); process.exit(0) }

const clean = (s) => s.replace(/"/g, "'").replace(/https?:\/\/\S+/g, '').trim()
const topic = `BREAKING AI NEWS: ${v.headline}. The facts, from live reports: ${picks.map((p) => clean(p.text)).join(' | ')}  Urgent news-flash style: what just happened, why it matters, one sharp closing line. Present tense, strictly these facts, no invented details.`
const gen = await new Promise((res, rej) => execFile('node', [join(ROOT, 'generate.mjs')], {
  maxBuffer: 1 << 26, env: { ...process.env, GEN_TOPIC: topic, GEN_SECONDS: String(SECONDS), GEN_NICHE: 'ai' },
}, (e, so, se) => e ? rej(new Error((se || e.message).slice(-400))) : res(so)))
const clip = JSON.parse(gen.trim().split('\n').pop()).clips[0]

const title = ('BREAKING: ' + (v.headline || clip.hook)).slice(0, 95)
const desc = [v.headline || '', '', 'Sources:', ...picks.map((p) => `• ${clean(p.text).slice(0, 100)} ${p.link}`), '', 'The AI Pulse — the latest from the AI world, every day.'].join('\n')
const r = await uploadShort(clip.file, title, desc, 'public', ['AI', 'breakingnews', 'ainews'])
recordPublished({ file: clip.file, id: r.id, url: r.url, title, score: null, privacy: 'public', kind: 'breaking' })

picks.forEach((p) => used.add(p.id)); writeFileSync(USEDF, JSON.stringify([...used].slice(-400)))
state.count++; saveState()
log(`🚨 BREAKING published: ${r.url} (${state.count}/${MAX} today)`)

// ping Yishai directly (no agent in the loop)
try {
  const tok = process.env.BRIDGE_BOT_TOKEN, chat = process.env.BRIDGE_CHAT_ID
  if (tok && chat) await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text: `🚨 The AI Pulse — BREAKING published:\n${v.headline}\n${r.url}` }),
  })
} catch (e) { log('telegram notify failed: ' + e.message) }
