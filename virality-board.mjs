#!/usr/bin/env node
// virality-board.mjs — the "what will go viral" scoreboard for the channel.
// Run `node youtube-audit.mjs` first (refreshes .youtube-audit.json), then this.
//  · First run  -> writes .virality-baseline.json (predicted score + starting views per clip).
//  · Later runs -> compares PREDICTED (decision-engine viralScore) vs ACTUAL (views/day since baseline),
//    so you can see whether the engine's viral picks actually performed. Read-only; no channel writes.
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const norm = (t) => (t || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()

// predicted viralScore per clip, harvested from every clips.json (decision engine output)
const pred = new Map()
;(function walk(d) {
  for (const f of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, f.name)
    if (f.isDirectory()) walk(p)
    else if (f.name === 'clips.json') { try {
      for (const c of JSON.parse(readFileSync(p, 'utf8'))) for (const k of [c.hook, c.title]) if (k) {
        const n = norm(k); if (!pred.has(n) || (c.viralScore || 0) > pred.get(n)) pred.set(n, c.viralScore ?? null)
      }
    } catch {} }
  }
})(join(ROOT, 'clips'))

const audit = JSON.parse(readFileSync(join(ROOT, '.youtube-audit.json'), 'utf8'))
const pub = audit.videos.filter((v) => v.privacy === 'public')
const baseF = join(ROOT, '.virality-baseline.json')

if (!existsSync(baseF)) {
  const base = { at: audit.at, clips: pub.map((v) => ({ id: v.id, title: v.title, pred: pred.get(norm(v.title)) ?? null, views0: v.views })) }
  writeFileSync(baseF, JSON.stringify(base, null, 2))
  console.error(`baseline written: ${base.clips.length} public clips @ ${base.at.slice(0, 10)}\n`)
  const board = base.clips.slice().sort((a, b) => (b.pred ?? -1) - (a.pred ?? -1))
  console.error('PREDICTED viral ranking (re-run in ~7 days to score it):\n')
  board.forEach((c, i) => console.error(`${String(i + 1).padStart(2)}. [pred ${String(c.pred ?? '?').padStart(3)}]  ${c.title.slice(0, 50)}`))
} else {
  const base = JSON.parse(readFileSync(baseF, 'utf8'))
  const days = Math.max(0.5, (new Date(audit.at) - new Date(base.at)) / 864e5)
  const b0 = new Map(base.clips.map((c) => [c.id, c]))
  const rows = pub.map((v) => {
    const b = b0.get(v.id) || { views0: 0, pred: pred.get(norm(v.title)) ?? null }
    const gained = v.views - (b.views0 ?? 0)
    return { title: v.title, pred: b.pred, views: v.views, gained, vel: +(gained / days).toFixed(1) }
  })
  console.error(`elapsed: ${days.toFixed(1)} days since baseline (${base.at.slice(0, 10)})\n`)
  console.error('PREDICTED vs ACTUAL:\n')
  console.error('by PREDICTED score:'); rows.slice().sort((a, b) => (b.pred ?? -1) - (a.pred ?? -1))
    .forEach((r) => console.error(`  [pred ${String(r.pred ?? '?').padStart(3)}]  ${String(r.gained).padStart(5)} views (+${r.vel}/day)  ${r.title.slice(0, 44)}`))
  console.error('\nby ACTUAL views gained:'); rows.slice().sort((a, b) => b.gained - a.gained)
    .forEach((r) => console.error(`  ${String(r.gained).padStart(5)} views  [pred ${String(r.pred ?? '?').padStart(3)}]  ${r.title.slice(0, 44)}`))
}
