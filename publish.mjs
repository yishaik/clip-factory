#!/usr/bin/env node
// publish.mjs <video.mp4> "<title>" ["description"] [public|unlisted|private]
// Uploads a vertical short to YouTube (channel of the authorized account) via the Data API v3.
// Auth: .youtube-publish.json refresh token (see youtube-auth.mjs), falling back to
// Application Default Credentials (gcloud auth application-default login) if that's missing.
import { statSync, createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { accessToken } from './youtube-api.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))

// anti-slop title: no ALL-CAPS shouting, no exclamation marks; restore proper nouns after de-shouting.
const PROPER = ['AI', 'API', 'AGI', 'LLM', 'GPU', 'GPT', 'OpenAI', 'Anthropic', 'Claude', 'Gemini', 'Google', 'Nvidia', 'DeepMind', 'DeepSeek', 'YouTube', 'US', 'China', 'Meta', 'Apple', 'Microsoft']
export function cleanTitle(t) {
  t = (t || '').trim().replace(/\s+/g, ' ')
  const letters = t.replace(/[^a-zA-Z]/g, '')
  const upper = letters.replace(/[^A-Z]/g, '')
  if (letters.length > 8 && upper.length / letters.length > 0.7) {
    t = t.charAt(0).toUpperCase() + t.slice(1).toLowerCase()
    for (const w of PROPER) t = t.replace(new RegExp(`\\b${w}\\b`, 'gi'), w)
  }
  return t.replace(/!+/g, '').replace(/\s+([.,?])/g, '$1').trim()
}

export async function uploadShort(file, title, description = '', privacy = 'public', tags = []) {
  if (!existsSync(file)) throw new Error('not found: ' + file)
  const tok = await accessToken({ allowAdcFallback: true })
  title = cleanTitle(title)
  if (!/https?:\/\//.test(description)) console.error('⚠ description has no source link — every upload should cite sources')
  const desc = (description + '\n\n#Shorts').trim()
  const allTags = ['shorts', ...tags].filter((t, i, a) => a.indexOf(t) === i).slice(0, 30)
  const meta = { snippet: { title: title.slice(0, 95), description: desc.slice(0, 4900), categoryId: '28', tags: allTags },
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

// record an upload in .published.json so audits/feedback see every video, whatever path
// published it. kind: 'clip' (pipeline cut) | 'original' (generated/) | 'news' — for the
// per-format performance breakdown (format-report.mjs).
export function recordPublished(entry) {
  const logf = join(ROOT, '.published.json')
  const pub = existsSync(logf) ? JSON.parse(readFileSync(logf, 'utf8')) : []
  pub.push(entry)
  writeFileSync(logf, JSON.stringify(pub, null, 2))
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/publish.mjs')
if (isMain) {
  const [file, title, description = '', privacy = 'public'] = process.argv.slice(2)
  if (!file || !title) { console.error('usage: node publish.mjs <video.mp4> "<title>" ["desc"] [public|unlisted|private]'); process.exit(1) }
  const r = await uploadShort(file, title, description, privacy)
  const kind = /[\\/]generated[\\/]/.test(file) ? 'original' : 'clip'
  recordPublished({ file, id: r.id, url: r.url, title: r.title, score: null, privacy, kind })
  console.log(JSON.stringify(r))
  console.error(`\n✅ uploaded: ${r.url}\n   "${r.title}"`)
}
