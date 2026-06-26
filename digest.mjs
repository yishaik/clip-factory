#!/usr/bin/env node
// digest.mjs — daily "what to clip" digest. Discovers fresh, clip-worthy long videos
// from sources.json and prints a phone-friendly Markdown digest (links + scores).
// Works today (discovery is not blocked). Run by the scheduled daily self-prompt.
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discover } from './source.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
const DAYS = Number(process.env.DIGEST_DAYS || 3)
const TOP = Number(process.env.DIGEST_TOP || 12)
const sources = (() => { const f = join(ROOT, 'sources.json'); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : [] })()
if (!sources.length) { console.error('no sources.json'); process.exit(1) }

const vids = (await discover(sources, { days: DAYS, skipSeen: true })).slice(0, TOP)
const today = new Date().toISOString().slice(0, 10)
let md = `🎬 *Clip Factory — clip-worthy videos (last ${DAYS}d)*\n\n`
if (!vids.length) md += '_(no fresh hook-worthy uploads found)_\n'
vids.forEach((v, i) => {
  md += `${i + 1}. [score ${v.score}] *${v.title}*\n   ${v.channel} · ${(v.published || '').slice(0, 10)}\n   ${v.url}\n\n`
})
md += `_Drop one into Clip Factory (\`node clip.mjs <file>\`) to cut it into vertical captioned clips._`
// also archive to the Second Brain raw feed (best-effort)
try { writeFileSync(join('D:/projects/second-brain/raw', `${today}-clip-digest.md`), `---\ntitle: Clip digest ${today}\ntype: raw\n---\n\n${md}\n`) } catch {}
console.log(md)
