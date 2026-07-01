#!/usr/bin/env node
// youtube-privacy.mjs <public|unlisted|private> <videoId...>  — flip privacy of existing uploads.
// Uses videos.update (part=status) with the youtube scope. Auth: .youtube-publish.json refresh token.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
async function token() {
  const c = JSON.parse(readFileSync(join(ROOT, '.youtube-publish.json'), 'utf8'))
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.client_id, client_secret: c.client_secret, refresh_token: c.refresh_token, grant_type: 'refresh_token' }) })
  const j = await r.json()
  if (!j.access_token) throw new Error('token refresh failed: ' + JSON.stringify(j))
  return j.access_token
}

const [privacy, ...ids] = process.argv.slice(2)
if (!['public', 'unlisted', 'private'].includes(privacy) || !ids.length) {
  console.error('usage: node youtube-privacy.mjs <public|unlisted|private> <videoId...>'); process.exit(1)
}
const tok = await token()
for (const id of ids) {
  const body = { id, status: { privacyStatus: privacy, selfDeclaredMadeForKids: false } }
  const r = await fetch('https://www.googleapis.com/youtube/v3/videos?part=status', {
    method: 'PUT', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const j = await r.json()
  if (r.ok) console.error(`✅ ${id} -> ${j.status?.privacyStatus}`)
  else console.error(`❌ ${id} -> ${r.status}: ${JSON.stringify(j).slice(0, 200)}`)
}
