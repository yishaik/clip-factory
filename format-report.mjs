#!/usr/bin/env node
// format-report.mjs — which FORMAT is winning: clip (podcast cut) vs original (generated)
// vs news (X-timeline brief). Joins .published.json with .youtube-audit.json views.
// Run `node youtube-audit.mjs` first for fresh numbers. Read-only.
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const audit = JSON.parse(readFileSync(join(ROOT, '.youtube-audit.json'), 'utf8'))
const pub = JSON.parse(readFileSync(join(ROOT, '.published.json'), 'utf8'))
const byYt = new Map(audit.videos.map((v) => [v.id, v]))

const kindOf = (p) => p.kind || (/[\\/]generated[\\/]/.test(p.file || '') ? 'original' : 'clip')
const groups = {}
for (const p of pub) {
  const v = byYt.get(p.id)
  if (!v) continue
  const ageD = Math.max(0.25, (new Date(audit.at) - new Date(v.published)) / 864e5)
  const row = { title: v.title, views: v.views, likes: v.likes, vpd: +(v.views / ageD).toFixed(1), privacy: v.privacy, url: v.url }
  ;(groups[kindOf(p)] ||= []).push(row)
}

console.log(`format report — ${audit.at.slice(0, 10)} audit, ${pub.length} published\n`)
for (const [kind, rows] of Object.entries(groups)) {
  const pubRows = rows.filter((r) => r.privacy === 'public')
  const tot = pubRows.reduce((a, r) => a + r.views, 0)
  const avgVpd = pubRows.length ? +(pubRows.reduce((a, r) => a + r.vpd, 0) / pubRows.length).toFixed(1) : 0
  console.log(`${kind.toUpperCase()} — ${pubRows.length} public (${rows.length} total) · ${tot} views · avg ${avgVpd} views/day`)
  for (const r of pubRows.sort((a, b) => b.vpd - a.vpd).slice(0, 5)) console.log(`   ${String(r.vpd).padStart(7)}/d  ${r.views}v ${r.likes}♥  ${r.title.slice(0, 55)}`)
  console.log()
}
