// broll.mjs — fetch REAL b-roll for a query (no AI-generated imagery).
// Order of preference:  Pexels video → Pexels photo → Openverse photo (keyless).
// Returns { type:'video'|'photo', path, credit, url } or null.
//
// Set PEXELS_API_KEY (free: https://www.pexels.com/api/) for real stock VIDEO,
// which looks far less "AI slop" than photos. Without it, falls back to Openverse
// Creative-Commons photos (keyless, lower quality but real).
import { writeFileSync } from 'node:fs'

// a descriptive UA is REQUIRED by Wikimedia (used by Openverse) or the image 403s
const UA = 'clip-factory/1.0 (https://github.com/yishaik; contact yishai.k@gmail.com)'
async function dl(u, path, headers = {}) {
  const r = await fetch(u, { headers: { 'user-agent': UA, ...headers } })
  if (!r.ok) throw new Error('dl ' + r.status)
  writeFileSync(path, Buffer.from(await r.arrayBuffer()))
  return path
}

// A proper Pexels API key (56-char, standard) handles rapid requests fine. We still keep
// a small pace as a courtesy/burst guard (tunable via PEXELS_PACE_MS). (A non-standard
// OAuth-style token throttles hard at <5s spacing — if you see 401s, check the key format.)
const sleep = (ms) => new Promise((s) => setTimeout(s, ms))
let _lastPexels = 0
async function pace(minMs = Number(process.env.PEXELS_PACE_MS || 1000)) {
  const wait = minMs - (Date.now() - _lastPexels)
  if (wait > 0) await sleep(wait)
  _lastPexels = Date.now()
}
// circuit breaker: if Pexels throttles us hard (repeated 401 windows), stop hammering
// it for the rest of this process and skip straight to the fallback — bounds total time
let _pexelsDead = false
async function pexelsGet(url, key, tries = 2) {
  if (_pexelsDead) return null
  for (let i = 0; i < tries; i++) {
    await pace()
    try {
      const r = await fetch(url, { headers: { authorization: key } })
      if (r.status === 200) return await r.json()
      if (r.status !== 401 && r.status !== 429 && r.status < 500) return null // real client error (bad query etc.)
    } catch {}
    if (i < tries - 1) await sleep(6000) // a 401 despite spacing → wait a full interval before the one retry
  }
  return null
}

// pick the mp4 whose height is closest to a 1080-wide vertical target, capped so we
// don't pull a 4K file for a 1080x1920 crop
function pickVideoFile(files) {
  const mp4 = (files || []).filter((f) => f.file_type === 'video/mp4' && f.link)
  if (!mp4.length) return null
  return mp4.map((f) => ({ f, score: Math.abs((f.height || 0) - 1280) + (Math.max(0, (f.height || 0) - 1920)) * 3 }))
    .sort((a, b) => a.score - b.score)[0].f
}

export async function fetchBroll(query, i, workDir) {
  const key = process.env.PEXELS_API_KEY
  let pexelsFailed = false
  if (key && !_pexelsDead) {
    // 1) Pexels video (portrait) — best anti-slop b-roll
    try {
      const j = await pexelsGet(`https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&orientation=portrait&size=medium&per_page=8`, key)
      if (j === null) pexelsFailed = true
      for (const v of j?.videos || []) {
        const f = pickVideoFile(v.video_files)
        if (f) { const p = `${workDir}/broll${i}.mp4`; await dl(f.link, p); return { type: 'video', path: p, credit: v.user?.name || 'Pexels', url: v.url, q: query } }
      }
    } catch {}
    // 2) Pexels photo (portrait)
    try {
      const j = await pexelsGet(`https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&orientation=portrait&per_page=8`, key)
      if (j === null) pexelsFailed = true
      const ph = (j?.photos || [])[0]
      if (ph) { const p = `${workDir}/broll${i}.jpg`; await dl(ph.src?.large2x || ph.src?.large || ph.src?.original, p); return { type: 'photo', path: p, credit: ph.photographer || 'Pexels', url: ph.url, q: query } }
    } catch {}
    // two throttled queries in a row → trip the breaker (skip Pexels for the rest of the run)
    if (pexelsFailed) { _pexelsFails = (_pexelsFails || 0) + 1; if (_pexelsFails >= 2) { _pexelsDead = true; console.error('  (Pexels throttled — skipping it for the rest of this run)') } }
  }
  // 3) Openverse (keyless) CC photo — OFF by default: its topical relevance is unreliable
  // (returns random people for "data center" etc.), which looks worse than the branded card.
  if (process.env.BROLL_OPENVERSE) {
    try {
      const r = await fetch(`https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&size=large&page_size=8&mature=false`, { headers: { 'user-agent': UA } })
      const j = await r.json()
      const im = (j.results || []).find((x) => x.url && /\.(jpe?g|png)(\?|$)/i.test(x.url)) || (j.results || [])[0]
      if (im?.url) { const p = `${workDir}/broll${i}.jpg`; await dl(im.url, p); return { type: 'photo', path: p, credit: im.creator || 'Openverse', url: im.foreign_landing_url, q: query } }
    } catch {}
  }
  return null
}
let _pexelsFails = 0

// download a tweet's own attached media (already-real, most relevant) as a photo asset
export async function fetchTweetMedia(mediaUrl, i, workDir) {
  try { const p = `${workDir}/tw${i}.jpg`; await dl(mediaUrl, p); return { type: 'photo', path: p, credit: 'from the post', url: mediaUrl, q: 'post media' } }
  catch { return null }
}
