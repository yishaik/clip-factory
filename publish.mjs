#!/usr/bin/env node
// publish.mjs <video.mp4> "<title>" ["description"] [public|unlisted|private]
// Uploads a vertical short to YouTube (channel of the authorized account) via the Data API v3.
// Auth: Application Default Credentials with the youtube.upload scope, e.g.
//   gcloud auth application-default login --client-id-file=client_secret.json \
//     --scopes=https://www.googleapis.com/auth/youtube.upload,https://www.googleapis.com/auth/youtube
import { execFile } from 'node:child_process'
import { statSync, createReadStream, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const run = (cmd, args) => new Promise((res, rej) => execFile(cmd, args, { maxBuffer: 1 << 24 }, (e, so, se) => e ? rej(new Error(se || e.message)) : res(so.trim())))
async function token() {
  const f = join(ROOT, '.youtube-publish.json') // saved refresh token (preferred)
  if (existsSync(f)) {
    const c = JSON.parse(readFileSync(f, 'utf8'))
    const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: c.client_id, client_secret: c.client_secret, refresh_token: c.refresh_token, grant_type: 'refresh_token' }) })
    const j = await r.json()
    if (j.access_token) return j.access_token
    throw new Error('token refresh failed: ' + JSON.stringify(j))
  }
  return (await run('gcloud', ['auth', 'application-default', 'print-access-token'])).trim() // fallback to ADC
}

export async function uploadShort(file, title, description = '', privacy = 'public', tags = []) {
  if (!existsSync(file)) throw new Error('not found: ' + file)
  const tok = await token()
  const desc = (description + '\n\n#Shorts').trim()
  const allTags = ['shorts', ...tags].filter((t, i, a) => a.indexOf(t) === i).slice(0, 30)
  const meta = { snippet: { title: title.slice(0, 95), description: desc.slice(0, 4900), categoryId: '24', tags: allTags },
    status: { privacyStatus: privacy, selfDeclaredMadeForKids: false } }
  // 1) start a resumable session
  const size = statSync(file).size
  const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'video/mp4', 'X-Upload-Content-Length': String(size) }, body: JSON.stringify(meta),
  })
  if (!init.ok) throw new Error('init failed ' + init.status + ': ' + (await init.text()).slice(0, 300))
  const session = init.headers.get('location')
  if (!session) throw new Error('no upload session url')
  // 2) PUT the bytes
  const put = await fetch(session, { method: 'PUT', headers: { 'content-type': 'video/mp4', 'content-length': String(size) }, body: createReadStream(file), duplex: 'half' })
  const out = await put.json()
  if (!put.ok) throw new Error('upload failed ' + put.status + ': ' + JSON.stringify(out).slice(0, 300))
  return { id: out.id, url: 'https://youtube.com/shorts/' + out.id, title: out.snippet?.title }
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/publish.mjs')
if (isMain) {
  const [file, title, description = '', privacy = 'public'] = process.argv.slice(2)
  if (!file || !title) { console.error('usage: node publish.mjs <video.mp4> "<title>" ["desc"] [public|unlisted|private]'); process.exit(1) }
  const r = await uploadShort(file, title, description, privacy)
  console.log(JSON.stringify(r))
  console.error(`\n✅ uploaded: ${r.url}\n   "${r.title}"`)
}
