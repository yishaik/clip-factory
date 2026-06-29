#!/usr/bin/env node
// clip.mjs — Clip Factory engine.
// One long video -> N short, vertical (9:16), captioned clips ready for TikTok/Reels/Shorts.
//   1) transcribe with local Whisper (free) -> timed cues
//   2) group cues into 15-45s windows, pick the most "clippable" ones (hook heuristic + optional Gemma)
//   3) ffmpeg: cut, reformat to 1080x1920 with blurred bg, burn TikTok-style captions
// Tools: ffmpeg, ffprobe, whisper (all local/free). Zero npm deps.
import { execFile } from 'node:child_process'
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, basename, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
// minimal .env loader so GEMINI_API_KEY (cloud fallback) is available even in scheduled/headless runs
try {
  const envf = join(ROOT, '.env')
  if (existsSync(envf)) for (const line of readFileSync(envf, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
} catch {}
const HOST = process.env.OLLAMA_HOST || 'http://localhost:11434'
const MODEL = process.env.CLIP_MODEL || 'gemma4:e4b'
const WMODEL = process.env.WHISPER_MODEL || 'base'

const run = (cmd, args, opts = {}) => new Promise((res, rej) => {
  execFile(cmd, args, { maxBuffer: 1 << 26, ...opts }, (e, so, se) => e ? rej(new Error((e.message || '') + '\n' + se)) : res(so + '\n' + se))
})

async function probeDuration(file) {
  const out = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file])
  return parseFloat(out.trim()) || 0
}

const T = (s) => { // seconds -> SRT timestamp
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60), ms = Math.round((s - Math.floor(s)) * 1000)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(ms).padStart(3, '0')}`
}
const parseT = (t) => { const m = t.trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/); return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000 : 0 }

function parseSrt(text) {
  const cues = []
  for (const block of text.replace(/\r/g, '').split(/\n\n+/)) {
    const lines = block.split('\n').filter(Boolean)
    const tl = lines.find((l) => l.includes('-->'))
    if (!tl) continue
    const [a, b] = tl.split('-->')
    const txt = lines.slice(lines.indexOf(tl) + 1).join(' ').trim()
    if (txt) cues.push({ start: parseT(a), end: parseT(b), text: txt })
  }
  return cues
}

// parse a whisper json into {cues, words}, shifting every timestamp by `offset` seconds
function parseWhisper(jsonp, offset = 0) {
  const j = JSON.parse(readFileSync(jsonp, 'utf8'))
  const cues = (j.segments || []).map((s) => ({ start: s.start + offset, end: s.end + offset, text: (s.text || '').trim() })).filter((c) => c.text)
  const words = []
  for (const s of (j.segments || [])) for (const w of (s.words || [])) { const t = (w.word || '').trim(); if (t && w.end > w.start) words.push({ start: w.start + offset, end: w.end + offset, text: t }) }
  return { cues, words }
}

// run whisper on one audio/video file, return the path to the json it wrote (or null on OOM/skip)
async function whisperRun(input, workDir, lang = '') {
  const args = [input, '--model', WMODEL, '--word_timestamps', 'True', '--output_format', 'json', '--output_dir', workDir]
  if (lang) args.push('--language', lang, '--task', 'transcribe') // forced language -> never auto-detect or translate
  await run('whisper', args, { cwd: workDir })
  const stem = basename(input, extname(input))
  let jsonp = join(workDir, stem + '.json')
  if (!existsSync(jsonp)) { const f = readdirSync(workDir).find((x) => x.endsWith('.json') && x.startsWith(stem)); if (f) jsonp = join(workDir, f) }
  return existsSync(jsonp) ? jsonp : null
}

// Transcribe to timed cues + words. CHUNKED by default: split into WHISPER_CHUNK_SEC windows,
// extract a small 16k-mono wav per chunk, transcribe sequentially (one at a time so peak memory
// stays bounded — whisper "bad allocation" OOMs on long inputs under load), then offset + merge.
// WHISPER_CHUNK_SEC=0 forces the legacy single-shot path. Result cached to transcript.json.
export async function transcribe(file, workDir) {
  file = resolve(file); workDir = resolve(workDir) // whisper runs with cwd=workDir, so inputs must be absolute
  const cacheF = join(workDir, 'transcript.json')
  // cache is keyed to the EXACT input (size+mtime) — a different/changed video can never reuse a stale
  // transcript (the kind of cross-run contamination that bit us before). Also keyed to model+chunk.
  const st = (() => { try { return statSync(file) } catch { return null } })()
  // Hebrew -> ivrit-ai fine-tune via faster-whisper (vanilla whisper mis-hears Hebrew badly, ~83% vs ~98%).
  // WHISPER_BACKEND=cli forces the plain CLI path; WHISPER_HE_MODEL overrides the model.
  const HE_MODEL = process.env.WHISPER_HE_MODEL || 'ivrit-ai/whisper-large-v3-turbo-ct2'
  const useFW = (process.env.WHISPER_LANG || '') === 'he' && process.env.WHISPER_BACKEND !== 'cli'
  const sig = st ? `${st.size}:${Math.round(st.mtimeMs)}:${useFW ? 'fw:' + HE_MODEL : WMODEL}:${process.env.WHISPER_CHUNK_SEC ?? 150}` : ''
  if (existsSync(cacheF)) { try { const c = JSON.parse(readFileSync(cacheF, 'utf8')); if (c.sig === sig && c.cues?.length) return { cues: c.cues, words: c.words } } catch {} }
  const CHUNK = Number(process.env.WHISPER_CHUNK_SEC ?? 150), OVERLAP = 1.5
  const dur = await probeDuration(file).catch(() => 0)
  let result = null
  // Hebrew backend: faster-whisper handles long audio itself; on any failure we fall back to the CLI path.
  if (useFW) {
    const out = join(workDir, 'fw.json')
    try {
      console.error(`  transcribe: Hebrew via faster-whisper (${HE_MODEL})`)
      await run('python', [join(ROOT, 'transcribe_fw.py'), file, 'he', HE_MODEL, out])
      const r = parseWhisper(out, 0); if (r.cues.length) result = r
    } catch (e) { console.error('  faster-whisper(he) failed -> whisper CLI: ' + String(e.message).slice(0, 100)) }
  }
  let lang = process.env.WHISPER_LANG || '' // empty = auto-detect on the FIRST chunk, then lock it for the rest
  if (!result && (!CHUNK || (dur && dur <= CHUNK + 5))) {
    const jp = await whisperRun(file, workDir, lang)
    if (!jp) throw new Error('whisper produced no transcript (likely OOM/bad-allocation — try WHISPER_MODEL=tiny)')
    result = parseWhisper(jp, 0)
  } else if (!result) {
    const allCues = [], allWords = []
    let lastEnd = 0
    for (let i = 0, start = 0; start < dur; i++, start += CHUNK) {
      const len = Math.min(CHUNK + OVERLAP, dur - start + 0.1)
      const wav = join(workDir, `chunk_${i}.wav`)
      await run('ffmpeg', ['-y', '-ss', String(start), '-t', String(len), '-i', file, '-vn', '-ac', '1', '-ar', '16000', wav])
      const jp = await whisperRun(wav, workDir, lang).catch(() => null)
      try { rmSync(wav, { force: true }) } catch {}
      if (!jp) { console.error(`  ! transcribe chunk ${i} (@${start.toFixed(0)}s) failed — skipping`); continue }
      if (!lang) { try { lang = JSON.parse(readFileSync(jp, 'utf8')).language || ''; if (lang) console.error(`  transcribe: locked language = ${lang}`) } catch {} } // lock detected language across chunks
      const { cues, words } = parseWhisper(jp, start)
      for (const c of cues) if (c.start >= lastEnd - 0.05) { allCues.push(c); lastEnd = Math.max(lastEnd, c.end) }
      const lastW = () => (allWords.length ? allWords[allWords.length - 1].start : -1)
      for (const w of words) if (w.start > lastW()) allWords.push(w)
    }
    if (!allCues.length) throw new Error('whisper produced no transcript across all chunks (try WHISPER_MODEL=tiny)')
    result = { cues: allCues, words: allWords }
  }
  try { writeFileSync(cacheF, JSON.stringify({ sig, ...result })) } catch {}
  return result
}

// group consecutive cues into windows of MIN..MAX seconds, breaking on long gaps
// Sentence-aware windows: each clip STARTS at a thought-start (after a pause or a sentence end)
// and ENDS at a sentence end, so it stands on its own and leads with its hook.
export function buildWindows(cues) {
  const GAP = Number(process.env.CLIP_GAP || 0.8)
  const MIN = Number(process.env.CLIP_MIN || 14)
  const TARGET = Number(process.env.CLIP_TARGET || 26)
  const MAX = Number(process.env.CLIP_MAX || 44)
  const endsSentence = (t) => /[.!?]["')\]]?$/.test((t || '').trim())
  const isStart = (i) => i === 0 || endsSentence(cues[i - 1].text) || (cues[i].start - cues[i - 1].end > GAP)
  const isEnd = (i) => i === cues.length - 1 || endsSentence(cues[i].text) || (cues[i + 1].start - cues[i].end > GAP)

  const wins = []
  for (let i = 0; i < cues.length; i++) {
    if (!isStart(i)) continue
    const start = cues[i].start
    let j = i
    while (j + 1 < cues.length) {
      const durNow = cues[j].end - start
      if (durNow >= TARGET && isEnd(j)) break          // hit target at a clean sentence end
      if (cues[j + 1].end - start > MAX) break          // adding the next cue would exceed max
      j++
    }
    // if we stopped mid-sentence (max reached), back off to the last clean end >= MIN
    if (!isEnd(j)) { let k = j; while (k > i && !(isEnd(k) && cues[k].end - start >= MIN)) k--; if (k > i) j = k }
    const end = cues[j].end
    if (end - start < MIN) continue
    wins.push({ start, end, cues: cues.slice(i, j + 1), text: cues.slice(i, j + 1).map((x) => x.text).join(' ') })
    i = j // non-overlapping: continue after this window
  }
  return wins
}

// hook score: punchy openers + numbers + curiosity words
const HOOKS = /\b(the truth|most important|secret|never|always|nobody|the one thing|here is|how to|why|stop|biggest mistake|the reason|what if|the trick|lesson|remember this)\b/i
function scoreWindow(w) {
  let s = 0
  if (HOOKS.test(w.text)) s += 5
  if (/\d/.test(w.text)) s += 2
  const dur = w.end - w.start
  if (dur >= 18 && dur <= 40) s += 3
  s += Math.min(3, w.cues.length) // some substance
  return s
}

// local Ollama (Gemma) — free, but OOMs under memory pressure on this machine
async function ollama(prompt, { json = false, ms = 180000 } = {}) {
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), ms)
    const opts = { temperature: 0.6 }; if (!process.env.CLIP_GPU) opts.num_gpu = 0 // CPU by default (small GPU is full)
    const body = { model: MODEL, prompt, stream: false, options: opts }; if (json) body.format = 'json'
    const r = await fetch(`${HOST}/api/generate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal }).finally(() => clearTimeout(t))
    if (!r.ok) return null
    return ((await r.json()).response || '').trim() || null
  } catch { return null }
}

// Gemini cloud (model configurable: flash for cheap fallback, 3.1-pro for the decision engine)
async function geminiCloud(prompt, { json = false, model, ms = 90000, think, maxTokens = 8192 } = {}) {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
  if (!key) return null
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), ms)
    const m = model || process.env.CLIP_CLOUD_MODEL || 'gemini-flash-latest'
    const gc = { temperature: 0.6, maxOutputTokens: maxTokens }; if (json) gc.responseMimeType = 'application/json'
    // NB gemini-3.1-pro-preview now REQUIRES thinking (budget 0 -> HTTP 400). Use a positive budget and a
    // maxOutputTokens large enough that thinking + the JSON both fit (thinking counts toward the limit).
    if (think != null) gc.thinkingConfig = { thinkingBudget: think }
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${key}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: gc }), signal: ctrl.signal,
    }).finally(() => clearTimeout(t))
    if (!r.ok) return null
    const j = await r.json()
    return ((j.candidates && j.candidates[0]?.content?.parts?.[0]?.text) || '').trim() || null
  } catch { return null }
}

// Claude cloud (Anthropic Messages API) — best taste/judgment; active only when ANTHROPIC_API_KEY is set
async function claudeCloud(prompt, { json = false, ms = 90000 } = {}) {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) return null
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), ms)
    const model = process.env.CLIP_CLAUDE_MODEL || 'claude-opus-4-8'
    const sys = json ? 'Respond with valid JSON only — no prose, no markdown fences.' : undefined
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 2048, temperature: 0.6, system: sys, messages: [{ role: 'user', content: prompt }] }), signal: ctrl.signal,
    }).finally(() => clearTimeout(t))
    if (!r.ok) return null
    const j = await r.json()
    return ((j.content && j.content[0]?.text) || '').trim() || null
  } catch { return null }
}

// DECISION engine — strongest first, then a fast reliable cloud model, then local (so hooks never silently
// drop to heuristic just because the slow preview model timed out).
async function decide(prompt, opts = {}) {
  if (process.env.ANTHROPIC_API_KEY) { const c = await claudeCloud(prompt, opts); if (c) return c }
  const think = Number(process.env.CLIP_THINK_BUDGET || 2048) // 3.1-pro now requires thinking; bound it + big output budget
  const pro = await geminiCloud(prompt, { ...opts, model: process.env.CLIP_DECISION_MODEL || 'gemini-3.1-pro-preview', ms: 150000, think, maxTokens: 16384 })
  if (pro) return pro
  const fast = await geminiCloud(prompt, { ...opts, model: 'gemini-flash-latest', ms: 40000, think, maxTokens: 16384 })
  if (fast) return fast
  return await ollama(prompt, opts)
}

// general helper (hooks/titles etc.): local first (free) → cloud
async function gemma(prompt, opts = {}) {
  if (process.env.CLIP_NO_LOCAL !== '1') {
    const local = await ollama(prompt, opts)
    if (local) return local
  }
  return await geminiCloud(prompt, opts)
}

// LLM decision engine: score each candidate window for short-form viral potential, in ONE call.
export async function rankWindowsLLM(windows) {
  const cands = windows.slice(0, 10) // heuristic pre-filter -> LLM precision-ranks these
  const list = cands.map((w, i) => `[${i}] (${Math.round(w.end - w.start)}s) ${w.text.slice(0, 200)}`).join('\n\n')
  const prompt = `You are a world-class short-form video editor (TikTok/Reels/YouTube Shorts). Below are numbered transcript segments from one long video. Score each 0-100 for viral potential as a STANDALONE short clip.\n` +
    `Reward: a strong hook in the first sentence, an emotional/surprising/contrarian payoff, a quotable line, clarity without outside context.\n` +
    `Penalize: rambling, starting mid-thought, filler, or needing context to make sense.\n` +
    `Return ONLY a JSON object {"clips":[{"i":<index>,"score":<0-100>,"hook":"<punchy 4-8 word caption, no hashtags>"}]} with one entry per segment. Keep it compact.\n\nSEGMENTS:\n${list}`
  const raw = await decide(prompt, { json: true, ms: 90000 })
  if (!raw) return null
  let arr
  try { const j = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw); arr = j.clips || j.segments || (Array.isArray(j) ? j : null) } catch { return null }
  if (!Array.isArray(arr) || !arr.length) return null
  const byI = new Map(arr.map((x) => [Number(x.i), x]))
  let hit = 0
  cands.forEach((w, i) => { const r = byI.get(i); if (r && r.score != null) { w.llmScore = Number(r.score) || 0; w.hook = (r.hook || '').toString().slice(0, 80); w.reason = (r.reason || '').toString().slice(0, 120); hit++ } })
  if (!hit) return null
  return cands.filter((w) => w.llmScore != null).sort((a, b) => b.llmScore - a.llmScore)
}

const nearestIndex = (arr, val) => { let bi = 0, bd = Infinity; for (let i = 0; i < arr.length; i++) { const d = Math.abs(arr[i] - val); if (d < bd) { bd = d; bi = i } } return bi }
const endsSentence = (t) => /[.!?]["')\]]?$/.test((t || '').trim())
const overlapFrac = (a, b) => { const o = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start)); return o / Math.min(a.end - a.start, b.end - b.start) }

// snap an LLM-proposed [ps,pe] moment to clean cue boundaries: begin at a thought-start, end on a
// sentence end, and keep the duration within [MIN,MAX]. Returns a window {start,end,cues,text} or null.
function snapMoment(cues, ps, pe, MIN, MAX) {
  if (!(pe > ps) || !cues.length) return null
  let si = nearestIndex(cues.map((c) => c.start), ps)
  for (let k = si; k >= Math.max(0, si - 2); k--) if (k === 0 || endsSentence(cues[k - 1].text)) { si = k; break } // back up to a thought-start
  let ei = Math.max(si, nearestIndex(cues.map((c) => c.end), pe))
  const start = cues[si].start
  while (ei < cues.length - 1 && cues[ei].end - start < MIN) ei++              // grow to reach MIN
  while (ei > si && cues[ei].end - start > MAX) ei--                            // shrink to respect MAX
  for (let k = ei; k < Math.min(cues.length, ei + 2); k++) if (endsSentence(cues[k].text) && cues[k].end - start <= MAX) { ei = k; break } // land on a sentence end
  const end = cues[ei].end
  if (end - start < MIN || end - start > MAX + 2) return null
  const seg = cues.slice(si, ei + 1)
  return { start, end, cues: seg, text: seg.map((c) => c.text).join(' ') }
}

// PRIMARY decision engine: hand the LLM the whole timestamped transcript and let it choose the most
// viral standalone moments WITH their own start/end times (like a real editor), instead of only ranking
// pre-cut heuristic windows. Proposed times are snapped to clean sentence boundaries + de-overlapped.
export async function pickMoments(cues, n) {
  if (!cues?.length) return null
  const MIN = Number(process.env.CLIP_MIN || 14), MAX = Number(process.env.CLIP_MAX || 44)
  const want = Math.min(12, n + 3)
  const lines = cues.map((c) => `${c.start.toFixed(1)} ${c.text}`).join('\n')
  const prompt = `You are a world-class short-form video editor (TikTok/Reels/YouTube Shorts). Below is a timestamped transcript of one long video — each line is "<startSeconds> <text>".\n` +
    `Find the ${want} BEST standalone short-clip moments, each ${MIN}-${MAX} seconds long. Choose START and END seconds so the clip OPENS on a strong hook and CLOSES on a complete thought — it must make sense with zero outside context.\n` +
    `Reward: a gripping first line, an emotional/surprising/contrarian payoff, a quotable line, a complete mini-story. Penalize: rambling, starting mid-thought, filler.\n` +
    `Return ONLY JSON {"clips":[{"start":<sec>,"end":<sec>,"score":<0-100>,"hook":"<punchy 4-8 word caption, no hashtags>","reason":"<one short clause>"}]}, best first.\n\nTRANSCRIPT:\n${lines}`
  const raw = await decide(prompt, { json: true, ms: 120000 })
  if (!raw) return null
  let arr
  try { const j = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || raw); arr = j.clips || j.moments || (Array.isArray(j) ? j : null) } catch { return null }
  if (!Array.isArray(arr) || !arr.length) return null
  const picks = []
  for (const m of arr) {
    const w = snapMoment(cues, Number(m.start), Number(m.end), MIN, MAX)
    if (!w) continue
    w.llmScore = Number(m.score) || 0; w.hook = (m.hook || '').toString().slice(0, 80); w.reason = (m.reason || '').toString().slice(0, 140)
    picks.push(w)
  }
  if (!picks.length) return null
  picks.sort((a, b) => b.llmScore - a.llmScore)
  const kept = [] // drop near-duplicate moments (keep the higher-scored)
  for (const w of picks) if (!kept.some((k) => overlapFrac(k, w) > 0.5)) kept.push(w)
  return kept
}

const aT = (s) => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = (s % 60); return `${h}:${String(m).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}` }
const assEsc = (t) => String(t).replace(/[{}\\]/g, '').replace(/\n/g, ' ')

// Emit Cap dialogue events for grouped word-lines. LTR: one \kf karaoke sweep per line.
// RTL: libass does NOT bidi-reorder karaoke/override runs, so multi-word Hebrew comes out in LOGICAL
// (left-to-right) order — wrong. Fix: REVERSE the words (first word ends up rightmost) and emit one event
// per word time-window with cumulative colouring (words spoken so far = yellow), which gives the correct
// right-to-left word order AND a right-to-left highlight. (verified by pixel-position of the lit word.)
export function emitCaptionLines(lines, rtl) {
  const RLM = '‏', YEL = '&H0000FFFF&', WHT = '&H00FFFFFF&'
  let ev = ''
  for (const ln of lines) {
    if (rtl) {
      const rev = [...ln].reverse()
      ln.forEach((w, i) => {
        const segEnd = i < ln.length - 1 ? ln[i + 1].start : ln[ln.length - 1].end
        const txt = rev.map((rw) => `{\\c${ln.indexOf(rw) <= i ? YEL : WHT}}${rw.text}`).join(' ')
        ev += `Dialogue: 0,${aT(w.start)},${aT(Math.max(w.start + 0.05, segEnd))},Cap,,0,0,0,,${RLM}${txt}\n`
      })
    } else {
      const start = ln[0].start, end = ln[ln.length - 1].end; let text = ''
      ln.forEach((w, i) => { const next = i < ln.length - 1 ? ln[i + 1].start : end; text += `{\\kf${Math.max(1, Math.round((next - w.start) * 100))}}${w.text} ` })
      ev += `Dialogue: 0,${aT(start)},${aT(end)},Cap,,0,0,0,,${text.trim()}\n`
    }
  }
  return ev
}

// build a styled ASS: word-by-word karaoke captions (lower third) + a hook title card (top, first 3s) + optional brand
export function buildAss(words, win, hook, brand) {
  const dur = win.end - win.start
  const W = words.filter((w) => w.end > win.start && w.start < win.end)
    .map((w) => ({ start: Math.max(0, w.start - win.start), end: Math.min(dur, Math.max(0.1, w.end - win.start)), text: assEsc(w.text) }))
  // group words into short karaoke lines
  const lines = []; let cur = []
  for (const w of W) {
    cur.push(w)
    const lineDur = w.end - cur[0].start
    if (cur.length >= 4 || lineDur >= 1.6 || /[.!?]$/.test(w.text)) { lines.push(cur); cur = [] }
  }
  if (cur.length) lines.push(cur)

  // RTL (Hebrew/Arabic) detected from the actual caption glyphs.
  const rtl = /[֐-׿؀-ۿ]/.test(W.map((w) => w.text).join('') + (hook || ''))
  const RLM = '‏'
  let events = emitCaptionLines(lines, rtl)
  if (hook) events = `Dialogue: 0,0:00:00.00,${aT(Math.min(3, dur))},Hook,,0,0,0,,${rtl ? RLM : ''}${assEsc(hook)}\n` + events
  if (brand) events += `Dialogue: 0,0:00:00.00,${aT(dur)},Brand,,0,0,0,,${assEsc(brand)}\n`

  // colours are &HAABBGGRR. sung=yellow, unsung=white, dark outline.
  return `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,Arial,76,&H0000FFFF,&H00FFFFFF,&H00101010,&H00000000,1,0,0,0,100,100,0,0,1,5,2,2,90,90,300,1
Style: Hook,Arial,56,&H00FFFFFF,&H00FFFFFF,&H00101010,&HB0000000,1,0,0,0,100,100,0,0,3,4,0,8,80,80,150,1
Style: Brand,Arial,40,&H00D9C6A8,&H00D9C6A8,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,2,1,2,40,40,90,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events}`
}

// analyse the speaker's face over the clip: {x:0..1 centre, conf, frac:fraction of frames with a face}
async function faceInfo(input, win) {
  try {
    const out = await run('python', [join(ROOT, 'face_track.py'), resolve(input), String(win.start), String(win.end - win.start)])
    const m = out.match(/\{[^{}]*"x"[^{}]*\}/)
    if (m) return JSON.parse(m[0])
  } catch {}
  return { x: 0.5, y: 0.42, size: 0, conf: 0, frac: 0 }
}

// source pixel dimensions (for face-framed crop geometry)
async function probeSize(file) {
  try { const o = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', file]); const [w, h] = o.trim().split('x').map(Number); if (w && h) return { w, h } } catch {}
  return { w: 1920, h: 1080 }
}
const even = (n) => Math.max(2, Math.round(n / 2) * 2)

const blurVf = (assArg) =>
  `[0:v]split=2[bg][fg];[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=24:4[bgb];` +
  `[fg]scale=1040:-2:force_original_aspect_ratio=decrease[fgs];[bgb][fgs]overlay=(W-w)/2:(H-h)/2[bv];[bv]ass=${assArg}[v]`

async function renderClip(input, win, idx, outDir, workDir, words) {
  const dur = win.end - win.start
  const assPath = join(workDir, `clip-${idx}.ass`)
  writeFileSync(assPath, buildAss(words || [], win, win.hook, process.env.CLIP_BRAND || ''))
  const assArg = basename(assPath) // ffmpeg cwd=workDir so the path is simple (libass-safe)
  const out = join(outDir, `clip-${idx}.mp4`)
  // framing: 'smart' (default) auto-picks per clip — crop around the speaker when a face is consistently
  // present, else fall back to blurred-fit (safe for B-roll). 'fill'/'blur' force a mode.
  const frame = process.env.CLIP_FRAME || 'smart'
  let mode = frame, fi = { x: 0.5, y: 0.42, size: 0 }
  if (frame === 'smart') {
    fi = await faceInfo(input, win)
    // Haar is a sparse detector — even a clear talking head only registers a face in ~30-45% of frames,
    // while B-roll sits near 0. Gate low so real speakers crop and only true B-roll falls back to blur.
    mode = (fi.frac >= 0.15 && fi.conf >= 5) ? 'crop' : 'blur'
    // but if a meaningful slice of the clip shows an on-screen graphic (chart/text) in the sides a crop
    // would discard, fall back to blur-fit so the whole composition stays visible instead of being sliced.
    if (mode === 'crop' && (fi.graphic || 0) >= Number(process.env.CLIP_GRAPHIC_FRAC || 0.15)) mode = 'blur'
  }
  let vf, note = mode
  if (mode === 'blur') vf = blurVf(assArg)
  else if (mode === 'fill') vf = `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920[bv];[bv]ass=${assArg}[v]`
  else { // face-framed 9:16 crop sized to the head's vertical TRAVEL across the clip (ylo..yhi) plus
         // head/chin room — so a still speaker crops tight and a moving one loosens just enough to never
         // cut the head. Clamped to source bounds; falls back to x-only crop if no extent data.
    const { w: sw, h: sh } = await probeSize(resolve(input))
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
    const HEAD = Number(process.env.CLIP_HEADROOM || 0.07), CHIN = Number(process.env.CLIP_CHINROOM || 0.10)
    const TARGET = Number(process.env.CLIP_FACE_TARGET || 0.32)
    if (fi.ylo != null && fi.yhi != null && fi.yhi > fi.ylo) {
      const topF = clamp(fi.ylo - HEAD, 0, 1), botF = clamp(fi.yhi + CHIN, 0, 1)
      const targetHc = ((fi.size || 0.25) * sh) / TARGET    // nice chest-up zoom (face ~TARGET of frame)
      const travelHc = (botF - topF) * sh                   // must at least span the head's vertical travel
      let Hc = clamp(Math.max(targetHc, travelHc), sh * 0.45, sh) // looser of the two; never over-zoom or exceed source
      let Wc = Hc * 9 / 16
      if (Wc > sw) { Wc = sw; Hc = Wc * 16 / 9 }            // portrait/near-square source: fit width
      Wc = even(Math.min(Wc, sw)); Hc = even(Math.min(Hc, sh))
      const top = even(clamp(topF * sh, 0, sh - Hc))         // keep headroom above the HIGHEST head position
      const left = even(clamp(fi.x * sw - Wc / 2, 0, sw - Wc))
      vf = `[0:v]crop=${Wc}:${Hc}:${left}:${top},scale=1080:1920,setsar=1[bv];[bv]ass=${assArg}[v]`
      note = `crop face x=${fi.x.toFixed(2)} head ${fi.ylo.toFixed(2)}-${fi.yhi.toFixed(2)} zoom ${(sh / Hc).toFixed(2)}x`
    } else { // face present but no extent data -> legacy x-only crop (full height)
      vf = `[0:v]scale=-2:1920[sc];[sc]crop=1080:1920:min(max(${fi.x.toFixed(3)}*iw-540\\,0)\\,iw-1080):0[bv];[bv]ass=${assArg}[v]`
      note = `crop x=${fi.x.toFixed(2)}`
    }
  }
  if (frame === 'smart') console.error(`     framing: ${note} (${Math.round((fi.frac || 0) * 100)}% faces)`)
  await run('ffmpeg', ['-y', '-ss', String(win.start), '-t', String(dur), '-i', resolve(input),
    '-filter_complex', vf, '-map', '[v]', '-map', '0:a', '-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', resolve(out)], { cwd: workDir })
  return out
}

export async function makeClips(input, { n = 3, outDir, ai = false } = {}) {
  input = resolve(input)
  if (!existsSync(input)) throw new Error('input not found: ' + input)
  outDir = outDir || join(ROOT, 'clips', basename(input, extname(input)))
  const workDir = join(outDir, '_work')
  mkdirSync(outDir, { recursive: true }); mkdirSync(workDir, { recursive: true })

  console.error('transcribing (whisper ' + WMODEL + ', word timestamps)...')
  const { cues, words } = await transcribe(input, workDir)
  if (!cues.length) throw new Error('no speech transcribed')

  // decision engine. PRIMARY: let the LLM read the whole timestamped transcript and choose viral
  // moments WITH their own boundaries (snapped to sentences). FALLBACK: rank pre-cut heuristic windows.
  let how = 'heuristic', windows = null
  if (process.env.CLIP_NO_LLM !== '1') {
    console.error('decision engine: LLM picking viral moments + boundaries...')
    const picked = await pickMoments(cues, n).catch((e) => { console.error('  pickMoments failed: ' + e.message); return null })
    if (picked && picked.length) { windows = picked; how = 'LLM moments' }
  }
  if (!windows) {
    windows = buildWindows(cues).map((w) => ({ ...w, score: scoreWindow(w) })).sort((a, b) => b.score - a.score)
    if (process.env.CLIP_NO_LLM !== '1') { const r = await rankWindowsLLM(windows).catch(() => null); if (r && r.length) { windows = r; how = 'LLM ranking (fallback)' } }
  }
  const chosen = windows.slice(0, n)
  console.error(`transcribed ${cues.length} cues -> ${windows.length} moments -> top ${chosen.length} (${how})`)

  const results = []
  for (let i = 0; i < chosen.length; i++) {
    const w = chosen[i]
    const sc = w.llmScore != null ? `viral ${w.llmScore}` : `score ${w.score}`
    console.error(`  clip ${i + 1}: ${w.start.toFixed(1)}-${w.end.toFixed(1)}s (${sc})${w.hook ? ' — “' + w.hook + '”' : ''}`)
    const file = await renderClip(input, w, i + 1, outDir, workDir, words)
    let title = w.hook || null
    if (!title && ai) title = await gemma(`Write a punchy 4-8 word social caption for this clip, no quotes/hashtags:\n"${w.text.slice(0, 400)}"`)
    results.push({ idx: i + 1, file, start: w.start, end: w.end, dur: +(w.end - w.start).toFixed(1), viralScore: w.llmScore ?? null, hook: w.hook || null, reason: w.reason || null, heuristic: w.score, title, text: w.text })
  }
  writeFileSync(join(outDir, 'clips.json'), JSON.stringify(results, null, 2))
  if (process.env.CLIP_KEEP !== '1') { try { rmSync(workDir, { recursive: true, force: true }) } catch {} }
  return { outDir, clips: results }
}

// CLI: node clip.mjs <video> [n]
const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/clip.mjs')
if (isMain) {
  const input = process.argv[2]
  if (!input) { console.error('usage: node clip.mjs <video.mp4> [n]'); process.exit(1) }
  const n = Number(process.argv[3] || 3)
  const { outDir, clips } = await makeClips(input, { n, ai: process.env.CLIP_AI === '1' })
  console.log(`\n✅ ${clips.length} clips -> ${outDir}`)
  for (const c of clips) console.log(`  clip-${c.idx}.mp4  ${c.dur}s  ${c.title ? '“' + c.title + '”' : ''}`)
}
