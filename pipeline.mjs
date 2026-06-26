#!/usr/bin/env node
// pipeline.mjs — the full Clip Factory loop: SOURCE -> DOWNLOAD -> CLIP.
//   1) discover fresh, clip-worthy long videos from sources.json (free RSS)
//   2) download the top candidates (yt-dlp, best-effort)
//   3) run the clip engine on each -> vertical captioned clips
// Writes a ranked queue.json regardless, so the list is usable even if a download is blocked.
import { execFile } from 'node:child_process'
import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discover, markSeen } from './source.mjs'
import { makeClips } from './clip.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
const DL = join(ROOT, 'downloads')
const N = Number(process.env.PIPE_VIDEOS || 3)       // how many source videos to process
const PER = Number(process.env.PIPE_CLIPS || 5)      // clips per video
const MAXMIN = Number(process.env.PIPE_MAXMIN || 40) // skip videos longer than this

const run = (cmd, args) => new Promise((res) => execFile(cmd, args, { maxBuffer: 1 << 26 }, (e, so, se) => res({ e, out: (so || '') + (se || '') })))

// best-effort download of a video URL via yt-dlp. Returns a file path or null (blocked).
async function tryDownload(url, id) {
  mkdirSync(DL, { recursive: true })
  const out = join(DL, id + '.%(ext)s')
  const args = ['-m', 'yt_dlp', '-f', 'mp4[height<=720]/best[height<=720]/best', '-o', out,
    '--no-playlist', '--max-filesize', '300M', '--match-filter', `duration < ${MAXMIN * 60}`, url]
  // try with browser cookies if available (helps bypass bot checks)
  if (process.env.PIPE_COOKIES) args.splice(2, 0, '--cookies-from-browser', process.env.PIPE_COOKIES)
  const { e, out: log } = await run('python', args)
  const f = join(DL, id + '.mp4')
  if (existsSync(f)) return f
  console.error(`    download blocked (${(log.match(/ERROR:[^\n]*/) || ['anti-bot'])[0].slice(0, 80)})`)
  return null
}

const sources = (() => { const f = join(ROOT, 'sources.json'); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : [] })()
if (!sources.length) { console.error('no sources.json'); process.exit(1) }

console.error(`[1/3] discovering from ${sources.length} channels...`)
const vids = await discover(sources)
console.error(`found ${vids.length} fresh candidates`)
writeFileSync(join(ROOT, 'queue.json'), JSON.stringify(vids, null, 2))

const top = vids.slice(0, N)
const done = []
for (const v of top) {
  console.error(`\n[2/3] ${v.title}  (${v.url})`)
  const file = await tryDownload(v.url, v.id)
  if (!file) { v.status = 'download-blocked'; continue }
  console.error(`[3/3] clipping...`)
  try {
    const { outDir, clips } = await makeClips(file, { n: PER })
    v.status = 'done'; v.clips = clips.length; v.outDir = outDir
    done.push(v)
    console.error(`  -> ${clips.length} clips in ${outDir}`)
  } catch (e) { v.status = 'clip-error: ' + e.message }
}
markSeen(top.map((v) => v.id))

console.log(`\n=== pipeline done: ${done.length}/${top.length} videos clipped ===`)
for (const v of top) console.log(`  [${v.status || '?'}] ${v.title}${v.clips ? ` (${v.clips} clips)` : ''}`)
if (!done.length) console.log('\nNote: YouTube download is anti-bot-blocked here. Discovery + queue.json work; drop a video file and run `node clip.mjs <file>`, or set PIPE_COOKIES=firefox if logged in there.')
