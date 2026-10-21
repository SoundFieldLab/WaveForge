/**
 * WaveForge 音频效果引擎 v3 —— 分享串编解码（ShareCodec）
 *
 * 出处/许可：自研实现（设计文档 §4.10 / 映射表 #19，决策为 🔴 必须自研）。
 *   - FNV-1a 32 位哈希：Fowler–Noll–Vo 公开算法（公有领域，无版权限制）。
 *   - base64url：RFC 4648 §5（URL 安全字母表，无填充）。
 *   - 解码端"白名单字段 + 数值 clamp"语义对应既有"分享串防注入"修复。
 *
 * 序列化格式：base64url( "<version>:<checksum>:<json>" )
 *   - version 恒为 SHARE_CODEC_VERSION（当前 1），解析时不匹配即抛错；
 *   - json 为"去 IR 数组"后的参数快照：卷积混响的 IR 数组不参与序列化，仅保留
 *     irName 引用（解码后 ir 恒为 null，由调用方按 irName 重新加载）；
 *   - checksum 为覆盖 "<version>:<json>" 的 FNV-1a 32 位值（8 位小写十六进制），
 *     固定长度置于版本号之后，保证 json 内含 ':' 也能无歧义解析。
 *
 * 确定性：序列化对象按固定字段顺序构造，同参数必得同串；同串解码结果唯一。
 * 纯 TS、零运行时依赖：仅使用平台全局（TextEncoder/TextDecoder/Math.imul）。
 */

import type { V3EngineParams, EqBand, SpatialSettings, ProcessingModuleKey } from '../types'
import { DEFAULT_PROCESSING_ORDER, MAX_PRO_EQ_BANDS } from '../types'
import type { VirtualSpeakerCfg } from '../spatial/types'
import type { BiquadType } from '../dsp/biquad'
import { createDefaultSpatialSettings } from '../types'

/** 当前分享串格式版本；变更不兼容格式时递增 */
export const SHARE_CODEC_VERSION = 1

// ---------------------------------------------------------------------------
// base64url（RFC 4648 §5）
// ---------------------------------------------------------------------------
const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

function utf8Encode(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function utf8Decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

/** 字节 → base64url（无填充；确定性） */
function bytesToBase64Url(bytes: Uint8Array): string {
  let out = ''
  const n = bytes.length
  for (let i = 0; i < n; i += 3) {
    const b0 = bytes[i]
    const b1 = i + 1 < n ? bytes[i + 1] : 0
    const b2 = i + 2 < n ? bytes[i + 2] : 0
    out += B64_ALPHABET[b0 >> 2]
    out += B64_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)]
    if (i + 1 < n) out += B64_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)]
    if (i + 2 < n) out += B64_ALPHABET[b2 & 0x3f]
  }
  return out
}

/** base64url → 字节；非法字符/非法长度抛 Error（防注入入口） */
function base64UrlToBytes(s: string): Uint8Array {
  if (s.length % 4 === 1) throw new Error('invalid share code: bad base64url length')
  let t = s
  while (t.length % 4 !== 0) t += '=' // 兼容带填充输入（本实现生成时无填充）
  const out: number[] = []
  for (let i = 0; i < t.length; i += 4) {
    const c0 = B64_ALPHABET.indexOf(t[i])
    const c1 = B64_ALPHABET.indexOf(t[i + 1])
    const c2 = t[i + 2] === '=' ? 0 : B64_ALPHABET.indexOf(t[i + 2])
    const c3 = t[i + 3] === '=' ? 0 : B64_ALPHABET.indexOf(t[i + 3])
    if (c0 < 0 || c1 < 0 || c2 < 0 || c3 < 0) {
      throw new Error('invalid share code: bad base64url character')
    }
    out.push((c0 << 2) | (c1 >> 4))
    if (t[i + 2] !== '=') out.push(((c1 & 0x0f) << 4) | (c2 >> 2))
    if (t[i + 3] !== '=') out.push(((c2 & 0x03) << 6) | c3)
  }
  return Uint8Array.from(out)
}

// ---------------------------------------------------------------------------
// FNV-1a 32 位（公开算法，公有领域）
// ---------------------------------------------------------------------------
function fnv1a32(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

function checksumOf(version: number, json: string): string {
  return fnv1a32(version + ':' + json).toString(16).padStart(8, '0')
}

// ---------------------------------------------------------------------------
// 解码：白名单字段 + 数值 clamp
// ---------------------------------------------------------------------------
type Raw = Record<string, unknown>

function isObj(v: unknown): v is Raw {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 数值 clamp：非有限数/类型不符 → 默认值；越界 → 钳到 [min,max] */
function num(v: unknown, min: number, max: number, def: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return def
  return v < min ? min : v > max ? max : v
}

function bool(v: unknown, def: boolean): boolean {
  return typeof v === 'boolean' ? v : def
}

/** 字符串白名单：仅接受 string（防注入），超长截断 */
function str(v: unknown, def: string | null, maxLen: number): string | null {
  if (v === null || v === undefined) return def
  if (typeof v !== 'string') return def
  return v.length > maxLen ? v.slice(0, maxLen) : v
}

/** 字符串枚举白名单 */
function oneOf<T extends string>(v: unknown, allowed: readonly T[], def: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : def
}

/** 数字枚举白名单（bandCount / direction） */
function numOneOf<T extends number>(v: unknown, allowed: readonly T[], def: T): T {
  return typeof v === 'number' && (allowed as readonly number[]).includes(v) ? (v as T) : def
}

/** 专业 EQ 滤波器类型白名单；旧分享串省略 type 时保持 peaking 语义。 */
const EQ_FILTER_TYPES: readonly BiquadType[] = [
  'peaking', 'lowshelf', 'highshelf', 'lowpass', 'highpass', 'bandpass', 'notch', 'allpass',
]

/** 数值数组（clamp 后截断到 maxLen）；缺失时返回默认值副本 */
function numArray(v: unknown, min: number, max: number, def: number[], maxLen: number): number[] {
  if (!Array.isArray(v)) return def.slice()
  const out: number[] = []
  for (const x of v) {
    if (out.length >= maxLen) break
    if (typeof x === 'number' && Number.isFinite(x)) out.push(x < min ? min : x > max ? max : x)
  }
  return out
}

/** v2 兼容专业 10 段默认频点（与 src/types.ts PRO_EQ_DEFAULT_BANDS 一致） */
function defaultEqProBands(): EqBand[] {
  return [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000].map((f) => ({
    frequency: f,
    gain: 0,
    q: 1.1,
  }))
}

// ---------------------------------------------------------------------------
// 空间音频（第 15 级）分享串编解码：plain-data JSON 块整体往返
// 子结构形状由 spatial/types 定义、由 EngineV3 移植的 spatialConfigFromSettings 消费，
// share-code 层不做逐字段白名单（避免与 spatial/types 双份维护漂移）——编码端原样
// 深拷贝为 plain object，解码端递归过滤只保留 boolean/有限 number/string/plain array/
// plain object（防 prototype 污染 + 剔除函数/Symbol/循环引用等异常 payload）。
// ---------------------------------------------------------------------------

/** 编码：SpatialSettings → plain object 深拷贝（剔除 undefined 字段，保 JSON 可序列化） */
function encodeSpatial(s: SpatialSettings): unknown {
  return decodeSpatial(JSON.parse(JSON.stringify(s)))
}

/** 递归深度上限（防恶意深度嵌套栈溢出） */
const SPATIAL_MAX_DEPTH = 12
/** 单对象键数上限（防超大 payload） */
const SPATIAL_MAX_KEYS = 256

/**
 * 解码端深度清洗：仅保留 boolean/有限 number/string/plain array/plain object，
 * 递归限深 SPATIAL_MAX_DEPTH、单对象键数限 SPATIAL_MAX_KEYS。任何非法/超限 → 返回 null
 * （调用方回退 createDefaultSpatialSettings）。纯函数、无原型污染（不触发 setter、
 * 不用 eval、不引用 __proto__/constructor 等危险键——全部丢弃）。
 */
function deepSanitizeSpatial(v: unknown, depth: number): unknown {
  if (depth > SPATIAL_MAX_DEPTH) return null
  if (v === null || v === undefined) return null
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') return v
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (Array.isArray(v)) {
    if (v.length > SPATIAL_MAX_KEYS) return null
    const out: unknown[] = []
    for (const item of v) {
      const cleaned = deepSanitizeSpatial(item, depth + 1)
      if (cleaned === null) return null // 子项非法 → 整体拒绝（保守，防半残结构）
      out.push(cleaned)
    }
    return out
  }
  if (typeof v === 'object') {
    const obj = v as Record<string, unknown>
    const keys = Object.keys(obj)
    if (keys.length > SPATIAL_MAX_KEYS) return null
    const out: Record<string, unknown> = {}
    for (const k of keys) {
      // 危险键一律丢弃（防原型污染）
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue
      const cleaned = deepSanitizeSpatial(obj[k], depth + 1)
      if (cleaned === null) return null
      out[k] = cleaned
    }
    return out
  }
  return null
}

/**
 * 解码 SpatialSettings：raw 为对象 → 深度清洗 → 期望形状校验（关键字段 mode 在白名单内，
 * 子对象存在性）→ 强类型断言；非法/缺省 → createDefaultSpatialSettings()。
 * 形状校验保持宽松（仅 mode 白名单 + 各子对象为对象），完整字段有效性由 EngineV3 消费时
 * 的 spatialConfigFromSettings 兜底（布局/场景助手自带钳位）。
 */
function decodeSpatial(raw: unknown): SpatialSettings {
  const cleaned = deepSanitizeSpatial(raw, 0)
  if (!cleaned || typeof cleaned !== 'object' || Array.isArray(cleaned)) {
    return createDefaultSpatialSettings()
  }
  const o = cleaned as Record<string, unknown>
  const mode = oneOf(
    o.mode,
    ['off', 'instant', 'headLocked', 'world', 'stage'] as const,
    'off',
  )
  // 关键子对象存在性校验：缺任一 → 默认（防半残结构进入引擎）
  const sub = ['instant', 'headLocked', 'world', 'stage', 'ambience']
  for (const k of sub) {
    if (!isObj(o[k])) return createDefaultSpatialSettings()
  }
  // 以默认为骨架、清洗后的值覆盖（保证新增子字段有默认；旧分享串缺字段不崩）
  const def = createDefaultSpatialSettings()
  return {
    mode,
    renderStyle: oneOf(o.renderStyle, ['natural', 'focused'] as const, 'natural'),
    inputFormat: oneOf(o.inputFormat, ['channels', 'ambix', 'ambix1', 'ambix2', 'ambix3', 'fuma', 'stereo51', 'stereo71'] as const, 'channels'),
    ambisonicTransform: (() => {
      const transform = isObj(o.ambisonicTransform) ? o.ambisonicTransform : {}
      return { yawDeg: num(transform.yawDeg, -180, 180, 0), pitchDeg: num(transform.pitchDeg, -180, 180, 0),
        rollDeg: num(transform.rollDeg, -180, 180, 0), orderGains: Array.from({ length: 4 }, (_, i) =>
          num(Array.isArray(transform.orderGains) ? transform.orderGains[i] : undefined, -4, 4, 1)) }
    })(),
    speakerCancellation: {
      enabled: bool((o.speakerCancellation as Record<string, unknown> | undefined)?.enabled, false),
      amount: num((o.speakerCancellation as Record<string, unknown> | undefined)?.amount, 0, 1, 0.4),
      delayMs: num((o.speakerCancellation as Record<string, unknown> | undefined)?.delayMs, 0.02, 1.5, 0.25),
      cutoffHz: num((o.speakerCancellation as Record<string, unknown> | undefined)?.cutoffHz, 200, 5000, 1800),
    },
    earlyAmount: num(o.earlyAmount, 0, 1, 1),
    lateAmount: num(o.lateAmount, 0, 1, 1),
    earlyReflectionModel: oneOf(o.earlyReflectionModel, ['cues', 'spectral'] as const, 'cues'),
    // masterGain 契约 0.5..1（注释见 spatial/types）：无上界时分享串可传 1e6
    // 把空间级输出 softClip 成方波（严重失真）
    masterGain: typeof o.masterGain === 'number' && Number.isFinite(o.masterGain)
      ? Math.min(1, Math.max(0.5, o.masterGain))
      : def.masterGain,
    instant: {
      ...def.instant,
      ...(o.instant as object),
      // room 枚举白名单：损坏/恶意值绕过类型系统直达 roomSim 查表（undefined → NaN 几何
      // → 引擎输出永久 NaN 静音）。其余 instant 数值字段由消费端 clamp 兜底。
      room: oneOf((o.instant as Record<string, unknown>).room,
        ['off', 'studio', 'hall', 'stage', 'church', 'outdoor', 'bathroom', 'corridor'] as const, def.instant.room),
      multichannelAuto: bool((o.instant as Record<string, unknown>).multichannelAuto, def.instant.multichannelAuto),
      multichannelLayout: oneOf((o.instant as Record<string, unknown>).multichannelLayout,
        ['auto', 'quad', '51', '71', '714'] as const, def.instant.multichannelLayout),
    },
    headLocked: {
      ...def.headLocked,
      ...(o.headLocked as object),
      // speakers 数组字段整体校验：含 null/非数组的 spread 会覆盖默认数组，
      // 消费端读 .length / p.azimuthDeg 抛 TypeError
      speakers: rebuildSpeakers((o.headLocked as Record<string, unknown>).speakers) ?? def.headLocked.speakers,
    },
    world: {
      ...def.world, ...(o.world as object),
      propagation: (o.world as Record<string, unknown>).propagation === true,
    },
    stage: { ...def.stage, ...(o.stage as object) },
    ambience: { ...def.ambience, ...(o.ambience as object),
      extraction: oneOf((o.ambience as Record<string, unknown>).extraction, ['pca', 'difference'] as const, 'pca') },
    budgetMode: oneOf(o.budgetMode, ['quality', 'auto', 'lowLatency'] as const, 'quality'),
    decorrelation: num(o.decorrelation, 0, 1, def.decorrelation ?? 0),
    ...(o.earlyReflectionOrders === undefined ? {} : { earlyReflectionOrders: num(o.earlyReflectionOrders, 0, 3, 2) }),
    convolution: oneOf(o.convolution, ['partitioned', 'time'] as const, def.convolution),
    hrtfInterp: oneOf(o.hrtfInterp, ['nearest', 'spherical'] as const, def.hrtfInterp),
    distanceModel: oneOf(o.distanceModel, ['inverse', 'linear', 'exponential'] as const, def.distanceModel),
    refDistance: num(o.refDistance, 0.1, 100, def.refDistance),
    maxDistance: num(o.maxDistance, 1, 200, def.maxDistance),
  }
}

/** headLocked.speakers 逐字段重建：数组元素缺任一字段即整个数组按默认处理 */
function rebuildSpeakers(raw: unknown): VirtualSpeakerCfg[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const out: VirtualSpeakerCfg[] = []
  for (const item of raw) {
    if (!isObj(item)) return null
    const az = (item as Record<string, unknown>).azimuthDeg
    const el = (item as Record<string, unknown>).elevationDeg
    const dist = (item as Record<string, unknown>).distance
    const gain = (item as Record<string, unknown>).gain
    const size = (item as Record<string, unknown>).size
    if (typeof az !== 'number' || !Number.isFinite(az)) return null
    if (typeof el !== 'number' || !Number.isFinite(el)) return null
    if (typeof dist !== 'number' || !Number.isFinite(dist) || dist < 0) return null
    if (typeof gain !== 'number' || !Number.isFinite(gain)) return null
    if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return null
    const speaker: VirtualSpeakerCfg = {
      azimuthDeg: az, elevationDeg: Math.max(-90, Math.min(90, el)),
      distance: Math.min(200, dist), gain: Math.max(0, Math.min(2, gain)), size: Math.min(1, size),
    }
    if (typeof item.muted === 'boolean') speaker.muted = item.muted
    if (item.route === 'l' || item.route === 'r' || item.route === 'both' || item.route === 'side') speaker.route = item.route
    if (typeof item.diffuse === 'number') speaker.diffuse = num(item.diffuse, 0, 1, 0)
    if (typeof item.polarity === 'number') speaker.polarity = num(item.polarity, -1, 1, 1)
    out.push(speaker)
  }
  return out
}

/** 白名单重建：只读取已知字段，未知字段（含 __proto__ 等注入键）一律丢弃 */
function sanitizeParams(raw: unknown): V3EngineParams & { spatial: SpatialSettings } {
  if (!isObj(raw)) throw new Error('invalid share code payload')
  const sampleRate = Math.round(num(raw.sampleRate, 8000, 192000, 48000))
  const precision = oneOf(raw.precision, ['float32', 'float64'] as const, 'float32')
  const order: ProcessingModuleKey[] = []
  if (Array.isArray(raw.processingOrder)) {
    for (const key of raw.processingOrder) {
      if (typeof key === 'string' && DEFAULT_PROCESSING_ORDER.includes(key as ProcessingModuleKey)
        && !order.includes(key as ProcessingModuleKey)) order.push(key as ProcessingModuleKey)
    }
  }
  for (const key of DEFAULT_PROCESSING_ORDER) if (!order.includes(key)) order.push(key)

  const eqRaw = isObj(raw.eq) ? raw.eq : {}
  const dynamicEqRaw = isObj(raw.dynamicEq) ? raw.dynamicEq : {}
  const dynamicBands = Array.isArray(dynamicEqRaw.bands)
    ? dynamicEqRaw.bands.filter(isObj).slice(0, 8).map((band) => ({
      enabled: bool(band.enabled, true),
      frequency: num(band.frequency, 20, Math.min(20000, sampleRate * 0.49), 1000),
      q: num(band.q, 0.1, 18, 1),
      thresholdDb: num(band.thresholdDb, -80, 0, -30),
      ratio: num(band.ratio, 1, 20, 4),
      maxReductionDb: num(band.maxReductionDb, 0, 24, 12),
      attackMs: num(band.attackMs, 0.1, 500, 10),
      releaseMs: num(band.releaseMs, 0.1, 3000, 150),
    })) : undefined
  const crossfeedRaw = isObj(raw.crossfeed) ? raw.crossfeed : {}
  const deesserRaw = isObj(raw.deesser) ? raw.deesser : {}
  const compRaw = isObj(raw.compressor) ? raw.compressor : {}
  const compMultiRaw = isObj(compRaw.multiband) ? compRaw.multiband : {}
  const nightRaw = isObj(raw.nightMode) ? raw.nightMode : {}
  const bassRaw = isObj(raw.bassEnhancer) ? raw.bassEnhancer : {}
  const revRaw = isObj(raw.reverb) ? raw.reverb : {}
  const revAlgRaw = isObj(revRaw.algorithmic) ? revRaw.algorithmic : {}
  const revConvRaw = isObj(revRaw.convolution) ? revRaw.convolution : {}
  const surRaw = isObj(raw.surround3d) ? raw.surround3d : {}
  const lcRaw = isObj(raw.loudnessCompensation) ? raw.loudnessCompensation : {}
  const lnRaw = isObj(raw.loudnessNormalization) ? raw.loudnessNormalization : {}
  const limRaw = isObj(raw.limiter) ? raw.limiter : {}
  const ieqRaw = isObj(raw.ieq) ? raw.ieq : {}
  const pitchRaw = isObj(raw.pitch) ? raw.pitch : {}
  const hearingRaw = isObj(raw.hearing) ? raw.hearing : {}
  const channelRaw = isObj(raw.channelCalibration) ? raw.channelCalibration : {}

  // eq.simpleBands：5 段，缺失补 0
  const simple = numArray(eqRaw.simpleBands, -20, 20, [0, 0, 0, 0, 0], 5)
  while (simple.length < 5) simple.push(0)

  // eq.proBands：白名单 {frequency,gain,q,type}；字段缺失 → 默认 10 段；显式空数组 → 保留空
  let proBands: EqBand[] = defaultEqProBands()
  if (Array.isArray(eqRaw.proBands)) {
    const parsed: EqBand[] = []
    for (const b of eqRaw.proBands) {
      if (parsed.length >= MAX_PRO_EQ_BANDS) break
      if (isObj(b)) {
        const band: EqBand = {
          frequency: num(b.frequency, 20, 20000, 1000),
          gain: num(b.gain, -20, 20, 0),
          q: num(b.q, 0.1, 10, 1.1),
        }
        // 保持旧分享串的对象形状：未携带 type 时不写入字段，运行时按 peaking 处理。
        if (typeof b.type === 'string') band.type = oneOf(b.type, EQ_FILTER_TYPES, 'peaking')
        parsed.push(band)
      }
    }
    proBands = parsed
  }

  // loudnessCompensation.bands：白名单 {frequency,gain}，最多 32 段
  const lcBands: { frequency: number; gain: number }[] = []
  if (Array.isArray(lcRaw.bands)) {
    for (const b of lcRaw.bands) {
      if (lcBands.length >= 32) break
      if (isObj(b)) {
        lcBands.push({ frequency: num(b.frequency, 20, 20000, 1000), gain: num(b.gain, -20, 20, 0) })
      }
    }
  }

  return {
    sampleRate,
    bitPerfectBypass: bool(raw.bitPerfectBypass, false),
    processingOrder: order,
    precision,
    eq: {
      enabled: bool(eqRaw.enabled, true),
      mode: oneOf(eqRaw.mode, ['simple', 'pro'] as const, 'pro'),
      simpleBands: simple,
      proBands,
      bandCount: Math.round(num(eqRaw.bandCount, 1, MAX_PRO_EQ_BANDS, 10)),
      qCompensation: bool(eqRaw.qCompensation, true),
      locked: bool(eqRaw.locked, false),
    },
    dynamicEq: {
      enabled: bool(dynamicEqRaw.enabled, false),
      frequency: num(dynamicEqRaw.frequency, 20, Math.min(20000, sampleRate * 0.49), 1000),
      q: num(dynamicEqRaw.q, 0.1, 18, 1),
      thresholdDb: num(dynamicEqRaw.thresholdDb, -80, 0, -30),
      ratio: num(dynamicEqRaw.ratio, 1, 20, 4),
      maxReductionDb: num(dynamicEqRaw.maxReductionDb, 0, 24, 12),
      attackMs: num(dynamicEqRaw.attackMs, 0.1, 500, 10),
      releaseMs: num(dynamicEqRaw.releaseMs, 0.1, 3000, 150),
      ...(dynamicBands?.length ? { bands: dynamicBands } : {}),
    },
    crossfeed: {
      enabled: bool(crossfeedRaw.enabled, false),
      amount: num(crossfeedRaw.amount, 0, 1, 0.3),
      cutoffHz: num(crossfeedRaw.cutoffHz, 100, 3000, 700),
      delayMs: num(crossfeedRaw.delayMs, 0, 1, 0.2),
    },
    deesser: {
      enabled: bool(deesserRaw.enabled, false),
      centerHz: num(deesserRaw.centerHz, 100, 16000, 6000),
      q: num(deesserRaw.q, 0.1, 10, 0.7),
      thresholdDb: num(deesserRaw.thresholdDb, -60, 0, -30),
      ratio: num(deesserRaw.ratio, 1, 50, 8),
      attackMs: num(deesserRaw.attackMs, 0, 100, 1),
      releaseMs: num(deesserRaw.releaseMs, 0, 2000, 80),
      splitBand: bool(deesserRaw.splitBand, true),
      mix: num(deesserRaw.mix, 0, 1, 1),
    },
    compressor: {
      enabled: bool(compRaw.enabled, false),
      mode: oneOf(compRaw.mode, ['downward', 'upward', 'multiband'] as const, 'downward'),
      upwardMaxGainDb: num(compRaw.upwardMaxGainDb, 0, 36, 24),
      transientPreserve: num(compRaw.transientPreserve, 0, 1, 0),
      thresholdDb: num(compRaw.thresholdDb, -60, 0, -20),
      ratio: num(compRaw.ratio, 1, 50, 4),
      kneeDb: num(compRaw.kneeDb, 0, 24, 6),
      attackMs: num(compRaw.attackMs, 0, 500, 10),
      releaseMs: num(compRaw.releaseMs, 0, 3000, 150),
      makeupDb: num(compRaw.makeupDb, -24, 24, 0),
      outputGain: num(compRaw.outputGain, 0, 2, 1),
      multiband: {
        lowMidHz: num(compMultiRaw.lowMidHz, 40, 2000, 180),
        midHighHz: num(compMultiRaw.midHighHz, 500, 20000, 4000),
        low: {
          thresholdDb: num(isObj(compMultiRaw.low) ? compMultiRaw.low.thresholdDb : undefined, -60, 0, -24),
          ratio: num(isObj(compMultiRaw.low) ? compMultiRaw.low.ratio : undefined, 1, 50, 3),
          kneeDb: num(isObj(compMultiRaw.low) ? compMultiRaw.low.kneeDb : undefined, 0, 24, 6),
          attackMs: num(isObj(compMultiRaw.low) ? compMultiRaw.low.attackMs : undefined, 0, 500, 12),
          releaseMs: num(isObj(compMultiRaw.low) ? compMultiRaw.low.releaseMs : undefined, 0, 3000, 180),
          makeupDb: num(isObj(compMultiRaw.low) ? compMultiRaw.low.makeupDb : undefined, -24, 24, 0),
        },
        mid: {
          thresholdDb: num(isObj(compMultiRaw.mid) ? compMultiRaw.mid.thresholdDb : undefined, -60, 0, -20),
          ratio: num(isObj(compMultiRaw.mid) ? compMultiRaw.mid.ratio : undefined, 1, 50, 2.5),
          kneeDb: num(isObj(compMultiRaw.mid) ? compMultiRaw.mid.kneeDb : undefined, 0, 24, 6),
          attackMs: num(isObj(compMultiRaw.mid) ? compMultiRaw.mid.attackMs : undefined, 0, 500, 10),
          releaseMs: num(isObj(compMultiRaw.mid) ? compMultiRaw.mid.releaseMs : undefined, 0, 3000, 150),
          makeupDb: num(isObj(compMultiRaw.mid) ? compMultiRaw.mid.makeupDb : undefined, -24, 24, 0),
        },
        high: {
          thresholdDb: num(isObj(compMultiRaw.high) ? compMultiRaw.high.thresholdDb : undefined, -60, 0, -24),
          ratio: num(isObj(compMultiRaw.high) ? compMultiRaw.high.ratio : undefined, 1, 50, 2),
          kneeDb: num(isObj(compMultiRaw.high) ? compMultiRaw.high.kneeDb : undefined, 0, 24, 6),
          attackMs: num(isObj(compMultiRaw.high) ? compMultiRaw.high.attackMs : undefined, 0, 500, 5),
          releaseMs: num(isObj(compMultiRaw.high) ? compMultiRaw.high.releaseMs : undefined, 0, 3000, 100),
          makeupDb: num(isObj(compMultiRaw.high) ? compMultiRaw.high.makeupDb : undefined, -24, 24, 0),
        },
      },
    },
    nightMode: {
      enabled: bool(nightRaw.enabled, false),
      amount: num(nightRaw.amount, 0, 10, 0),
    },
    bassEnhancer: {
      enabled: bool(bassRaw.enabled, false),
      cutoffHz: num(bassRaw.cutoffHz, 20, 500, 90),
      q: num(bassRaw.q, 0.1, 10, 0.7),
      harmonicType: oneOf(bassRaw.harmonicType, ['odd', 'even', 'atan', 'soft'] as const, 'odd'),
      harmonicGain: num(bassRaw.harmonicGain, 0, 1, 0.6),
      mix: num(bassRaw.mix, 0, 1, 0.5),
      levelDb: num(bassRaw.levelDb, -6, 6, 0),
      lowBoostDb: num(bassRaw.lowBoostDb, -6, 12, 0),
    },
    reverb: {
      enabled: bool(revRaw.enabled, false),
      mode: oneOf(revRaw.mode, ['convolution', 'algorithmic', 'off'] as const, 'algorithmic'),
      algorithmic: {
        type: oneOf(revAlgRaw.type, ['hall', 'room', 'plate', 'spring', 'stage'] as const, 'hall'),
        roomSize: num(revAlgRaw.roomSize, 0, 1, 0.5),
        damping: num(revAlgRaw.damping, 0, 1, 0.5),
        wet: num(revAlgRaw.wet, 0, 1, 0.3),
        dry: num(revAlgRaw.dry, 0, 1, 0.7),
        preDelayMs: num(revAlgRaw.preDelayMs, 0, 500, 0),
        width: num(revAlgRaw.width, 0, 2, 1),
      },
      convolution: {
        ir: null, // IR 数组不进入分享串；解码后恒为 null，由调用方按 irName 重新加载
        irId: str(revConvRaw.irId, null, 128),
        irName: str(revConvRaw.irName, null, 256),
        purpose: oneOf(revConvRaw.purpose, ['reverb', 'roomCorrection', 'speakerCorrection', 'headphoneCorrection'] as const, 'reverb'),
        mix: num(revConvRaw.mix, 0, 1, 0.3),
        preDelayMs: num(revConvRaw.preDelayMs, 0, 500, 0),
        partitionSize: numOneOf(revConvRaw.partitionSize, [128, 256, 512, 1024] as const, 512),
        dePeriodize: bool(revConvRaw.dePeriodize, true),
      },
    },
    surround3d: {
      enabled: bool(surRaw.enabled, false),
      // 引擎域 0..1（scale = 0.5 + 0.5·d）：此前 clamp 0..10 与引擎域不一致，
      // 分享串传 distance=10 会把环绕电平拉到 5.5×，下游限幅器长期深压缩
      distance: num(surRaw.distance, 0, 1, 0.5),
      speed: num(surRaw.speed, 0, 10, 1),
      angle: num(surRaw.angle, -360, 360, 0),
      direction: numOneOf(surRaw.direction, [1, -1] as const, 1),
    },
    loudnessCompensation: {
      enabled: bool(lcRaw.enabled, false),
      mode: oneOf(lcRaw.mode, ['auto', 'preset', 'custom'] as const, 'auto'),
      preset: oneOf(lcRaw.preset, ['flat', 'bass', 'vocal', 'warm', 'bright', 'night'] as const, 'flat'),
      bands: lcBands,
      volumePercent: num(lcRaw.volumePercent, 0, 100, 80),
      maxBoostDb: num(lcRaw.maxBoostDb, 0, 24, 12),
      smoothingSeconds: num(lcRaw.smoothingSeconds, 0.01, 10, 0.2),
    },
    loudnessNormalization: {
      enabled: bool(lnRaw.enabled, false),
      targetLufs: num(lnRaw.targetLufs, -40, 0, -14),
      maxGainDb: num(lnRaw.maxGainDb, 0, 24, 9),
      minGainDb: num(lnRaw.minGainDb, -24, 0, -9),
      useRealtimeMeter: bool(lnRaw.useRealtimeMeter, true),
      externalGainDb: num(lnRaw.externalGainDb, -24, 24, 0),
      replayGainMode: oneOf(lnRaw.replayGainMode, ['off', 'track', 'album'] as const, 'off'),
      replayGainDb: lnRaw.replayGainDb === null ? null : num(lnRaw.replayGainDb, -60, 24, 0),
    },
    limiter: {
      enabled: bool(limRaw.enabled, true),
      thresholdDb: num(limRaw.thresholdDb, -60, 0, -1),
      lookaheadMs: num(limRaw.lookaheadMs, 0, 50, 5),
      attackMs: num(limRaw.attackMs, 0, 50, 0.5),
      releaseMs: num(limRaw.releaseMs, 0, 2000, 150),
      truePeak: bool(limRaw.truePeak, true),
    },
    ieq: {
      enabled: bool(ieqRaw.enabled, false),
      strength: num(ieqRaw.strength, 0, 1, 0.5),
      targetCurve: oneOf(ieqRaw.targetCurve, ['flat', 'warm', 'bright', 'vocal'] as const, 'flat'),
      timeConstantSec: num(ieqRaw.timeConstantSec, 0.1, 10, 3),
    },
    pitch: {
      enabled: bool(pitchRaw.enabled, false),
      semitones: num(pitchRaw.semitones, -10, 10, 0),
      rate: num(pitchRaw.rate, 0.25, 3, 1),
      voiceBalance: num(pitchRaw.voiceBalance, -1, 1, 0),
    },
    hearing: {
      enabled: bool(hearingRaw.enabled, false),
    },
    // 空间音频（第 15 级）：raw 缺 spatial 字段 → decodeSpatial 返回默认 off；
    // 旧分享串（无 spatial）往返得默认 off，行为与 v3 历史一致
    spatial: decodeSpatial(raw.spatial),
    stereoWidth: num(raw.stereoWidth, 0, 2, 1),
    lowMonoAmount: num(raw.lowMonoAmount, 0, 1, 0),
    lowMonoCutoffHz: num(raw.lowMonoCutoffHz, 40, 250, 120),
    subsonicEnabled: bool(raw.subsonicEnabled, false),
    subsonicCutoffHz: num(raw.subsonicCutoffHz, 10, 40, 20),
    channelCalibration: {
      enabled: bool(channelRaw.enabled, false),
      leftDb: num(channelRaw.leftDb, -24, 24, 0),
      rightDb: num(channelRaw.rightDb, -24, 24, 0),
    },
    sceneId: str(raw.sceneId, null, 64),
    customized: bool(raw.customized, false),
  }
}

// ---------------------------------------------------------------------------
// 编码：固定字段顺序构造可序列化快照（去 IR 数组 → 仅 irName）
// ---------------------------------------------------------------------------
function toShareObject(p: V3EngineParams): unknown {
  return {
    sampleRate: p.sampleRate,
    bitPerfectBypass: p.bitPerfectBypass ?? false,
    processingOrder: p.processingOrder ?? [...DEFAULT_PROCESSING_ORDER],
    precision: p.precision ?? 'float32',
    eq: {
      enabled: p.eq.enabled,
      mode: p.eq.mode,
      simpleBands: p.eq.simpleBands.slice(0, 5),
      proBands: p.eq.proBands.slice(0, MAX_PRO_EQ_BANDS).map((b) => ({
        frequency: b.frequency,
        gain: b.gain,
        q: b.q,
        ...(b.type ? { type: b.type } : {}),
      })),
      bandCount: p.eq.bandCount,
      qCompensation: p.eq.qCompensation,
      locked: p.eq.locked,
    },
    dynamicEq: p.dynamicEq ? { ...p.dynamicEq } : undefined,
    crossfeed: p.crossfeed ? { ...p.crossfeed } : undefined,
    deesser: {
      enabled: p.deesser.enabled,
      centerHz: p.deesser.centerHz,
      q: p.deesser.q,
      thresholdDb: p.deesser.thresholdDb,
      ratio: p.deesser.ratio,
      attackMs: p.deesser.attackMs,
      releaseMs: p.deesser.releaseMs,
      splitBand: p.deesser.splitBand,
      mix: p.deesser.mix,
    },
    compressor: {
      enabled: p.compressor.enabled,
      mode: p.compressor.mode ?? 'downward',
      upwardMaxGainDb: p.compressor.upwardMaxGainDb ?? 24,
      transientPreserve: p.compressor.transientPreserve ?? 0,
      thresholdDb: p.compressor.thresholdDb,
      ratio: p.compressor.ratio,
      kneeDb: p.compressor.kneeDb,
      attackMs: p.compressor.attackMs,
      releaseMs: p.compressor.releaseMs,
      makeupDb: p.compressor.makeupDb,
      outputGain: p.compressor.outputGain,
      multiband: p.compressor.multiband ? {
        lowMidHz: p.compressor.multiband.lowMidHz,
        midHighHz: p.compressor.multiband.midHighHz,
        low: { ...p.compressor.multiband.low },
        mid: { ...p.compressor.multiband.mid },
        high: { ...p.compressor.multiband.high },
      } : undefined,
    },
    nightMode: {
      enabled: p.nightMode.enabled,
      amount: p.nightMode.amount,
    },
    bassEnhancer: {
      enabled: p.bassEnhancer.enabled,
      cutoffHz: p.bassEnhancer.cutoffHz,
      q: p.bassEnhancer.q,
      harmonicType: p.bassEnhancer.harmonicType,
      harmonicGain: p.bassEnhancer.harmonicGain,
      mix: p.bassEnhancer.mix,
      levelDb: p.bassEnhancer.levelDb,
      lowBoostDb: p.bassEnhancer.lowBoostDb,
    },
    reverb: {
      enabled: p.reverb.enabled,
      mode: p.reverb.mode,
      algorithmic: {
        type: p.reverb.algorithmic.type,
        roomSize: p.reverb.algorithmic.roomSize,
        damping: p.reverb.algorithmic.damping,
        wet: p.reverb.algorithmic.wet,
        dry: p.reverb.algorithmic.dry,
        preDelayMs: p.reverb.algorithmic.preDelayMs,
        width: p.reverb.algorithmic.width,
      },
      // 去 IR 数组：卷积 IR 只保留 irName 引用，ir 不参与序列化
      convolution: {
        irId: p.reverb.convolution.irId ?? null,
        irName: p.reverb.convolution.irName,
        purpose: p.reverb.convolution.purpose ?? 'reverb',
        mix: p.reverb.convolution.mix,
        preDelayMs: p.reverb.convolution.preDelayMs,
        partitionSize: p.reverb.convolution.partitionSize ?? 512,
        dePeriodize: p.reverb.convolution.dePeriodize,
      },
    },
    surround3d: {
      enabled: p.surround3d.enabled,
      distance: p.surround3d.distance,
      speed: p.surround3d.speed,
      angle: p.surround3d.angle,
      direction: p.surround3d.direction,
    },
    loudnessCompensation: {
      enabled: p.loudnessCompensation.enabled,
      mode: p.loudnessCompensation.mode,
      preset: p.loudnessCompensation.preset,
      bands: p.loudnessCompensation.bands.slice(0, 32).map((b) => ({ frequency: b.frequency, gain: b.gain })),
      volumePercent: p.loudnessCompensation.volumePercent,
      maxBoostDb: p.loudnessCompensation.maxBoostDb,
      smoothingSeconds: p.loudnessCompensation.smoothingSeconds,
    },
    loudnessNormalization: {
      enabled: p.loudnessNormalization.enabled,
      targetLufs: p.loudnessNormalization.targetLufs,
      maxGainDb: p.loudnessNormalization.maxGainDb,
      minGainDb: p.loudnessNormalization.minGainDb,
      useRealtimeMeter: p.loudnessNormalization.useRealtimeMeter,
      externalGainDb: p.loudnessNormalization.externalGainDb,
      replayGainMode: p.loudnessNormalization.replayGainMode ?? 'off',
      replayGainDb: p.loudnessNormalization.replayGainDb ?? null,
    },
    limiter: {
      enabled: p.limiter.enabled,
      thresholdDb: p.limiter.thresholdDb,
      lookaheadMs: p.limiter.lookaheadMs,
      attackMs: p.limiter.attackMs,
      releaseMs: p.limiter.releaseMs,
      truePeak: p.limiter.truePeak,
    },
    ieq: {
      enabled: p.ieq.enabled,
      strength: p.ieq.strength,
      targetCurve: p.ieq.targetCurve,
      timeConstantSec: p.ieq.timeConstantSec,
    },
    pitch: {
      enabled: p.pitch.enabled,
      semitones: p.pitch.semitones,
      rate: p.pitch.rate,
      voiceBalance: p.pitch.voiceBalance,
    },
    hearing: {
      enabled: p.hearing.enabled,
    },
    // 空间音频（第 15 级）：作为清洗后的 JSON 块整体序列化（子结构形状由 spatial/types 定义，
    // 引擎内联后无需 share-code 级别的逐字段白名单——解码端 deepSanitizeSpatial
    // 递归过滤为 plain data 防 prototype 污染/超大 payload；非法/缺省 → 默认 off）。
    spatial: p.spatial ? encodeSpatial(p.spatial) : undefined,
    stereoWidth: p.stereoWidth,
    lowMonoAmount: p.lowMonoAmount ?? 0,
    lowMonoCutoffHz: p.lowMonoCutoffHz ?? 120,
    subsonicEnabled: p.subsonicEnabled ?? false,
    subsonicCutoffHz: p.subsonicCutoffHz ?? 20,
    channelCalibration: p.channelCalibration ? { ...p.channelCalibration } : undefined,
    sceneId: p.sceneId,
    customized: p.customized,
  }
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/** 序列化：版本 + JSON(去 IR 数组→irName) + FNV-1a 校验 → base64url */
export function encodeShareCode(p: V3EngineParams): string {
  const json = JSON.stringify(toShareObject(p))
  const payload = SHARE_CODEC_VERSION + ':' + checksumOf(SHARE_CODEC_VERSION, json) + ':' + json
  return bytesToBase64Url(utf8Encode(payload))
}

/** 反序列化：版本/校验和验证 + 白名单字段 + 数值 clamp；非法输入抛 Error */
export function decodeShareCode(s: string): V3EngineParams & { spatial: SpatialSettings } {
  if (typeof s !== 'string' || s.length === 0) {
    throw new Error('invalid share code: empty input')
  }
  let text: string
  try {
    text = utf8Decode(base64UrlToBytes(s))
  } catch (e) {
    throw new Error('invalid share code: ' + (e instanceof Error ? e.message : 'bad base64url'))
  }
  const firstColon = text.indexOf(':')
  if (firstColon <= 0) throw new Error('invalid share code: missing version')
  const version = text.slice(0, firstColon)
  // 布局：<version>:<8位校验和>:<json> —— json 起点 = 版本冒号 + 1 + 校验和长度(8) + 1
  const checksum = text.slice(firstColon + 1, firstColon + 9)
  const json = text.slice(firstColon + 10)
  if (version !== String(SHARE_CODEC_VERSION)) {
    throw new Error('unsupported share code version: ' + version)
  }
  if (!/^[0-9a-f]{8}$/.test(checksum)) {
    throw new Error('invalid share code: bad checksum format')
  }
  if (checksumOf(SHARE_CODEC_VERSION, json) !== checksum) {
    throw new Error('share code checksum mismatch')
  }
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    throw new Error('invalid share code: malformed JSON')
  }
  return sanitizeParams(raw)
}
