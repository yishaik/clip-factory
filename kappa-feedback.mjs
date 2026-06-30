#!/usr/bin/env node
// kappa-feedback.mjs — does Clip Factory's decision engine agree with YOUR taste?
//
// Joins the engine's verdicts (feedback/decisions.jsonl) with your 👍/👎
// (feedback/feedback.jsonl), writes a flat labels file, and runs `kappa score` on it.
// The judge label is the engine's confidence, binarized at a score threshold; the human
// label is your verdict. Cohen's kappa then says whether high engine-confidence tracks
// the clips you actually liked. Also prints plain precision (how many picks you liked).
//
//   node kappa-feedback.mjs [--threshold=75]
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = dirname(fileURLToPath(import.meta.url))
const FB = join(ROOT, 'feedback')
const arg = process.argv.find((a) => a.startsWith('--threshold='))
const TH = Number((arg && arg.split('=')[1]) || process.env.KAPPA_THRESHOLD || 75)

const readJsonl = (f) =>
  existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) : []

const key = (x) => `${x.run}::${x.id}`
// latest verdict / latest feedback wins (later lines override)
const dec = new Map(); for (const d of readJsonl(join(FB, 'decisions.jsonl'))) dec.set(key(d), d)
const fb = new Map(); for (const f of readJsonl(join(FB, 'feedback.jsonl'))) fb.set(key(f), f.human)

const rows = []
for (const [k, d] of dec) {
  const h = fb.get(k)
  if (h !== 'good' && h !== 'bad') continue          // only clips you've rated
  rows.push({ id: k, judge: (Number(d.score) || 0) >= TH ? 'good' : 'bad', human: h, score: d.score })
}
if (!rows.length) {
  console.error('No clips have both an engine decision and your feedback yet.')
  console.error('Rate some: node feedback.mjs <run> <clip-id> good|bad   (or the Studio 👍/👎)')
  process.exit(1)
}

const labels = join(FB, 'labels.jsonl')
writeFileSync(labels, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
const liked = rows.filter((r) => r.human === 'good').length
console.log(`joined ${rows.length} rated clips · you liked ${liked}/${rows.length} (${Math.round(100 * liked / rows.length)}% precision) · judge threshold score>=${TH}`)
console.log(`labels -> ${labels}\n`)

const kappaPy = join(ROOT, '..', 'kappa', 'kappa.py')
if (!existsSync(kappaPy)) {
  console.error(`kappa not found at ${kappaPy} — clone it next to clip-factory, then re-run.`)
  process.exit(1)
}
const r = spawnSync('python', [kappaPy, 'score', labels], { stdio: 'inherit' })
process.exit(r.status == null ? 1 : r.status)
