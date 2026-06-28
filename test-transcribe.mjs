#!/usr/bin/env node
// test-transcribe.mjs — round-trip correctness test for the transcription stage.
// For each language: synthesize a KNOWN sentence (Gemini TTS) -> transcribe -> compare.
// Proves (a) transcription works per-language, (b) the transcript matches what was actually said,
// (c) no stale-cache contamination (fresh workdir per case + the size/mtime-keyed cache).
//   node test-transcribe.mjs            # all langs
//   node test-transcribe.mjs he es      # subset
import { execFile } from 'node:child_process'
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transcribe } from './clip.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
try { const e = join(ROOT, '.env'); if (existsSync(e)) for (const l of readFileSync(e, 'utf8').split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '') } } catch {}
const KEY = process.env.GEMINI_API_KEY
const GAPI = 'https://generativelanguage.googleapis.com/v1beta/models'
const run = (cmd, args) => new Promise((res, rej) => execFile(cmd, args, { maxBuffer: 1 << 26 }, (e, so, se) => e ? rej(new Error(se || e.message)) : res(so)))

// known ground-truth sentences (kept simple/clear so TTS reads them faithfully)
const CASES = {
  en: 'The stock market crashed seventy percent in a single year.',
  he: 'שוק המניות התרסק שבעים אחוז בתוך שנה אחת.',
  es: 'El mercado de valores se desplomó setenta por ciento en un solo año.',
  fr: 'Le marché boursier a chuté de soixante-dix pour cent en une seule année.',
  ar: 'انهارت سوق الأسهم بنسبة سبعين بالمئة في عام واحد.',
}

async function tts(text, wav, work) {
  const r = await fetch(`${GAPI}/gemini-2.5-flash-preview-tts:generateContent?key=${KEY}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: `Say clearly and slowly:\n${text}` }] }], generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Charon' } } } } }),
  })
  const j = await r.json()
  const data = j?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data
  if (!data) throw new Error('TTS failed: ' + (j?.error?.message || 'no audio'))
  writeFileSync(join(work, 'v.pcm'), Buffer.from(data, 'base64'))
  await run('ffmpeg', ['-y', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', join(work, 'v.pcm'), wav])
}

// normalize + word-recall: fraction of reference words that appear in the hypothesis
const norm = (s) => (s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim()
function recall(ref, hyp) {
  const r = norm(ref).split(' ').filter(Boolean), h = new Set(norm(hyp).split(' ').filter(Boolean))
  if (!r.length) return 0
  return r.filter((w) => h.has(w)).length / r.length
}

const langs = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(CASES)
if (!KEY) { console.error('no GEMINI_API_KEY in .env'); process.exit(1) }
console.log(`transcription round-trip test (whisper ${process.env.WHISPER_MODEL || 'base'})\n`)
let pass = 0
for (const lang of langs) {
  const text = CASES[lang]; if (!text) { console.log(`  ${lang}: no test sentence`); continue }
  const work = join(ROOT, 'clips', `_ttest_${lang}`, '_work')
  rmSync(join(ROOT, 'clips', `_ttest_${lang}`), { recursive: true, force: true }); mkdirSync(work, { recursive: true })
  try {
    const wav = join(work, 'speech.wav')
    await tts(text, wav, work)
    process.env.WHISPER_LANG = lang
    const { cues } = await transcribe(wav, work)
    const got = cues.map((c) => c.text).join(' ')
    const score = recall(text, got)
    const ok = score >= 0.6
    if (ok) pass++
    console.log(`  ${lang}  ${ok ? 'PASS' : 'WEAK'}  recall ${(score * 100).toFixed(0)}%`)
    console.log(`     said: ${text}`)
    console.log(`     got : ${got.trim()}`)
  } catch (e) { console.log(`  ${lang}  ERROR  ${e.message.slice(0, 100)}`) }
  rmSync(join(ROOT, 'clips', `_ttest_${lang}`), { recursive: true, force: true })
}
console.log(`\n${pass}/${langs.length} languages PASS (recall >= 60%)`)
