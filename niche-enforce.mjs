#!/usr/bin/env node
// niche-enforce.mjs — align the channel with the AI/tech niche.
// Reads .youtube-audit.json (run youtube-audit.mjs first for fresh data), classifies every video
// by NICHE_RE, then: off-niche public -> unlisted, on-niche unlisted -> public.
// Dry-run by default; pass --apply to actually update privacy via the Data API.
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NICHE_RE } from './source.mjs'
import { accessToken, setPrivacy } from './youtube-api.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
const APPLY = process.argv.includes('--apply')

const audit = JSON.parse(readFileSync(join(ROOT, '.youtube-audit.json'), 'utf8'))
const plan = []
for (const v of audit.videos) {
  const onNiche = NICHE_RE.test(v.title)
  if (!onNiche && v.privacy === 'public') plan.push({ ...v, to: 'unlisted', why: 'off-niche' })
  if (onNiche && v.privacy === 'unlisted') plan.push({ ...v, to: 'public', why: 'on-niche' })
}

console.log(`${audit.videos.length} videos on channel — ${plan.length} privacy change(s)${APPLY ? '' : ' [DRY RUN — pass --apply]'}\n`)
for (const p of plan) console.log(`  ${p.privacy} -> ${p.to}  (${p.why}, ${p.views}v)  ${p.title}\n      ${p.url}`)

if (APPLY && plan.length) {
  const tok = await accessToken()
  for (const p of plan) {
    try { await setPrivacy(tok, p.id, p.to); console.log(`  ✅ ${p.to}: ${p.title.slice(0, 50)}`) }
    catch (e) { console.log(`  ❌ ${p.title.slice(0, 40)} — ${e.message}`) }
  }
}
