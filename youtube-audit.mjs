#!/usr/bin/env node
// youtube-audit.mjs — read-only inventory of the authorized channel's uploads.
// Lists every video with privacyStatus, views, likes, comments, publish date, duration.
// Flags likely duplicates (normalized-title match). No writes. Auth: .youtube-publish.json refresh token.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
async function token() {
  const c = JSON.parse(readFileSync(join(ROOT, '.youtube-publish.json'), 'utf8'))
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.client_id, client_secret: c.client_secret, refresh_token: c.refresh_token, grant_type: 'refresh_token' }) })
  const j = await r.json()
  if (!j.access_token) throw new Error('token refresh failed: ' + JSON.stringify(j))
  return j.access_token
}
const api = async (tok, path) => {
  const r = await fetch('https://www.googleapis.com/youtube/v3/' + path, { headers: { authorization: `Bearer ${tok}` } })
  const j = await r.json()
  if (!r.ok) throw new Error(path.slice(0, 40) + ' -> ' + r.status + ': ' + JSON.stringify(j).slice(0, 200))
  return j
}
const norm = (t) => (t || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()

const tok = await token()
const ch = await api(tok, 'channels?part=contentDetails,snippet,statistics&mine=true')
const c0 = ch.items?.[0]
if (!c0) { console.error('no channel for this auth'); process.exit(1) }
const uploads = c0.contentDetails.relatedPlaylists.uploads
console.error(`channel: ${c0.snippet.title}  ·  ${Number(c0.statistics.subscriberCount||0).toLocaleString()} subs  ·  ${Number(c0.statistics.videoCount||0)} videos  ·  ${Number(c0.statistics.viewCount||0).toLocaleString()} total views`)

let ids = [], pageToken = ''
do {
  const pl = await api(tok, `playlistItems?part=contentDetails&maxResults=50&playlistId=${uploads}` + (pageToken ? `&pageToken=${pageToken}` : ''))
  ids.push(...pl.items.map((i) => i.contentDetails.videoId))
  pageToken = pl.nextPageToken || ''
} while (pageToken)

const vids = []
for (let i = 0; i < ids.length; i += 50) {
  const batch = ids.slice(i, i + 50).join(',')
  const v = await api(tok, `videos?part=snippet,status,statistics,contentDetails&id=${batch}`)
  for (const it of v.items) vids.push({
    id: it.id, title: it.snippet.title, privacy: it.status.privacyStatus,
    published: it.snippet.publishedAt, dur: it.contentDetails.duration,
    views: Number(it.statistics.viewCount || 0), likes: Number(it.statistics.likeCount || 0),
    comments: Number(it.statistics.commentCount || 0), url: 'https://youtube.com/shorts/' + it.id,
  })
}
vids.sort((a, b) => new Date(b.published) - new Date(a.published))

// duplicate detection by normalized title
const byNorm = new Map()
for (const v of vids) { const k = norm(v.title); if (!byNorm.has(k)) byNorm.set(k, []); byNorm.get(k).push(v) }
const dupes = [...byNorm.values()].filter((g) => g.length > 1)

writeFileSync(join(ROOT, '.youtube-audit.json'), JSON.stringify({ channel: c0.snippet.title, at: new Date().toISOString(), stats: c0.statistics, videos: vids, dupes }, null, 2))

const byPriv = vids.reduce((m, v) => (m[v.privacy] = (m[v.privacy] || 0) + 1, m), {})
console.error(`\n=== ${vids.length} videos: ` + Object.entries(byPriv).map(([k, n]) => `${n} ${k}`).join(', ') + ' ===\n')
for (const v of vids) console.error(
  `[${v.privacy.padEnd(8)}] ${String(v.views).padStart(5)}v ${String(v.likes).padStart(3)}♥ ${String(v.comments).padStart(2)}💬  ${v.published.slice(0,10)}  ${v.title.slice(0,52)}\n            ${v.url}`)
if (dupes.length) { console.error(`\n⚠ ${dupes.length} duplicate title group(s):`); for (const g of dupes) console.error('  · ' + g[0].title + '  ->  ' + g.map((x) => `${x.url}(${x.privacy},${x.views}v)`).join('  ')) }
console.error('\nwrote .youtube-audit.json')
