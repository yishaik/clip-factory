#!/usr/bin/env node
// views-feedback.mjs — ground-truth feedback from ACTUAL viewer behaviour.
// Joins .published.json (file -> YouTube id) with .youtube-audit.json (views per video),
// converts each published clip's views/day into a good/bad label relative to the channel
// median, and appends the labels to feedback/feedback.jsonl in the same {run,id,human}
// shape the manual 👍/👎 uses — so kappa-feedback.mjs calibrates the decision engine
// against what the audience did, not just personal taste. (Later lines override earlier
// ones there, so views-labels supersede manual ratings for the same clip — intended:
// audience truth outranks taste.)
//
//   node youtube-audit.mjs && node views-feedback.mjs [--min-views=10] [--dry]
import { readFileSync, existsSync, appendFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const MINV = Number((process.argv.find((a) => a.startsWith('--min-views=')) || '').split('=')[1] || 10)
const DRY = process.argv.includes('--dry')

const audit = JSON.parse(readFileSync(join(ROOT, '.youtube-audit.json'), 'utf8'))
const pub = JSON.parse(readFileSync(join(ROOT, '.published.json'), 'utf8'))
const byYt = new Map(audit.videos.map((v) => [v.id, v]))

// published clip -> {run, id} from its file path; views/day from the audit snapshot
const rows = []
for (const p of pub) {
  const m = (p.file || '').replace(/\\/g, '/').match(/clips\/([^/]+)\/(clip-\d+)\.mp4$/)
  const v = byYt.get(p.id)
  if (!m || !v) continue
  const age = Math.max(0.25, (new Date(audit.at) - new Date(v.published)) / 864e5)
  rows.push({ run: m[1], id: m[2], views: v.views, vpd: +(v.views / age).toFixed(2), title: v.title })
}
if (!rows.length) { console.error('no published clips found in the audit — run node youtube-audit.mjs first'); process.exit(1) }

const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0 }
const medViews = med(rows.map((r) => r.views)), medVpd = med(rows.map((r) => r.vpd))
console.error(`${rows.length} published clips · median ${medViews} views · median ${medVpd} views/day · floor ${MINV}`)
if (medViews < MINV) {
  console.error(`channel median below --min-views=${MINV}: not enough traffic for meaningful labels yet. No labels written.`)
  process.exit(0)
}

// relative to the channel: clear winners = good, clear losers = bad, middle = no label (noise)
const labels = rows
  .map((r) => ({ ...r, human: r.vpd >= 1.5 * medVpd ? 'good' : r.vpd <= 0.5 * medVpd ? 'bad' : null }))
  .filter((r) => r.human)
for (const r of labels) console.error(`  ${r.human === 'good' ? '👍' : '👎'} ${String(r.vpd).padStart(7)}/day  ${r.run}/${r.id}  ${r.title.slice(0, 44)}`)
console.error(`${labels.length} labels (${labels.filter((r) => r.human === 'good').length} good / ${labels.filter((r) => r.human === 'bad').length} bad), ${rows.length - labels.length} in the noise band skipped`)

if (DRY) { console.error('[dry] nothing written'); process.exit(0) }
mkdirSync(join(ROOT, 'feedback'), { recursive: true })
const ts = new Date().toISOString()
appendFileSync(join(ROOT, 'feedback', 'feedback.jsonl'),
  labels.map((r) => JSON.stringify({ ts, run: r.run, id: r.id, human: r.human, via: 'views', views: r.views, vpd: r.vpd })).join('\n') + '\n')
console.error('appended to feedback/feedback.jsonl — now run: node kappa-feedback.mjs')
