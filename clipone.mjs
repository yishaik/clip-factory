#!/usr/bin/env node
// clipone.mjs <youtube-url|file> [n]  — download one source (or use a local file) and clip it.
// Env: CLIP_FRAME (smart|fill|blur), PIPE_HEAD (minutes, default 10). Used by the Studio UI.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeClips } from './clip.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
const DL = join(ROOT, 'downloads')
const HEAD = Number(process.env.PIPE_HEAD || 10)
const run = (cmd, args, opts = {}) => new Promise((res) => execFile(cmd, args, { maxBuffer: 1 << 27, ...opts }, (e, so, se) => res({ e, out: (so || '') + (se || '') })))
const probe = async (f) => parseFloat(((await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', f])).out || '').trim()) || 0

async function download(url) {
  mkdirSync(DL, { recursive: true })
  const id = (url.match(/[?&]v=([\w-]{6,})/) || url.match(/youtu\.be\/([\w-]{6,})/) || url.match(/shorts\/([\w-]{6,})/) || [, 'src' + Math.abs([...url].reduce((a, c) => a * 31 + c.charCodeAt(0) | 0, 7)).toString(36)])[1]
  const out = join(DL, id + '.mp4')
  if (existsSync(out)) return out
  const { out: log } = await run('python', ['-m', 'yt_dlp', '--extractor-args', 'youtube:player_client=android_vr,web_safari',
    '-f', 'bv*[height<=720][ext=mp4]+140/bv*[height<=720]+ba/b[height<=720][ext=mp4]/18/best', '--merge-output-format', 'mp4',
    '-o', join(DL, id + '.%(ext)s'), '--no-playlist', '--max-filesize', '600M', url])
  if (!existsSync(out)) throw new Error('download failed: ' + (log.match(/ERROR:[^\n]*/) || ['blocked'])[0].slice(0, 100))
  return out
}

async function trimHead(file) {
  if (!HEAD) return file
  const dur = await probe(file)
  if (!(dur > HEAD * 60 + 5)) return file
  const t = file.replace(/\.mp4$/, '.head.mp4')
  await run('ffmpeg', ['-y', '-i', file, '-t', String(HEAD * 60), '-c', 'copy', t])
  return existsSync(t) ? t : file
}

const src = process.argv[2]
const n = Number(process.argv[3] || 3)
if (!src) { console.error('usage: node clipone.mjs <url|file> [n]'); process.exit(1) }
console.error('[1/2] getting source...')
const file = /^https?:/.test(src) ? await download(src) : src
if (!existsSync(file)) { console.error('not found: ' + file); process.exit(1) }
console.error('[2/2] clipping...')
const { outDir, clips } = await makeClips(await trimHead(file), { n })
console.log(JSON.stringify({ outDir, clips: clips.map((c) => ({ file: c.file, hook: c.hook, viral: c.viralScore, dur: c.dur })) }))
