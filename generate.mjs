#!/usr/bin/env node
// generate.mjs — build an ORIGINAL vertical short from scratch on a fresh hot topic.
//   1) pull live trending topics (Google Trends RSS, free)
//   2) the strongest model (Gemini 3.1 Pro) picks the best one + writes a punchy script + hook
//   3) TTS voiceover (Windows SAPI) -> 4) Whisper word timestamps -> karaoke captions (reused from clip.mjs)
//   5) ffmpeg: animated gradient bg + voice + burned captions -> vertical 1080x1920 mp4
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transcribe, buildAss } from './clip.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
try { // .env loader for GEMINI_API_KEY
  const envf = join(ROOT, '.env')
  if (existsSync(envf)) for (const l of readFileSync(envf, 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
} catch {}
const OUT = join(ROOT, 'generated')
const run = (cmd, args, opts = {}) => new Promise((res, rej) => execFile(cmd, args, { maxBuffer: 1 << 26, ...opts }, (e, so, se) => e ? rej(new Error((e.message || '') + '\n' + se)) : res(so + '\n' + se)))

async function hotTopics() {
  try {
    const xml = await (await fetch('https://trends.google.com/trending/rss?geo=US')).text()
    const t = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1].match(/<title>([^<]+)/)?.[1]).filter(Boolean)
    return t.slice(0, 18)
  } catch { return [] }
}

async function gemini(prompt, { json = false } = {}) {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
  const model = process.env.GEN_MODEL || 'gemini-3.1-pro-preview'
  const gc = { temperature: 0.8, maxOutputTokens: 4096 }; if (json) gc.responseMimeType = 'application/json'
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: gc }),
  })
  const j = await r.json()
  return (j.candidates && j.candidates[0]?.content?.parts?.[0]?.text || '').trim()
}

async function makeScript(topics) {
  const prompt = `You are a top short-form video writer (TikTok/Reels/Shorts). ${topics.length ? `From these LIVE trending topics, pick the ONE with the best story for a 35-45s vertical video — intriguing, broad appeal, a real narrative. Avoid bare names, sports scores, or anything you can't make a compelling story from.\nTrending: ${topics.join(', ')}` : 'Pick a genuinely fascinating, currently-relevant topic for a 35-45s vertical video.'}
Write it. Return ONLY JSON:
{"topic":"<the chosen topic>","hook":"<4-7 word on-screen title, punchy>","script":"<narration: 6-9 short punchy sentences, ~110-150 words, conversational, killer first line that creates curiosity, builds, ends on a thought-provoking line. No emojis, no hashtags, no stage directions.>"}`
  const raw = await gemini(prompt, { json: true })
  return JSON.parse(raw.match(/\{[\s\S]*\}/)[0])
}

async function tts(text, wav, workDir) {
  const txt = join(workDir, 'script.txt'); writeFileSync(txt, text)
  const ps = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile('${wav.replace(/\\/g, '\\\\')}'); $s.Rate = 0; $t = Get-Content -Raw '${txt.replace(/\\/g, '\\\\')}'; $s.Speak($t); $s.Dispose()`
  await run('powershell', ['-NoProfile', '-Command', ps])
}

const probeDur = async (f) => parseFloat((await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', f])).trim()) || 0

// captions for a text-only generated short: BIG, centred karaoke + a bold hook title card up top
function genAss(words, dur, hook) {
  const aT = (s) => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = (s % 60); return `${h}:${String(m).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}` }
  const esc = (t) => String(t).replace(/[{}\\]/g, '').replace(/\n/g, ' ')
  const W = words.map((w) => ({ start: w.start, end: Math.max(w.start + 0.1, w.end), text: esc(w.text) }))
  const lines = []; let cur = []
  for (const w of W) { cur.push(w); const d = w.end - cur[0].start; if (cur.length >= 3 || d >= 1.3 || /[.!?]$/.test(w.text)) { lines.push(cur); cur = [] } }
  if (cur.length) lines.push(cur)
  let ev = ''
  if (hook) ev += `Dialogue: 0,0:00:00.00,${aT(Math.min(3.5, dur))},Hook,,0,0,0,,${esc(hook)}\n`
  for (const ln of lines) {
    const start = ln[0].start, end = ln[ln.length - 1].end
    let text = ''
    ln.forEach((w, i) => { const next = i < ln.length - 1 ? ln[i + 1].start : end; const cs = Math.max(1, Math.round((next - w.start) * 100)); text += `{\\kf${cs}}${w.text} ` })
    ev += `Dialogue: 0,${aT(start)},${aT(end)},Cap,,0,0,0,,${text.trim()}\n`
  }
  return `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,Arial,92,&H0000FFFF,&H00FFFFFF,&H00101010,&H00000000,1,0,0,0,100,100,0,0,1,6,3,5,80,80,0,1
Style: Hook,Arial,64,&H00FFFFFF,&H00FFFFFF,&H00101010,&HC02018FF,1,0,0,0,100,100,0,0,3,5,1,8,70,70,200,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${ev}`
}

async function main() {
  mkdirSync(OUT, { recursive: true }); const work = join(OUT, '_work'); mkdirSync(work, { recursive: true })
  console.error('finding hot topics...'); const topics = await hotTopics()
  console.error(topics.length ? `trending: ${topics.slice(0, 8).join(' · ')}` : '(trends unavailable, model will choose)')
  console.error('writing script (Gemini 3.1 Pro)...'); const { topic, hook, script } = await makeScript(topics)
  console.error(`TOPIC: ${topic}\nHOOK: ${hook}\nSCRIPT: ${script}\n`)

  const wav = join(work, 'narration.wav')
  console.error('voiceover (TTS)...'); await tts(script, wav, work)
  const dur = await probeDur(wav); console.error(`narration ${dur.toFixed(1)}s`)

  console.error('captions (Whisper word timestamps)...'); const { words } = await transcribe(wav, work)
  const assPath = join(work, 'gen.ass'); writeFileSync(assPath, genAss(words, dur, hook))

  console.error('rendering vertical video...')
  const slug = (topic || 'short').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'short'
  const out = join(OUT, slug + '.mp4')
  // animated dark gradient background + voice + burned karaoke captions
  const bg = `gradients=s=1080x1920:c0=0x1b1140:c1=0x090913:x0=0:y0=0:x1=1080:y1=1920:d=${Math.ceil(dur) + 1}:speed=0.012,format=yuv420p`
  // run with cwd=work so ass=gen.ass is a simple relative path (libass-safe on Windows)
  await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', bg, '-i', wav,
    '-filter_complex', `[0:v]ass=gen.ass[v]`,
    '-map', '[v]', '-map', '1:a', '-t', String(dur), '-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', out], { cwd: work })
  writeFileSync(join(OUT, slug + '.json'), JSON.stringify({ topic, hook, script, dur, file: out }, null, 2))
  console.log(`\n✅ ${out}\n   topic: ${topic}\n   hook: ${hook}`)
}
main().catch((e) => { console.error('ERR ' + e.message); process.exit(1) })
