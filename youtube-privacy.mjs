#!/usr/bin/env node
// youtube-privacy.mjs <public|unlisted|private> <videoId...>  — flip privacy of existing uploads.
// Uses videos.update (part=status) with the youtube scope. Auth: .youtube-publish.json refresh token.
import { accessToken, setPrivacy } from './youtube-api.mjs'

const [privacy, ...ids] = process.argv.slice(2)
if (!['public', 'unlisted', 'private'].includes(privacy) || !ids.length) {
  console.error('usage: node youtube-privacy.mjs <public|unlisted|private> <videoId...>'); process.exit(1)
}
const tok = await accessToken()
for (const id of ids) {
  try { await setPrivacy(tok, id, privacy); console.error(`✅ ${id} -> ${privacy}`) }
  catch (e) { console.error(`❌ ${id} -> ${e.message}`) }
}
