#!/usr/bin/env node
// clip.mjs — Clip Factory engine.
// One long video -> N short, vertical (9:16), captioned clips ready for TikTok/Reels/Shorts.
//   1) transcribe with local Whisper (free) -> timed cues
//   2) group cues into 15-45s windows, pick the most "clippable" ones (hook heuristic + optional Gemma)
//   3) ffmpeg: cut, reformat to 1080x1920 with blurred bg, burn TikTok-style captions
// Tools: ffmpeg, ffprobe, whisper (all local/free). Zero npm deps.
import { execFile } from 'node:child_process'
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname, basename, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
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

async function transcribe(file, workDir) {
  const srt = join(workDir, basename(file, extname(file)) + '.srt')
  if (!existsSync(srt)) {
    await run('whisper', [file, '--model', WMODEL, '--output_format', 'srt', '--output_dir', workDir], { cwd: workDir })
  }
  return parseSrt(readFileSync(srt, 'utf8'))
}

// group consecutive cues into windows of MIN..MAX seconds, breaking on long gaps
function buildWindows(cues, min = 10, max = 45) {
  const GAP = Number(process.env.CLIP_GAP || 1.2)      // a pause this long starts a new clip
  const TARGET = Number(process.env.CLIP_TARGET || 24) // aim for ~this many seconds per clip
  const wins = []
  let cur = []
  for (const c of cues) {
    if (!cur.length) { cur = [c]; continue }
    const start = cur[0].start
    const prevEnd = cur[cur.length - 1].end
    const dur = prevEnd - start
    if (c.start - prevEnd > GAP || c.end - start > max || (dur >= TARGET && dur >= min)) { wins.push(cur); cur = [c]; continue }
    cur.push(c)
  }
  if (cur.length) wins.push(cur)
  return wins
    .map((cs) => ({ start: cs[0].start, end: cs[cs.length - 1].end, cues: cs, text: cs.map((x) => x.text).join(' ') }))
    .filter((w) => w.end - w.start >= min * 0.6)
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

async function gemmaTitle(text) {
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 60000)
    const opts = { temperature: 0.7 }; if (!process.env.CLIP_GPU) opts.num_gpu = 0
    const r = await fetch(`${HOST}/api/generate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, prompt: `Write a punchy 4-8 word social caption/hook for this short clip. No quotes, no hashtags.\n\n"${text.slice(0, 400)}"`, stream: false, options: opts }),
      signal: ctrl.signal,
    }).finally(() => clearTimeout(t))
    if (!r.ok) return null
    return ((await r.json()).response || '').trim().split('\n')[0].replace(/^["']|["']$/g, '').slice(0, 80) || null
  } catch { return null }
}

function writeClipSrt(cues, winStart, path) {
  let out = ''
  cues.forEach((c, i) => {
    out += `${i + 1}\n${T(Math.max(0, c.start - winStart))} --> ${T(Math.max(0.2, c.end - winStart))}\n${c.text}\n\n`
  })
  writeFileSync(path, out)
}

async function renderClip(input, win, idx, outDir, workDir) {
  const dur = win.end - win.start
  const srtPath = join(workDir, `clip-${idx}.srt`)
  writeClipSrt(win.cues, win.start, srtPath)
  const srtArg = basename(srtPath) // run ffmpeg with cwd=workDir so the path is simple (libass-safe)
  const out = join(outDir, `clip-${idx}.mp4`)
  const vf = `[0:v]split=2[bg][fg];[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=24:4[bgb];` +
    `[fg]scale=1040:-2:force_original_aspect_ratio=decrease[fgs];[bgb][fgs]overlay=(W-w)/2:(H-h)/2[bv];` +
    `[bv]subtitles=${srtArg}:force_style='Fontname=Arial,FontSize=16,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00101010,BorderStyle=1,Outline=4,Shadow=1,Alignment=2,MarginV=60'[v]`
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

  console.error('transcribing (whisper ' + WMODEL + ')...')
  const cues = await transcribe(input, workDir)
  if (!cues.length) throw new Error('no speech transcribed')
  const windows = buildWindows(cues).map((w) => ({ ...w, score: scoreWindow(w) })).sort((a, b) => b.score - a.score)
  const chosen = windows.slice(0, n)
  console.error(`transcribed ${cues.length} cues -> ${windows.length} windows -> top ${chosen.length}`)

  const results = []
  for (let i = 0; i < chosen.length; i++) {
    const w = chosen[i]
    console.error(`  clip ${i + 1}: ${w.start.toFixed(1)}-${w.end.toFixed(1)}s (score ${w.score})`)
    const file = await renderClip(input, w, i + 1, outDir, workDir)
    const title = ai ? await gemmaTitle(w.text) : null
    results.push({ idx: i + 1, file, start: w.start, end: w.end, dur: +(w.end - w.start).toFixed(1), score: w.score, title, text: w.text })
  }
  writeFileSync(join(outDir, 'clips.json'), JSON.stringify(results, null, 2))
  try { rmSync(workDir, { recursive: true, force: true }) } catch {}
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
