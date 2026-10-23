/**
 * ShareCodec 单元测试
 *
 * 说明：测试内独立实现 FNV-1a 与 base64url，用于"手工构造"越界/篡改/白名单注入
 * 的分享串——验证 decodeShareCode 不信任 encodeShareCode 的输出（防注入语义）。
 */
import { describe, expect, it } from 'vitest'
import { createDefaultParams } from '../src/types'
import { SHARE_CODEC_VERSION, encodeShareCode, decodeShareCode } from '../src/engine/ShareCodec'

// ---- 测试内独立实现（与被测实现互不引用，互为对照） ----
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

function fnv1a32(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

function bytesToB64url(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0
    out += B64[b0 >> 2] + B64[((b0 & 3) << 4) | (b1 >> 4)]
    if (i + 1 < bytes.length) out += B64[((b1 & 15) << 2) | (b2 >> 6)]
    if (i + 2 < bytes.length) out += B64[b2 & 63]
  }
  return out
}

/** 手工构造合法格式的分享串（版本 + 校验 + JSON），可自由注入任意 JSON */
function makeRawShare(paramsJson: string, version: number = SHARE_CODEC_VERSION): string {
  const payload = version + ':' + fnv1a32(version + ':' + paramsJson).toString(16).padStart(8, '0') + ':' + paramsJson
  return bytesToB64url(new TextEncoder().encode(payload))
}

describe('encodeShareCode / decodeShareCode', () => {
  it('默认参数往返一致（ir 恒为 null）', () => {
    const p = createDefaultParams(48000)
    const decoded = decodeShareCode(encodeShareCode(p))
    expect(decoded).toEqual(p)
  })

  it('世界模式传播开关分享往返且拒绝非布尔注入', () => {
    const p = createDefaultParams(48000)
    p.spatial!.world.propagation = true
    expect(decodeShareCode(encodeShareCode(p)).spatial!.world.propagation).toBe(true)
    const injected = JSON.parse(JSON.stringify(p)) as Record<string, unknown>
    const spatial = injected.spatial as Record<string, unknown>
    const world = spatial.world as Record<string, unknown>
    world.propagation = 'true'
    const decoded = decodeShareCode(makeRawShare(JSON.stringify(injected)))
    expect(decoded.spatial!.world.propagation).toBe(false)
  })

  it('非默认参数往返一致（含 sceneId/自定义 EQ 段）', () => {
    const p = createDefaultParams(44100)
    p.customized = true
    p.sceneId = 'jazz'
    p.eq.proBands[0] = { frequency: 40, gain: 3.5, q: 0.8 }
    p.eq.proBands[1] = { frequency: 160, gain: -2, q: 1.4 }
    p.deesser.enabled = true
    p.deesser.thresholdDb = -40
    p.compressor.transientPreserve = 0.65
    p.reverb.enabled = true
    p.reverb.mode = 'convolution'
    p.reverb.convolution.irName = 'hall-cathedral'
    p.loudnessNormalization.targetLufs = -16
    p.stereoWidth = 1.4
    p.lowMonoAmount = 0.65
    p.lowMonoCutoffHz = 175
    p.subsonicEnabled = true
    p.subsonicCutoffHz = 28
    const decoded = decodeShareCode(encodeShareCode(p))
    expect(decoded).toEqual(p)
    expect(decoded.reverb.convolution.ir).toBeNull()
    expect(decoded.reverb.convolution.irName).toBe('hall-cathedral')
  })

  it('低频单声道参数参与分享串往返并清洗越界值', () => {
    const p = createDefaultParams(48000)
    p.lowMonoAmount = 0.7
    p.lowMonoCutoffHz = 180
    const decoded = decodeShareCode(encodeShareCode(p))
    expect(decoded.lowMonoAmount).toBe(0.7)
    expect(decoded.lowMonoCutoffHz).toBe(180)
    const malformed = decodeShareCode(makeRawShare(JSON.stringify({ sampleRate: 48000, lowMonoAmount: 4, lowMonoCutoffHz: 4 })))
    expect(malformed.lowMonoAmount).toBe(1)
    expect(malformed.lowMonoCutoffHz).toBe(40)
  })

  it('次声高通参数参与分享串往返并清洗越界值', () => {
    const p = createDefaultParams(48000)
    p.subsonicEnabled = true
    p.subsonicCutoffHz = 32
    const decoded = decodeShareCode(encodeShareCode(p))
    expect(decoded.subsonicEnabled).toBe(true)
    expect(decoded.subsonicCutoffHz).toBe(32)
    const malformed = decodeShareCode(makeRawShare(JSON.stringify({ sampleRate: 48000, subsonicEnabled: 'on', subsonicCutoffHz: 100 })))
    expect(malformed.subsonicEnabled).toBe(false)
    expect(malformed.subsonicCutoffHz).toBe(40)
  })

  it('压缩器瞬态保留量参与分享串往返，旧分享串缺省为关闭', () => {
    const p = createDefaultParams(48000)
    p.compressor.transientPreserve = 0.7
    expect(decodeShareCode(encodeShareCode(p)).compressor.transientPreserve).toBe(0.7)
    expect(decodeShareCode(makeRawShare(JSON.stringify({ sampleRate: 48000, compressor: { transientPreserve: 4 } })))
      .compressor.transientPreserve).toBe(1)
    expect(decodeShareCode(makeRawShare(JSON.stringify({ sampleRate: 48000, compressor: {} })))
      .compressor.transientPreserve).toBe(0)
  })

  it('IR 数组被去除：编码后解码 ir 恒为 null，irName 保留', () => {
    const p = createDefaultParams(48000)
    p.reverb.convolution.ir = new Float32Array([0.5, 0.2, 0.1])
    p.reverb.convolution.irName = 'user-ir'
    const s = encodeShareCode(p)
    // 序列化串中不得包含 IR 数值（0.5）——去 IR 数组语义
    expect(s).not.toContain('0.5')
    const decoded = decodeShareCode(s)
    expect(decoded.reverb.convolution.ir).toBeNull()
    expect(decoded.reverb.convolution.irName).toBe('user-ir')
  })

  it('确定性：同参数两次编码得同一串；解码再编码得规范形', () => {
    const p = createDefaultParams(48000)
    p.eq.proBands[3] = { frequency: 500, gain: 2.4, q: 1.2 }
    const s1 = encodeShareCode(p)
    const s2 = encodeShareCode(p)
    expect(s1).toBe(s2)
    expect(encodeShareCode(decodeShareCode(s1))).toBe(s1)
  })

  it('篡改任一字符 → 校验失败抛 Error', () => {
    const s = encodeShareCode(createDefaultParams(48000))
    // 翻转第一个字符（保证 != 原字符）
    const flipped = s[0] === 'A' ? 'B' : 'A'
    const bad = flipped + s.slice(1)
    expect(bad).not.toBe(s)
    expect(() => decodeShareCode(bad)).toThrow()
  })

  it('版本不符 → 抛 unsupported version', () => {
    const raw = makeRawShare(JSON.stringify({ sampleRate: 48000 }), SHARE_CODEC_VERSION + 1)
    expect(() => decodeShareCode(raw)).toThrow(/unsupported share code version/)
  })

  it('校验和错误 → 抛 checksum mismatch', () => {
    // 用错误校验和构造（版本 2 之后拼接错误 hex）
    const json = JSON.stringify({ sampleRate: 48000 })
    const payload = SHARE_CODEC_VERSION + ':00000000:' + json
    expect(() => decodeShareCode(bytesToB64url(new TextEncoder().encode(payload)))).toThrow(/checksum mismatch/)
  })

  it('非法 base64url / 空输入 → 抛 Error', () => {
    expect(() => decodeShareCode('')).toThrow()
    expect(() => decodeShareCode('!!!!!not-base64!!!!!')).toThrow()
    // 'aaa' 是合法 base64url 但解码后无版本前缀 → 内容校验失败抛错
    expect(() => decodeShareCode('a'.repeat(3))).toThrow()
  })

  it('数值 clamp：越界值被钳到白名单范围', () => {
    const json = JSON.stringify({
      sampleRate: 999999, // → 192000
      eq: { proBands: [{ frequency: 50, gain: 999, q: 0 }, { frequency: 10, gain: -999, q: 99 }] },
      deesser: { enabled: 'yes', thresholdDb: 12 }, // 类型不符 → 默认；越界 → 0
      reverb: { convolution: { mix: 5 } }, // → 1
      stereoWidth: -3, // → 0
    })
    const decoded = decodeShareCode(makeRawShare(json))
    expect(decoded.sampleRate).toBe(192000)
    expect(decoded.eq.proBands[0]).toEqual({ frequency: 50, gain: 20, q: 0.1 })
    expect(decoded.eq.proBands[1]).toEqual({ frequency: 20, gain: -20, q: 10 })
    expect(decoded.deesser.enabled).toBe(false)
    expect(decoded.deesser.thresholdDb).toBe(0)
    expect(decoded.reverb.convolution.mix).toBe(1)
    expect(decoded.stereoWidth).toBe(0)
  })

  it('白名单：未知字段（含 __proto__ 注入键）被丢弃', () => {
    const json = JSON.stringify({
      sampleRate: 48000,
      __proto__: { polluted: true },
      evil: 'drop-me',
      eq: { enabled: false, hacked: 999 },
    })
    const decoded = decodeShareCode(makeRawShare(json))
    expect(decoded.eq.enabled).toBe(false)
    expect(decoded.eq.mode).toBe('pro') // 未提供的字段用默认值
    expect((decoded as unknown as Record<string, unknown>)['evil']).toBeUndefined()
    // 原型未被污染
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('非法枚举回落默认值，自定义段数越界时钳制到容量上限', () => {
    const json = JSON.stringify({
      sampleRate: 48000,
      reverb: { mode: 'nuclear' },
      bassEnhancer: { harmonicType: 'x³' },
      surround3d: { direction: 7 },
      eq: { bandCount: 99 },
    })
    const decoded = decodeShareCode(makeRawShare(json))
    expect(decoded.reverb.mode).toBe('algorithmic')
    expect(decoded.bassEnhancer.harmonicType).toBe('odd')
    expect(decoded.surround3d.direction).toBe(1)
    expect(decoded.eq.bandCount).toBe(64)
  })

  it('多声道空间布局分享串往返，并对白名单外布局回退 5.1', () => {
    const params = createDefaultParams(48000)
    params.spatial.mode = 'instant'
    params.spatial.instant.multichannelAuto = true
    params.spatial.instant.multichannelLayout = '714'
    const decoded = decodeShareCode(encodeShareCode(params))
    expect(decoded.spatial.instant.multichannelAuto).toBe(true)
    expect(decoded.spatial.instant.multichannelLayout).toBe('714')
    const invalid = decodeShareCode(makeRawShare(JSON.stringify({ sampleRate: 48000,
      spatial: { ...params.spatial, instant: { ...params.spatial.instant, multichannelLayout: 'unsupported' } } })))
    expect(invalid.spatial.instant.multichannelLayout).toBe('51')
  })

  it('长字符串截断（防超长注入）', () => {
    const json = JSON.stringify({ sampleRate: 48000, reverb: { convolution: { irName: 'x'.repeat(1000) } } })
    const decoded = decodeShareCode(makeRawShare(json))
    expect(decoded.reverb.convolution.irName!.length).toBeLessThanOrEqual(256)
  })
});


describe('空间高级参数持久化', () => {
  it('自动输入布局、反射策略及零尺寸自定义扬声器完整往返', () => {
    const params = createDefaultParams(48000)
    params.spatial.budgetMode = 'auto'
    params.spatial.instant.multichannelLayout = 'auto'
    params.spatial.headLocked.layout = 'custom'
    params.spatial.headLocked.speakers = [{ azimuthDeg: -40, elevationDeg: 20, distance: 0,
      gain: 0.8, size: 0, diffuse: 0.75, polarity: -1, muted: true, route: 'side' }]
    const decoded = decodeShareCode(encodeShareCode(params))
    expect(decoded.spatial.budgetMode).toBe('auto')
    expect(decoded.spatial.instant.multichannelLayout).toBe('auto')
    expect(decoded.spatial.headLocked.speakers).toEqual(params.spatial.headLocked.speakers)
  })
})
