import { describe, expect, it } from 'vitest'
import { parseReplayGainTags, scanReplayGainBytes, scanReplayGainUrl, selectReplayGainDb } from '../src/dsp/ReplayGain'
import { EngineV3 } from '../src/engine/EngineV3'
import { decodeShareCode, encodeShareCode } from '../src/engine/ShareCodec'
import { createDefaultParams } from '../src/types'

function oggPage(sequence: number, continued: boolean, segments: Uint8Array[]): Uint8Array {
  const header = new Uint8Array(27 + segments.length)
  header.set(new TextEncoder().encode('OggS'))
  header[4] = 0
  header[5] = continued ? 1 : 0
  header[18] = sequence & 0xff
  header[22] = (sequence >>> 8) & 0xff
  header[26] = segments.length
  const body = new Uint8Array(segments.reduce((sum, segment) => sum + segment.length, 0))
  let offset = 0
  segments.forEach((segment, index) => {
    header[27 + index] = segment.length
    body.set(segment, offset)
    offset += segment.length
  })
  return Uint8Array.from([...header, ...body])
}

function vorbisCommentPacket(signature: 'opus' | 'vorbis', comments: string[]): Uint8Array {
  const encoder = new TextEncoder()
  const prefix = signature === 'opus' ? encoder.encode('OpusTags') : Uint8Array.from([3, ...encoder.encode('vorbis')])
  const vendor = encoder.encode('WaveForge test')
  const values = comments.map((comment) => encoder.encode(comment))
  const length = prefix.length + 4 + vendor.length + 4 + values.reduce((sum, value) => sum + 4 + value.length, 0)
  const packet = new Uint8Array(length)
  let offset = 0
  packet.set(prefix, offset); offset += prefix.length
  packet[offset++] = vendor.length; offset += 3
  packet.set(vendor, offset); offset += vendor.length
  packet[offset++] = values.length; offset += 3
  for (const value of values) {
    packet[offset++] = value.length; offset += 3
    packet.set(value, offset); offset += value.length
  }
  return packet
}

function mp4Atom(type: string, payload: Uint8Array, extended = false): Uint8Array {
  const headerLength = extended ? 16 : 8
  const atom = new Uint8Array(headerLength + payload.length)
  const view = new DataView(atom.buffer)
  view.setUint32(0, extended ? 1 : atom.length, false)
  atom.set(new TextEncoder().encode(type), 4)
  if (extended) {
    view.setUint32(8, 0, false)
    view.setUint32(12, atom.length, false)
  }
  atom.set(payload, headerLength)
  return atom
}

function joinBytes(...parts: Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) { joined.set(part, offset); offset += part.length }
  return joined
}

function apeV2Tag(entries: Array<[string, string]>, trailingId3v1 = false): Uint8Array {
  const encoder = new TextEncoder()
  const items = entries.map(([key, value]) => {
    const keyBytes = encoder.encode(key)
    const valueBytes = encoder.encode(value)
    const item = new Uint8Array(8 + keyBytes.length + 1 + valueBytes.length)
    const view = new DataView(item.buffer)
    view.setUint32(0, valueBytes.length, true)
    view.setUint32(4, 0, true)
    item.set(keyBytes, 8)
    item.set(valueBytes, 9 + keyBytes.length)
    return item
  })
  const itemData = joinBytes(...items)
  const footer = new Uint8Array(32)
  footer.set(encoder.encode('APETAGEX'))
  const view = new DataView(footer.buffer)
  view.setUint32(8, 2000, true)
  view.setUint32(12, itemData.length + 32, true)
  view.setUint32(16, entries.length, true)
  view.setUint32(20, 0, true)
  const id3v1 = trailingId3v1 ? new Uint8Array(128).fill(0) : new Uint8Array()
  return joinBytes(itemData, footer, id3v1)
}

describe('ReplayGain 标签', () => {
  it.each(['vorbis', 'opus'] as const)('从 Ogg %s 注释包解析 ReplayGain 并支持跨页分片', (signature) => {
    const identification = new TextEncoder().encode(signature === 'opus' ? 'OpusHead' : '\x01vorbis')
    const packet = vorbisCommentPacket(signature, [
      'REPLAYGAIN_TRACK_GAIN=-4.25 dB', 'REPLAYGAIN_ALBUM_GAIN=-2.00 dB', 'REPLAYGAIN_TRACK_PEAK=0.91',
      `PADDING=${'x'.repeat(300)}`,
    ])
    expect(packet.length).toBeGreaterThan(255)
    const first = oggPage(0, false, [identification, packet.subarray(0, 255)])
    const second = oggPage(1, true, [packet.subarray(255)])
    const bytes = new Uint8Array(first.length + second.length)
    bytes.set(first); bytes.set(second, first.length)
    expect(scanReplayGainBytes(bytes)).toEqual({ trackGainDb: -4.25, albumGainDb: -2, trackPeak: 0.91, albumPeak: null })
  })

  it('从 MP4 iTunes 自由格式 atom 读取 ReplayGain 并接受扩展 atom 长度', () => {
    const encoder = new TextEncoder()
    const fullAtomPayload = (text: string) => joinBytes(new Uint8Array(4), encoder.encode(text))
    const mean = mp4Atom('mean', fullAtomPayload('com.apple.iTunes'))
    const name = mp4Atom('name', fullAtomPayload('replaygain_track_gain'))
    const data = mp4Atom('data', joinBytes(Uint8Array.from([0, 0, 0, 1, 0, 0, 0, 0]), encoder.encode('-3.75 dB')))
    const freeform = mp4Atom('----', joinBytes(mean, name, data))
    const ilst = mp4Atom('ilst', freeform)
    const meta = mp4Atom('meta', joinBytes(new Uint8Array(4), ilst))
    const moov = mp4Atom('moov', mp4Atom('udta', meta), true)
    const file = joinBytes(mp4Atom('ftyp', encoder.encode('M4A ')), moov)
    expect(scanReplayGainBytes(file).trackGainDb).toBe(-3.75)
  })

  it('MP4 的 moov 位于文件尾时请求有限尾段并读取标签', async () => {
    const encoder = new TextEncoder()
    const fullAtomPayload = (text: string) => joinBytes(new Uint8Array(4), encoder.encode(text))
    const freeform = mp4Atom('----', joinBytes(
      mp4Atom('mean', fullAtomPayload('com.apple.iTunes')),
      mp4Atom('name', fullAtomPayload('replaygain_album_gain')),
      mp4Atom('data', joinBytes(Uint8Array.from([0, 0, 0, 1, 0, 0, 0, 0]), encoder.encode('-2.50 dB'))),
    ))
    const moov = mp4Atom('moov', mp4Atom('udta', mp4Atom('meta', joinBytes(new Uint8Array(4), mp4Atom('ilst', freeform)))))
    const file = joinBytes(mp4Atom('ftyp', encoder.encode('M4A ')), mp4Atom('mdat', new Uint8Array(1_100_000).fill(0x7e)), moov)
    const previousFetch = globalThis.fetch
    const requests: string[] = []
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const range = new Headers(init?.headers).get('Range')!
      requests.push(range)
      const [, startText, endText] = range.match(/^bytes=(\d+)-(\d+)$/)!
      const start = Number(startText)
      const end = Math.min(Number(endText), file.length - 1)
      return new Response(file.subarray(start, end + 1), {
        status: 206,
        headers: { 'Content-Range': `bytes ${start}-${end}/${file.length}` },
      })
    }) as typeof fetch
    try {
      expect(await scanReplayGainUrl('https://example.test/audio.m4a')).toMatchObject({ albumGainDb: -2.5 })
    } finally {
      globalThis.fetch = previousFetch
    }
    expect(requests).toHaveLength(2)
    expect(requests[1]).toMatch(/^bytes=\d+-\d+$/)
  })

  it('从 APEv2 footer 读取标签，包括后置 ID3v1 数据', () => {
    const tag = apeV2Tag([
      ['REPLAYGAIN_TRACK_GAIN', '-5.25 dB'],
      ['REPLAYGAIN_ALBUM_PEAK', '0.95'],
    ], true)
    expect(scanReplayGainBytes(tag)).toEqual({ trackGainDb: -5.25, albumGainDb: null, trackPeak: null, albumPeak: 0.95 })
  })

  it('MP3 的 APEv2 标签位于文件尾时请求有限范围并解析 ReplayGain', async () => {
    const encoder = new TextEncoder()
    const file = joinBytes(encoder.encode('ID3'), new Uint8Array(1_100_000), apeV2Tag([['REPLAYGAIN_TRACK_GAIN', '-4.75 dB']]))
    const previousFetch = globalThis.fetch
    const requests: string[] = []
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const range = new Headers(init?.headers).get('Range')!
      requests.push(range)
      const [, startText, endText] = range.match(/^bytes=(\d+)-(\d+)$/)!
      const start = Number(startText)
      const end = Math.min(Number(endText), file.length - 1)
      return new Response(file.subarray(start, end + 1), {
        status: 206,
        headers: { 'Content-Range': `bytes ${start}-${end}/${file.length}`, 'Content-Type': 'audio/mpeg' },
      })
    }) as typeof fetch
    try {
      expect(await scanReplayGainUrl('https://example.test/audio.mp3')).toMatchObject({ trackGainDb: -4.75 })
    } finally {
      globalThis.fetch = previousFetch
    }
    expect(requests).toHaveLength(2)
  })

  it('服务器忽略 Range 时不重复请求文件头来冒充 MP4 尾段', async () => {
    const encoder = new TextEncoder()
    const file = joinBytes(mp4Atom('ftyp', encoder.encode('M4A ')), mp4Atom('mdat', new Uint8Array(1_100_000)))
    const previousFetch = globalThis.fetch
    let requestCount = 0
    globalThis.fetch = (async () => {
      requestCount++
      return new Response(file.subarray(0, 1024 * 1024), {
        status: 200,
        headers: { 'Content-Length': String(file.length) },
      })
    }) as typeof fetch
    try {
      expect(await scanReplayGainUrl('https://example.test/no-range.m4a')).toEqual({
        trackGainDb: null, albumGainDb: null, trackPeak: null, albumPeak: null,
      })
    } finally {
      globalThis.fetch = previousFetch
    }
    expect(requestCount).toBe(1)
  })

  it('扫描 ID3v2 TXXX 与 FLAC Vorbis Comment 文件头', () => {
    const encoder = new TextEncoder()
    const description = encoder.encode('REPLAYGAIN_TRACK_GAIN')
    const value = encoder.encode('-7.23 dB')
    const frame = Uint8Array.from([0, ...description, 0, ...value])
    const id3 = new Uint8Array(10 + 10 + frame.length)
    id3.set(encoder.encode('ID3'), 0)
    id3[3] = 3
    id3[9] = 10 + frame.length
    id3.set(encoder.encode('TXXX'), 10)
    id3[17] = frame.length
    id3.set(frame, 20)
    expect(scanReplayGainBytes(id3).trackGainDb).toBe(-7.23)

    const comment = encoder.encode('REPLAYGAIN_ALBUM_GAIN=+2.00 dB')
    const payload = new Uint8Array(4 + 4 + 4 + comment.length)
    payload[4] = 1
    payload[8] = comment.length
    payload.set(comment, 12)
    const flac = new Uint8Array(8 + payload.length)
    flac.set(encoder.encode('fLaC'), 0)
    flac[4] = 0x84
    flac[7] = payload.length
    flac.set(payload, 8)
    expect(scanReplayGainBytes(flac).albumGainDb).toBe(2)
  })
  it('解析 ID3/Vorbis 风格大小写与 dB 后缀，并按模式回退', () => {
    const tags = parseReplayGainTags({
      REPLAYGAIN_TRACK_GAIN: '-7.23 dB',
      'replaygain album gain': '+1.50 dB',
      replaygain_track_peak: '0.987',
      replaygain_album_peak: 1.02,
    })
    expect(tags).toEqual({ trackGainDb: -7.23, albumGainDb: 1.5, trackPeak: 0.987, albumPeak: 1.02 })
    expect(selectReplayGainDb(tags, 'track')).toBe(-7.23)
    expect(selectReplayGainDb({ ...tags, albumGainDb: null }, 'album')).toBe(-7.23)
  })

  it('接受播放源提供的驼峰字段与嵌套 ReplayGain 对象', () => {
    expect(parseReplayGainTags({ replayGainTrackGain: -4.2, replayGainAlbumPeak: 0.92 }).trackGainDb).toBe(-4.2)
    expect(parseReplayGainTags({ replayGain: { trackGain: -6.3, albumGain: -3.1, trackPeak: 0.8 } }))
      .toMatchObject({ trackGainDb: -6.3, albumGainDb: -3.1, trackPeak: 0.8 })
  })

  it('非法标签被忽略，分享串保留当前 ReplayGain 选择', () => {
    const tags = parseReplayGainTags({ REPLAYGAIN_TRACK_GAIN: 'loud', replaygain_track_peak: '-1' })
    expect(tags).toEqual({ trackGainDb: null, albumGainDb: null, trackPeak: null, albumPeak: null })
    const params = createDefaultParams(48000)
    params.loudnessNormalization.replayGainMode = 'track'
    params.loudnessNormalization.replayGainDb = -5.5
    const decoded = decodeShareCode(encodeShareCode(params))
    expect(decoded.loudnessNormalization.replayGainMode).toBe('track')
    expect(decoded.loudnessNormalization.replayGainDb).toBe(-5.5)
  })

  it('手动响度模式把 ReplayGain 增益叠加到外部增益并平滑应用', () => {
    const fs = 48000
    const engine = new EngineV3(fs)
    const params = createDefaultParams(fs)
    params.limiter.enabled = false
    params.loudnessNormalization = {
      ...params.loudnessNormalization,
      enabled: true,
      useRealtimeMeter: false,
      externalGainDb: 0,
      replayGainMode: 'track',
      replayGainDb: -6,
    }
    engine.setParams(params)
    const input = new Float32Array(fs).fill(0.1)
    const out = new Float32Array(fs)
    engine.process([input, input], [out, new Float32Array(fs)])
    expect(out[fs - 1] / input[fs - 1]).toBeCloseTo(Math.pow(10, -6 / 20), 2)
  })
})

