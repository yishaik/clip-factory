#!/usr/bin/env node
// clip.mjs — Clip Factory engine.
// One long video -> N short, vertical (9:16), captioned clips ready for TikTok/Reels/Shorts.
//   1) transcribe with local Whisper (free) -> timed cues
//   2) group cues into 15-45s windows, pick the most "clippable" ones (hook heuristic + optional Gemma)
//   3) ffmpeg: cut, reformat to 1080x1920 with blurred bg, burn TikTok-style captions
// Tools: ffmpeg, ffprobe, whisper (all local/free). Zero npm deps.
import { execFile } from 'node:child_process'
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs'
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

export async function transcribe(file, workDir) {
  let jsonp = join(workDir, basename(file, extname(file)) + '.json')
  if (!existsSync(jsonp)) {
    await run('whisper', [file, '--model', WMODEL, '--word_timestamps', 'True', '--output_format', 'json', '--output_dir', workDir], { cwd: workDir })
  }
  // whisper can exit 0 yet skip a file on "bad allocation" (OOM) — surface that clearly, and
  // tolerate a differently-named output by picking up any json it did write.
  if (!existsSync(jsonp)) {
    const found = readdirSync(workDir).find((f) => f.endsWith('.json'))
    if (found) jsonp = join(workDir, found)
    else throw new Error('whisper produced no transcript (likely OOM/bad-allocation — try WHISPER_MODEL=tiny or a shorter PIPE_HEAD)')
  }
  const j = JSON.parse(readFileSync(jsonp, 'utf8'))
  const cues = (j.segments || []).map((s) => ({ start: s.start, end: s.end, text: (s.text || '').trim() })).filter((c) => c.text)
  const words = []
  for (const s of (j.segments || [])) for (const w of (s.words || [])) { const t = (w.word || '').trim(); if (t && w.end > w.start) words.push({ start: w.start, end: w.end, text: t }) }
  return { cues, words }
}

// group consecutive cues into windows of MIN..MAX seconds, breaking on long gaps
// Sentence-aware windows: each clip STARTS at a thought-start (after a pause or a sentence end)
// and ENDS at a sentence end, so it stands on its own and leads with its hook.
function buildWindows(cues) {
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

// Gemini cloud (model configurable: flash for cheap fallback, 2.5-pro for the decision engine)
async function geminiCloud(prompt, { json = false, model, ms = 90000 } = {}) {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
  if (!key) return null
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), ms)
    const m = model || process.env.CLIP_CLOUD_MODEL || 'gemini-flash-latest'
    const gc = { temperature: 0.6, maxOutputTokens: 4096 }; if (json) gc.responseMimeType = 'application/json'
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

// DECISION engine model — strongest available: Claude (if key) → Gemini 2.5 Pro → local Gemma
async function decide(prompt, opts = {}) {
  if (process.env.ANTHROPIC_API_KEY) { const c = await claudeCloud(prompt, opts); if (c) return c }
  const g = await geminiCloud(prompt, { ...opts, model: process.env.CLIP_DECISION_MODEL || 'gemini-3.1-pro-preview' })
  if (g) return g
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
async function rankWindowsLLM(windows) {
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

const aT = (s) => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = (s % 60); return `${h}:${String(m).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}` }
const assEsc = (t) => String(t).replace(/[{}\\]/g, '').replace(/\n/g, ' ')

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

  let events = ''
  for (const ln of lines) {
    const start = ln[0].start, end = ln[ln.length - 1].end
    let text = ''
    ln.forEach((w, i) => { const next = i < ln.length - 1 ? ln[i + 1].start : end; const cs = Math.max(1, Math.round((next - w.start) * 100)); text += `{\\kf${cs}}${w.text} ` })
    events += `Dialogue: 0,${aT(start)},${aT(end)},Cap,,0,0,0,,${text.trim()}\n`
  }
  if (hook) events = `Dialogue: 0,0:00:00.00,${aT(Math.min(3, dur))},Hook,,0,0,0,,${assEsc(hook)}\n` + events
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
  return { x: 0.5, conf: 0, frac: 0 }
}

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
  let mode = frame, X = 0.5
  if (frame === 'smart') {
    const fi = await faceInfo(input, win)
    // Haar is a sparse detector — even a clear talking head only registers a face in ~30-45% of frames,
    // while B-roll sits near 0. Gate low so real speakers crop and only true B-roll falls back to blur.
    if (fi.frac >= 0.15 && fi.conf >= 5) { mode = 'crop'; X = fi.x } else mode = 'blur'
    console.error(`     framing: ${mode === 'crop' ? `crop x=${X.toFixed(2)}` : 'blur-fit'} (${Math.round((fi.frac || 0) * 100)}% faces)`)
  }
  const vf = mode === 'blur'
    ? blurVf(assArg)
    : mode === 'fill'
      ? `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920[bv];[bv]ass=${assArg}[v]`
      : `[0:v]scale=-2:1920[sc];[sc]crop=1080:1920:min(max(${X.toFixed(3)}*iw-540\\,0)\\,iw-1080):0[bv];[bv]ass=${assArg}[v]`
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
  let windows = buildWindows(cues).map((w) => ({ ...w, score: scoreWindow(w) })).sort((a, b) => b.score - a.score)

  // decision engine: LLM virality ranking (default), heuristic fallback
  let how = 'heuristic'
  if (process.env.CLIP_NO_LLM !== '1') {
    console.error('decision engine: scoring segments for virality (LLM)...')
    const llm = await rankWindowsLLM(windows).catch(() => null)
    if (llm && llm.length) { windows = llm; how = 'LLM virality' }
  }
  const chosen = windows.slice(0, n)
  console.error(`transcribed ${cues.length} cues -> ${windows.length} candidate windows -> top ${chosen.length} (${how})`)

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
