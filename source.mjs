#!/usr/bin/env node
// source.mjs — the SOURCING stage of Clip Factory.
// Discover fresh long-form videos from YouTube channels (free per-channel RSS, no API key,
// not bot-blocked), rank them by clip-worthiness, and emit a queue for the clip engine.
// Channels live in sources.json (array of channel_id "UC..." OR @handle OR channel URL).
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const SEENF = join(ROOT, '.source-seen.json')
const DAYS = Number(process.env.SOURCE_DAYS || 21) // only consider videos newer than this

const get = async (url) => {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 20000)
  try { const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 ClipFactory' }, signal: ctrl.signal }); return await r.text() } finally { clearTimeout(t) }
}
const decode = (s) => (s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x?[0-9a-f]+;/gi, ' ')

// resolve a channel_id from a UC-id, @handle, or channel URL
export async function resolveChannelId(src) {
  src = String(src).trim()
  if (/^UC[\w-]{20,}$/.test(src)) return src
  const url = src.startsWith('http') ? src : `https://www.youtube.com/${src.startsWith('@') ? src : '@' + src}`
  const html = await get(url)
  return html.match(/"(?:externalId|channelId)":"(UC[\w-]{20,})"/)?.[1] || html.match(/channel\/(UC[\w-]{20,})/)?.[1] || null
}

export async function channelFeed(channelId) {
  const xml = await get(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`)
  const author = decode(xml.match(/<author>[\s\S]*?<name>([^<]+)/)?.[1] || '')
  const out = []
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1]
    const id = e.match(/<yt:videoId>([^<]+)/)?.[1]
    const title = decode(e.match(/<title>([^<]+)/)?.[1])
    const published = e.match(/<published>([^<]+)/)?.[1]
    const views = Number(e.match(/views="(\d+)"/)?.[1] || 0)
    if (id) out.push({ id, title, published, views, channel: author, channelId, url: `https://www.youtube.com/watch?v=${id}` })
  }
  return out
}

// clip-worthiness of a video by its TITLE (hook words, numbers, questions, how-to)
const TITLE_HOOK = /\b(how to|why|the truth|secret|mistake|stop|never|always|nobody|biggest|best|worst|reason|lesson|story of|inside|guide|framework|million|\$\d|\d+x|\d+ ways|first \d)\b/i
function scoreTitle(t) {
  let s = 0
  if (TITLE_HOOK.test(t)) s += 4
  if (/\d/.test(t)) s += 2
  if (/\?$/.test(t)) s += 1
  if (t.split(' ').length >= 5) s += 1
  return s
}

export async function discover(sources, { days = DAYS } = {}) {
  const seen = new Set(existsSync(SEENF) ? JSON.parse(readFileSync(SEENF, 'utf8')) : [])
  const cutoff = Date.now() - days * 864e5
  const found = []
  for (const src of sources) {
    try {
      const cid = await resolveChannelId(src)
      if (!cid) { console.error(`  ! could not resolve ${src}`); continue }
      const vids = await channelFeed(cid)
      for (const v of vids) {
        if (seen.has(v.id)) continue
        if (v.published && new Date(v.published).getTime() < cutoff) continue
        v.score = scoreTitle(v.title)
        found.push(v)
      }
      console.error(`  ${src} -> ${vids.length} in feed`)
    } catch (e) { console.error(`  ! ${src}: ${e.message}`) }
  }
  found.sort((a, b) => b.score - a.score || new Date(b.published) - new Date(a.published))
  return found
}

export function markSeen(ids) {
  const seen = new Set(existsSync(SEENF) ? JSON.parse(readFileSync(SEENF, 'utf8')) : [])
  ids.forEach((i) => seen.add(i))
  writeFileSync(SEENF, JSON.stringify([...seen].slice(-5000)))
}

// CLI: node source.mjs  (reads sources.json)  |  node source.mjs @handle UC...
const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/source.mjs')
if (isMain) {
  let sources = process.argv.slice(2)
  if (!sources.length) {
    const f = join(ROOT, 'sources.json')
    sources = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : []
  }
  if (!sources.length) { console.error('no sources. add sources.json (array of @handle / UC-id / url) or pass them as args'); process.exit(1) }
  console.error(`discovering from ${sources.length} channels (last ${DAYS}d)...`)
  const vids = await discover(sources)
  console.log(`\n${vids.length} fresh candidate videos (ranked by clip-worthiness):\n`)
  for (const v of vids.slice(0, 20)) console.log(`  [${v.score}] ${v.title}  — ${v.channel}\n        ${v.url}  (${(v.published || '').slice(0, 10)})`)
}
