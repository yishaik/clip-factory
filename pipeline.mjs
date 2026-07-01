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
const MAXMIN = Number(process.env.PIPE_MAXMIN || 60) // skip videos longer than this
const HEAD = Number(process.env.PIPE_HEAD || 8)      // only clip the first N minutes (0 = whole) — bounds whisper memory (12min OOMs under load)

const run = (cmd, args) => new Promise((res) => execFile(cmd, args, { maxBuffer: 1 << 26 }, (e, so, se) => res({ e, out: (so || '') + (se || '') })))

// best-effort download of a video URL via yt-dlp. Returns a file path or null (blocked).
async function tryDownload(url, id) {
  mkdirSync(DL, { recursive: true })
  const out = join(DL, id + '.%(ext)s')
  const args = ['-m', 'yt_dlp',
    // these player clients return playable URLs without solving YouTube's n-challenge.
    // prefer 720p DASH (https video-only + m4a audio, merged) over the 360p progressive fallback.
    '--extractor-args', 'youtube:player_client=android_vr,web_safari',
    '-f', 'bv*[height<=720][ext=mp4]+140/bv*[height<=720]+ba/b[height<=720][ext=mp4]/18/best',
    '--merge-output-format', 'mp4', '-o', out,
    '--no-playlist', '--max-filesize', '600M', '--match-filter', `duration < ${MAXMIN * 60}`, url]
  if (process.env.PIPE_COOKIES) args.splice(2, 0, '--cookies-from-browser', process.env.PIPE_COOKIES)
  const { e, out: log } = await run('python', args)
  const f = join(DL, id + '.mp4')
  if (existsSync(f)) return f
  console.error(`    download blocked (${(log.match(/ERROR:[^\n]*/) || ['anti-bot'])[0].slice(0, 80)})`)
  return null
}

// trim to the first HEAD minutes (bounds transcription time) if the video is longer
async function trimHead(file) {
  if (!HEAD) return file
  const { out } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file])
  const dur = parseFloat(out)
  if (!(dur > HEAD * 60 + 5)) return file
  const trimmed = file.replace(/\.mp4$/, '.head.mp4')
  await run('ffmpeg', ['-y', '-i', file, '-t', String(HEAD * 60), '-c', 'copy', trimmed])
  return existsSync(trimmed) ? trimmed : file
}

const sources = (() => { const f = join(ROOT, 'sources.json'); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : [] })()
if (!sources.length) { console.error('no sources.json'); process.exit(1) }

console.error(`[1/3] discovering from ${sources.length} channels...`)
const vids = await discover(sources)
console.error(`found ${vids.length} fresh candidates`)
writeFileSync(join(ROOT, 'queue.json'), JSON.stringify(vids, null, 2))

// process candidates until N are successfully clipped (skip past download-blocks / OOM failures)
const done = []
const attempted = []
const MAXTRIES = N + Number(process.env.PIPE_TRIES || 3)
for (const v of vids) {
  if (done.length >= N || attempted.length >= MAXTRIES) break
  attempted.push(v)
  console.error(`\n[2/3] ${v.title}  (${v.url})`)
  const file = await tryDownload(v.url, v.id)
  if (!file) { v.status = 'download-blocked'; continue }
  console.error(`[3/3] clipping...`)
  try {
    const clipFile = await trimHead(file)
    const { outDir, clips } = await makeClips(clipFile, { n: PER })
    v.status = 'done'; v.clips = clips; v.outDir = outDir
    done.push(v)
    console.error(`  -> ${clips.length} clips in ${outDir}`)
  } catch (e) { v.status = 'clip-error: ' + e.message; console.error(`  ! ${e.message}`) }
}
markSeen(attempted.map((v) => v.id))

// ── PUBLISH stage (opt-in: PIPE_PUBLISH=1) — auto-upload the best clips to YouTube ──
// Anti-slop gate: a clip goes PUBLIC only if it passes all three checks — score >= PIPE_PUBLISH_MIN
// (default 88), framing is face-crop (not blurred bg), and hook contains a concrete anchor (number /
// name / event). Anything that fails goes UNLISTED for manual review. Override all privacy with PIPE_PUBLISH_PRIVACY.
if (process.env.PIPE_PUBLISH && done.length) {
  const MIN = Number(process.env.PIPE_PUBLISH_MIN || 88)
  const MAX_CLIPS = Number(process.env.PIPE_PUBLISH_MAX || 3)
  const FORCE_PRIV = process.env.PIPE_PUBLISH_PRIVACY || ''

  const VAGUE = /\b(you'?ve noticed|what if|something|this is that|here'?s why|believe it or not)\b/i
  const hookIsClean = (h) => !!(h && h.length >= 6 && !VAGUE.test(h) && (/\d/.test(h) || /[A-Z]/.test((h + '  ').slice(4))))
  const gatePrivacy = (c) => {
    if (FORCE_PRIV) return FORCE_PRIV
    if ((c.viralScore ?? 0) < MIN) return 'unlisted'
    if (c.frame === 'blur') return 'unlisted'
    if (!hookIsClean(c.hook || c._title)) return 'unlisted'
    return 'public'
  }

  const STOP = new Set(['the','a','an','is','are','was','it','in','of','to','and','or','for','on','at','by','with','that','this'])
  const tagsFromHook = (h) => ['shorts', ...(h || '').toLowerCase().match(/\b[a-z]{4,}\b/g || []).filter((w) => !STOP.has(w)).slice(0, 8)]

  const logf = join(ROOT, '.published.json')
  const pub = existsSync(logf) ? JSON.parse(readFileSync(logf, 'utf8')) : []
  const already = new Set(pub.map((p) => p.file))
  const cand = done.flatMap((v) => (v.clips || []).map((c) => ({ ...c, _title: v.title, _url: v.url })))
    .filter((c) => (c.viralScore ?? 0) >= 70 && !already.has(c.file))
    .sort((a, b) => (b.viralScore ?? 0) - (a.viralScore ?? 0))
    .slice(0, MAX_CLIPS)

  const DRY = !!process.env.PIPE_PUBLISH_DRY
  if (cand.length) {
    console.log(`\n[publish] ${cand.length} clip(s) -> YouTube${DRY ? ' [DRY RUN]' : ''}`)
    if (!DRY) {
      const { uploadShort } = await import('./publish.mjs')
      for (const c of cand) {
        const priv = gatePrivacy(c)
        const title = (c.hook || c._title || 'Short').slice(0, 95)
        const excerpt = (c.text || '').slice(0, 120).trim()
        const desc = [c.reason, excerpt ? `"${excerpt}…"` : '', `Watch the full video: ${c._url}`].filter(Boolean).join('\n\n')
        try {
          const r = await uploadShort(c.file, title, desc, priv, tagsFromHook(title))
          const icon = priv === 'public' ? '✅' : '📋'
          console.log(`   ${icon} [${priv}] ${r.url}  "${title.slice(0, 44)}"`)
          pub.push({ file: c.file, id: r.id, url: r.url, title, score: c.viralScore ?? null, privacy: priv })
        } catch (e) { console.log(`   ❌ "${title.slice(0, 40)}" — ${String(e.message).slice(0, 140)}`) }
      }
      writeFileSync(logf, JSON.stringify(pub, null, 2))
    } else {
      for (const c of cand) console.log(`   would publish [${gatePrivacy(c)}]: ${(c.hook || c._title || '').slice(0, 55)}  (viral ${c.viralScore ?? '?'})`)
    }
  }
}

console.log(`\n=== pipeline done: ${done.length}/${attempted.length} attempted ===`)
for (const v of done) {
  console.log(`\n📹 ${v.title} — ${v.channel}\n   ${v.url}`)
  for (const c of v.clips) console.log(`   ${c.file}  (viral ${c.viralScore ?? '?'}, ${c.dur}s) "${c.hook || ''}"`)
}
for (const v of attempted.filter((v) => v.status !== 'done')) console.log(`   [${v.status}] ${v.title}`)
if (!done.length) console.log('\nNote: nothing produced (downloads blocked or no candidates). Discovery + queue.json still work.')
