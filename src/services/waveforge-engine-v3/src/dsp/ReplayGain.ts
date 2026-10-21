/** ReplayGain 标签读取与安全解析（不依赖具体容器/解码器）。 */

export interface ReplayGainTags {
  trackGainDb: number | null
  albumGainDb: number | null
  trackPeak: number | null
  albumPeak: number | null
}

function findTag(tags: Record<string, unknown>, suffix: string): unknown {
  const key = Object.keys(tags).find((name) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase().replace(/[ .:-]/g, '_').replace(/^replay_gain_/, 'replaygain_') === suffix)
  return key === undefined ? undefined : tags[key]
}

function parseDb(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.max(-60, Math.min(24, value)) : null
  if (typeof value !== 'string') return null
  const match = value.trim().match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(?:\s*dB)?$/i)
  if (!match) return null
  const parsed = Number(match[1])
  return Number.isFinite(parsed) ? Math.max(-60, Math.min(24, parsed)) : null
}

function parsePeak(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(4, parsed) : null
}

/** 从 ID3/Vorbis/APE/MP4 风格的键值对象读取 ReplayGain 标签。键名比较不区分大小写。 */
export function parseReplayGainTags(tags: Record<string, unknown>): ReplayGainTags {
  const nested = tags.replayGain && typeof tags.replayGain === 'object' && !Array.isArray(tags.replayGain)
    ? tags.replayGain as Record<string, unknown> : {}
  return {
    trackGainDb: parseDb(findTag(tags, 'replaygain_track_gain') ?? findTag(nested, 'track_gain') ?? (typeof tags.replayGain === 'number' ? tags.replayGain : undefined)),
    albumGainDb: parseDb(findTag(tags, 'replaygain_album_gain') ?? findTag(nested, 'album_gain')),
    trackPeak: parsePeak(findTag(tags, 'replaygain_track_peak') ?? findTag(nested, 'track_peak')),
    albumPeak: parsePeak(findTag(tags, 'replaygain_album_peak') ?? findTag(nested, 'album_peak')),
  }
}

export function selectReplayGainDb(tags: ReplayGainTags, mode: 'track' | 'album'): number | null {
  return mode === 'album' ? tags.albumGainDb ?? tags.trackGainDb : tags.trackGainDb ?? tags.albumGainDb
}

const MAX_TAG_BYTES = 1024 * 1024

function u32le(data: Uint8Array, offset: number): number {
  return (data[offset] | data[offset + 1] << 8 | data[offset + 2] << 16 | data[offset + 3] << 24) >>> 0
}

function synchsafe(data: Uint8Array, offset: number): number {
  return data[offset] << 21 | data[offset + 1] << 14 | data[offset + 2] << 7 | data[offset + 3]
}

function decodeId3Text(bytes: Uint8Array, encoding: number): string {
  if (encoding === 0) return new TextDecoder('iso-8859-1').decode(bytes)
  if (encoding === 3) return new TextDecoder('utf-8').decode(bytes)
  if (encoding !== 1 && encoding !== 2) return ''
  const hasBom = encoding === 1 && bytes.length >= 2
    && ((bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0xff && bytes[1] === 0xfe))
  const byteOrder = encoding === 2 || (hasBom && bytes[0] === 0xfe) ? 'utf-16be' : 'utf-16le'
  const content = hasBom ? bytes.subarray(2) : bytes
  if (byteOrder === 'utf-16be') {
    const swapped = new Uint8Array(content.length)
    for (let i = 0; i + 1 < content.length; i += 2) { swapped[i] = content[i + 1]; swapped[i + 1] = content[i] }
    return new TextDecoder('utf-16le').decode(swapped)
  }
  return new TextDecoder('utf-16le').decode(content)
}

function scanId3(data: Uint8Array): Record<string, string> {
  const tags: Record<string, string> = {}
  if (data.length < 10 || String.fromCharCode(...data.subarray(0, 3)) !== 'ID3') return tags
  const version = data[3]
  if (version !== 3 && version !== 4) return tags
  const end = Math.min(data.length, 10 + synchsafe(data, 6))
  let offset = 10
  if (data[5] & 0x40) {
    if (offset + 4 > end) return tags
    offset += version === 4 ? synchsafe(data, offset) : 4 + ((data[offset] << 24 | data[offset + 1] << 16 | data[offset + 2] << 8 | data[offset + 3]) >>> 0)
  }
  while (offset + 10 <= end) {
    const id = String.fromCharCode(...data.subarray(offset, offset + 4))
    if (!/^[A-Z0-9]{4}$/.test(id)) break
    const size = version === 4 ? synchsafe(data, offset + 4)
      : ((data[offset + 4] << 24 | data[offset + 5] << 16 | data[offset + 6] << 8 | data[offset + 7]) >>> 0)
    const flags = data[offset + 9]
    offset += 10
    if (size <= 0 || offset + size > end) break
    if (id === 'TXXX' && (flags & 0x0c) === 0) {
      const payload = data.subarray(offset, offset + size)
      const encoding = payload[0]
      const width = encoding === 1 || encoding === 2 ? 2 : 1
      let separator = 1
      while (separator + width <= payload.length) {
        if (payload[separator] === 0 && (width === 1 || payload[separator + 1] === 0)) break
        separator += width === 2 ? 2 : 1
      }
      if (separator + width <= payload.length) {
        const key = decodeId3Text(payload.subarray(1, separator), encoding).trim()
        const value = decodeId3Text(payload.subarray(separator + width), encoding).replace(/\0+$/, '').trim()
        if (key) tags[key] = value
      }
    }
    offset += size
  }
  return tags
}

function scanApeV2Tags(data: Uint8Array): Record<string, string> {
  const tags: Record<string, string> = {}
  const signature = [0x41, 0x50, 0x45, 0x54, 0x41, 0x47, 0x45, 0x58] // APETAGEX
  for (let footerOffset = data.length - 32; footerOffset >= 0; footerOffset--) {
    let matches = true
    for (let i = 0; i < signature.length; i++) {
      if (data[footerOffset + i] !== signature[i]) { matches = false; break }
    }
    if (!matches) continue
    const version = u32le(data, footerOffset + 8)
    const tagSize = u32le(data, footerOffset + 12)
    const itemCount = u32le(data, footerOffset + 16)
    const flags = u32le(data, footerOffset + 20)
    if ((version !== 1000 && version !== 2000) || (flags & 0x20000000) !== 0 || tagSize < 32 || tagSize > MAX_TAG_BYTES
      || tagSize > footerOffset + 32 || itemCount > 4096) continue

    let offset = footerOffset + 32 - tagSize
    const itemsEnd = footerOffset
    const found: Record<string, string> = {}
    const decoder = new TextDecoder()
    let valid = true
    for (let item = 0; item < itemCount; item++) {
      if (offset + 8 > itemsEnd) { valid = false; break }
      const valueSize = u32le(data, offset)
      offset += 8 // value length and item flags
      let keyEnd = offset
      while (keyEnd < itemsEnd && data[keyEnd] !== 0) keyEnd++
      if (keyEnd === itemsEnd || valueSize > itemsEnd - keyEnd - 1) { valid = false; break }
      const key = decoder.decode(data.subarray(offset, keyEnd)).trim()
      offset = keyEnd + 1
      const value = decoder.decode(data.subarray(offset, offset + valueSize)).replace(/\0+$/, '').trim()
      if (key) found[key] = value
      offset += valueSize
    }
    if (valid) return found
  }
  return tags
}

function scanVorbisComments(data: Uint8Array, offset: number, end: number): Record<string, string> {
  const tags: Record<string, string> = {}
  if (offset + 8 > end) return tags
  const vendorLength = u32le(data, offset)
  offset += 4 + vendorLength
  if (offset + 4 > end) return tags
  const count = Math.min(u32le(data, offset), 4096)
  offset += 4
  for (let i = 0; i < count && offset + 4 <= end; i++) {
    const length = u32le(data, offset)
    offset += 4
    if (length > end - offset) break
    const comment = new TextDecoder().decode(data.subarray(offset, offset + length))
    const equals = comment.indexOf('=')
    if (equals > 0) tags[comment.slice(0, equals)] = comment.slice(equals + 1)
    offset += length
  }
  return tags
}

function scanOggComments(data: Uint8Array): Record<string, string> {
  const decoder = new TextDecoder()
  let offset = 0
  let packetParts: Uint8Array[] = []
  let packetLength = 0
  let discardContinuedPacket = false

  while (offset + 27 <= data.length) {
    if (data[offset] !== 0x4f || data[offset + 1] !== 0x67 || data[offset + 2] !== 0x67 || data[offset + 3] !== 0x53) break
    if (data[offset + 4] !== 0) break
    const continued = (data[offset + 5] & 1) !== 0
    const segmentCount = data[offset + 26]
    const tableStart = offset + 27
    const bodyStart = tableStart + segmentCount
    if (bodyStart > data.length) break
    if (continued !== (packetLength > 0 || discardContinuedPacket)) {
      packetParts = []
      packetLength = 0
      discardContinuedPacket = continued
    }

    let bodyOffset = bodyStart
    let pageValid = true
    for (let i = 0; i < segmentCount; i++) {
      const length = data[tableStart + i]
      const segmentEnd = bodyOffset + length
      if (segmentEnd > data.length) { pageValid = false; break }
      if (!discardContinuedPacket) {
        if (packetLength + length > MAX_TAG_BYTES) {
          packetParts = []
          packetLength = 0
          discardContinuedPacket = true
        } else if (length > 0) {
          packetParts.push(data.subarray(bodyOffset, segmentEnd))
          packetLength += length
        }
      }
      bodyOffset = segmentEnd

      if (length < 255) {
        if (discardContinuedPacket) {
          discardContinuedPacket = false
        } else if (packetLength > 0) {
          const packet = new Uint8Array(packetLength)
          let packetOffset = 0
          for (const part of packetParts) { packet.set(part, packetOffset); packetOffset += part.length }
          packetParts = []
          packetLength = 0

          let commentOffset = 0
          if (packet.length >= 8 && decoder.decode(packet.subarray(0, 8)) === 'OpusTags') {
            commentOffset = 8
          } else if (packet.length >= 7 && packet[0] === 3 && decoder.decode(packet.subarray(1, 7)) === 'vorbis') {
            commentOffset = 7
          }
          if (commentOffset) return scanVorbisComments(packet, commentOffset, packet.length)
        }
      }
    }
    if (!pageValid) break
    offset = bodyOffset
  }
  return {}
}

function readU32be(data: Uint8Array, offset: number): number {
  return (data[offset] * 0x1000000 + (data[offset + 1] << 16) + (data[offset + 2] << 8) + data[offset + 3]) >>> 0
}

interface Mp4Atom {
  type: string
  payloadStart: number
  end: number
}

function readMp4Atom(data: Uint8Array, offset: number, parentEnd: number): Mp4Atom | null {
  if (offset + 8 > parentEnd) return null
  let size = readU32be(data, offset)
  const type = String.fromCharCode(data[offset + 4], data[offset + 5], data[offset + 6], data[offset + 7])
  let headerSize = 8
  if (size === 1) {
    if (offset + 16 > parentEnd) return null
    const high = readU32be(data, offset + 8)
    const low = readU32be(data, offset + 12)
    if (high !== 0) return null
    size = low
    headerSize = 16
  } else if (size === 0) {
    size = parentEnd - offset
  }
  if (size < headerSize || size > parentEnd - offset) return null
  return { type, payloadStart: offset + headerSize, end: offset + size }
}

function scanMp4Freeform(data: Uint8Array, atom: Mp4Atom, tags: Record<string, string>): void {
  let offset = atom.payloadStart
  let name = ''
  let mean = ''
  let value = ''
  while (offset < atom.end) {
    const child = readMp4Atom(data, offset, atom.end)
    if (!child) break
    if ((child.type === 'mean' || child.type === 'name') && child.payloadStart + 4 <= child.end) {
      const text = new TextDecoder().decode(data.subarray(child.payloadStart + 4, child.end)).replace(/\0+$/, '').trim()
      if (child.type === 'mean') mean = text
      else name = text
    } else if (child.type === 'data' && child.payloadStart + 8 <= child.end) {
      value = new TextDecoder().decode(data.subarray(child.payloadStart + 8, child.end)).replace(/\0+$/, '').trim()
    }
    offset = child.end
  }
  if (name && (!mean || mean === 'com.apple.iTunes') && value) tags[name] = value
}

function scanMp4Atoms(data: Uint8Array, start: number, end: number, tags: Record<string, string>, depth = 0): void {
  if (depth > 8) return
  let offset = start
  while (offset < end) {
    const atom = readMp4Atom(data, offset, end)
    if (!atom) return
    if (atom.type === '----') {
      scanMp4Freeform(data, atom, tags)
    } else if (atom.type === 'moov' || atom.type === 'udta' || atom.type === 'ilst') {
      scanMp4Atoms(data, atom.payloadStart, atom.end, tags, depth + 1)
    } else if (atom.type === 'meta' && atom.payloadStart + 4 <= atom.end) {
      scanMp4Atoms(data, atom.payloadStart + 4, atom.end, tags, depth + 1)
    }
    offset = atom.end
  }
}

function scanMp4ReplayGain(data: Uint8Array): Record<string, string> {
  const tags: Record<string, string> = {}
  scanMp4Atoms(data, 0, data.length, tags)
  return tags
}

function scanMp4ReplayGainTail(data: Uint8Array): Record<string, string> {
  for (let typeOffset = 4; typeOffset <= data.length - 4; typeOffset++) {
    if (data[typeOffset] !== 0x6d || data[typeOffset + 1] !== 0x6f || data[typeOffset + 2] !== 0x6f || data[typeOffset + 3] !== 0x76) continue
    const atom = readMp4Atom(data, typeOffset - 4, data.length)
    if (!atom || atom.type !== 'moov') continue
    const tags: Record<string, string> = {}
    scanMp4Atoms(data, atom.payloadStart, atom.end, tags, 1)
    if (Object.keys(tags).length > 0) return tags
  }
  return {}
}

function isApeV2Candidate(url: string, response: Response): boolean {
  const type = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
  if (type === 'audio/mpeg' || type === 'audio/ape' || type === 'audio/x-ape' || type === 'audio/wavpack') return true
  return /\.(?:mp3|ape|wv|mpc)(?:$|[?#])/i.test(url)
}

function responseTotalLength(response: Response): number | null {
  const range = response.headers.get('content-range')?.match(/\/(\d+)$/)
  const value = range?.[1] ?? response.headers.get('content-length')
  const length = value ? Number(value) : NaN
  return Number.isSafeInteger(length) && length > 0 ? length : null
}

async function readResponseBytes(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array((await response.arrayBuffer()).slice(0, MAX_TAG_BYTES))
  const buffer = new Uint8Array(MAX_TAG_BYTES)
  let used = 0
  try {
    while (used < buffer.length) {
      const { done, value } = await reader.read()
      if (done) break
      const count = Math.min(value.length, buffer.length - used)
      buffer.set(value.subarray(0, count), used)
      used += count
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return buffer.subarray(0, used)
}

function hasReplayGain(tags: ReplayGainTags): boolean {
  return tags.trackGainDb !== null || tags.albumGainDb !== null || tags.trackPeak !== null || tags.albumPeak !== null
}

/** 扫描音频数据中的 ID3v2 TXXX、APEv2、FLAC/Ogg Vorbis Comment 与 MP4 iTunes 自由格式标签。 */
export function scanReplayGainBytes(data: Uint8Array): ReplayGainTags {
  const bytes = data.subarray(0, MAX_TAG_BYTES)
  if (bytes.length >= 4 && String.fromCharCode(...bytes.subarray(0, 4)) === 'OggS') {
    return parseReplayGainTags(scanOggComments(bytes))
  }
  if (bytes.length >= 8 && String.fromCharCode(...bytes.subarray(4, 8)) === 'ftyp') {
    return parseReplayGainTags(scanMp4ReplayGain(bytes))
  }
  const apeTags = scanApeV2Tags(bytes)
  if (Object.keys(apeTags).length > 0) return parseReplayGainTags(apeTags)
  if (bytes.length >= 4 && String.fromCharCode(...bytes.subarray(0, 4)) === 'fLaC') {
    let offset = 4
    while (offset + 4 <= bytes.length) {
      const blockType = bytes[offset] & 0x7f
      const last = (bytes[offset] & 0x80) !== 0
      const length = bytes[offset + 1] << 16 | bytes[offset + 2] << 8 | bytes[offset + 3]
      offset += 4
      if (offset + length > bytes.length) break
      if (blockType === 4) return parseReplayGainTags(scanVorbisComments(bytes, offset, offset + length))
      offset += length
      if (last) break
    }
  }
  return parseReplayGainTags(scanId3(bytes))
}

/** 有界读取源文件头；MP4 与 APEv2 候选源未命中时可额外读取至多 1 MiB 文件尾。 */
export async function scanReplayGainUrl(url: string, signal?: AbortSignal): Promise<ReplayGainTags> {
  const response = await fetch(url, { headers: { Range: `bytes=0-${MAX_TAG_BYTES - 1}` }, signal })
  if (!response.ok) throw new Error(`ReplayGain 标签读取失败：HTTP ${response.status}`)
  const totalLength = responseTotalLength(response)
  const head = await readResponseBytes(response)
  const tags = scanReplayGainBytes(head)
  const isMp4 = head.length >= 8 && String.fromCharCode(...head.subarray(4, 8)) === 'ftyp'
  const isApeCandidate = isApeV2Candidate(url, response)
  if (hasReplayGain(tags) || response.status !== 206 || head.length < MAX_TAG_BYTES || totalLength === null || totalLength <= head.length
    || (!isMp4 && !isApeCandidate)) return tags

  const tailStart = Math.max(head.length, totalLength - MAX_TAG_BYTES)
  if (tailStart >= totalLength) return tags
  const tailResponse = await fetch(url, { headers: { Range: `bytes=${tailStart}-${totalLength - 1}` }, signal })
  if (tailResponse.status !== 206) return tags
  const tail = await readResponseBytes(tailResponse)
  return parseReplayGainTags(isMp4 ? scanMp4ReplayGainTail(tail) : scanApeV2Tags(tail))
}

