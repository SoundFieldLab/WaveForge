'use strict'

const assert = require('assert')
const http = require('http')
const os = require('os')
const path = require('path')
const fs = require('fs')
const test = require('node:test')
const { AudioDownloadService } = require('../desktop/audio-download.cjs')

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'waveforge-audio-policy-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10 }))
  return root
}

const { PassThrough } = require('stream')

function response(statusCode, headers, body = Buffer.from('ID3-test-audio')) {
  return { statusCode, headers, body, resume() {}, on() {}, destroy() {} }
}

function streamResponse(statusCode, headers, delay = 0) {
  const stream = new PassThrough()
  stream.statusCode = statusCode
  stream.headers = headers
  setTimeout(() => { stream.end(Buffer.from('ID3-audio')) }, delay)
  return stream
}

function fakeRequestFactory(calls, handler) {
  return ({ url, headers }, callback) => {
    calls.push({ url, headers })
    const request = {
      destroyed: false,
      on(event, listener) { if (event === 'error') request.errorListener = listener; return request },
      setTimeout() {},
      destroy() { request.destroyed = true },
    }
    setImmediate(() => handler({ url, headers }, callback, request))
    return request
  }
}

test('adds provider headers, follows relative redirects, and accepts 206', async t => {
  const root = fixture(t)
  const calls = []
  const service = new AudioDownloadService(root, {
    requestFactory: fakeRequestFactory(calls, ({ url }, callback) => {
      if (url.includes('/start')) return callback(response(302, { location: '/audio' }))
      callback(streamResponse(206, { 'content-type': 'audio/mpeg', 'content-length': '9' }))
    }),
  })
  const file = await service.downloadForAnalysis('https://example.qq.com/start?guid=secret', 'qq-track')
  assert.ok(fs.existsSync(file))
  assert.equal(calls.length, 2)
  assert.equal(calls[0].headers.Referer, 'https://y.qq.com/')
  assert.equal(calls[0].headers.Accept, 'audio/*,application/octet-stream;q=0.9,*/*;q=0.8')
  assert.ok(calls[0].headers['User-Agent'])
  service.clearLocalAuthorizations()
})

test('cooled 403 does not retry the same signed URL, but a new URL can try', async t => {
  const root = fixture(t)
  const calls = []
  let now = 1000
  const service = new AudioDownloadService(root, {
    now: () => now,
    requestFactory: fakeRequestFactory(calls, (_request, callback) => callback(response(403, {}))),
  })
  await assert.rejects(service.downloadForAnalysis('https://audio.example/song.mp3?sig=old', 'song'), /AUDIO_DOWNLOAD_HTTP_403/)
  await assert.rejects(service.downloadForAnalysis('https://audio.example/song.mp3?sig=old', 'song'), /AUDIO_DOWNLOAD_403_COOLDOWN/)
  assert.equal(calls.length, 1)
  await assert.rejects(service.downloadForAnalysis('https://audio.example/song.mp3?sig=new', 'song'), /AUDIO_DOWNLOAD_HTTP_403/)
  assert.equal(calls.length, 2)
  now += 31_000
  await assert.rejects(service.downloadForAnalysis('https://audio.example/song.mp3?sig=old', 'song'), /AUDIO_DOWNLOAD_HTTP_403/)
  assert.equal(calls.length, 3)
})

test('joins concurrent downloads only for the same track and signed URL', async t => {
  const root = fixture(t)
  const calls = []
  const service = new AudioDownloadService(root, {
    requestFactory: fakeRequestFactory(calls, (_request, callback) => {
      callback(streamResponse(200, { 'content-type': 'audio/mpeg' }))
    }),
  })
  const oldUrl = 'https://audio.example/song.mp3?sig=old'
  const newUrl = 'https://audio.example/song.mp3?sig=new'
  await Promise.all([
    service.downloadForAnalysis(oldUrl, 'song'),
    service.downloadForAnalysis(oldUrl, 'song'),
    service.downloadForAnalysis(newUrl, 'song'),
  ])
  assert.equal(calls.length, 2)
})

// —— 时长闸（expectedDuration）：空 vkey/试听片段返回"合法容器但只有半首"的截断文件
//（实测 370s 的歌存下 176.5s 的合法 FLAC）。commit 前拒绝 + 缓存复用前删除。

/** 拼一个最小合法 FLAC：'fLaC' + 4 字节块头（00 00 00 22 = STREAMINFO 34B，最后一块）
 *  + STREAMINFO payload。位域（大端）：payload 偏移 10 起 20bit 采样率 → 8bit 通道/位深
 *  → 36bit 总采样数（偏移 13 低 4bit 为最高位，14..17 为低 32bit）。补 32B padding 过
 *  探测器 64B 大小下限（真实文件还有 128bit MD5）。 */
function flacFixture(sampleRate, totalSamples) {
  const header = Buffer.from('fLaC', 'latin1')
  const blockHeader = Buffer.from([0x00, 0x00, 0x00, 0x22])
  const info = Buffer.alloc(34)
  info[10] = (sampleRate >> 12) & 0xff
  info[11] = (sampleRate >> 4) & 0xff
  info[12] = ((sampleRate & 0x0f) << 4) | (Math.floor(totalSamples / 2 ** 32) & 0x0f)
  info[14] = Math.floor(totalSamples / 2 ** 24) & 0xff
  info[15] = Math.floor(totalSamples / 2 ** 16) & 0xff
  info[16] = Math.floor(totalSamples / 2 ** 8) & 0xff
  info[17] = totalSamples & 0xff
  return Buffer.concat([header, blockHeader, info, Buffer.alloc(32)])
}

test('probeAudioDurationSeconds reads FLAC STREAMINFO', t => {
  const root = fixture(t)
  const service = new AudioDownloadService(root, {})
  // 176.493s @44100Hz——被截断文件的精确参数
  const truncated = flacFixture(44100, Math.round(176.4933 * 44100))
  const p = path.join(root, 'truncated.flac')
  fs.writeFileSync(p, truncated)
  const duration = service.probeAudioDurationSeconds(p)
  assert.ok(Math.abs(duration - 176.4933) < 0.01, `duration=${duration}`)
  // 370s 整曲
  const full = flacFixture(44100, Math.round(370 * 44100))
  fs.writeFileSync(p, full)
  const fullDuration = service.probeAudioDurationSeconds(p)
  assert.ok(Math.abs(fullDuration - 370) < 0.01, `fullDuration=${fullDuration}`)
})

test('commit rejects truncated audio when expectedDuration is given', async t => {
  const root = fixture(t)
  const calls = []
  // 服务端返回 176.5s 的"合法 FLAC"，曲目元数据 370s → commit 拒绝
  const service = new AudioDownloadService(root, {
    requestFactory: fakeRequestFactory(calls, (_request, callback) => {
      callback(streamResponse(200, { 'content-type': 'audio/flac' }, flacFixture(44100, Math.round(176.4933 * 44100)).length, 0))
    }),
  })
  // streamResponse 固定发 9 字节；这里临时替换响应体工厂：直接给 PassThrough 写夹具
  const stream = new PassThrough()
  stream.statusCode = 200
  stream.headers = { 'content-type': 'audio/flac' }
  service.requestFactory = (_opts, callback) => {
    const request = { destroyed: false, on() { return request }, setTimeout() {}, destroy() { request.destroyed = true } }
    setImmediate(() => callback(stream))
    return request
  }
  setImmediate(() => stream.end(flacFixture(44100, Math.round(176.4933 * 44100))))
  await assert.rejects(
    service.downloadForAnalysis('https://audio.example/song.flac', 'qq-truncated', { expectedDuration: 370 }),
    /AUDIO_DOWNLOAD_DURATION_MISMATCH/,
  )
  // 拒绝的坏文件不得进缓存索引
  assert.equal(service.cacheIndex.get('qq-truncated'), undefined)
})

test('cache reuse re-validates duration and evicts stale truncated file', async t => {
  const root = fixture(t)
  const calls = []
  let payload = null
  const service = new AudioDownloadService(root, {
    requestFactory: fakeRequestFactory(calls, (_request, callback) => {
      const stream = new PassThrough()
      stream.statusCode = 200
      stream.headers = { 'content-type': 'audio/flac' }
      setImmediate(() => stream.end(payload))
      callback(stream)
    }),
  })
  // 第一次：370s 整曲正常入缓存
  payload = flacFixture(44100, Math.round(370 * 44100))
  const first = await service.downloadForAnalysis('https://audio.example/song.flac?sig=a', 'song-a', { expectedDuration: 370 })
  assert.ok(fs.existsSync(first))
  // 模拟缓存文件被换成截断版（旧 bug 时代写入的坏文件）
  fs.writeFileSync(first, flacFixture(44100, Math.round(176.4933 * 44100)))
  // 复用缓存：时长闸发现实际 176.5s vs 期望 370s → 删缓存重新下载
  payload = flacFixture(44100, Math.round(370 * 44100))
  const second = await service.downloadForAnalysis('https://audio.example/song.flac?sig=b', 'song-a', { expectedDuration: 370 })
  assert.notEqual(second, first)
  assert.ok(fs.existsSync(second))
  const duration = service.probeAudioDurationSeconds(second)
  assert.ok(Math.abs(duration - 370) < 1, `re-downloaded duration=${duration}`)
})

test('cache index round-trips relative filePaths (portable across directory moves)', async t => {
  const root = fixture(t)
  const service = new AudioDownloadService(root, {
    requestFactory: fakeRequestFactory([], (_request, callback) => {
      callback(streamResponse(200, { 'content-type': 'audio/mpeg' }))
    }),
  })
  const file = await service.downloadForAnalysis('https://audio.example/song.mp3', 'song-portable')
  assert.ok(fs.existsSync(file))

  // 序列化 → 索引文件里应为相对文件名（可移植）
  service.saveCacheIndex()
  const indexPath = path.join(root, 'cache-index.json')
  const raw = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
  const entry = raw.find(item => item.trackKey === 'song-portable')
  assert.ok(entry, 'index entry exists')
  assert.ok(!path.isAbsolute(entry.filePath), `serialized filePath should be relative: ${entry.filePath}`)

  // 模拟整个缓存目录被搬到新位置：新 service 实例指向新 tempRoot，索引文件一起搬
  const newRoot = path.join(fixture(t), 'moved')
  fs.mkdirSync(newRoot, { recursive: true })
  fs.copyFileSync(indexPath, path.join(newRoot, 'cache-index.json'))
  fs.copyFileSync(file, path.join(newRoot, path.basename(file)))
  const service2 = new AudioDownloadService(newRoot, {})
  const hit = service2.downloadForAnalysis('https://audio.example/anything.mp3', 'song-portable', { expectedDuration: 5 })
  // 缓存命中：新位置直接返回（不需要重新下载）
  assert.equal(await hit, path.join(newRoot, path.basename(file)))
})
