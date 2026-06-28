#!/usr/bin/env node
// generate.mjs — build an ORIGINAL vertical short from scratch on a fresh hot topic.
//  1) Google Trends hot topic  2) Gemini 3.1 Pro: pick topic + script + hook + per-scene image prompts
//  3) Gemini neural TTS voiceover  4) Imagen 9:16 visuals (Ken-Burns slideshow)
//  5) Whisper word timestamps -> karaoke captions  6) ffmpeg -> 1080x1920 mp4
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transcribe } from './clip.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
try {
  const envf = join(ROOT, '.env')
  if (existsSync(envf)) for (const l of readFileSync(envf, 'utf8').split(/\r?\n/)) {
    const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
} catch {}
const KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
const OUT = join(ROOT, 'generated')
const GAPI = 'https://generativelanguage.googleapis.com/v1beta/models'
const run = (cmd, args, opts = {}) => new Promise((res, rej) => execFile(cmd, args, { maxBuffer: 1 << 27, ...opts }, (e, so, se) => e ? rej(new Error((e.message || '') + '\n' + se)) : res(so + '\n' + se)))
const probeDur = async (f) => parseFloat((await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', f])).trim()) || 0

async function hotTopics() {
  try {
    const xml = await (await fetch('https://trends.google.com/trending/rss?geo=US')).text()
    return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1].match(/<title>([^<]+)/)?.[1]).filter(Boolean).slice(0, 18)
  } catch { return [] }
}

async function gemini(prompt, { json = false, model = process.env.GEN_MODEL || 'gemini-3.1-pro-preview' } = {}) {
  const gc = { temperature: 0.85, maxOutputTokens: 4096 }; if (json) gc.responseMimeType = 'application/json'
  const r = await fetch(`${GAPI}/${model}:generateContent?key=${KEY}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: gc }) })
  const j = await r.json()
  return (j.candidates && j.candidates[0]?.content?.parts?.[0]?.text || '').trim()
}

const RECENTF = join(ROOT, '.gen-recent.json')
const recentTopics = () => { try { return JSON.parse(readFileSync(RECENTF, 'utf8')) } catch { return [] } }
const rememberTopic = (t) => { const r = recentTopics(); r.push(t); writeFileSync(RECENTF, JSON.stringify(r.slice(-12))) }

const LANGS = { en: 'English', he: 'Hebrew', es: 'Spanish', ar: 'Arabic', fr: 'French' }
async function script(topics) {
  const custom = (process.env.GEN_TOPIC || '').trim()
  const lang = LANGS[process.env.GEN_LANG || 'en'] || 'English'
  const avoid = recentTopics()
  const prompt = `You are a top short-form video writer. ${custom ? `Make a 35-45s vertical video about: "${custom}".` : topics.length ? `From these LIVE trending topics pick the ONE with the best story for a 35-45s vertical video (intriguing, broad appeal, a real narrative — avoid bare names / sports scores).\nTrending: ${topics.join(', ')}` : 'Pick a fascinating, currently-relevant topic.'}${!custom && avoid.length ? `\nDo NOT pick any of these recently-used topics (choose something different): ${avoid.join(', ')}` : ''}
Write "topic", "hook" and "script" in ${lang}. Keep the "scenes" image prompts in ENGLISH (for the image model).
Return ONLY JSON:
{"topic":"...","hook":"<4-7 word punchy on-screen title, in ${lang}>","script":"<narration in ${lang}: 6-9 short punchy sentences, ~110-150 words, conversational, killer first line, ends thought-provoking. No emojis/hashtags/stage-directions>","scenes":["<English image prompt 1>","<English image prompt 2>","...5-6 cinematic photo prompts that visually follow the script beat by beat; each a vivid, specific, photorealistic vertical scene (no text, no logos)"]}`
  return JSON.parse((await gemini(prompt, { json: true })).match(/\{[\s\S]*\}/)[0])
}

async function tts(text, wav, work) {
  const r = await fetch(`${GAPI}/gemini-2.5-flash-preview-tts:generateContent?key=${KEY}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: `Read this as an engaging, natural storyteller — clear, warm, well-paced:\n${text}` }] }], generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: process.env.GEN_VOICE || 'Charon' } } } } }),
  })
  const j = await r.json()
  const data = j?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data
  if (!data) throw new Error('TTS failed: ' + (j?.error?.message || 'no audio'))
  const pcm = join(work, 'voice.pcm'); writeFileSync(pcm, Buffer.from(data, 'base64'))
  await run('ffmpeg', ['-y', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', pcm, wav])
}

async function image(prompt, png) {
  const r = await fetch(`${GAPI}/imagen-4.0-fast-generate-001:predict?key=${KEY}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instances: [{ prompt: prompt + ', cinematic, photorealistic, dramatic lighting, vertical' }], parameters: { sampleCount: 1, aspectRatio: '9:16' } }),
  })
  const j = await r.json()
  const data = j?.predictions?.[0]?.bytesBase64Encoded
  if (!data) return false
  writeFileSync(png, Buffer.from(data, 'base64')); return true
}

// lower-third karaoke captions (over imagery) + a hook title card up top
function genAss(words, dur, hook) {
  const aT = (s) => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = (s % 60); return `${h}:${String(m).padStart(2, '0')}:${x.toFixed(2).padStart(5, '0')}` }
  const esc = (t) => String(t).replace(/[{}\\]/g, '').replace(/\n/g, ' ')
  const W = words.map((w) => ({ start: w.start, end: Math.max(w.start + 0.1, w.end), text: esc(w.text) }))
  const lines = []; let cur = []
  for (const w of W) { cur.push(w); const d = w.end - cur[0].start; if (cur.length >= 3 || d >= 1.3 || /[.!?]$/.test(w.text)) { lines.push(cur); cur = [] } }
  if (cur.length) lines.push(cur)
  let ev = hook ? `Dialogue: 0,0:00:00.00,${aT(Math.min(3.2, dur))},Hook,,0,0,0,,${esc(hook)}\n` : ''
  for (const ln of lines) {
    const start = ln[0].start, end = ln[ln.length - 1].end; let text = ''
    ln.forEach((w, i) => { const next = i < ln.length - 1 ? ln[i + 1].start : end; text += `{\\kf${Math.max(1, Math.round((next - w.start) * 100))}}${w.text} ` })
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
Style: Cap,Arial,74,&H0000FFFF,&H00FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,6,3,2,90,90,360,1
Style: Hook,Arial,62,&H00FFFFFF,&H00FFFFFF,&H00101010,&HB0000000,1,0,0,0,100,100,0,0,3,5,1,8,70,70,170,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${ev}`
}

async function main() {
  if (!KEY) throw new Error('GEMINI_API_KEY missing')
  mkdirSync(OUT, { recursive: true }); const work = join(OUT, '_work'); mkdirSync(work, { recursive: true })
  console.error('hot topics...'); const topics = await hotTopics(); console.error('trending: ' + topics.slice(0, 8).join(' · '))
  console.error('script (Gemini 3.1 Pro)...'); const s = await script(topics); rememberTopic(s.topic)
  console.error(`TOPIC: ${s.topic}\nHOOK: ${s.hook}\nSCENES: ${(s.scenes || []).length}\n`)

  const wav = join(work, 'voice.wav')
  console.error('neural voiceover (Gemini TTS)...'); await tts(s.script, wav, work)
  const dur = await probeDur(wav); console.error(`voice ${dur.toFixed(1)}s`)

  if (process.env.GEN_LANG && process.env.GEN_LANG !== 'en') process.env.WHISPER_LANG = process.env.GEN_LANG
  console.error('captions (Whisper)...'); const { words } = await transcribe(wav, work)
  const assPath = join(work, 'gen.ass'); writeFileSync(assPath, genAss(words, dur, s.hook))

  console.error('generating visuals (Imagen)...')
  const scenes = (s.scenes && s.scenes.length ? s.scenes : [s.topic]).slice(0, 6)
  const imgs = []
  for (let i = 0; i < scenes.length; i++) { const png = join(work, `img${i}.png`); if (await image(scenes[i], png)) { imgs.push(png); console.error(`  img ${i + 1}/${scenes.length} ok`) } }
  if (!imgs.length) throw new Error('no images generated')

  console.error('Ken-Burns slideshow...')
  const T = dur / imgs.length, FPS = 30, segs = []
  for (let i = 0; i < imgs.length; i++) {
    const seg = join(work, `seg${i}.mp4`); segs.push(seg)
    // -framerate on the looped input gives T*FPS input frames; zoompan d=1 => one zoom step per frame (no blow-up)
    const zexpr = `zoompan=z='min(zoom+0.0009,1.12)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1080x1920:fps=${FPS}`
    await run('ffmpeg', ['-y', '-loop', '1', '-framerate', String(FPS), '-t', T.toFixed(2), '-i', imgs[i],
      '-vf', `scale=1188:2112:force_original_aspect_ratio=increase,crop=1188:2112,${zexpr},format=yuv420p`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', seg])
  }
  const listF = join(work, 'list.txt'); writeFileSync(listF, segs.map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n'))
  const slideshow = join(work, 'slideshow.mp4')
  await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listF, '-c', 'copy', slideshow])

  console.error('final render...')
  const slug = (s.topic || 'short').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'short'
  const out = join(OUT, slug + '.mp4')
  await run('ffmpeg', ['-y', '-i', slideshow, '-i', wav,
    '-filter_complex', `[0:v]drawbox=x=0:y=1230:w=1080:h=690:color=black@0.32:t=fill,ass=gen.ass[v]`,
    '-map', '[v]', '-map', '1:a', '-t', String(dur), '-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', out], { cwd: work })
  writeFileSync(join(OUT, slug + '.json'), JSON.stringify({ ...s, dur, file: out }, null, 2))
  console.error(`\n✅ ${out}\n   topic: ${s.topic}\n   hook: ${s.hook}\n   ${imgs.length} visuals · ${dur.toFixed(0)}s`)
  console.log(JSON.stringify({ outDir: OUT, topic: s.topic, script: s.script, clips: [{ file: out, hook: s.hook, dur: +dur.toFixed(0) }] }))
}
main().catch((e) => { console.error('ERR ' + e.message); process.exit(1) })
