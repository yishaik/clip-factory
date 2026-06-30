#!/usr/bin/env node
// feedback.mjs — record your taste verdict on a produced clip, for kappa calibration.
// The decision engine logs which moments it picked (feedback/decisions.jsonl); this records
// whether YOU actually liked them. Pair the two with kappa-feedback.mjs.
//
//   node feedback.mjs <run> <clip-id> <good|bad>   e.g. node feedback.mjs my-video clip-2 bad
//   node feedback.mjs list [run]                   show decisions + any verdicts you've given
import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const FB = join(ROOT, 'feedback')
const readJsonl = (f) =>
  existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) : []

const [cmd, ...rest] = process.argv.slice(2)

if (cmd === 'list') {
  const run = rest[0]
  const dec = readJsonl(join(FB, 'decisions.jsonl')).filter((d) => !run || d.run === run)
  const fb = new Map(readJsonl(join(FB, 'feedback.jsonl')).map((f) => [`${f.run}::${f.id}`, f.human]))
  if (!dec.length) { console.log('no decisions logged yet — run the clip engine first.'); process.exit(0) }
  let curRun = null
  for (const d of dec) {
    if (d.run !== curRun) { curRun = d.run; console.log(`\n${curRun}`) }
    const v = fb.get(`${d.run}::${d.id}`)
    const mark = v === 'good' ? '👍' : v === 'bad' ? '👎' : '· '
    console.log(`  ${mark} ${d.id.padEnd(10)} ${d.picked ? 'PICKED' : '(rejected)'}  score=${d.score}  ${d.hook || ''}`)
  }
  process.exit(0)
}

if (rest.length < 1 || !['good', 'bad'].includes((rest[1] || '').toLowerCase())) {
  console.error('usage: node feedback.mjs <run> <clip-id> <good|bad>   |   node feedback.mjs list [run]')
  process.exit(2)
}
const [run, id, human] = [cmd, rest[0], rest[1].toLowerCase()]
mkdirSync(FB, { recursive: true })
appendFileSync(join(FB, 'feedback.jsonl'), JSON.stringify({ ts: new Date().toISOString(), run, id, human }) + '\n')
console.log(`recorded: ${run}/${id} = ${human === 'good' ? '👍 good' : '👎 bad'}`)
