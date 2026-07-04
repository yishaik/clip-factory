// youtube-api.mjs — shared YouTube Data API v3 auth + fetch helpers.
// Single source of truth for the OAuth refresh-token exchange used by every
// channel-management script (audit, privacy, niche-enforce, publish).
// Auth: .youtube-publish.json refresh token, produced by youtube-auth.mjs.
import { existsSync, readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const run = (cmd, args) => new Promise((res, rej) => execFile(cmd, args, { maxBuffer: 1 << 24 }, (e, so, se) => e ? rej(new Error(se || e.message)) : res(so.trim())))

// Access token from the saved refresh token. publish.mjs also accepts an ADC fallback
// (gcloud application-default) for environments without a saved refresh token.
export async function accessToken({ allowAdcFallback = false } = {}) {
  const f = join(ROOT, '.youtube-publish.json')
  if (existsSync(f)) {
    const c = JSON.parse(readFileSync(f, 'utf8'))
    const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: c.client_id, client_secret: c.client_secret, refresh_token: c.refresh_token, grant_type: 'refresh_token' }) })
    const j = await r.json()
    if (j.access_token) return j.access_token
    throw new Error('token refresh failed: ' + JSON.stringify(j))
  }
  if (allowAdcFallback) return run('gcloud', ['auth', 'application-default', 'print-access-token'])
  throw new Error('.youtube-publish.json missing — run: node youtube-auth.mjs')
}

// GET wrapper for the Data API — JSON in, JSON out, throws with the API's own error body.
export async function ytGet(tok, path) {
  const r = await fetch('https://www.googleapis.com/youtube/v3/' + path, { headers: { authorization: `Bearer ${tok}` } })
  const j = await r.json()
  if (!r.ok) throw new Error(path.slice(0, 40) + ' -> ' + r.status + ': ' + JSON.stringify(j).slice(0, 200))
  return j
}

// videos.update(part=status) — flips a video's privacy.
export async function setPrivacy(tok, id, privacy) {
  const r = await fetch('https://www.googleapis.com/youtube/v3/videos?part=status', {
    method: 'PUT', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
    body: JSON.stringify({ id, status: { privacyStatus: privacy, selfDeclaredMadeForKids: false } }) })
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`)
}
