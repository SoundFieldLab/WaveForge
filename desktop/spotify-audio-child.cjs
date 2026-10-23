// Spotify 音频通道隔离进程（utilityProcess 入口）：
// node-librespot 的 resolveAudioFileAsync 在部分 Windows 机器上会原生 abort
// （进程直接消失、无 JS 堆栈）。放在主进程里跑会拖死整个应用；
// 这里把「连接 + locate + key/CDN 元数据」搬进子进程：崩了只损失一次解析，
// 主进程照常给上层回 SPOTIFY_CHILD_CRASH 降级。
//
// 协议（MessagePort）：
//  → { type: 'issue', id, trackId, bitrate }
//  ← { type: 'issue-ok', id, cdnUrl, keyHex, format, mimeType, skip, total, length }
//  ← { type: 'issue-err', id, error }
//  ← { type: 'exit', reason }（子进程自发退出/重置时）
//  ← MessagePort close（原生崩溃时唯一可靠信号）
const crypto = require('crypto')

const QUIET_LIMIT_MS = 30_000
const FILE_TTL_MS = 10 * 60_000
const MAX_TRACK_BYTES = 200 * 1024 * 1024

// Ogg Vorbis 封装：每页头 "OggS" + 27 字节固定头；audio 起点跳过首 167 字节
// （librespot 上游 audiospotify/spotifyd 同源口径：vorbis 167 / mp3 0）。
const SHAPES = {
  ogg_vorbis_96: { skip: 167, mimeType: 'audio/ogg' },
  ogg_vorbis_160: { skip: 167, mimeType: 'audio/ogg' },
  ogg_vorbis_320: { skip: 167, mimeType: 'audio/ogg' },
  mp3_160: { skip: 0, mimeType: 'audio/mpeg' },
  mp3_320: { skip: 0, mimeType: 'audio/mpeg' },
  mp4_128: { skip: 0, mimeType: 'audio/mp4' },
}

function loadLibrespot() {
  try {
    return require('@lox-audioserver/node-librespot')
  } catch {
    return null
  }
}

const librespot = loadLibrespot()
let held = null
let opening = null
let generation = 0
const files = new Map()
const pending = new Map()
let port = null

const send = (message) => { try { port?.postMessage(message) } catch { /* 端口已死 */ } }
const within = (promise, what) => {
  let limit
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      limit = setTimeout(() => reject(new Error(`Spotify did not answer: ${what} exceeded ${QUIET_LIMIT_MS}ms`)), QUIET_LIMIT_MS)
    }),
  ]).finally(() => clearTimeout(limit))
}
const closeQuietly = (session) => { try { Promise.resolve(session?.close?.()).catch(() => {}) } catch { /* 已关 */ } }

async function connect(accessToken) {
  if (!librespot) throw new Error('SPOTIFY_UNAVAILABLE: no librespot prebuilt')
  if (held) return held.session
  if (!opening) {
    const started = generation
    opening = (async () => {
      if (!accessToken) throw new Error('SPOTIFY_NO_TOKEN')
      const session = await within(librespot.createSession({ accessToken, deviceName: 'WaveForge' }), 'connecting')
      if (started !== generation) { closeQuietly(session); throw new Error('SPOTIFY_SESSION_CHANGED') }
      return session
    })().finally(() => { opening = null })
      .then((session) => { held = { session }; return session })
  }
  return opening
}

async function locate(session, trackId, bitrate) {
  for (;;) {
    const kept = held
    try {
      return await within(session.resolveAudioFileAsync({ uri: `spotify:track:${trackId}`, bitrate }), 'locating')
    } catch (error) {
      const said = String(error?.message ?? error)
      if (/unavailable|no audio files|track is unavailable/i.test(said)) {
        throw new Error(`SPOTIFY_TRACK_UNPLAYABLE: ${said.slice(0, 160)}`)
      }
      if (kept && held === kept && held?.session === session) {
        closeQuietly(session)
        held = null
        continue
      }
      throw error
    }
  }
}

async function prepare(session, trackId, bitrate, anew = false) {
  const name = `${trackId}:${bitrate}`
  const kept = files.get(name)
  if (kept && !anew && Date.now() - kept.locatedAt < FILE_TTL_MS) return kept
  let job = pending.get(name)
  if (!job) {
    const started = generation
    job = (async () => {
      const located = await locate(session, trackId, bitrate)
      const shape = SHAPES[String(located?.format ?? '')] ?? (String(located?.format ?? '').startsWith('ogg') ? { skip: 167, mimeType: 'audio/ogg' } : { skip: 0, mimeType: 'audio/mpeg' })
      if (!/^[0-9a-f]{32}$/i.test(String(located?.keyHex ?? '')) || typeof located.cdnUrl !== 'string') {
        throw new Error(`SPOTIFY_TRACK_UNPLAYABLE: unusable format ${located?.format ?? 'unknown'}`)
      }
      const length = Number(located.length ?? 0)
      if (!Number.isSafeInteger(length) || length <= shape.skip || length > MAX_TRACK_BYTES) {
        // 长度缺失不致命：CDN content-range 会兜底（主进程 openRange 时再校验）
        return {
          cdnUrl: located.cdnUrl,
          keyHex: String(located.keyHex),
          format: String(located.format ?? ''),
          mimeType: shape.mimeType,
          skip: shape.skip,
          total: 0,
          length: length || 0,
          locatedAt: Date.now(),
        }
      }
      const file = {
        cdnUrl: located.cdnUrl,
        keyHex: String(located.keyHex),
        format: String(located.format ?? ''),
        mimeType: shape.mimeType,
        skip: shape.skip,
        total: length - shape.skip,
        length,
        locatedAt: Date.now(),
      }
      files.delete(name)
      files.set(name, file)
      while (files.size > 32) files.delete(files.keys().next().value)
      return file
    })()
    pending.set(name, job)
    job.finally(() => { if (pending.get(name) === job) pending.delete(name) }).catch(() => {})
    if (started !== generation) throw new Error('SPOTIFY_SESSION_CHANGED')
  }
  return job
}

process.parentPort.on('message', async (event) => {
  const message = event.data ?? {}
  if (message.type !== 'issue') return
  if (!port) port = event.target
  const { id, trackId, bitrate, accessToken } = message
  try {
    if (!/^[0-9A-Za-z]{22}$/.test(String(trackId ?? ''))) throw new Error('SPOTIFY_BAD_TRACK_ID')
    const session = await connect(accessToken)
    const file = await prepare(session, String(trackId), Number(bitrate) || 160)
    send({ type: 'issue-ok', id, ...file })
  } catch (error) {
    send({ type: 'issue-err', id, error: String(error?.message ?? error).slice(0, 220) })
  }
})

// 崩溃时这里是唯一可靠信号：parentPort close → 主进程重建子进程
process.parentPort.on('close', () => {
  generation += 1
  files.clear()
  if (held) { closeQuietly(held.session); held = null }
})
