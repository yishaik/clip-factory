#!/usr/bin/env node
// source.mjs — the SOURCING stage of Clip Factory.
// Discover fresh long-form videos from YouTube channels (free per-channel RSS, no API key,
// not bot-blocked), rank them by clip-worthiness, and emit a queue for the clip engine.
// Channels live in sources.json (array of channel_id "UC..." OR @handle OR channel URL).
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
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

const ageDays = (published) => Math.max(0.5, (Date.now() - (published ? new Date(published).getTime() : 0)) / 864e5)

// clip-worthiness, unified across providers:
//  - RSS items have a publish date -> rank by view-VELOCITY (views/day = "viral right now").
//  - search items have no date -> rank by absolute views (evergreen clip gold), scaled DOWN
//    (SOURCE_EVERGREEN_W, default 4) so fresh trending generally still wins.
// title hookiness + freshness break ties. log-compressed so orders of magnitude separate.
function scoreVideo(v) {
  const title = scoreTitle(v.title)
  if (v.published) {
    const vel = (v.views || 0) / ageDays(v.published)
    v.velocity = Math.round(vel)
    return +(Math.log10(vel + 1) * 10 + title + Math.max(0, 7 - ageDays(v.published))).toFixed(2)
  }
  const ev = Math.log10((v.views || 0) + 1) * Number(process.env.SOURCE_EVERGREEN_W || 4)
  return +(ev + title).toFixed(2)
}

// free YouTube keyword search via yt-dlp (no API key, not blocked). Flat = id+title+views+channel
// (no publish date), which is fine: search surfaces evergreen popular videos from creators we DON'T
// follow -> diversity beyond the fixed channel list.
export async function searchYouTube(query, limit = 8) {
  const out = await new Promise((res) => execFile('python',
    ['-m', 'yt_dlp', '--flat-playlist', '--no-warnings', '--print', '%(id)s\t%(title)s\t%(view_count)s\t%(channel)s', `ytsearch${limit}:${query}`],
    { maxBuffer: 1 << 26 }, (e, so) => res(so || '')))
  const vids = []
  for (const line of out.split('\n')) {
    const [id, title, views, channel] = line.split('\t')
    if (id && /^[\w-]{11}$/.test(id)) vids.push({ id, title: title || '', views: Number(views) || 0, channel: channel || '', channelId: 'search:' + (channel || query), via: 'search', query, url: `https://www.youtube.com/watch?v=${id}` })
  }
  return vids
}

const loadSearches = () => { const f = join(ROOT, 'searches.json'); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : [] }

const ytId = (url) => (url || '').match(/[?&]v=([\w-]{11})/)?.[1] || (url || '').match(/youtu\.be\/([\w-]{11})/)?.[1] || null

// scrape a YouTube watch page for views/date/channel/length/title (no API key) — used to enrich
// videos discovered elsewhere (e.g. Hacker News) into the same dated, velocity-rankable shape.
async function youtubeMeta(id) {
  const h = await get(`https://www.youtube.com/watch?v=${id}`)
  const published = h.match(/itemprop="datePublished" content="([^"]+)"/)?.[1] || h.match(/"publishDate":"([^"]+)"/)?.[1] || null
  return {
    views: Number(h.match(/"viewCount":"(\d+)"/)?.[1] || 0),
    published: published ? published.slice(0, 10) : null,
    channel: decode(h.match(/"author":"([^"]+)"/)?.[1] || ''),
    len: Number(h.match(/"lengthSeconds":"(\d+)"/)?.[1] || 0),
    title: decode(h.match(/<title>([^<]+)<\/title>/)?.[1] || '').replace(/ - YouTube$/, ''),
  }
}

// Hacker News: surfaces videos its tech/startup crowd is upvoting — creators outside our channel list.
// HN gives only a link + points, so we take the top-by-points youtube links and enrich each with YT meta.
export async function searchHackerNews(limit = 12) {
  const j = JSON.parse(await get('https://hn.algolia.com/api/v1/search_by_date?tags=story&query=youtube&hitsPerPage=60'))
  const seen = new Set(), picks = []
  for (const h of (j.hits || [])) {
    const id = ytId(h.url)
    if (id && !seen.has(id)) { seen.add(id); picks.push({ id, hnPoints: h.points || 0, hnTitle: h.title }) }
  }
  picks.sort((a, b) => b.hnPoints - a.hnPoints)
  const out = await Promise.all(picks.slice(0, limit).map(async (p) => {
    try {
      const m = await youtubeMeta(p.id)
      if (!m.views) return null
      return { id: p.id, title: m.title || p.hnTitle, views: m.views, published: m.published, channel: m.channel || 'HN', channelId: 'hn:' + (m.channel || p.id), len: m.len, via: 'hn', hnPoints: p.hnPoints, url: `https://www.youtube.com/watch?v=${p.id}` }
    } catch { return null }
  }))
  return out.filter(Boolean)
}

// keep one channel from flooding the head: each channel contributes its best `cap` first, overflow follows.
function diversify(sorted, cap) {
  const count = new Map(), head = [], tail = []
  for (const v of sorted) {
    const n = count.get(v.channelId) || 0
    if (n < cap) { head.push(v); count.set(v.channelId, n + 1) } else tail.push(v)
  }
  return head.concat(tail)
}

export async function discover(sources, { days = DAYS, skipSeen = false, queries } = {}) {
  const seen = skipSeen ? new Set() : new Set(existsSync(SEENF) ? JSON.parse(readFileSync(SEENF, 'utf8')) : [])
  const cutoff = Date.now() - days * 864e5
  const found = []
  // provider 1: per-channel RSS (fresh, dated -> velocity-ranked)
  for (const src of sources) {
    try {
      const cid = await resolveChannelId(src)
      if (!cid) { console.error(`  ! could not resolve ${src}`); continue }
      const vids = await channelFeed(cid)
      for (const v of vids) {
        if (seen.has(v.id)) continue
        if (v.published && new Date(v.published).getTime() < cutoff) continue
        v.via = 'rss'; v.score = scoreVideo(v)
        found.push(v)
      }
      console.error(`  ${src} -> ${vids.length} in feed`)
    } catch (e) { console.error(`  ! ${src}: ${e.message}`) }
  }
  // provider 2: YouTube keyword search (topics in searches.json or passed in) -> creators we don't follow
  const qs = queries || loadSearches()
  await Promise.all(qs.map(async (q) => {
    try {
      const vids = await searchYouTube(q, Number(process.env.SOURCE_SEARCH_N || 8))
      let added = 0
      for (const v of vids) { if (seen.has(v.id)) continue; v.score = scoreVideo(v); found.push(v); added++ }
      console.error(`  search "${q}" -> ${vids.length} (${added} new)`)
    } catch (e) { console.error(`  ! search "${q}": ${e.message}`) }
  }))
  // provider 3: Hacker News (videos its tech/startup crowd is upvoting) — opt-out with SOURCE_HN=0
  if (process.env.SOURCE_HN !== '0') {
    try {
      const vids = await searchHackerNews(Number(process.env.SOURCE_HN_N || 12))
      let added = 0
      for (const v of vids) {            // no publish-age cutoff: HN recency is the signal, not video age
        if (seen.has(v.id)) continue
        v.score = scoreVideo(v); found.push(v); added++
      }
      console.error(`  hacker-news -> ${vids.length} videos (${added} new)`)
    } catch (e) { console.error(`  ! hacker-news: ${e.message}`) }
  }
  // a video can surface from several providers -> keep the highest-scoring copy
  const byId = new Map()
  for (const v of found) { const e = byId.get(v.id); if (!e || v.score > e.score) byId.set(v.id, v) }
  const merged = [...byId.values()].sort((a, b) => b.score - a.score || (new Date(b.published || 0) - new Date(a.published || 0)))
  return diversify(merged, Number(process.env.SOURCE_PER_CHANNEL || 2))
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
  for (const v of vids.slice(0, 20)) console.log(`  [${v.score}] (${v.via}) ${v.title}  — ${v.channel}\n        ${(v.views || 0).toLocaleString()} views${v.velocity ? ' · ' + v.velocity.toLocaleString() + '/day' : ''}${v.published ? ' · ' + v.published.slice(0, 10) : ' · evergreen'}\n        ${v.url}`)
}
