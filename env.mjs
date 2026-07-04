// env.mjs — minimal .env loader shared by every entry script (so scheduled/headless
// runs get GEMINI_API_KEY etc. without a dotenv dependency). Existing process.env wins.
import { existsSync, readFileSync } from 'node:fs'

export function loadEnv(...files) {
  for (const f of files) {
    if (!f || !existsSync(f)) continue
    for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  }
}
