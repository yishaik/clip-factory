import { createReadStream, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, sep } from 'node:path'

// Resolve symlinks before checking containment; a string prefix is not a boundary.
export function allowedFile(root, file, extensions) {
  if (typeof file !== 'string' || !isAbsolute(file)) return null
  try {
    const path = realpathSync(file)
    const rel = relative(realpathSync(root), path)
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null
    if (!extensions.test(path) || !statSync(path).isFile()) return null
    return path
  } catch {
    return null
  }
}

export function serveVideo(req, res, path) {
  let size
  try { size = statSync(path).size } catch {
    res.writeHead(404).end()
    return
  }
  const headers = { 'content-type': 'video/mp4', 'accept-ranges': 'bytes' }
  let start = 0, end = size - 1
  const range = req.headers.range
  if (range !== undefined) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range)
    if (match && (match[1] || match[2])) {
      if (!match[1]) {
        const suffix = Number(match[2])
        start = Math.max(0, size - suffix)
        if (!Number.isSafeInteger(suffix) || suffix === 0) start = size
      } else {
        start = Number(match[1])
        end = match[2] ? Number(match[2]) : end
      }
    } else start = size
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
      res.writeHead(416, { ...headers, 'content-range': `bytes */${size}`, 'content-length': 0 }).end()
      return
    }
    end = Math.min(end, size - 1)
    headers['content-range'] = `bytes ${start}-${end}/${size}`
  }
  headers['content-length'] = Math.max(0, end - start + 1)
  res.writeHead(range === undefined ? 200 : 206, headers)
  if (size === 0) return res.end()
  const stream = createReadStream(path, { start, end })
  stream.on('error', () => res.destroy())
  res.on('close', () => stream.destroy())
  stream.pipe(res)
}
