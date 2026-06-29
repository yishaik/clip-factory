#!/usr/bin/env node
// generate.mjs — build an ORIGINAL vertical short from scratch on a fresh hot topic.
//  1) Google Trends hot topic  2) Gemini 3.1 Pro: pick topic + script + hook + per-scene image prompts
//  3) Gemini neural TTS voiceover  4) Imagen 9:16 visuals (Ken-Burns slideshow)
//  5) Whisper word timestamps -> karaoke captions  6) ffmpeg -> 1080x1920 mp4
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transcribe, emitCaptionLines } from './clip.mjs'
import { resolveMusic, listLibrary } from './music.mjs'

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
  const secs = Math.max(15, Math.min(60, Number(process.env.GEN_SECONDS || 30)))   // target length
  const words = Math.round(secs * 2.4)                                              // ~conversational TTS rate
  const sents = Math.max(4, Math.round(words / 15))                                 // short punchy sentences
  const nScenes = Math.max(4, Math.min(6, Math.round(secs / 6)))
  const prompt = `You are a top short-form video writer. ${custom ? `Make a ~${secs}s vertical video about: "${custom}".` : topics.length ? `From these LIVE trending topics pick the ONE with the best story for a ~${secs}s vertical video (intriguing, broad appeal, a real narrative — avoid bare names / sports scores).\nTrending: ${topics.join(', ')}` : 'Pick a fascinating, currently-relevant topic.'}${!custom && avoid.length ? `\nDo NOT pick any of these recently-used topics (choose something different): ${avoid.join(', ')}` : ''}
Write "topic", "hook" and "script" in ${lang}. Keep "style" and the "scenes" image prompts in ENGLISH (for the image model).
LENGTH IS CRITICAL: the script must be ~${words} words (HARD ceiling ${words + 12}) — it will be read aloud and must land near ${secs}s. Be ruthless: a killer first line, then ${sents}-${sents + 1} SHORT punchy sentences, cut every filler word, no throat-clearing, end on a thought-provoking line. Tight beats > completeness.
Return ONLY JSON:
{"topic":"...","hook":"<4-7 word punchy on-screen title, in ${lang}>","script":"<narration in ${lang}, ~${words} words, conversational, fast-paced. No emojis/hashtags/stage-directions>","style":"<ONE art-direction line applied to EVERY scene for a cohesive look: a specific palette + lighting + film/lens look, e.g. 'moody teal-and-amber, low-key dramatic lighting, shallow depth of field, 35mm film grain, cinematic'>","music":"<short instrumental background-music brief matching the mood: genre + instruments + tempo, e.g. 'soft cinematic ambient, warm piano and strings, slow, hopeful' — no vocals>","scenes":["<English image prompt 1>","...${nScenes} photo prompts that follow the script beat by beat. Each: a vivid, specific subject AND an explicit shot type — VARY them across scenes (wide establishing, medium, tight close-up, detail/insert, low-angle) for visual rhythm. Describe ONLY subject+composition (the shared 'style' supplies palette/lighting). CRITICAL: every scene must be visually COMPATIBLE with the chosen style — same mood, time-of-day and palette feasibility; do NOT pick subjects that fight it (e.g. if the style is dark/low-key, avoid bright daylight or snow-white scenes — choose subjects that can plausibly carry that palette). photorealistic, vertical 9:16, no text, no logos."]}`
  const out = JSON.parse((await gemini(prompt, { json: true })).match(/\{[\s\S]*\}/)[0])
  out._maxWords = words + 12
  return out
}

// hard length guard: if the model overshot, keep whole sentences up to the word budget (preserves a clean end)
function fitWords(text, maxWords) {
  const sents = String(text).match(/[^.!?]+[.!?]+/g) || [String(text)]
  const kept = []; let n = 0
  for (const s of sents) { const w = s.trim().split(/\s+/).filter(Boolean).length; if (n + w > maxWords && kept.length) break; kept.push(s.trim()); n += w }
  return kept.join(' ')
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

async function image(prompt, png, style = '') {
  const look = style || 'cinematic, photorealistic, dramatic lighting' // shared art-direction -> cohesive look across scenes
  const imgModel = process.env.GEN_IMAGE_MODEL || 'imagen-4.0-generate-001'        // standard (sharper) over -fast
  // style FIRST so the image model weights the shared palette/lighting highly (keeps scenes cohesive)
  const r = await fetch(`${GAPI}/${imgModel}:predict?key=${KEY}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instances: [{ prompt: `${look}. ${prompt}. Vertical 9:16, no text, no watermark` }], parameters: { sampleCount: 1, aspectRatio: '9:16' } }),
  })
  const j = await r.json()
  const data = j?.predictions?.[0]?.bytesBase64Encoded
  if (!data) return false
  writeFileSync(png, Buffer.from(data, 'base64')); return true
}

// distribute the KNOWN-correct words across Whisper's timing (Whisper is only a timing reference — its
// transcribed TEXT is unreliable, esp. in Hebrew). Maps true word i to the proportional Whisper word,
// keeping times monotonic, so captions show exactly what was said with roughly-synced highlighting.
export function alignToTiming(trueWords, wWords) {
  if (!wWords.length) return trueWords.map((t, i) => ({ start: i * 0.4, end: i * 0.4 + 0.38, text: t }))
  const m = wWords.length, n = trueWords.length; let last = 0
  return trueWords.map((text, i) => {
    const w = wWords[Math.min(m - 1, Math.floor((i + 0.5) * m / n))]
    const start = Math.max(last, w.start), end = Math.max(start + 0.18, w.end)
    last = end
    return { start, end, text }
  })
}

// lower-third karaoke captions (over imagery) + a hook title card up top. rtl => Hebrew/Arabic handling.
export function genAss(words, dur, hook, rtl = false) {
  const aT = (s) => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = (s % 60); return `${h}:${String(m).padStart(2, '0')}:${x.toFixed(2).padStart(5, '0')}` }
  const esc = (t) => String(t).replace(/[{}\\]/g, '').replace(/\n/g, ' ')
  const RLM = '‏'                                  // force RTL base direction
  const W = words.map((w) => ({ start: w.start, end: Math.max(w.start + 0.1, w.end), text: esc(w.text) }))
  const lines = []; let cur = []
  for (const w of W) { cur.push(w); const d = w.end - cur[0].start; if (cur.length >= 3 || d >= 1.3 || /[.!?]$/.test(w.text)) { lines.push(cur); cur = [] } }
  if (cur.length) lines.push(cur)
  let ev = hook ? `Dialogue: 0,0:00:00.00,${aT(Math.min(3.2, dur))},Hook,,0,0,0,,${rtl ? RLM : ''}${esc(hook)}\n` : ''
  ev += emitCaptionLines(lines, rtl, 84, 1580) // Cap fontsize 84, lower-third baseline
  return `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,Arial Black,84,&H0000FFFF,&H00FFFFFF,&H00101010,&H00000000,1,0,0,0,100,100,0,0,1,7,4,2,80,80,360,1
Style: Hook,Arial Black,64,&H00FFFFFF,&H00FFFFFF,&H00101010,&HC0000000,1,0,0,0,100,100,0,0,3,6,2,8,70,70,180,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${ev}`
}

async function main() {
  if (!KEY) throw new Error('GEMINI_API_KEY missing')
  mkdirSync(OUT, { recursive: true }); const work = join(OUT, '_work'); mkdirSync(work, { recursive: true })
  console.error('hot topics...'); const topics = await hotTopics(); console.error('trending: ' + topics.slice(0, 8).join(' · '))
  console.error('script (Gemini 3.1 Pro)...'); const s = await script(topics); rememberTopic(s.topic)
  const rawWords = s.script.split(/\s+/).filter(Boolean).length
  s.script = fitWords(s.script, s._maxWords)                 // enforce the length ceiling
  const finalWords = s.script.split(/\s+/).filter(Boolean).length
  console.error(`TOPIC: ${s.topic}\nHOOK: ${s.hook}\nSCENES: ${(s.scenes || []).length} · words: ${rawWords}->${finalWords} (cap ${s._maxWords})\n`)

  const wav = join(work, 'voice.wav')
  console.error('neural voiceover (Gemini TTS)...'); await tts(s.script, wav, work)
  const dur = await probeDur(wav); console.error(`voice ${dur.toFixed(1)}s`)

  const lang = process.env.GEN_LANG || 'en', rtl = lang === 'he' || lang === 'ar'
  if (lang !== 'en') process.env.WHISPER_LANG = lang
  try { rmSync(join(work, 'voice.json'), { force: true }); rmSync(join(work, 'transcript.json'), { force: true }) } catch {} // never reuse a previous run's transcript
  // Whisper gives the TIMING; the caption TEXT comes from the known script (Whisper mis-hears Hebrew badly)
  console.error('captions (Whisper timing + true script text)...'); const { words } = await transcribe(wav, work)
  const capWords = alignToTiming(s.script.trim().split(/\s+/).filter(Boolean), words)
  const assPath = join(work, 'gen.ass'); writeFileSync(assPath, genAss(capWords, dur, s.hook, rtl))

  console.error(`generating visuals (Imagen)...  style: ${s.style || '(default)'}`)
  const scenes = (s.scenes && s.scenes.length ? s.scenes : [s.topic]).slice(0, 6)
  const imgs = []
  for (let i = 0; i < scenes.length; i++) { const png = join(work, `img${i}.png`); if (await image(scenes[i], png, s.style)) { imgs.push(png); console.error(`  img ${i + 1}/${scenes.length} ok`) } }
  if (!imgs.length) throw new Error('no images generated')

  console.error('Ken-Burns slideshow (varied motion + crossfades)...')
  const FPS = 30, N = imgs.length
  const XF = Math.min(Number(process.env.GEN_XFADE || 0.6), 1.2) // crossfade seconds between scenes
  // each segment is longer by the overlap so the crossfaded total still equals the voiceover length
  const segDur = (dur + (N - 1) * XF) / N
  const frames = Math.max(1, Math.round(segDur * FPS))
  // cycle distinct camera moves so consecutive scenes don't feel static/identical (z over a 1.25x oversample)
  const moves = [
    `zoompan=z='min(zoom+0.0011,1.18)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`,         // push in, centre
    `zoompan=z='1.14':x='(iw-iw/zoom)*on/${frames}':y='ih/2-(ih/zoom/2)'`,                   // pan right
    `zoompan=z='1.14':x='(iw-iw/zoom)*(1-on/${frames})':y='ih/2-(ih/zoom/2)'`,               // pan left
    `zoompan=z='min(zoom+0.0011,1.18)':x='iw/2-(iw/zoom/2)':y='(ih-ih/zoom)*on/${frames}'`,  // push in + tilt down
    `zoompan=z='1.14':x='iw/2-(iw/zoom/2)':y='(ih-ih/zoom)*(1-on/${frames})'`,               // tilt up
  ]
  const segs = []
  for (let i = 0; i < N; i++) {
    const seg = join(work, `seg${i}.mp4`); segs.push(seg)
    const kb = `${moves[i % moves.length]}:d=1:s=1080x1920:fps=${FPS}`
    await run('ffmpeg', ['-y', '-loop', '1', '-framerate', String(FPS), '-t', segDur.toFixed(2), '-i', imgs[i],
      '-vf', `scale=1350:2400:force_original_aspect_ratio=increase,crop=1350:2400,${kb},format=yuv420p`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', seg])
  }

  // optional background music (ducked under the voice). GEN_MUSIC=explicit path wins; else GEN_MUSIC_MODE:
  //   none | library (a track from music/) | ai (Replicate MusicGen, prompt = GEN_MUSIC_PROMPT or the LLM's mood)
  const TRANS = ['fade', 'smoothleft', 'smoothright', 'slideup', 'circleopen', 'fadeblack']
  let music = process.env.GEN_MUSIC || ''
  if (!music) {
    const mode = process.env.GEN_MUSIC_MODE || (listLibrary().length ? 'library' : 'none')
    if (mode !== 'none') {
      const aiPrompt = process.env.GEN_MUSIC_PROMPT || s.music || ''
      if (mode === 'ai') console.error(`AI music (Replicate MusicGen): "${aiPrompt}"...`)
      try { music = await resolveMusic({ mode, aiPrompt, seconds: Math.min(30, Math.round(dur)), outPath: join(work, 'ai_music.mp3') }) }
      catch (e) { console.error('  music skipped: ' + e.message) }
    }
  }
  console.error('final render (crossfades + captions' + (music ? ' + music' : '') + ')...')

  const inputs = []; segs.forEach((sg) => inputs.push('-i', sg)); inputs.push('-i', wav)
  const voiceIdx = N; let musIdx = -1
  if (music) { inputs.push('-i', music); musIdx = N + 1 }
  // video: chain crossfades between consecutive segments, then hook backdrop + captions
  const parts = []; let prev = '[0:v]'
  for (let i = 1; i < N; i++) {
    const off = (i * (segDur - XF)).toFixed(3), lbl = `[x${i}]`
    parts.push(`${prev}[${i}:v]xfade=transition=${TRANS[(i - 1) % TRANS.length]}:duration=${XF}:offset=${off}${lbl}`)
    prev = lbl
  }
  parts.push(`${prev}ass=gen.ass[v]`) // strong outline+shadow on the captions replaces the old flat backdrop band
  // audio: voice alone, or voice + music ducked when the voice is speaking
  let aMap = `${voiceIdx}:a`
  if (musIdx >= 0) {
    const vol = Number(process.env.GEN_MUSIC_VOL || 0.20)
    parts.push(`[${musIdx}:a]aloop=loop=-1:size=2000000000,volume=${vol}[mus]`)
    parts.push(`[mus][${voiceIdx}:a]sidechaincompress=threshold=0.05:ratio=6:attack=5:release=350[duck]`)
    parts.push(`[${voiceIdx}:a][duck]amix=inputs=2:duration=first:normalize=0[a]`)
    aMap = '[a]'
  }
  const slug = (s.topic || 'short').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'short'
  const out = join(OUT, slug + '.mp4')
  await run('ffmpeg', ['-y', ...inputs, '-filter_complex', parts.join(';'),
    '-map', '[v]', '-map', aMap, '-t', String(dur), '-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', out], { cwd: work })
  if (music) console.error(`  music: ${music.replace(ROOT, '.')}`)
  writeFileSync(join(OUT, slug + '.json'), JSON.stringify({ ...s, dur, file: out }, null, 2))
  console.error(`\n✅ ${out}\n   topic: ${s.topic}\n   hook: ${s.hook}\n   ${imgs.length} visuals · ${dur.toFixed(0)}s`)
  console.log(JSON.stringify({ outDir: OUT, topic: s.topic, script: s.script, clips: [{ file: out, hook: s.hook, dur: +dur.toFixed(0) }] }))
}
const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/generate.mjs')
if (isMain) main().catch((e) => { console.error('ERR ' + e.message); process.exit(1) })
