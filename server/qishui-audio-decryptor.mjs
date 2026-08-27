/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 */
/**
 * 汽水音乐加密音频解密代理（server/qishui-audio-decryptor.mjs）
 *
 * 移植自 temp/SodaMusic_Qishui_Code/qishui-audio-decryptor/ 的三个参考文件
 * （decrypt-utils.js / mp4-box.js / track-decryptor.js，CommonJS → ESM），
 * 并对齐参考 server.js /api/audio 路由中「URL 带 #auth= 时走解密代理」的行为。
 *
 * 解决的问题：汽水音乐 VIP/高音质曲目下发的音频流是 CENC 加密的 fMP4
 * （spade_a 播放凭证 + AES-128-CTR 逐 sample 加密），前端 <audio> 直接拉上游
 * CDN 会静音。本模块在服务端完成：
 *   spade_a 凭证还原密钥 → moov/senc/stsz/stsc/stco 解析每 sample 的 IV 与长度
 *   → AES-CTR 逐 sample 解密 mdat → 重装为完整 FLAC 裸流或明文 fMP4(m4a)。
 *
 * 算法与参考实现保持一致（mp4 box 遍历规则、sample 划分、IV 截断/补零、
 * dfLa 元数据扫描、enca→mp4a 改写均有等价冒烟测试对拍），工程化差异：
 *  - 导出 Express 挂载函数 registerSodaAudioProxy(app)：
 *      GET /api/soda/audio?u=<base64url(原始加密流URL)>&k=<base64url(凭证json)>
 *  - 先整包缓冲再解密（稳定优先，同参考实现 getQishuiDecryptedAudio 的 arrayBuffer 策略；
 *    CENC 的 sample 表在 moov 内、mdat 可前可后，逐 sample 解密天然要求全量数据）；
 *  - 解密结果按 SHA1(cleanUrl+auth) 做有界内存 LRU 缓存：<audio> seek 会反复发
 *    Range 请求，缓存避免重复下载+解密；总字节数封顶防内存膨胀；
 *  - 上游请求带 UA/Referer（汽水/抖音系域名补 Referer）与整体超时；
 *  - 轻量 SSRF 校验：仅放行公网 http(s) 目标（私网/环回/链路本地字面地址与 DNS 解析
 *    结果均拒绝），与仓库 /api/cover 的防护口径一致；
 *  - Range 支持：206 分段 / 416 越界回包，无 Range 时全量 200。
 *
 * 已知限制：仅支持参考实现覆盖的容器形态——单音轨 CENC fMP4（stsd 含 dfLa 时重装为
 * FLAC，否则原容器重装为 m4a）；不支持多音轨/视频轨与 senc 子 sample 加密段。
 */

import crypto from 'node:crypto'
import dns from 'node:dns'

// ─────────────────────────── mp4 box 解析（移植 mp4-box.js） ───────────────────────────

class Mp4Box {
  constructor({ size, type, offset, data }) {
    this.size = size
    this.type = type
    this.offset = offset
    this.data = data
  }

  isEmpty() {
    return this.size === 0
  }

  static fromBuffer(buffer, offset) {
    if (!Buffer.isBuffer(buffer) || offset + 8 > buffer.length) {
      return new Mp4Box({
        size: 0,
        type: '',
        offset: 0,
        data: Buffer.alloc(0),
      })
    }

    const size = buffer.readUInt32BE(offset)
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii')
    const end = size >= 8 && offset + size <= buffer.length ? offset + size : buffer.length

    return new Mp4Box({
      size: end - offset,
      type,
      offset,
      data: buffer.subarray(offset + 8, end),
    })
  }

  static findBox(buffer, boxType, offset = 0, end = buffer.length) {
    let position = offset

    while (position < end) {
      if (position + 8 > end) {
        break
      }

      const size = buffer.readUInt32BE(position)
      if (size < 8 || position + size > end) {
        break
      }

      const type = buffer.subarray(position + 4, position + 8).toString('ascii')
      if (type === boxType) {
        return Mp4Box.fromBuffer(buffer, position)
      }

      position += size
    }

    return new Mp4Box({
      size: 0,
      type: '',
      offset: 0,
      data: Buffer.alloc(0),
    })
  }
}

// ─────────────────────────── 工具函数（移植 decrypt-utils.js） ───────────────────────────

function bitCount(value) {
  let current = value
  current = current - ((current >> 1) & 0x55555555)
  current = (current & 0x33333333) + ((current >> 2) & 0x33333333)
  return (((current + (current >> 4)) & 0x0f0f0f0f) * 0x01010101) >> 24
}

function decodeBase36(charCode) {
  if (charCode >= 48 && charCode <= 57) {
    return charCode - 48
  }

  if (charCode >= 97 && charCode <= 122) {
    return charCode - 97 + 10
  }

  return 0xff
}

/** spade_a 混淆内层还原（位运算混淆，算法与参考实现逐字节一致） */
function decryptSpadeInner(spadeKey) {
  const result = Buffer.from(spadeKey)
  const working = Buffer.alloc(spadeKey.length + 2)
  working[0] = 0xfa
  working[1] = 0x55
  spadeKey.copy(working, 2)

  for (let index = 0; index < result.length; index += 1) {
    let value = (spadeKey[index] ^ working[index]) - bitCount(index) - 21

    while (value < 0) {
      value += 0xff
    }

    result[index] = value & 0xff
  }

  return result
}

/** spade 凭证 blob → 明文 keyHex 字符串 */
function decryptSpade(spadeKeyBytes) {
  if (!Buffer.isBuffer(spadeKeyBytes) || spadeKeyBytes.length < 3) {
    return ''
  }

  const paddingLength = (spadeKeyBytes[0] ^ spadeKeyBytes[1] ^ spadeKeyBytes[2]) - 48
  if (spadeKeyBytes.length < paddingLength + 2) {
    return ''
  }

  const innerInput = spadeKeyBytes.subarray(1, spadeKeyBytes.length - paddingLength)
  const tempBuffer = decryptSpadeInner(innerInput)

  if (tempBuffer.length === 0) {
    return ''
  }

  const skipBytes = decodeBase36(tempBuffer[0])
  const decodedMessageLength = spadeKeyBytes.length - paddingLength - 2
  const endIndex = 1 + decodedMessageLength - skipBytes

  if (endIndex > tempBuffer.length) {
    return ''
  }

  return tempBuffer.subarray(1, endIndex).toString('utf8')
}

/** base64 形态的 spade_a 凭证还原；非凭证输入返回空串 */
export function decryptSpadeA(spadeA) {
  try {
    return decryptSpade(Buffer.from(String(spadeA || ''), 'base64'))
  } catch {
    return ''
  }
}

function hexToBuffer(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0) {
    throw new Error('Hex string length must be even.')
  }

  return Buffer.from(hex, 'hex')
}

/** sample 维度 AES-128-CTR 解密（CTR 模式加解密同构） */
function aesCtrDecrypt(key, iv, encrypted) {
  const decipher = crypto.createDecipheriv('aes-128-ctr', key, iv)
  return Buffer.concat([decipher.update(encrypted), decipher.final()])
}

/** stsz → 每 sample 字节长度表 */
function parseStsz(data) {
  const sampleSize = data.readUInt32BE(4)
  const count = data.readUInt32BE(8)

  if (sampleSize !== 0) {
    return Array.from({ length: count }, () => sampleSize)
  }

  const sizes = []
  for (let index = 0; index < count; index += 1) {
    sizes.push(data.readUInt32BE(12 + index * 4))
  }

  return sizes
}

/** stsc → chunk-sample 映射表（顺序流式解密用不到，保留以维持解析完整性校验） */
function parseStsc(data) {
  const entryCount = data.readUInt32BE(4)
  const entries = []

  for (let index = 0; index < entryCount; index += 1) {
    const base = 8 + index * 12
    entries.push({
      firstChunk: data.readUInt32BE(base),
      samplesPerChunk: data.readUInt32BE(base + 4),
      id: data.readUInt32BE(base + 8),
    })
  }

  return entries
}

/**
 * senc → 每 sample 的 IV 表。
 * 参考实现的汽水流固定使用 8 字节 IV（读 8 位、右侧补零到 CTR 要求的 16 字节）。
 */
function parseSenc(data) {
  const count = data.readUInt32BE(4)
  const ivs = []
  let position = 8

  for (let index = 0; index < count; index += 1) {
    const iv = Buffer.alloc(16)
    data.copy(iv, 0, position, position + 8)
    ivs.push(iv)
    position += 8
  }

  return ivs
}

/**
 * 在 stsd 载荷中扫描 'dfLa'（FLAC in MP4 注册框）。
 * 命中则返回 dfLa 框体内容（调用方会剥掉 4 字节 version/flags 得到原生 FLAC 元数据块），
 * 未命中返回空 —— 以此区分「重装为 .flac」还是「重装为 .m4a」。
 */
function scanForFlacMetadata(stsdData) {
  const marker = Buffer.from([0x64, 0x66, 0x4c, 0x61])
  const index = stsdData.indexOf(marker)

  if (index === -1 || index < 4) {
    return Buffer.alloc(0)
  }

  const boxSize = stsdData.readUInt32BE(index - 4)
  const contentStart = index + 4
  const contentEnd = Math.min(index - 4 + boxSize, stsdData.length)

  if (contentEnd <= contentStart) {
    return Buffer.alloc(0)
  }

  return stsdData.subarray(contentStart, contentEnd)
}

/** m4a 重装路径：把加密音频采样项描述符 enca 改写为明文 mp4a，让普通解复用器接受 */
function replaceEncaWithMp4a(buffer, searchStart, searchEnd) {
  const target = Buffer.from('enca')
  const replacement = Buffer.from('mp4a')

  for (let index = searchStart; index + 4 <= searchEnd; index += 1) {
    if (buffer.subarray(index, index + 4).equals(target)) {
      replacement.copy(buffer, index)
      break
    }
  }
}

// ─────────────────────────── 主解密流程（移植 track-decryptor.js） ───────────────────────────

/** spade_a → AES 密钥：纯 hex 直接用，否则按 base64 spade 凭证还原 */
export function resolveSodaTrackKey(spadeA) {
  if (!spadeA) {
    throw new Error('缺少 spade_a 播放凭证，无法解密汽水音频。')
  }

  const isHex = /^[0-9a-fA-F]+$/.test(spadeA)
  const keyHex = isHex ? spadeA : decryptSpadeA(spadeA)

  if (!keyHex) {
    throw new Error('无法从 spade_a 凭证还原解密密钥。')
  }

  const key = hexToBuffer(keyHex)
  if (key.length !== 16) {
    throw new Error('解密密钥长度非法（期望 AES-128 的 16 字节）。')
  }

  return key
}

/** 顺序解密全部 sample：mdat 数据区从 mdat 头后开始按 stsz 依次切分 */
function decryptSampleList(fileBuffer, key, sampleSizes, ivs, mdatOffset) {
  const decryptedSamples = []
  let sampleOffset = mdatOffset + 8

  for (let index = 0; index < sampleSizes.length; index += 1) {
    const size = sampleSizes[index]
    const iv = ivs[index]

    if (!iv) {
      throw new Error('sample ' + index + ' 缺少解密 IV。')
    }

    const encrypted = fileBuffer.subarray(sampleOffset, sampleOffset + size)
    if (encrypted.length < size) {
      throw new Error('sample ' + index + ' 数据不完整（mdat 被截断）。')
    }
    decryptedSamples.push(aesCtrDecrypt(key, iv, encrypted))
    sampleOffset += size
  }

  return decryptedSamples
}

/** FLAC 重装：fLaC 魔数 + 原生元数据块 + 解密后的帧序列 */
function buildFlacFile(flacMetadata, decryptedSamples) {
  const flacSignature = Buffer.from('fLaC')
  const metadataBody = flacMetadata.length > 4
    ? flacMetadata.subarray(4)
    : flacMetadata

  return Buffer.concat([flacSignature, metadataBody, ...decryptedSamples])
}

/** m4a 重装：原容器骨架不变，把解密后的 sample 原地覆写回 mdat 数据区 */
function buildM4aFile(fileBuffer, decryptedSamples, mdat, stsd) {
  const output = Buffer.from(fileBuffer)
  let writePointer = mdat.offset + 8

  for (const sample of decryptedSamples) {
    sample.copy(output, writePointer)
    writePointer += sample.length
  }

  replaceEncaWithMp4a(output, stsd.offset, stsd.offset + stsd.size)
  return output
}

/**
 * 解密一首汽水加密曲目（对应参考 TrackDecryptor.decrypt）。
 * @returns {{ buffer: Buffer, extension: '.flac'|'.m4a', contentType: string, meta: object }}
 */
export function decryptSodaTrack({ encryptedBuffer, spadeA }) {
  if (!Buffer.isBuffer(encryptedBuffer) || encryptedBuffer.length === 0) {
    throw new Error('encryptedBuffer 必须是非空 Buffer。')
  }

  const key = resolveSodaTrackKey(spadeA)

  const moov = Mp4Box.findBox(encryptedBuffer, 'moov')
  if (moov.isEmpty()) {
    throw new Error("解密失败：未找到 'moov' atom。")
  }

  const trak = Mp4Box.findBox(encryptedBuffer, 'trak', moov.offset + 8, moov.offset + moov.size)
  const mdia = Mp4Box.findBox(encryptedBuffer, 'mdia', trak.offset + 8, trak.offset + trak.size)
  const minf = Mp4Box.findBox(encryptedBuffer, 'minf', mdia.offset + 8, mdia.offset + mdia.size)
  const stbl = Mp4Box.findBox(encryptedBuffer, 'stbl', minf.offset + 8, minf.offset + minf.size)
  const stsd = Mp4Box.findBox(encryptedBuffer, 'stsd', stbl.offset + 8, stbl.offset + stbl.size)
  const stsz = Mp4Box.findBox(encryptedBuffer, 'stsz', stbl.offset + 8, stbl.offset + stbl.size)
  const stsc = Mp4Box.findBox(encryptedBuffer, 'stsc', stbl.offset + 8, stbl.offset + stbl.size)
  const stco = Mp4Box.findBox(encryptedBuffer, 'stco', stbl.offset + 8, stbl.offset + stbl.size)

  // senc 优先在 moov 直属层找（片段形态），回落到 stbl 内（普通形态）
  let senc = Mp4Box.findBox(encryptedBuffer, 'senc', moov.offset + 8, moov.offset + moov.size)
  if (senc.isEmpty()) {
    senc = Mp4Box.findBox(encryptedBuffer, 'senc', stbl.offset + 8, stbl.offset + stbl.size)
  }

  if (senc.isEmpty()) {
    throw new Error("解密失败：未找到 'senc' atom（该流可能不是 CENC 加密形态）。")
  }

  const mdat = Mp4Box.findBox(encryptedBuffer, 'mdat')
  if (mdat.isEmpty()) {
    throw new Error("解密失败：未找到 'mdat' atom。")
  }

  const flacMetadata = scanForFlacMetadata(stsd.data)
  const isFlac = flacMetadata.length > 0

  const sampleSizes = parseStsz(stsz.data)
  parseStsc(stsc.data)
  const chunkCount = stco.data.readUInt32BE(4)
  const ivs = parseSenc(senc.data)

  if (sampleSizes.length !== ivs.length) {
    throw new Error('解密失败：sample 数量 ' + sampleSizes.length + ' 与 IV 数量 ' + ivs.length + ' 不一致。')
  }

  const decryptedSamples = decryptSampleList(encryptedBuffer, key, sampleSizes, ivs, mdat.offset)

  const outputBuffer = isFlac
    ? buildFlacFile(flacMetadata, decryptedSamples)
    : buildM4aFile(encryptedBuffer, decryptedSamples, mdat, stsd)

  const extension = isFlac ? '.flac' : '.m4a'
  const contentType = isFlac ? 'audio/flac' : 'audio/mp4'

  return {
    buffer: outputBuffer,
    extension,
    contentType,
    meta: {
      isFlac,
      sampleCount: sampleSizes.length,
      chunkCount,
    },
  }
}

// ─────────────────────────── URL 包装 / 还原 ───────────────────────────

const SODA_AUDIO_PROXY_PATH = '/api/soda/audio'

/** 后端本机基址：桌面端约定 localhost:3001，PORT 环境变量可覆盖（前端直用返回 url 播放） */
function sodaAudioProxyOrigin() {
  const port = Number(process.env.PORT) > 0 ? Number(process.env.PORT) : 3001
  return 'http://localhost:' + port
}

function b64urlEncodeUtf8(text) {
  return Buffer.from(String(text), 'utf8').toString('base64url')
}

function b64urlDecodeUtf8(text) {
  return Buffer.from(String(text), 'base64').toString('utf8')
}

function decodeUriSafe(text) {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/**
 * 把带 #auth= 凭证的汽水 CDN 地址包装为本代理地址：
 *   url 不含 #auth= → 原样返回（非加密流无需解密）；
 *   url 含 #auth=   → http://localhost:<port>/api/soda/audio?u=<b64url(cleanUrl)>&k=<b64url({"auth":...})>
 * 无法解析出合法 http(s) 地址时同样原样返回，宁可退回旧行为也不下发坏链。
 */
export function sodaWrapAudioUrl(url, auth) {
  const text = String(url || '')
  const idx = text.indexOf('#auth=')
  if (idx < 0) return text

  const cleanUrl = text.slice(0, idx)
  let credential = decodeUriSafe(text.slice(idx + 6))
  if (!credential && auth) credential = String(auth)
  if (!credential || !/^https?:\/\//i.test(cleanUrl)) return text

  return (
    sodaAudioProxyOrigin() +
    SODA_AUDIO_PROXY_PATH +
    '?u=' + b64urlEncodeUtf8(cleanUrl) +
    '&k=' + b64urlEncodeUtf8(JSON.stringify({ auth: credential }))
  )
}

/** 从 k 参数还原凭证：兼容 {"auth"|"spade_a"|"spadeA"|"play_auth": "..."} JSON 信封与裸字符串 */
function extractSodaCredential(kRaw) {
  const text = b64urlDecodeUtf8(kRaw)
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object') {
      for (const field of ['auth', 'spade_a', 'spadeA', 'play_auth']) {
        if (typeof parsed[field] === 'string' && parsed[field]) return parsed[field]
      }
    }
  } catch {
    // 非 JSON：按裸凭证字符串处理
  }
  return text.trim()
}

/** 从 u/k 查询参数还原 { cleanUrl, credential }；参数非法返回 null */
export function sodaUnwrapAudioParams(uParam, kParam) {
  if (!uParam || !kParam) return null
  let cleanUrl = ''
  try {
    cleanUrl = b64urlDecodeUtf8(uParam)
  } catch {
    return null
  }
  if (!/^https?:\/\//i.test(cleanUrl)) return null
  const credential = extractSodaCredential(kParam)
  if (!credential) return null
  return { cleanUrl, credential }
}

// ─────────────────────────── 上游拉取（UA/Referer/超时/SSRF 校验） ───────────────────────────

const SODA_PROXY_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/** 上游整体超时（响应头+body 一并覆盖）；单曲加密 fMP4 通常 <60MB */
const SODA_UPSTREAM_TIMEOUT_MS = 30_000
/** 单次拉取体积上限，防御异常大响应拖垮内存 */
const SODA_UPSTREAM_MAX_BYTES = 512 * 1024 * 1024

/** 私网/环回/链路本地判断（口径与 local-server 的 isPrivateNetworkAddress 一致） */
function isPrivateNetworkAddress(address) {
  if (address.includes(':')) {
    const lower = address.toLowerCase()
    if (lower === '::' || lower === '::1' || lower === '0:0:0:0:0:0:0:0' || lower === '0:0:0:0:0:0:0:1') return true
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true
    return false
  }
  const parts = address.split('.').map(Number)
  if (parts.length !== 4) return false
  const [a, b] = parts
  return a === 0 || a === 127 || a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
}

/** SSRF 校验：目标必须是解析到公网的 http(s) 地址；返回拒绝原因或空串 */
async function sodaUpstreamBlockReason(rawUrl) {
  let parsed
  try {
    parsed = new URL(rawUrl)
  } catch {
    return '无效的音频地址'
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return '仅允许 http(s) 音频地址'
  }
  const hostname = String(parsed.hostname || '').replace(/^\[|\]$/g, '')
  if (!hostname) return '音频地址缺少主机名'

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
    if (hostname.split('.').some((part) => Number(part) > 255)) return '音频地址指向非法 IP'
    return isPrivateNetworkAddress(hostname) ? '禁止代理内网/本机音频地址' : ''
  }
  if (hostname.includes(':')) {
    return isPrivateNetworkAddress(hostname) ? '禁止代理内网/本机音频地址' : ''
  }

  const name = hostname.toLowerCase()
  if (name === 'localhost' || name.endsWith('.local')) return '禁止代理本机音频地址'
  try {
    const addresses = await Promise.race([
      dns.promises.lookup(name, { all: true, verbatim: true }),
      new Promise((resolve, reject) => setTimeout(() => reject(new Error('dns timeout')), 3000)),
    ])
    return addresses.some(({ address }) => isPrivateNetworkAddress(address))
      ? '禁止代理内网/本机音频地址'
      : ''
  } catch {
    return '音频域名解析失败，已保守拒绝'
  }
}

/** 汽水 CDN 请求头：浏览器 UA + 抖音系域名补 Referer 防盗链 */
function sodaUpstreamHeaders(audioUrl) {
  const headers = { 'User-Agent': SODA_PROXY_UA }
  try {
    const host = new URL(audioUrl).hostname.toLowerCase()
    if (/qishui\.com|douyin|byteimg|zijieapi|bytedance/.test(host)) {
      headers.Referer = 'https://www.qishui.com/'
    }
  } catch {
    // URL 已在校验阶段解析过，这里兜底忽略
  }
  return headers
}

/** 拉取完整上游加密流（整包缓冲，稳定优先） */
async function fetchSodaEncryptedStream(cleanUrl) {
  const blockReason = await sodaUpstreamBlockReason(cleanUrl)
  if (blockReason) {
    const err = new Error(blockReason)
    err.statusCode = 400
    throw err
  }

  let response
  try {
    response = await fetch(cleanUrl, {
      headers: sodaUpstreamHeaders(cleanUrl),
      redirect: 'follow',
      signal: AbortSignal.timeout(SODA_UPSTREAM_TIMEOUT_MS),
    })
  } catch (err) {
    const reason = err && err.name === 'TimeoutError' ? '上游音频拉取超时' : '上游音频连接失败：' + ((err && err.message) || err)
    const wrapped = new Error(reason)
    wrapped.statusCode = 502
    throw wrapped
  }

  if (!response.ok) {
    const wrapped = new Error('上游音频拉取失败：HTTP ' + response.status)
    wrapped.statusCode = 502
    throw wrapped
  }

  const declaredLength = Number(response.headers.get('content-length') || 0)
  if (declaredLength > SODA_UPSTREAM_MAX_BYTES) {
    const wrapped = new Error('上游音频体积超出代理上限（' + Math.round(SODA_UPSTREAM_MAX_BYTES / 1024 / 1024) + 'MB）')
    wrapped.statusCode = 502
    throw wrapped
  }

  const reader = response.body.getReader()
  const chunks = []
  let received = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.length
    if (received > SODA_UPSTREAM_MAX_BYTES) {
      try { await reader.cancel() } catch { /* 忽略取消错误 */ }
      const wrapped = new Error('上游音频体积超出代理上限（' + Math.round(SODA_UPSTREAM_MAX_BYTES / 1024 / 1024) + 'MB）')
      wrapped.statusCode = 502
      throw wrapped
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

// ─────────────────────────── 解密结果缓存（seek 场景避免重复下载+解密） ───────────────────────────

const SODA_DECRYPT_CACHE_MAX_BYTES = 256 * 1024 * 1024
const SODA_DECRYPT_CACHE_MAX_ENTRIES = 12
const sodaDecryptCache = new Map()
let sodaDecryptCacheBytes = 0

function sodaDecryptCacheKey(cleanUrl, credential) {
  return crypto.createHash('sha1').update(cleanUrl + '\n' + credential).digest('hex')
}

function rememberDecryptedAudio(key, payload) {
  if (!payload || !Buffer.isBuffer(payload.buffer)) return
  if (payload.buffer.length > SODA_DECRYPT_CACHE_MAX_BYTES) return
  const existing = sodaDecryptCache.get(key)
  if (existing) {
    sodaDecryptCacheBytes -= existing.buffer.length
    sodaDecryptCache.delete(key)
  }
  sodaDecryptCache.set(key, Object.assign({ at: Date.now() }, payload))
  sodaDecryptCacheBytes += payload.buffer.length
  while (
    (sodaDecryptCacheBytes > SODA_DECRYPT_CACHE_MAX_BYTES || sodaDecryptCache.size > SODA_DECRYPT_CACHE_MAX_ENTRIES) &&
    sodaDecryptCache.size > 1
  ) {
    const oldest = [...sodaDecryptCache.entries()].sort((a, b) => (a[1].at || 0) - (b[1].at || 0))[0]
    if (!oldest) break
    sodaDecryptCacheBytes -= oldest[1].buffer.length
    sodaDecryptCache.delete(oldest[0])
  }
}

async function getSodaDecryptedAudio(cleanUrl, credential) {
  const key = sodaDecryptCacheKey(cleanUrl, credential)
  const cached = sodaDecryptCache.get(key)
  if (cached) {
    cached.at = Date.now()
    return cached
  }
  const encryptedBuffer = await fetchSodaEncryptedStream(cleanUrl)
  const result = decryptSodaTrack({ encryptedBuffer, spadeA: credential })
  const payload = { buffer: result.buffer, contentType: result.contentType, extension: result.extension }
  rememberDecryptedAudio(key, payload)
  return payload
}

// ─────────────────────────── 响应输出（Range 206 / 全量 200，移植 sendAudioBuffer） ───────────────────────────

function sendSodaAudioBuffer(res, buffer, contentType, rangeHeader) {
  const total = buffer.length
  const match = /^bytes=(\d*)-(\d*)$/i.exec(String(rangeHeader || ''))
  if (match) {
    let start = match[1] ? Number(match[1]) : 0
    let end = match[2] ? Number(match[2]) : total - 1
    if (!Number.isFinite(start) || start < 0) start = 0
    if (!Number.isFinite(end) || end >= total) end = total - 1
    if (start > end || start >= total) {
      res.writeHead(416, { 'Content-Range': 'bytes */' + total })
      res.end()
      return
    }
    res.writeHead(206, {
      'Content-Type': contentType || 'audio/mp4',
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Range': 'bytes ' + start + '-' + end + '/' + total,
      'Cache-Control': 'no-store',
    })
    res.end(buffer.subarray(start, end + 1))
    return
  }
  res.writeHead(200, {
    'Content-Type': contentType || 'audio/mp4',
    'Access-Control-Allow-Origin': '*',
    'Accept-Ranges': 'bytes',
    'Content-Length': total,
    'Cache-Control': 'no-store',
  })
  res.end(buffer)
}

// ─────────────────────────── Express 路由挂载 ───────────────────────────

/**
 * 注册 GET /api/soda/audio 解密代理路由。
 * 用法（local-server.mjs）：registerSodaAudioProxy(app)
 */
export function registerSodaAudioProxy(app) {
  app.get(SODA_AUDIO_PROXY_PATH, async (req, res) => {
    try {
      const parsed = sodaUnwrapAudioParams(req.query.u, req.query.k)
      if (!parsed) {
        return res.status(400).json({
          error: '参数缺失或非法：需要 u=<base64url(原始加密流URL)> 与 k=<base64url(播放凭证json)>',
        })
      }

      const payload = await getSodaDecryptedAudio(parsed.cleanUrl, parsed.credential)
      sendSodaAudioBuffer(res, payload.buffer, payload.contentType, req.headers.range)
    } catch (err) {
      const message = String((err && err.message) || err || '解密代理失败')
      console.error('[Soda/AudioProxy]', message)
      if (res.headersSent) {
        try { res.destroy() } catch { /* 忽略 */ }
        return
      }
      const status = Number(err && err.statusCode) === 400 ? 400 : 502
      res.status(status).json({ error: '汽水音频解密代理失败：' + message })
    }
  })
}
