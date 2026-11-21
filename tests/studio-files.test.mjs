import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Writable } from 'node:stream'
import { allowedFile, serveVideo } from '../studio-files.mjs'

test('file containment rejects prefix siblings, traversal and symlink escapes', (t) => {
  const fixture = mkdtempSync(resolve('tests/.files-'))
  t.after(() => rmSync(fixture, { recursive: true, force: true }))
  const root = join(fixture, 'media')
  const sibling = join(fixture, 'media-other')
  mkdirSync(root)
  mkdirSync(sibling)
  const video = join(root, 'clip.mp4')
  const outside = join(sibling, 'clip.mp4')
  writeFileSync(video, '0123456789')
  writeFileSync(outside, 'private')
  writeFileSync(join(root, 'audio.mp3'), 'music')
  symlinkSync(outside, join(root, 'escape.mp4'))
  symlinkSync(video, join(root, 'internal.mp4'))
  mkdirSync(join(root, 'directory.mp4'))
  const check = (file) => allowedFile(root, file, /\.mp4$/i)
  assert.equal(check(video), video)
  assert.equal(check(join(root, 'internal.mp4')), video)
  for (const file of [outside, join(root, '../media-other/clip.mp4'), join(root, 'escape.mp4'), join(root, 'missing.mp4'), join(root, 'directory.mp4'), join(root, 'audio.mp3'), 'clip.mp4', null, {}, root]) {
    assert.equal(check(file), null)
  }
  assert.equal(allowedFile(root, join(root, 'audio.mp3'), /\.mp3$/i), join(root, 'audio.mp3'))
})

test('video server handles full, bounded, open and suffix ranges safely', async (t) => {
  const fixture = mkdtempSync(resolve('tests/.video-'))
  t.after(() => rmSync(fixture, { recursive: true, force: true }))
  const video = join(fixture, 'clip.mp4')
  const empty = join(fixture, 'empty.mp4')
  writeFileSync(video, '0123456789')
  writeFileSync(empty, '')
  // Exercise the streaming response without opening sockets or loading Studio's env.
  const url = '/'
  async function fetch(path, { headers = {} } = {}) {
    const chunks = []
    const response = new Writable({ write(chunk, encoding, done) { chunks.push(Buffer.from(chunk)); done() } })
    response.writeHead = (status, values = {}) => {
      response.status = status
      response.headers = new Map(Object.entries(values).map(([key, value]) => [key, String(value)]))
      return response
    }
    const finished = new Promise((resolve, reject) => {
      response.on('finish', resolve)
      response.on('error', reject)
    })
    serveVideo({ headers }, response, path === '/empty' ? empty : path === '/missing' ? join(fixture, 'missing') : video)
    await finished
    response.text = async () => Buffer.concat(chunks).toString()
    return response
  }
  const full = await fetch(url)
  assert.equal(full.status, 200)
  assert.equal(await full.text(), '0123456789')
  for (const [range, expected, contentRange] of [
    ['bytes=2-4', '234', 'bytes 2-4/10'],
    ['bytes=7-', '789', 'bytes 7-9/10'],
    ['bytes=-3', '789', 'bytes 7-9/10'],
    ['bytes=-99', '0123456789', 'bytes 0-9/10'],
    ['bytes=8-99', '89', 'bytes 8-9/10'],
  ]) {
    const res = await fetch(url, { headers: { range } })
    assert.equal(res.status, 206, range)
    assert.equal(res.headers.get('content-range'), contentRange)
    assert.equal(await res.text(), expected)
  }
  for (const range of ['bytes=10-', 'bytes=5-2', 'bytes=-0', 'bytes=-', 'bytes=abc', 'items=0-1', 'bytes=0-1,3-4', 'bytes=0-999999999999999999999']) {
    const res = await fetch(url, { headers: { range } })
    assert.equal(res.status, 416, range)
    assert.equal(res.headers.get('content-range'), 'bytes */10')
    assert.equal(await res.text(), '')
  }
  const res = await fetch('/empty')
  assert.equal(res.status, 200)
  assert.equal(await res.text(), '')
  assert.equal((await fetch('/empty', { headers: { range: 'bytes=0-' } })).status, 416)
  assert.equal((await fetch('/missing')).status, 404)
  assert.equal((await fetch(url)).status, 200)
})
