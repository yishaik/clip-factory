#!/usr/bin/env node
// music.mjs — background-music sourcing for the Studio + generate pipeline.
//   library  : royalty-free tracks dropped in music/
//   ai       : generate an instrumental bed with Replicate MusicGen (REPLICATE_API_TOKEN)
// The chosen track is mixed UNDER the voiceover with sidechain ducking by generate.mjs.
import { readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const MUSIC_DIR = join(ROOT, 'music')
const AUDIO_RE = /\.(mp3|m4a|wav|ogg|aac)$/i

// list royalty-free tracks the user has dropped in music/
export function listLibrary() {
  if (!existsSync(MUSIC_DIR)) return []
  return readdirSync(MUSIC_DIR).filter((f) => AUDIO_RE.test(f)).map((f) => join(MUSIC_DIR, f))
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Generate an instrumental background track via Replicate MusicGen. Returns the saved file path.
// prompt = music brief (genre/instruments/mood), seconds = target length (MusicGen caps ~30s; we loop later).
export async function generateMusic(prompt, seconds = 20, outPath) {
  const token = process.env.REPLICATE_API_TOKEN
  if (!token) throw new Error('REPLICATE_API_TOKEN missing — add it to .env to generate music')
  const dur = Math.min(30, Math.max(5, Math.round(seconds)))
  outPath = outPath || join(MUSIC_DIR, '_ai_track.mp3')
  mkdirSync(dirname(outPath), { recursive: true })
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  // official model endpoint (no version hash needed); Prefer: wait returns synchronously when it can
  const r = await fetch('https://api.replicate.com/v1/models/meta/musicgen/predictions', {
    method: 'POST', headers: { ...headers, prefer: 'wait' },
    body: JSON.stringify({ input: { prompt: `${prompt}. instrumental, no vocals, seamless loop`, duration: dur, model_version: 'stereo-large', output_format: 'mp3', normalization_strategy: 'loudness' } }),
  })
  let pred = await r.json()
  if (pred.error) throw new Error('replicate: ' + JSON.stringify(pred.error))
  for (let i = 0; pred.status && !['succeeded', 'failed', 'canceled'].includes(pred.status) && i < 120; i++) {
    await sleep(2000)
    pred = await (await fetch(pred.urls.get, { headers })).json()
  }
  if (pred.status !== 'succeeded') throw new Error('music generation ' + (pred.status || 'no-status') + ': ' + (JSON.stringify(pred.error) || ''))
  const url = Array.isArray(pred.output) ? pred.output[0] : pred.output
  if (!url) throw new Error('replicate returned no audio')
  writeFileSync(outPath, Buffer.from(await (await fetch(url)).arrayBuffer()))
  return outPath
}

// Resolve a track for a run given the mode. mode: 'none' | 'library' | 'ai' | '<explicit path>'.
// aiPrompt/seconds used when mode==='ai'. Returns a file path or '' (no music).
export async function resolveMusic({ mode = 'none', aiPrompt = '', seconds = 20, outPath } = {}) {
  if (!mode || mode === 'none') return ''
  if (mode === 'library') { const lib = listLibrary(); return lib.length ? lib[0] : '' }
  if (mode === 'ai') return await generateMusic(aiPrompt || 'soft cinematic ambient background, warm and subtle', seconds, outPath)
  return existsSync(mode) ? mode : '' // explicit path
}

// CLI: node music.mjs "prompt" [seconds]  -> generate a track to music/_ai_track.mp3
const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/music.mjs')
if (isMain) {
  try { const env = join(ROOT, '.env'); if (existsSync(env)) for (const l of (await import('node:fs')).readFileSync(env, 'utf8').split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '') } } catch {}
  const prompt = process.argv[2] || 'soft cinematic ambient, warm piano and strings, slow, hopeful'
  const secs = Number(process.argv[3] || 15)
  console.error(`generating music: "${prompt}" (${secs}s)...`)
  const out = await generateMusic(prompt, secs)
  console.log(out)
  console.error('✅ ' + out)
}
