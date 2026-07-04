#!/usr/bin/env node
// explain.mjs — the ANTI-SLOP short: ONE real post, explained in depth.
//   1) pick ONE fresh high-velocity AI post from x-reader/history.json (or EXPLAIN_TWEET)
//   2) screenshot the REAL tweet card via x-reader's logged-in profile (+ grab its media)
//   3) Gemini: lead-in + read the post + a DETAILED explanation of what it means (one topic)
//   4) neural TTS voiceover + Whisper-timed karaoke captions
//   5) render: post screenshot on-screen while it's READ, then REAL b-roll under the explanation
//   6) (opt-in EXPLAIN_PUBLISH=1) upload to YouTube with the source post linked
//
// Env: EXPLAIN_SECONDS(70) · EXPLAIN_HOURS(24) · EXPLAIN_LANG(en) · EXPLAIN_TWEET(id|url to force)
//      PEXELS_API_KEY(real stock video) · EXPLAIN_PUBLISH(1) · EXPLAIN_MUSIC_MODE
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transcribe } from './clip.mjs'
import { tts, gemini, alignToTiming, genAss } from './generate.mjs'
import { resolveMusic, listLibrary } from './music.mjs'
import { fetchBroll, fetchTweetMedia } from './broll.mjs'
import { NICHE_RE } from './source.mjs'
import { loadEnv } from './env.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
loadEnv(join(ROOT, '.env'))
const KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
const OUT = join(ROOT, 'generated')
const HISTORY = 'D:/projects/x-reader/history.json'
const SHOT = 'D:/projects/x-reader/shot-tweet.mjs'
const USEDF = join(ROOT, '.explain-used.json')

const SECS = Math.max(35, Math.min(90, Number(process.env.EXPLAIN_SECONDS || 70)))
const HOURS = Number(process.env.EXPLAIN_HOURS || 24)
const LANG = process.env.EXPLAIN_LANG || 'en'
const RTL = LANG === 'he' || LANG === 'ar'
const LANGS = { en: 'English', he: 'Hebrew', es: 'Spanish', ar: 'Arabic', fr: 'French' }

const run = (cmd, args, opts = {}) => new Promise((res, rej) => execFile(cmd, args, { maxBuffer: 1 << 27, ...opts }, (e, so, se) => e ? rej(new Error((e.message || '') + '\n' + se)) : res((so || '') + '\n' + (se || ''))))
const probeDur = async (f) => parseFloat((await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', f])).trim()) || 0
const wc = (s) => String(s).trim().split(/\s+/).filter(Boolean).length
const clean = (s) => String(s || '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim()

// keep whole sentences up to a word budget (preserves a clean ending)
function fitWords(text, maxWords) {
  const sents = String(text).match(/[^.!?]+[.!?]+/g) || [String(text)]
  const kept = []; let n = 0
  for (const s of sents) { const w = wc(s); if (n + w > maxWords && kept.length) break; kept.push(s.trim()); n += w }
  return kept.join(' ')
}

// ── 1) pick ONE fresh, high-velocity AI post ─────────────────────────────────
function selectTweet() {
  const used = new Set(existsSync(USEDF) ? JSON.parse(readFileSync(USEDF, 'utf8')) : [])
  const hist = JSON.parse(readFileSync(HISTORY, 'utf8'))
  const now = Date.now()
  const items = []
  for (const [id, t] of Object.entries(hist)) {
    if (used.has(id) || !t.text || t.text.length < 60) continue
    const ts = new Date(t.time || t.firstSeen).getTime()
    const ageH = (now - ts) / 36e5
    if (!(ageH >= 0) || ageH > HOURS) continue
    if (!NICHE_RE.test(t.text)) continue
    const s = (t.samples || [])[t.samples.length - 1] || {}
    const eng = (s.likes || 0) + 2 * (s.reposts || 0) + (s.replies || 0) + (s.views || 0) / 100
    items.push({ id, text: clean(t.text), rawText: t.text, link: t.link, handle: t.handle, author: t.name || '', ageH: +ageH.toFixed(1), velocity: +(eng / Math.max(0.5, ageH)).toFixed(2) })
  }
  items.sort((a, b) => b.velocity - a.velocity)
  return items
}

function markUsed(id) {
  const used = existsSync(USEDF) ? JSON.parse(readFileSync(USEDF, 'utf8')) : []
  used.push(id); writeFileSync(USEDF, JSON.stringify(used.slice(-400)))
}

// ── 2) screenshot the real tweet card (+ its media) ──────────────────────────
async function shotTweet(linkOrId, outPng) {
  const out = await run('node', [SHOT, linkOrId, outPng]).catch((e) => JSON.stringify({ ok: false, reason: e.message.slice(0, 100) }))
  const line = out.trim().split('\n').filter(Boolean).pop() || '{}'
  try { return JSON.parse(line) } catch { return { ok: false, reason: 'bad shot output' } }
}

// fallback: render a clean dark "post card" PNG from text (when the live shot fails)
async function makeTextCard(author, text, outPng, work) {
  const wrap = (s, n) => { const w = s.split(/\s+/); const out = []; let line = ''; for (const x of w) { if ((line + ' ' + x).trim().length > n) { out.push(line.trim()); line = x } else line += ' ' + x } if (line.trim()) out.push(line.trim()); return out }
  const lines = [author || '@post', '', ...wrap(text, 30)]
  const txt = join(work, 'card.txt'); writeFileSync(txt, lines.join('\n'))
  const h = Math.max(700, 180 + lines.length * 74)
  const esc = (p) => p.replace(/\\/g, '/').replace(/:/g, '\\:')
  const font = existsSync('C:/Windows/Fonts/seguisb.ttf') ? 'C:/Windows/Fonts/seguisb.ttf' : 'C:/Windows/Fonts/arialbd.ttf'
  await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', `color=c=0x15202b:s=1040x${h}`, '-vf',
    `drawtext=fontfile='${esc(font)}':textfile='${esc(txt)}':fontcolor=white:fontsize=44:line_spacing=26:x=60:y=70`,
    '-frames:v', '1', outPng])
  return outPng
}

// ── 3) script: lead-in + read + detailed explanation, one topic ──────────────
async function writeScript(pick) {
  const totalWords = Math.round(SECS * 2.4)
  const readWords = Math.min(60, Math.round(totalWords * 0.32))
  const explainWords = totalWords - readWords
  const lang = LANGS[LANG] || 'English'
  const prompt = `You are a sharp, credible AI-news explainer writing narration for ONE vertical short. A real post was published on X:
AUTHOR: ${pick.author ? pick.author + ' ' : ''}${pick.handle || ''}
POST: """${pick.text.slice(0, 600)}"""

Write narration in ${lang} that (1) frames it in one line, (2) states the post's core claim plainly, then (3) explains IN DEPTH what it actually means and why it matters — ONE topic only, a real analysis, not a list. Assume a smart viewer who wants the significance, not hype.
TONE: factual, specific, calm-authoritative — like a great human explainer. NO hype clichés (game-changer, insane, mind-blowing, revolutionary, "you won't believe"), no emoji, no exclamation marks, no hashtags.
Return ONLY JSON:
{"hook":"<4-7 word on-screen title, ${lang}, sentence case>",
 "leadin":"<1 spoken sentence naming the source/context>",
 "read":"<the post's core message in 1-2 spoken sentences, faithful to it, plain ${lang}>",
 "explain":"<the DETAILED explanation, ~${explainWords} words: what it means, the context a viewer lacks, why it matters, what actually changes. Concrete and specific, no filler.>",
 "broll":["<3-4 REAL-WORLD stock-footage search queries for the explanation visuals: concrete, filmable subjects only — e.g. 'data center servers', 'humanoid robot factory', 'person coding at night', 'close up computer chip', 'city street crowd'. No text, no logos, no abstract concepts.>"],
 "music":"<short instrumental mood brief: genre + instruments + tempo, no vocals>"}
Budget: leadin+read ~${readWords} words; explain ~${explainWords} words.`
  let s = null, lastErr
  for (let attempt = 0; attempt < 3 && !s; attempt++) {
    try {
      const raw = await gemini(prompt, { json: true })
      // extract JSON carefully: find opening brace, then reverse-search closing brace
      const start = raw.indexOf('{')
      if (start < 0) throw new Error('no JSON in output')
      const end = raw.lastIndexOf('}')
      if (end <= start) throw new Error('malformed JSON delimiters')
      const jsonStr = raw.slice(start, end + 1)
      const p = JSON.parse(jsonStr)
      if (!p.explain || !p.read) throw new Error('missing explain/read fields')
      s = p
    } catch (e) { lastErr = e; if (attempt < 2) await new Promise((r) => setTimeout(r, 1200)) }
  }
  if (!s) throw new Error('script generation failed: ' + (lastErr?.message || '?'))
  s.explain = fitWords(s.explain, explainWords + 25)
  s.narration = [s.leadin, s.read, s.explain].map((x) => String(x || '').trim()).filter(Boolean).join(' ')
  s.readText = [s.leadin, s.read].map((x) => String(x || '').trim()).filter(Boolean).join(' ')
  s.broll = (s.broll || []).filter(Boolean).slice(0, 4)
  return s
}

// ── b-roll assets: tweet media first, then real stock for each query ─────────
async function gatherBroll(media, queries, need, work) {
  const assets = []
  // real stock first (clean, cinematic) — the post's OWN media can be dense charts/paper
  for (const q of queries) {
    if (assets.length >= need) break
    const a = await fetchBroll(q, assets.length, work).catch(() => null)
    if (a) { assets.push(a); console.error(`  b-roll: "${q}" -> ${a.type} (${a.credit})`) }
    else console.error(`  b-roll: "${q}" -> none`)
  }
  // include ONE piece of the post's own media only when asked (EXPLAIN_USE_TWEET_MEDIA=1)
  if (process.env.EXPLAIN_USE_TWEET_MEDIA && assets.length < need && (media || []).length) {
    const a = await fetchTweetMedia(media[0], assets.length, work); if (a) { assets.push(a); console.error('  b-roll: post media (1)') }
  }
  return assets
}

// build a 1080x1920 segment from a b-roll asset (Ken-Burns for photos, cropped for video)
async function brollSeg(asset, dur, i, work, frames) {
  const seg = join(work, `bseg${i}.mp4`)
  if (asset.type === 'video') {
    await run('ffmpeg', ['-y', '-stream_loop', '-1', '-i', asset.path, '-t', dur.toFixed(2),
      '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30,format=yuv420p',
      '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', seg])
  } else {
    const moves = [
      `zoompan=z='min(zoom+0.0011,1.18)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`,
      `zoompan=z='1.14':x='(iw-iw/zoom)*on/${frames}':y='ih/2-(ih/zoom/2)'`,
      `zoompan=z='1.14':x='(iw-iw/zoom)*(1-on/${frames})':y='ih/2-(ih/zoom/2)'`,
      `zoompan=z='min(zoom+0.0011,1.18)':x='iw/2-(iw/zoom/2)':y='(ih-ih/zoom)*on/${frames}'`,
    ]
    const kb = `${moves[i % moves.length]}:d=1:s=1080x1920:fps=30`
    await run('ffmpeg', ['-y', '-loop', '1', '-framerate', '30', '-t', dur.toFixed(2), '-i', asset.path,
      '-vf', `scale=1350:2400:force_original_aspect_ratio=increase,crop=1350:2400,${kb},format=yuv420p`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', seg])
  }
  return seg
}

// the READING segment: the post card, sharp & centred, on a blurred-darkened copy of itself
async function readingSeg(cardPng, dur, work) {
  const seg = join(work, 'read.mp4')
  await run('ffmpeg', ['-y', '-loop', '1', '-framerate', '30', '-t', dur.toFixed(2), '-i', cardPng,
    '-filter_complex',
    `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=32:3,eq=brightness=-0.42:saturation=0.7[bg];` +
    `[0:v]scale=968:1480:force_original_aspect_ratio=decrease[card];` +
    `[bg][card]overlay=(W-w)/2:(H-h)/2-40,format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', seg])
  return seg
}

async function main() {
  if (!KEY) throw new Error('GEMINI_API_KEY missing')
  mkdirSync(OUT, { recursive: true }); const work = join(OUT, '_work_explain'); mkdirSync(work, { recursive: true })

  // 1) pick
  const force = (process.env.EXPLAIN_TWEET || '').trim()
  let pick
  if (force) {
    const id = (force.match(/(\d{6,})/) || [])[1] || force
    const hist = existsSync(HISTORY) ? JSON.parse(readFileSync(HISTORY, 'utf8')) : {}
    const t = hist[id] || {}
    pick = { id, text: clean(t.text || ''), link: t.link || force, handle: t.handle || '', author: t.name || '', velocity: 0, ageH: 0 }
  } else {
    const items = selectTweet()
    if (!items.length) { console.log('no fresh AI post in the last ' + HOURS + 'h'); process.exit(0) }
    pick = items[0]
    console.error(`${items.length} candidates. picked [v${pick.velocity} · ${pick.ageH}h] ${pick.handle}: ${pick.text.slice(0, 90)}`)
  }

  // 2) screenshot the real card (+ media)
  const cardPng = join(work, 'card.png')
  console.error('screenshotting the real post...')
  const shot = await shotTweet(pick.link || pick.id, cardPng)
  let media = []
  if (shot.ok) {
    media = shot.media || []
    if ((!pick.text || pick.text.length < 40) && shot.text) pick.text = clean(shot.text)
    if (!pick.author && shot.author) pick.author = shot.author
    console.error(`  card captured · ${media.length} media`)
  } else {
    console.error(`  live shot failed (${shot.reason}) → rendering a text card`)
    if (!pick.text) throw new Error('no post text and no live shot — cannot build')
    await makeTextCard(pick.author || pick.handle, pick.text, cardPng, work)
  }

  // 3) script
  console.error('writing script (Gemini)...')
  const s = await writeScript(pick)
  console.error(`HOOK: ${s.hook}\nnarration ${wc(s.narration)} words · b-roll: ${s.broll.join(' · ')}`)

  // 4) voiceover + captions
  const wav = join(work, 'voice.wav')
  console.error('neural voiceover...'); await tts(s.narration, wav, work)
  const dur = await probeDur(wav); console.error(`voice ${dur.toFixed(1)}s`)
  if (LANG !== 'en') process.env.WHISPER_LANG = LANG
  try { rmSync(join(work, 'voice.json'), { force: true }); rmSync(join(work, 'transcript.json'), { force: true }) } catch {}
  console.error('captions (Whisper timing + true text)...')
  const { words } = await transcribe(wav, work)
  const capWords = alignToTiming(s.narration.trim().split(/\s+/).filter(Boolean), words)
  writeFileSync(join(work, 'explain.ass'), genAss(capWords, dur, s.hook, RTL))

  // timing: card stays up while the post is READ, b-roll fills the explanation
  const XF = 0.6
  const readFrac = Math.max(0.28, Math.min(0.52, wc(s.readText) / Math.max(1, wc(s.narration))))
  const Ta = +(dur * readFrac).toFixed(2)
  const Tb = +(dur - Ta).toFixed(2)
  const K = Math.max(2, Math.min(5, Math.round(Tb / 4.5)))
  console.error(`layout: reading ${Ta}s + explanation ${Tb}s over ${K} b-roll shots`)

  // gather real b-roll
  console.error('fetching REAL b-roll' + (process.env.PEXELS_API_KEY ? ' (Pexels)' : ' (Openverse, keyless)') + '...')
  let assets = await gatherBroll(media, s.broll, K, work)
  if (!assets.length) { console.error('  no real b-roll → clean fallback: the post card with slow Ken-Burns'); assets = [{ type: 'photo', path: cardPng, credit: 'post' }] }
  { const base = assets.length; let p = 0; while (assets.length < K) { assets.push(assets[p % base]); p++ } } // pad by CYCLING (varied)

  // build segments: [reading, b-roll x K]
  const shares = [Ta, ...Array.from({ length: K }, () => Tb / K)]
  const segs = []
  segs.push(await readingSeg(cardPng, shares[0] + XF, work))
  for (let i = 0; i < K; i++) {
    const d = shares[i + 1] + XF
    const frames = Math.max(1, Math.round(d * 30))
    segs.push(await brollSeg(assets[i % assets.length], d, i, work, frames))
  }

  // music (ducked)
  let music = process.env.EXPLAIN_MUSIC || ''
  if (!music) {
    const mode = process.env.EXPLAIN_MUSIC_MODE || (listLibrary().length ? 'library' : 'none')
    if (mode !== 'none') {
      try { music = await resolveMusic({ mode, aiPrompt: process.env.EXPLAIN_MUSIC_PROMPT || s.music || '', seconds: Math.min(90, Math.round(dur)), outPath: join(work, 'ai_music.mp3') }) }
      catch (e) { console.error('  music skipped: ' + e.message) }
    }
  }

  // 5) render — xfade chain (cumulative offsets) + captions + audio
  console.error('final render (crossfades + captions' + (music ? ' + music' : '') + ')...')
  const TRANS = ['fade', 'smoothleft', 'smoothright', 'slideup', 'circleopen', 'fadeblack']
  const inputs = []; segs.forEach((sg) => inputs.push('-i', sg)); inputs.push('-i', wav)
  const voiceIdx = segs.length; let musIdx = -1
  if (music) { inputs.push('-i', music); musIdx = segs.length + 1 }

  const parts = []; let prev = '[0:v]'; let acc = shares[0] + XF
  for (let i = 1; i < segs.length; i++) {
    const off = (acc - XF).toFixed(3), lbl = `[x${i}]`
    parts.push(`${prev}[${i}:v]xfade=transition=${TRANS[(i - 1) % TRANS.length]}:duration=${XF}:offset=${off}${lbl}`)
    prev = lbl; acc += (shares[i] + XF) - XF
  }
  parts.push(`${prev}ass=explain.ass[v]`)
  let aMap = `${voiceIdx}:a`
  if (musIdx >= 0) {
    const vol = Number(process.env.EXPLAIN_MUSIC_VOL || 0.16)
    parts.push(`[${musIdx}:a]aloop=loop=-1:size=2000000000,volume=${vol}[mus]`)
    parts.push(`[mus][${voiceIdx}:a]sidechaincompress=threshold=0.05:ratio=6:attack=5:release=350[duck]`)
    parts.push(`[${voiceIdx}:a][duck]amix=inputs=2:duration=first:normalize=0[a]`)
    aMap = '[a]'
  }
  const slug = (s.hook || pick.handle || 'post').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'post'
  const out = join(OUT, 'explain-' + slug + '.mp4')
  await run('ffmpeg', ['-y', ...inputs, '-filter_complex', parts.join(';'),
    '-map', '[v]', '-map', aMap, '-t', String(dur), '-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', out], { cwd: work })

  const source = pick.link ? pick.link.replace(/\/(analytics|likes|retweets)\/?$/i, '') : null
  writeFileSync(join(OUT, 'explain-' + slug + '.json'), JSON.stringify({ ...s, dur, file: out, source, handle: pick.handle }, null, 2))
  console.error(`\n✅ ${out}\n   hook: ${s.hook}\n   ${dur.toFixed(0)}s · ${assets.length} real b-roll shots${source ? '\n   source: ' + source : ''}`)

  // 6) optional publish
  if (process.env.EXPLAIN_PUBLISH) {
    const { uploadShort, recordPublished } = await import('./publish.mjs')
    const title = (s.hook || 'AI, explained').slice(0, 95)
    const desc = [s.leadin, '', `Source post: ${source || pick.handle}`, '', 'One AI story, explained — every day on The AI Pulse.'].filter(Boolean).join('\n')
    const r = await uploadShort(out, title, desc, process.env.EXPLAIN_PRIVACY || 'public', ['AI', 'ainews', 'artificialintelligence', 'tech', 'explained'])
    recordPublished({ file: out, id: r.id, url: r.url, title, score: null, privacy: process.env.EXPLAIN_PRIVACY || 'public', kind: 'explain' })
    console.error(`✅ published: ${r.url}`)
  }
  if (!force) markUsed(pick.id)
  console.log(JSON.stringify({ outDir: OUT, hook: s.hook, source, clips: [{ file: out, hook: s.hook, dur: +dur.toFixed(0) }] }))
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/explain.mjs')
if (isMain) main().catch((e) => { console.error('ERR ' + e.message); process.exit(1) })
