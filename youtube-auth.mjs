#!/usr/bin/env node
// youtube-auth.mjs — one-time OAuth for YouTube uploads. Loopback flow, NO timeout (authorize at your pace).
// Prints AUTH_URL; open it ON THIS PC, authorize, and it saves .youtube-publish.json (refresh token).
import http from 'node:http'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const cf = join(ROOT, 'client_secret.json')
if (!existsSync(cf)) { console.error('client_secret.json missing'); process.exit(1) }
const c = JSON.parse(readFileSync(cf, 'utf8')).installed || JSON.parse(readFileSync(cf, 'utf8')).web
const PORT = 8085, REDIRECT = `http://localhost:${PORT}`
const SCOPES = 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube'
const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(c.client_id)}&redirect_uri=${encodeURIComponent(REDIRECT)}&response_type=code&scope=${encodeURIComponent(SCOPES)}&access_type=offline&prompt=consent`

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, REDIRECT)
  const code = u.searchParams.get('code')
  if (!code) { res.writeHead(200, { 'content-type': 'text/html' }).end('Waiting for the authorization code…'); return }
  try {
    const body = new URLSearchParams({ code, client_id: c.client_id, client_secret: c.client_secret, redirect_uri: REDIRECT, grant_type: 'authorization_code' })
    const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body })
    const j = await r.json()
    if (j.refresh_token) {
      writeFileSync(join(ROOT, '.youtube-publish.json'), JSON.stringify({ client_id: c.client_id, client_secret: c.client_secret, refresh_token: j.refresh_token }, null, 2))
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<h2 style="font-family:sans-serif">✅ Authorized! You can close this tab.</h2>')
      console.log('SAVED .youtube-publish.json'); setTimeout(() => process.exit(0), 600)
    } else { res.end('error: ' + JSON.stringify(j)); console.error('TOKEN ERR ' + JSON.stringify(j)) }
  } catch (e) { res.end('error ' + e.message); console.error(e.message) }
})
server.listen(PORT, () => console.log('AUTH_URL: ' + authUrl + '\nlistening on ' + REDIRECT + ' (no timeout)'))
