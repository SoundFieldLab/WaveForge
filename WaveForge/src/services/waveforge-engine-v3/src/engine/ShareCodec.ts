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

import type { V3EngineParams, EqBand } from '../types'

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

/** 白名单重建：只读取已知字段，未知字段（含 __proto__ 等注入键）一律丢弃 */
function sanitizeParams(raw: unknown): V3EngineParams {
  if (!isObj(raw)) throw new Error('invalid share code payload')
  const sampleRate = Math.round(num(raw.sampleRate, 8000, 192000, 48000))

  const eqRaw = isObj(raw.eq) ? raw.eq : {}
  const deesserRaw = isObj(raw.deesser) ? raw.deesser : {}
  const compRaw = isObj(raw.compressor) ? raw.compressor : {}
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

  // eq.simpleBands：5 段，缺失补 0
  const simple = numArray(eqRaw.simpleBands, -20, 20, [0, 0, 0, 0, 0], 5)
  while (simple.length < 5) simple.push(0)

  // eq.proBands：白名单 {frequency,gain,q}；字段缺失 → 默认 10 段；显式空数组 → 保留空
  let proBands: EqBand[] = defaultEqProBands()
  if (Array.isArray(eqRaw.proBands)) {
    const parsed: EqBand[] = []
    for (const b of eqRaw.proBands) {
      if (parsed.length >= 20) break
      if (isObj(b)) {
        parsed.push({
          frequency: num(b.frequency, 20, 20000, 1000),
          gain: num(b.gain, -20, 20, 0),
          q: num(b.q, 0.1, 10, 1.1),
        })
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
    eq: {
      enabled: bool(eqRaw.enabled, true),
      mode: oneOf(eqRaw.mode, ['simple', 'pro'] as const, 'pro'),
      simpleBands: simple,
      proBands,
      bandCount: numOneOf(eqRaw.bandCount, [10, 20] as const, 10),
      qCompensation: bool(eqRaw.qCompensation, true),
      locked: bool(eqRaw.locked, false),
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
      thresholdDb: num(compRaw.thresholdDb, -60, 0, -20),
      ratio: num(compRaw.ratio, 1, 50, 4),
      kneeDb: num(compRaw.kneeDb, 0, 24, 6),
      attackMs: num(compRaw.attackMs, 0, 500, 10),
      releaseMs: num(compRaw.releaseMs, 0, 3000, 150),
      makeupDb: num(compRaw.makeupDb, -24, 24, 0),
      outputGain: num(compRaw.outputGain, 0, 2, 1),
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
        irName: str(revConvRaw.irName, null, 256),
        mix: num(revConvRaw.mix, 0, 1, 0.3),
        preDelayMs: num(revConvRaw.preDelayMs, 0, 500, 0),
        dePeriodize: bool(revConvRaw.dePeriodize, true),
      },
    },
    surround3d: {
      enabled: bool(surRaw.enabled, false),
      distance: num(surRaw.distance, 0, 10, 0.5),
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
    stereoWidth: num(raw.stereoWidth, 0, 2, 1),
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
    eq: {
      enabled: p.eq.enabled,
      mode: p.eq.mode,
      simpleBands: p.eq.simpleBands.slice(0, 5),
      proBands: p.eq.proBands.slice(0, 20).map((b) => ({ frequency: b.frequency, gain: b.gain, q: b.q })),
      bandCount: p.eq.bandCount,
      qCompensation: p.eq.qCompensation,
      locked: p.eq.locked,
    },
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
      thresholdDb: p.compressor.thresholdDb,
      ratio: p.compressor.ratio,
      kneeDb: p.compressor.kneeDb,
      attackMs: p.compressor.attackMs,
      releaseMs: p.compressor.releaseMs,
      makeupDb: p.compressor.makeupDb,
      outputGain: p.compressor.outputGain,
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
        irName: p.reverb.convolution.irName,
        mix: p.reverb.convolution.mix,
        preDelayMs: p.reverb.convolution.preDelayMs,
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
    stereoWidth: p.stereoWidth,
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
export function decodeShareCode(s: string): V3EngineParams {
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