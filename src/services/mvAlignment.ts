/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 */
/**
 * MV 背景 ↔ 歌曲「对齐」服务
 *
 * MV 背景是静音循环视频，画面时间要映射到歌曲音频时间轴上。不同 MV 的起点不同：
 * 有的开口即唱（offset≈0），有的带前摇/前奏（offset 为几秒到几十秒），现场版/翻唱
 * 则根本对不上。盲目用「音频位置 % 视频时长」做同步（旧逻辑）会对不上的视频反复
 * seek → 每次 seek 触发重缓冲 → 形成「放着放着卡一下」的死循环。
 *
 * 本服务为每个 (歌曲, MV) 计算一个带置信度的偏移量：
 * - 字幕对齐（快/准）：MV 的 B 站 CC 字幕行时间 ↔ 本地歌词行时间做文本匹配，取偏移中位数
 * - 节拍对齐（通用/慢）：Python beat 服务分析 MV 音频轨的节拍点，与歌曲节拍点做互相关峰值
 * - 置信度不足（现场版/翻唱/完全对不上）→ 返回 null，调用方"不操作"（自由循环播放）
 *
 * 结果按 (songKey, bvid) 持久化（localStorage），同一对只算一次。
 */

import type { LyricLine } from './musicApi'
import type { TrackAnalysis } from '../audio/types'
import {
  getBilibiliPlayUrl,
  bilibiliStreamUrl,
  getBilibiliSubtitles,
  getBilibiliSubtitleJson,
  pickBestSubtitle,
  cleanSubtitleLines,
  getBilibiliWatchSettings,
  type BilibiliSubtitleLine,
} from './bilibiliApi'
import { autoMixAnalysisService, computeVocalBandEnvelope, decodeAudioUrl, computeFrameEnvelope, detectLiveMusicEntry, detectLiveMusicEntryAt, detectMusicStart, envelopeOffsetOf, envelopeSegmentAnchors, envelopeSegmentSupport, envelopeSegmentVote, ENVELOPE_PROMINENCE_MIN } from './autoMixAnalysisService'

export interface MvAlignment {
  /** MV 视频时间 - 歌曲音频时间的偏移（秒）：歌曲位置 s 对应视频位置 s + offsetSeconds */
  offsetSeconds: number
  /** 0-1 置信度 */
  confidence: number
  method: 'subtitle' | 'beat' | 'live-vocal' | 'envelope'
  /**
   * 判定来源溯源（可选，线上审计用）：'model-veto' = 模型否决路径产出，'model-rescue' =
   * 闸门拒绝后模型翻案，'subtitle-scan' = 字幕翻译口径全局扫描（低样本），缺省 = 常规
   * 证据链。rescue/封顶产物进 30 天缓存后与普通对齐不可区分——线上审计「翻案采纳的
   * 对齐实际表现如何」必须靠这个字段。
   */
  source?: 'model-rescue' | 'subtitle-scan'
  /** 包络峰突出度（method=envelope 时携带）：主峰 − ±2s 外次峰，持久化迁移据此裁决可信度 */
  prominence?: number
  /**
   * 分段偏移锚点（method=envelope 且现场改编显著时携带，可选）：现场版中段常有
   * 讲段/即兴/变速（实测 俺の彼女 巡演中段 140-225s 在全局锚处相关≈0），恒定偏移
   * 会逐句漂。锚点 = 段相关 ≥0.5 的"段相关≥高置信"段落的局部最优偏移，改编区由
   * 相邻锚线性内插。同步层用 offsetAt(alignment, songTime) 取当前偏移。
   */
  segments?: MvAlignmentSegment[]
}

/** 分段偏移锚点：锚点段中心的歌曲时间 + 该段局部偏移（升序 songTime） */
export interface MvAlignmentSegment {
  songTime: number
  offsetSeconds: number
  /** 段内相关（0-1）：同步层插值时按相关性加权 */
  correlation: number
}

/** 低于该置信度视为不可靠，调用方应自由播放、不做对齐校正 */
export const MIN_ALIGNMENT_CONFIDENCE = 0.5
/** 偏移量合理性上限：前摇超过 45s 基本是货不对板（别的现场/剪辑），不冒险对齐 */
const MAX_SANE_OFFSET_SECONDS = 45
/**
 * 包络偏移的硬上限：现场/巡演投稿 MV 常带数十秒开场（欢呼/报幕/客座乐手独奏），
 * 真偏移可超 45s（俺の彼女 巡演实测 +54.7s 被旧 45 上限截断）。超过 90s 的"偏移"
 * 几乎必然是 MV 长出一整段与本曲无关的内容（MC/串场），不冒险对齐。
 */
const MAX_ENVELOPE_OFFSET_SECONDS = 90
/** 包络证据链的结构证实门槛：段落支持率（恒定偏移下 30s 段相关>0.4 的占比）。
 *  实测标定：真对齐 0.44、全部假峰 0.00——0.35 留出弱段干扰余量 */
const ENVELOPE_SEGMENT_SUPPORT_MIN = 0.35

/**
 * 包络证据链裁决模型（逻辑回归，2026-10-18 用 .tmp-kg-align 采集集训练标定）：
 * 训练数据 = live-eval-results × live-evidence join 的 206 条金样本（124 可救 / 82 不可救；
 * 真值来自三探测器入口锚一致的 strong-anchor，无需人工标注）。9 特征全部是证据链
 * 在线已计算的量。5 折 CV：救 96% / 误放 1%——对照现行规则闸门在同样本上误放 12/82
 * （翻唱/混剪被错放 → 歌词错位），模型把它压到 1/82。
 * 半监督扩展实验（votes-cache 5222 条弱标签）召回反降至 60%——弱标签有噪声，不采用。
 * 用法是「双向补丁」而非替换闸门：
 *  - 否决（veto）：闸门放行但 score<0.25 且 peak<0.6（非同录音铁证）→ 拒绝；
 *    实测砍掉 10/12 误放、0 漏救（阈值 0.25/0.3 效用并列最优，取 0.25 留召回余量）。
 *  - 翻案（rescue）：闸门拒绝但 score≥0.7 且投票-峰偏移一致 ≤1.5s → 弱对齐采纳
 *    （conf 封顶 0.55，同步层追频容差自动放宽；本标定集上闸门拒绝子集无漏救，
 *    该分支是保险带，覆盖标定集未见的组合）。
 */
const EVIDENCE_MODEL_FEATURES = ['peak', 'prom', 'support', 'anchors', 'strongAnchors', 'anchorSpread', 'segs', 'durRatio', 'voteOffDelta'] as const
/** v1 模型：206 条金样本（live-eval × evidence join，2026-10-18）——硬真值口径精确 */
const EVIDENCE_MODEL_MU = [0.585491, 0.139356, 0.595812, 4.495146, 2.57767, 0.843204, 6.461165, 1.174453, 10.21165]
const EVIDENCE_MODEL_SD = [0.269441, 0.123276, 0.433484, 3.316255, 2.666092, 1.842415, 2.065892, 1.496235, 18.76248]
const EVIDENCE_MODEL_WEIGHTS = [0.941639, 0.927916, 1.675872, 0.869195, 0.432629, -0.143366, -0.000179, -0.097504, -0.873591]
const EVIDENCE_MODEL_BIAS = 1.39506
/** v2/v3 模型：4712-4750 条样本（5524 组全量复算重标定，2026-10-18）。v3 在 v2 基础上
 *  两项修正：① 共识过滤——256/1343 首的「强候选间偏移散布>2s」的不可靠共识歌不产灰区
 *  标签（共识本身错时相对标签就是噪声）；② 灰区样本降权 0.5（相对标签弱于硬真值）。
 *  v3 单独 CV 召回 87.8%/误放 2.2%，但与 v1 组合后是全部组合里最优的：
 *  金样本 救121/误放1/漏救3（v1+v2 为 119/1/5，三模型 120/3/4）——不对称效用（救-3×误放）
 *  v1+v3=118 最高，故产线取 v1+v3 均值。 */
const EVIDENCE_MODEL_V2_MU = [0.79703, 0.23193, 0.237065, 1.111158, 1.111158, 0.976632, 4.417684, 1.087691, 27.685112]
const EVIDENCE_MODEL_V2_SD = [0.297421, 0.152234, 0.207844, 0.843715, 0.843715, 1.975023, 1.946512, 1.061153, 7.837813]
const EVIDENCE_MODEL_V2_WEIGHTS = [2.255976, 1.197891, 0.697516, 0.548505, 0.548505, -0.45519, 0.113254, -0.182286, 0.267588]
const EVIDENCE_MODEL_V2_BIAS = 2.295523
const EVIDENCE_MODEL_V3_MU = [0.801298, 0.234174, 0.238572, 1.108111, 1.108111, 0.979498, 4.398835, 1.091605, 27.665915]
const EVIDENCE_MODEL_V3_SD = [0.304654, 0.153841, 0.209564, 0.85274, 0.85274, 1.975575, 1.944622, 1.091735, 7.866195]
const EVIDENCE_MODEL_V3_WEIGHTS = [6.604523, 2.840231, 1.744424, 5.630855, 5.630855, -1.833398, 0.0857, -1.692419, -0.509836]
const EVIDENCE_MODEL_V3_BIAS = -0.062846
const EVIDENCE_MODEL_VETO_SCORE = 0.25
const EVIDENCE_MODEL_RESCUE_SCORE = 0.7
const EVIDENCE_MODEL_RESCUE_MAX_VOTE_DELTA = 1.5

export interface EvidenceModelInput {
  peak: number
  prom: number
  support: number
  anchors: number
  strongAnchors: number
  anchorSpread: number
  segs: number
  durRatio: number
  voteOffDelta: number
}

const sigmoid01 = (z: number): number => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))))

function evidenceModelForward(mu: number[], sd: number[], weights: number[], bias: number, values: number[]): number {
  let z = bias
  for (let i = 0; i < values.length; i += 1) {
    const value = Number.isFinite(values[i]) ? values[i] : 0
    z += weights[i] * (value - mu[i]) / sd[i]
  }
  return sigmoid01(z)
}

/** 证据链裁决模型前向（v1+v3 ensemble 均值）：返回 P(可救)∈[0,1]。输入缺失按 0 处理。 */
export function scoreEvidenceAlignment(input: EvidenceModelInput): number {
  const values = [input.peak, input.prom, input.support, input.anchors, input.strongAnchors, input.anchorSpread, input.segs, input.durRatio, input.voteOffDelta]
  const v1 = evidenceModelForward(EVIDENCE_MODEL_MU, EVIDENCE_MODEL_SD, EVIDENCE_MODEL_WEIGHTS, EVIDENCE_MODEL_BIAS, values)
  const v3 = evidenceModelForward(EVIDENCE_MODEL_V3_MU, EVIDENCE_MODEL_V3_SD, EVIDENCE_MODEL_V3_WEIGHTS, EVIDENCE_MODEL_V3_BIAS, values)
  return (v1 + v3) / 2
}

/**
 * 从包络证据链的运行时量构造模型输入。anchors 统计取自 envelopeSegmentAnchors
 *（与采纳路径的分段锚点同一来源）；无锚点（全曲均匀贴合）时 anchors/strongAnchors/
 * anchorSpread 记 0——训练集里「锚点全部≈全局锚」的样本正是这个形态。
 */
function buildEvidenceModelInput(args: {
  peak: number
  prom: number
  supportRatio: number
  supportSegments: number
  voteOffset: number | null | undefined
  envOffset: number
  songDuration: number
  mvDuration: number | undefined
  anchors: Array<{ offsetSeconds: number; correlation: number }> | null
}): EvidenceModelInput {
  const anchors = args.anchors ?? []
  const strongAnchors = anchors.filter((a) => a.correlation >= 0.5).length
  const anchorSpread = anchors.length >= 2
    ? Math.max(...anchors.map((a) => a.offsetSeconds)) - Math.min(...anchors.map((a) => a.offsetSeconds))
    : 0
  return {
    peak: args.peak,
    prom: args.prom,
    support: args.supportRatio,
    anchors: anchors.length,
    strongAnchors,
    anchorSpread,
    segs: args.supportSegments,
    durRatio: args.songDuration > 0 && args.mvDuration && args.mvDuration > 0 ? args.mvDuration / args.songDuration : 1,
    voteOffDelta: args.voteOffset != null ? Math.abs(args.voteOffset - args.envOffset) : 30,
  }
}

/**
 * 包络互相关结果的统一裁决：峰值与峰突出度双门槛，置信度按证据分级。
 * 旧版把置信度硬编码 0.55（恰好压过 0.5 门槛）且只看绝对峰值——phonk 等重复结构
 * 的相关曲线平坦、±2s 外常有几乎等高的竞争峰，argmax 落在错误重复段照样过闸
 * （实测 Одна offset=-1.8s、真实 ≈+3s，背景整体慢一句）。突出度不足 = 偏移
 * 是"抛硬币"选出来的 → 拒绝（自由播放），宁缺毋滥。
 */
export function buildEnvelopeAlignment(offsetSeconds: number, peak: number, prominence: number): MvAlignment | null {
  if (!(peak >= 0.6) || !(prominence >= ENVELOPE_PROMINENCE_MIN)) return null
  if (!Number.isFinite(offsetSeconds) || Math.abs(offsetSeconds) > MAX_SANE_OFFSET_SECONDS) return null
  const confidence = Math.max(0, Math.min(0.8, 0.4 + (peak - 0.6) + prominence * 2))
  return { offsetSeconds: Math.round(offsetSeconds * 100) / 100, confidence, method: 'envelope', prominence: Math.round(prominence * 100) / 100 }
}

/**
 * 取歌曲位置 songTime 的瞬时偏移：有分段锚点时在相邻锚点间插值（位置线性 +
 * 相关性抛物线修正：端点严格等于锚点值，中点偏向相关性更高的一侧），
 * 锚点区间外用最近锚；无锚点/非法输入退回恒定 offsetSeconds。
 * 纯函数（同步层每秒调用），无状态。
 */
export function offsetAt(alignment: MvAlignment | null | undefined, songTime: number): number {
  if (!alignment) return 0
  const segments = alignment.segments
  if (!segments || segments.length === 0 || !Number.isFinite(songTime)) return alignment.offsetSeconds
  if (songTime <= segments[0].songTime) return segments[0].offsetSeconds
  const last = segments[segments.length - 1]
  if (songTime >= last.songTime) return last.offsetSeconds
  for (let i = 0; i < segments.length - 1; i += 1) {
    const a = segments[i]
    const b = segments[i + 1]
    if (songTime >= a.songTime && songTime <= b.songTime) {
      const span = b.songTime - a.songTime
      if (span <= 0) return b.offsetSeconds
      const t = (songTime - a.songTime) / span
      const parabola = 4 * (1 - t) * t // 端点 0、中点 1
      const corrBias = 0.5 * (a.correlation / Math.max(1e-6, a.correlation + b.correlation) - 0.5)
      return a.offsetSeconds + (b.offsetSeconds - a.offsetSeconds) * (t - corrBias * parabola)
    }
  }
  return alignment.offsetSeconds
}

// v3：拍点网格路径曾把循环自证的 conf=1.00 偏移（现场/翻唱 MV 拿录音室节拍强对齐）
// 写入 v2 缓存 30 天（俺の彼女 越播越偏），该判定已修复——旧记录无法自证清白，直接弃用
const STORAGE_KEY = 'waveforge:mv-alignments:v3-seconds'
const LEGACY_STORAGE_KEY = 'waveforge:mv-alignments:v2-seconds'
const CACHE_MAX = 200
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 天
const NEGATIVE_CACHE_TTL_MS = 30 * 1000

interface CachedEntry extends MvAlignment {
  ts: number
  /** 写入时的候选类型：loadPersisted 据此裁决 live-vocal 旧记录是否可信（见 loadPersisted 迁移注释） */
  candidateType?: string
}

type MemoryEntry = MvAlignment & { candidateType?: string }

const memoryCache = new Map<string, MemoryEntry>()
const inFlight = new Map<string, Promise<MvAlignment | null>>()
const prewarmInFlight = new Map<string, Promise<void>>()
const negativeCache = new Map<string, { signature: string; expiresAt: number }>()

function hashString(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

/** 失败缓存按当前可用输入签名隔离；歌词加载完成或流 URL 刷新后应立即允许重试。 */
export function mvAlignmentInputSignature(input: MvAlignmentInput): string {
  const lyrics = Array.isArray(input.lyrics)
    ? input.lyrics.map(line => `${line?.time ?? ''}:${line?.text ?? ''}`).join('\n')
    : ''
  return [
    `lyrics:${lyrics ? hashString(lyrics) : '-'}`,
    `song:${input.songUrl ? hashString(input.songUrl) : '-'}`,
    `video:${input.videoUrl ? hashString(input.videoUrl) : '-'}`,
    `cid:${input.cid || 0}`,
    `type:${input.candidateType || '-'}`,
    `cc:${input.ccVerification || 'unverified'}`,
  ].join('|')
}

function isNegativelyCached(key: string, signature: string): boolean {
  const cached = negativeCache.get(key)
  if (!cached) return false
  if (cached.expiresAt <= Date.now() || cached.signature !== signature) {
    negativeCache.delete(key)
    return false
  }
  return true
}

function rememberAlignmentFailure(key: string, signature: string, signal?: AbortSignal): void {
  if (!signal?.aborted) negativeCache.set(key, { signature, expiresAt: Date.now() + NEGATIVE_CACHE_TTL_MS })
}

/** 测试隔离用；生产代码不应调用。 */
export function resetMvAlignmentCachesForTests(): void {
  memoryCache.clear()
  inFlight.clear()
  prewarmInFlight.clear()
  negativeCache.clear()
}

/** MV 对齐调试日志：写入 userData/automix-backend.log（[renderer:MvAlign]），便于人工核对 */
const mvLog = (msg: string): void => {
  // eslint-disable-next-line no-console
  console.log('[MvAlign]', msg)
  // Node 测试环境无 window（vitest node 环境跑 detectOffsetFromBeats），守卫避免 ReferenceError
  if (typeof window === 'undefined') return
  void window.electron?.automixLog?.('MvAlign', msg)?.catch?.(() => undefined)
}

function loadPersisted(): Map<string, MemoryEntry> {
  try {
    // 版本迁移：旧键直接删除（v2 时代写入的拍点网格偏移无法自证清白，见 STORAGE_KEY 注释；
    // 其余正常记录重算便宜，丢弃无代价）
    try { localStorage.removeItem(LEGACY_STORAGE_KEY) } catch { /* 忽略：读取即隔离 */ }
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return new Map()
    const parsed = JSON.parse(raw) as Record<string, CachedEntry>
    const now = Date.now()
    const map = new Map<string, MemoryEntry>()
    for (const [key, entry] of Object.entries(parsed)) {
      if (entry && typeof entry.offsetSeconds === 'number' && now - entry.ts < CACHE_TTL_MS) {
        // 迁移：live-vocal 记录只在写入时带有 live/cover/instrumental 候选类型才可信。
        // 旧记录不带 candidateType，无法排除"节拍已裁决对不上、补偿仍强加偏移"的旧路径
        // （实测 5АМ 转载视频被写入 +12.2s 错误偏移后 30 天内每次播放都命中缓存）。
        // 补偿结果可秒级重算，丢弃无代价；live/cover 的正常记录重算后会带类型重新持久化。
        if (entry.method === 'live-vocal') {
          const ownerType = entry.candidateType
          if (ownerType !== 'live' && ownerType !== 'cover' && ownerType !== 'instrumental') continue
        }
        // 迁移：旧 envelope 记录不带突出度，无法排除"绝对峰值够高但 argmax 落在错误
        // 重复段"的偏移（实测 Одна -1.8s、真实 ≈+3s，背景慢一句）。重算便宜（MV 侧
        // 分析已预热），丢弃无代价；新记录经 buildEnvelopeAlignment 分级后带 prominence。
        if (entry.method === 'envelope' && !(typeof entry.prominence === 'number' && entry.prominence >= ENVELOPE_PROMINENCE_MIN)) continue
        // 分段锚点随记录恢复（坏数据防护：非升序/越界/条目过少直接丢弃，退常数偏移）
        let segments: MvAlignmentSegment[] | undefined
        if (Array.isArray(entry.segments) && entry.segments.length >= 2) {
          const valid = entry.segments.every((s, i) =>
            s && typeof s.songTime === 'number' && typeof s.offsetSeconds === 'number'
            && typeof s.correlation === 'number' && Number.isFinite(s.songTime) && Number.isFinite(s.offsetSeconds)
            && (i === 0 || s.songTime > entry.segments![i - 1].songTime))
          if (valid) segments = entry.segments
        }
        map.set(key, { offsetSeconds: entry.offsetSeconds, confidence: entry.confidence, method: entry.method, prominence: entry.prominence, candidateType: entry.candidateType, ...(entry.source ? { source: entry.source } : {}), ...(segments ? { segments } : {}) })
      }
    }
    return map
  } catch {
    return new Map()
  }
}

function persist(): void {
  try {
    const now = Date.now()
    const all: Record<string, CachedEntry> = {}
    const entries = [...memoryCache.entries()]
    // 只保留最新 CACHE_MAX 条（Map 插入序 = 时间序）
    for (const [key, value] of entries.slice(-CACHE_MAX)) {
      all[key] = { ...value, ts: now }
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
  } catch {
    // 存储失败（隐私模式等）静默
  }
}

/** 同步读取：内存缓存（已持久化的惰性加载一次） */
export function getMvAlignment(songKey: string, bvid: string): MvAlignment | null {
  if (!bvid) return null
  const key = `${songKey}|${bvid}`
  if (memoryCache.size === 0 && localStorage) {
    for (const [k, v] of loadPersisted()) memoryCache.set(k, v)
  }
  return memoryCache.get(key) || null
}

/**
 * 缓存可信度闸门：非官方/非歌词视频且 CC 内容与歌词不符（剪辑/二创）时，
 * beat-only 偏移不可信（节拍自洽≠同一录音）。该规则必须同时约束
 * ensureMvAlignment 的写入端和播放器/背景的快速读取端——否则旧缓存
 * 会绕过写入端检查被直接消费（实测 Villain 6s→17s）。
 */
export function shouldRejectAlignmentFor(
  cached: MvAlignment | null | undefined,
  owner: { candidateType?: string; ccVerification?: MvAlignmentInput['ccVerification'] } | null | undefined,
): boolean {
  return Boolean(
    cached
    && cached.method === 'beat'
    && owner?.candidateType === 'other'
    && owner?.ccVerification === 'mismatch',
  )
}

/** 带候选可信度闸门的缓存读取：快速路径（播放器/背景）必须用这个而不是裸 getMvAlignment。 */
export function getMvAlignmentFor(
  songKey: string,
  bvid: string,
  owner: { candidateType?: string; ccVerification?: MvAlignmentInput['ccVerification'] } | null | undefined,
): MvAlignment | null {
  const cached = getMvAlignment(songKey, bvid)
  return shouldRejectAlignmentFor(cached, owner) ? null : cached
}

export interface MvAlignmentInput {
  songKey: string
  /**
   * App 稳定 trackKey（automix 分析缓存键）：节拍对齐优先复用它已缓存的歌曲分析——
   * automix 的音频按曲目身份下载，不受 audio.src 过渡竞态影响。songKey（如
   * qq:646755675）与 automix trackKey（如 qq-002L2DQS2FWzn1）是两套键，互不命中。
   */
  trackKey?: string
  songTitle: string
  songArtists: string[]
  songDuration: number
  /** 歌曲音频 URL（节拍对齐需要；blob/空则不跑节拍路径） */
  songUrl?: string
  /** 本地歌词（字幕对齐需要；无歌词则跳过字幕路径） */
  lyrics?: LyricLine[]
  bvid: string
  cid: number
  /** MV DASH 音频流 URL（节拍对齐需要） */
  videoUrl?: string
  /** B 站 playurl 的 cacheKey（音频流同源生成用） */
  cacheKey?: string
  /**
   * 候选视频类型（bilibiliApi 的 CandidateType）。live/cover/二创与音源是不同录音，
   * 节拍与音源无法对齐（现场版节奏/编曲不同），这类 MV 背景应自由播放——不计算对齐。
   */
  candidateType?: string
  /** 候选 CC 与歌曲歌词的内容验证；mismatch 只限制 beat-only 对齐，不否定视频身份。 */
  ccVerification?: 'match' | 'mismatch' | 'unverified'
  signal?: AbortSignal
}

function awaitSharedAlignment(
  promise: Promise<MvAlignment | null>,
  signal?: AbortSignal,
): Promise<MvAlignment | null> {
  if (!signal) return promise
  if (signal.aborted) return Promise.resolve(null)
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort)
      resolve(null)
    }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      result => {
        signal.removeEventListener('abort', abort)
        resolve(result)
      },
      error => {
        signal.removeEventListener('abort', abort)
        reject(error)
      },
    )
  })
}

/** 计算并对齐缓存；已缓存/在途时直接返回。失败或置信度不足返回 null。 */
export async function ensureMvAlignment(input: MvAlignmentInput, signal?: AbortSignal): Promise<MvAlignment | null> {
  const { songKey, bvid } = input
  if (!songKey || !bvid || bvid.startsWith('fallback-')) return null
  const key = `${songKey}|${bvid}`
  const cached = getMvAlignment(songKey, bvid)
  const rejectCachedBeat = shouldRejectAlignmentFor(cached, input)
  if (cached && !rejectCachedBeat) {
    mvLog(`命中缓存：${songKey} ${bvid} offset=${cached.offsetSeconds}s conf=${cached.confidence.toFixed(2)} method=${cached.method}`)
    return cached
  }
  if (rejectCachedBeat && cached) {
    memoryCache.delete(key)
    persist()
    mvLog(`丢弃旧节拍缓存：${songKey} ${bvid} type=other cc=mismatch offset=${cached.offsetSeconds}s`)
  }
  const inputSignature = mvAlignmentInputSignature(input)
  if (isNegativelyCached(key, inputSignature)) {
    mvLog(`命中短期失败缓存：${songKey} ${bvid}（输入未变化，跳过重复对齐）`)
    return null
  }
  const flightKey = `${key}|${inputSignature}`
  const existing = inFlight.get(flightKey)
  if (existing) return awaitSharedAlignment(existing, signal)
  const sharedInput = { ...input, signal: undefined }
  // live/cover/二创与音源是不同录音：节拍无法对齐。但 MV 自带 CC 字幕仍可逐句对齐；
  // 字幕失败后才退到现场版的音乐入口补偿。
  if (input.candidateType === 'live' || input.candidateType === 'cover' || input.candidateType === 'instrumental') {
    const promise = (async () => {
      if (Array.isArray(input.lyrics) && input.lyrics.length > 0) {
        const subLive = await detectViaSubtitles(sharedInput)
        if (subLive && subLive.confidence >= MIN_ALIGNMENT_CONFIDENCE) {
          memoryCache.set(key, { ...subLive, candidateType: input.candidateType })
          negativeCache.delete(key)
          persist()
          mvLog(`对齐成功（现场版字幕）：${songKey} ${bvid} offset=${subLive.offsetSeconds}s conf=${subLive.confidence.toFixed(2)} method=subtitle`)
          return subLive
        }
      }
      const compensation = await computeLiveCompensation(sharedInput)
      if (!compensation) rememberAlignmentFailure(key, inputSignature)
      return compensation
    })()
    inFlight.set(flightKey, promise)
    void promise.then(
      () => { if (inFlight.get(flightKey) === promise) inFlight.delete(flightKey) },
      () => { if (inFlight.get(flightKey) === promise) inFlight.delete(flightKey) },
    )
    return awaitSharedAlignment(promise, signal)
  }
  mvLog(`开始对齐：${songKey} ${bvid} candidateType=${input.candidateType || '-'} songDur=${input.songDuration}s videoDur? cid=${input.cid}`)
  const promise = (async () => {
    const result = await detectAlignment(sharedInput)
    if (result && result.confidence >= MIN_ALIGNMENT_CONFIDENCE) {
      memoryCache.set(key, { ...result, candidateType: input.candidateType })
      negativeCache.delete(key)
      persist()
      mvLog(`对齐成功：${songKey} ${bvid} offset=${result.offsetSeconds}s conf=${result.confidence.toFixed(2)} method=${result.method}`)
      return result
    }
    // 节拍/字幕都没对上，且候选不是官方/纯歌词视频（other 类可能是翻唱/现场/二创，
    // 与音源是不同录音——节拍网格必然不贴合）。补一次现场声乐补偿（MV 音乐入口 −
    // 歌曲首句歌词），至少把前奏/开唱位置对上去（实测 黒音さや 翻唱 rainy tone）。
    // 官方 MV 是同一录音、网格失败通常是信号问题，不做此补偿（会加错误偏移）。
    // 但节拍路径**真正跑过**（歌曲与 MV 音频 URL 齐备）仍返回 null = 信号链已裁决
    // "非同录音/对不上"（网格置信度、包络相关峰全不过线）：此时锚点补偿会用错误的
    // 对应关系强加偏移（实测 5АМ 转载视频被补偿强加 +12.2s，背景歌词错位数句且入
    // 缓存 30 天）→ 只允许在节拍路径没跑过（缺 URL，多为 blob 播放）时补偿兜底。
    const beatPathRan = Boolean(input.songUrl?.startsWith('http') && input.videoUrl?.startsWith('http'))
    if (input.candidateType !== 'official' && input.candidateType !== 'lyrics' && !beatPathRan) {
      const comp = await computeLiveCompensation(sharedInput)
      if (comp && comp.confidence >= MIN_ALIGNMENT_CONFIDENCE) {
        memoryCache.set(key, { ...comp, candidateType: input.candidateType })
        negativeCache.delete(key)
        persist()
        mvLog(`对齐成功（补偿兜底）：${songKey} ${bvid} offset=${comp.offsetSeconds}s conf=${comp.confidence.toFixed(2)} method=${comp.method}`)
        return comp
      }
    }
    mvLog(`对齐未通过门槛：${songKey} ${bvid} result=${result ? `${result.offsetSeconds}s conf=${result.confidence.toFixed(2)}` : 'null'}（门槛=${MIN_ALIGNMENT_CONFIDENCE}，自由播放）`)
    rememberAlignmentFailure(key, inputSignature)
    return null
  })()
  inFlight.set(flightKey, promise)
  void promise.then(
    () => {
      if (inFlight.get(flightKey) === promise) inFlight.delete(flightKey)
    },
    () => {
      if (inFlight.get(flightKey) === promise) inFlight.delete(flightKey)
    },
  )
  return awaitSharedAlignment(promise, signal)
}

/**
 * 音乐入口锚（多探测器共识）：现场版补偿里"视频音乐入口 − 歌曲音乐入口"是最可靠的入口锚。
 * 数据集实测（97 组真实配对 / 72 组强参考 peak≥0.7 / 290 负样本，脚本见仓库 .tmp-kg-align/）：
 *  - 必须**同种探测器两侧同用**：p60/p60 ≤2s 命中 79%，混用（abs/p60）仅 18%——不同探测器的
 *    偏差方向不同，混用不会抵消；
 *  - 单探测器对比：p60/p60 79% > p35/p35 74% > abs/abs 42%（abs 常无命中，放弃率 43%）；
 *  - 三候选（p60/p60、p35/p35、abs/abs）取 2s 一致簇的中位作共识，否则退回 p60/p60：
 *    ≤2s 81% / ≤4s 86%，且能救回"p60 迟到"的素材——ヒビカセ 武道馆现场 p60 锚 −18.8s（错），
 *    p35/abs 一致落在 +6.9s（= 全曲包络互相关真值）。
 * 返 null 表示无可用锚。
 */
export function pickMusicAnchor(candidates: Array<number | null>, preferred: number | null): number | null {
  const inRange = candidates.filter((v): v is number => v != null && Number.isFinite(v) && Math.abs(v) <= 15)
  let best: number[] = []
  for (const v of inRange) {
    const cluster = inRange.filter((x) => Math.abs(x - v) <= 2)
    if (cluster.length > best.length) best = cluster
  }
  if (best.length >= 2) return best.slice().sort((a, b) => a - b)[Math.floor(best.length / 2)]
  if (preferred != null && Number.isFinite(preferred) && Math.abs(preferred) <= 15) return preferred
  return inRange[0] ?? null
}

/**
 * 现场版补偿的锚点选择（纯函数，便于单测）。优先级（按数据集实测精度排）：
 *  1. 包络互相关（envelope）：全曲响度结构证据，过闸门（buildEnvelopeAlignment）即最可信；
 *  2. 音乐入口（music）：见 pickMusicAnchor —— 72 组强参考上 ≤2s 81%；
 *  3. 首句歌词（vocals）：offset = MV 音乐入口 − 歌曲首句歌词。**实测最差**（≤2s 仅 8~29%）：
 *     它的前提是"现场歌声≈其音乐入口"，可视频在前奏里往往还有一整段器乐（本曲 ≈15s），
 *     于是系统性偏差≈歌曲前奏长度。保留为最后兜底（音乐入口不可用时）。
 * 全部不可用返回 null（调用方自由播放）。
 */
export function pickLiveCompensationAnchor(args: {
  /** buildEnvelopeAlignment 过闸门后的包络对齐结果（未过闸门/未计算为 null） */
  envelope: MvAlignment | null
  /** 歌曲首句歌词时间（秒）；无歌词/坏数据为 null */
  firstVocal: number | null
  /** MV 侧音乐/歌声入口（p60，首选单探测器） */
  mvMusicStart: number
  /** 音乐入口锚候选 = mvEntry − songEntry（不同探测器对各算一个；p60 那个作为 preferred 传） */
  musicAnchors: Array<number | null>
}): { alignment: MvAlignment; anchor: '包络' | '音乐入口' | '歌词' } | null {
  if (args.envelope) return { alignment: args.envelope, anchor: '包络' }
  const preferred = args.musicAnchors[0] ?? null
  const music = pickMusicAnchor(args.musicAnchors, preferred)
  if (music != null) {
    return { alignment: { offsetSeconds: music, confidence: 0.55, method: 'live-vocal' }, anchor: '音乐入口' }
  }
  if (args.firstVocal != null) {
    const offsetA = args.mvMusicStart - args.firstVocal
    if (Math.abs(offsetA) <= 15) {
      return { alignment: { offsetSeconds: offsetA, confidence: 0.55, method: 'live-vocal' }, anchor: '歌词' }
    }
  }
  return null
}

/** 歌曲侧包络缓存（按 URL）：对齐与「候选同一性复核」共用同一次解码，避免重复下载+解码整曲。 */
const songEnvelopeCache = new Map<string, { frameRms: number[]; frameRate: number }>()
const songEnvelopeInFlight = new Map<string, Promise<{ frameRms: number[]; frameRate: number } | null>>()

/** 解码歌曲音频取帧 RMS 包络：优先 electron 下载缓存（automix 同路——QQ 音频 URL 的
 *  vkey 会过期/被竞态打断，裸 fetch 实测 "Failed to fetch"），失败再试裸 URL。
 *  expectedDuration：透传给下载侧做时长闸（空 vkey/试听返回"合法容器但只有半首"，
 *  半首包络算出的偏移/支持率全不可信）。 */
export async function getSongEnvelope(songUrl: string, signal?: AbortSignal, cacheKey?: string, expectedDuration?: number): Promise<{ frameRms: number[]; frameRate: number } | null> {
  if (!songUrl || !(songUrl.startsWith('http') || songUrl.startsWith('blob:'))) return null
  const cached = songEnvelopeCache.get(songUrl)
  if (cached) return cached
  const existing = songEnvelopeInFlight.get(songUrl)
  if (existing) return existing
  const promise = (async () => {
    try {
      // trackKey 缺省用 songUrl 的哈希（稳定且不会撞缓存索引语义）；调用方有 songKey 时优先。
      // songKey 域的键与现场版补偿/拍点路径一致——同一首歌整条对齐链只解码一次。
      const key = cacheKey || `env:${hashString(songUrl)}`
      const localSong = await window.electron?.audioDownload?.prepare?.(songUrl, key, { expectedDuration })
      const mediaSong = localSong ? await window.electron?.audioDownload?.getMediaUrl?.(localSong) : null
      const { buffer } = await decodeAudioUrl(mediaSong || songUrl, signal)
      const envelope = computeFrameEnvelope(buffer)
      // 上限 8 条：一次会话里通常只有当前曲 + 预载下一曲
      if (songEnvelopeCache.size >= 8) {
        const oldest = songEnvelopeCache.keys().next().value
        if (oldest) songEnvelopeCache.delete(oldest)
      }
      songEnvelopeCache.set(songUrl, envelope)
      return envelope
    } catch (error) {
      mvLog(`歌曲包络解码失败：${error instanceof Error ? error.message : String(error)}（songUrl=${songUrl.slice(0, 60)}…）`)
      return null
    } finally {
      songEnvelopeInFlight.delete(songUrl)
    }
  })()
  songEnvelopeInFlight.set(songUrl, promise)
  return promise
}

/**
 * 候选同一性探针（供匹配层注入使用）：对给定候选各取一次低码率音频，算与当前歌曲包络的
 * 相关峰（bvid → peak）——即"该视频与正在播放的录音是否同源可对齐"。任一条失败跳过；
 * 整体无结果时由调用方退回纯元数据排序。放在这里（而非匹配层）是为了让 bilibiliApi
 * 保持无音频依赖：匹配层只注入这个函数。
 */
export async function probeCandidateIdentities(
  candidates: ReadonlyArray<{ video: { bvid: string }; cid?: number }>,
  songUrl: string,
  signal?: AbortSignal,
  songKey?: string,
): Promise<Map<string, number>> {
  const peaks = new Map<string, number>()
  const songEnvelope = await getSongEnvelope(songUrl, signal, songKey)
  if (!songEnvelope) return peaks
  for (const candidate of candidates) {
    if (signal?.aborted) break
    const cid = candidate.cid || 0
    if (!cid) continue
    try {
      const playInfo = await getBilibiliPlayUrl(candidate.video.bvid, cid, 64, signal)
      if (playInfo.code !== 0 || !playInfo.cacheKey) continue
      const decoded = await decodeAudioUrl(bilibiliStreamUrl(playInfo.cacheKey, 'audio'), signal)
      const mvEnvelope = computeFrameEnvelope(decoded.buffer)
      const corr = envelopeOffsetOf(mvEnvelope.frameRms, songEnvelope.frameRms, songEnvelope.frameRate)
      peaks.set(candidate.video.bvid, corr.peak)
    } catch {
      // 单条失败跳过：探针是 best-effort
    }
  }
  return peaks
}

/**
 * 现场/翻唱/伴奏 MV 的前奏补偿：不同录音无法做节拍**网格**对齐，但可以对齐"开篇/开唱位置"。
 * 三锚策略（选择逻辑见 pickLiveCompensationAnchor）：
 *  - 包络互相关（envelope）：offset = 全曲响度结构互相关峰。同一首歌的现场录音响度结构
 *    仍逐段对应，峰过闸门（peak≥0.6、突出度≥0.05）时最可信——实测 ヒビカセ 武道馆现场
 *    +6.9s/peak0.69/prom0.10，与两侧入口差（+6.8s）一致；入口锚在该曲因"现场器乐前奏
 *    比录音室长"而偏 3s 以上。未过闸门（不同编曲/混剪）退回入口锚。
 *  - 首句歌词锚（vocals）：offset = MV 音乐入口 − 歌曲首句歌词时间。适合现场版
 *    （现场版歌声≈其音乐入口，《宮》实测 +1.4s）。歌词缺失/坏数据时不可用。
 *  - 音乐入口锚（music）：offset = MV 音乐入口 − 歌曲音乐入口。适合忠实翻唱
 *    （双方前奏长度相近，入口对齐即开篇对齐）。rainy tone 原曲前奏 24.6s、首句歌词
 *    24.94s——若用 vocals 锚会算出 −24s 超限被弃；music 锚 ≈ 0 正确。
 * 入口锚超限（>15s，结构完全不同）放弃。
 */
async function computeLiveCompensation(input: MvAlignmentInput, signal?: AbortSignal): Promise<MvAlignment | null> {
  if (!input.videoUrl?.startsWith('http')) {
    mvLog(`现场版补偿跳过：${input.bvid} 无 MV 音频 URL（videoUrl=${input.videoUrl || '空'}）`)
    return null
  }
  const key = `${input.songKey}|${input.bvid}`
  const flightKey = `live:${key}|${mvAlignmentInputSignature(input)}`
  const cached = getMvAlignment(input.songKey, input.bvid)
  if (cached) return cached
  const existing = inFlight.get(flightKey)
  if (existing) return existing
  const promise = (async () => {
    try {
      const { buffer } = await decodeAudioUrl(input.videoUrl!, signal)
      const { frameRms, frameRate } = computeFrameEnvelope(buffer)
      // 音乐入口三对探测器（p60/p35/abs）；音乐锚需"同种探测器两侧同用"（混用偏差不抵消），
      // 单探测器优劣与共识规则见 pickMusicAnchor 的实测注释。
      const mvEntryP60 = detectLiveMusicEntry(frameRms, frameRate)
      const mvEntryP35 = detectLiveMusicEntryAt(frameRms, frameRate, 0.35)
      const mvEntryAbs = detectMusicStart(frameRms, frameRate)

      // 歌曲侧包络：锚 C 与锚 B 共用一次解码（与「候选同一性复核」也共享缓存）
      const songEnv = input.songUrl ? await getSongEnvelope(input.songUrl, signal, input.songKey, input.songDuration) : null

      // 锚 C（首选）：全曲包络互相关。现场/翻唱与音源虽是两条录音、节拍网格不可用，
      // 但同一首歌的**响度结构**仍逐段对应：相关峰过闸（buildEnvelopeAlignment：
      // peak≥0.6 且突出度≥0.05）即"结构对得上"，直接取该偏移。实测 ヒビカセ 武道馆现场
      // （qq:7420896 × BV1Lwz6YGEa6）：offset=+6.9s peak=0.69 prominence=0.10 → conf=0.69。
      // 闸门标定（97 组真实配对 / 290 负样本）：现规则通过 78% 真实配对、负样本 0 误通过；
      // 放宽到 peak≥0.55 且 prom≥0.03 可到 81%/0 误通过，但 0.55~0.6 段无法验证正确性，暂不放宽。
      // 峰闸未过时加**段落支持率**复核（恒定偏移下 30s 段相关>0.4 占比 ≥0.35）：
      // 全曲峰会被现场讲段/即兴拉低（俺の彼女 巡演 peak=0.574 突出度 0.075 但锚 C 原
      // ±45s 截断下连峰都找不到），段落支持率是唯一能把真对齐与"宽胖相关云"分开的
      // 判别式（实测真峰 0.44、窗内假峰全 0.00）。
      let envelopeResult: MvAlignment | null = null
      if (songEnv) {
        const corr = envelopeOffsetOf(frameRms, songEnv.frameRms, songEnv.frameRate)
        envelopeResult = buildEnvelopeAlignment(corr.offset, corr.peak, corr.prominence)
        if (!envelopeResult && Math.abs(corr.offset) <= MAX_ENVELOPE_OFFSET_SECONDS) {
          const support = envelopeSegmentSupport(frameRms, songEnv.frameRms, songEnv.frameRate, corr.offset)
          if (support.ratio >= ENVELOPE_SEGMENT_SUPPORT_MIN) {
            // 投票真值仲裁（分档，与拍点路径同判据，6248 对 votes-cache 标定）：
            //   峰<0.45 → 无条件信投票；峰 0.45-0.6 → 需支持率<0.45（簇票≥3 的矛盾对
            //   真值 83% 在峰侧，只有支持率低才说明峰的结构证实不足）
            let chosenOffset = corr.offset
            const voteArbitration = envelopeSegmentVote(frameRms, songEnv.frameRms, songEnv.frameRate, corr.offset)
            if (voteArbitration != null && Math.abs(voteArbitration - corr.offset) > 1.5) {
              const unconditional = corr.peak < 0.45
              const supportWeak = corr.peak < 0.6 && support.ratio < 0.45
              if (unconditional || supportWeak) {
                chosenOffset = voteArbitration
                mvLog(`现场版投票真值仲裁：${input.bvid} 峰=${corr.offset.toFixed(2)}s(支持率=${support.ratio.toFixed(2)}) 与段投票 ${voteArbitration.toFixed(2)}s 矛盾 → 信投票（${unconditional ? '弱峰无条件档' : '弱证实档'}）`)
              }
            }
            // 分段锚点：与拍点路径同一模型（改编区插值过渡），锚点跨度不足时省略
            let segments: MvAlignmentSegment[] | undefined
            const anchors = envelopeSegmentAnchors(frameRms, songEnv.frameRms, songEnv.frameRate, chosenOffset)
            if (anchors.length >= 2) {
              const driftSpread = Math.max(...anchors.map((a) => a.offsetSeconds)) - Math.min(...anchors.map((a) => a.offsetSeconds))
              if (driftSpread >= 0.3) {
                segments = anchors.map((a) => ({ songTime: Math.round(a.songTime * 10) / 10, offsetSeconds: Math.round(a.offsetSeconds * 100) / 100, correlation: Math.round(a.correlation * 100) / 100 }))
              }
            }
            envelopeResult = {
              offsetSeconds: Math.round(chosenOffset * 100) / 100,
              // 弱支持档封顶 0.55（同 detectViaBeats 注释）
              confidence: Math.max(0.5, Math.min(
                (corr.peak < 0.6 && support.ratio < 0.5) ? 0.55 : 0.8,
                0.4 + (corr.peak - 0.6) + support.ratio * 0.5)),
              method: 'envelope',
              prominence: Math.round(corr.prominence * 100) / 100,
              ...(segments ? { segments } : {}),
            }
          } else if (corr.peak >= 0.45) {
            // 投票一致救援（与拍点路径同一判据，194 对 live 基准净增 2TP/0FP）：
            // 峰 0.45-0.6 且段投票与峰一致（≤5s）→ 峰可信旁证，采纳（负样本审计后维持 0.45）
            const voteOffset = envelopeSegmentVote(frameRms, songEnv.frameRms, songEnv.frameRate, corr.offset)
            if (voteOffset != null && Math.abs(voteOffset - corr.offset) <= 5) {
              envelopeResult = {
                offsetSeconds: Math.round(corr.offset * 100) / 100,
                confidence: Math.max(0.5, Math.min(0.8, 0.4 + (corr.peak - 0.6) + 0.2)),
                method: 'envelope',
                prominence: Math.round(corr.prominence * 100) / 100,
              }
              mvLog(`现场版投票救援：${input.bvid} 峰=${corr.peak.toFixed(2)} 与段投票一致（${voteOffset.toFixed(2)}s）→ 采纳`)
            }
          }
          mvLog(`现场版段落支持复核：${input.bvid} offset=${corr.offset.toFixed(2)}s peak=${corr.peak.toFixed(2)} 支持率=${support.ratio.toFixed(2)}（${support.segments} 段）→ ${envelopeResult ? `证实采用${envelopeResult.segments ? `（分段 ${envelopeResult.segments.length} 锚）` : ''}` : '仍不足'}`)
        }
        mvLog(`现场版包络互相关：${input.bvid} offset=${corr.offset.toFixed(2)}s peak=${corr.peak.toFixed(2)} prominence=${corr.prominence.toFixed(2)} → ${envelopeResult ? `采用 conf=${envelopeResult.confidence.toFixed(2)}` : '未过闸门'}`)
      }

      // 锚 A：首句歌词时间（录音室版歌声起始）
      const firstVocal = firstLyricTime(input.lyrics)

      // 锚 B：音乐入口锚候选。三对探测器各算一次（同种探测器两侧同用——混用不抵消偏差，实测差 4 倍）：
      //   p60/p60（单探测器最优）｜p35/p35｜abs/abs；共识判定见 pickMusicAnchor。
      const songEntry = (fn: (rms: number[], rate: number) => number) => (songEnv ? fn(songEnv.frameRms, songEnv.frameRate) : 0)
      const anchorOf = (mvEntry: number, songEntryValue: number) => (mvEntry > 0 && songEntryValue > 0 ? mvEntry - songEntryValue : null)
      const musicAnchors = [
        anchorOf(mvEntryP60, songEntry(detectLiveMusicEntry)),
        anchorOf(mvEntryP35, songEntry((rms, rate) => detectLiveMusicEntryAt(rms, rate, 0.35))),
        anchorOf(mvEntryAbs, songEntry(detectMusicStart)),
      ]

      // 锚点优先级：包络互相关 > 音乐入口（多探测器共识）> 首句歌词
      const picked = pickLiveCompensationAnchor({ envelope: envelopeResult, firstVocal, mvMusicStart: mvEntryP60, musicAnchors })
      if (!picked) {
        const offsetA = firstVocal != null ? mvEntryP60 - firstVocal : null
        mvLog(`现场版补偿放弃：${input.bvid} 无可用锚（vocals=${offsetA != null ? offsetA.toFixed(1) : '无'} music=${JSON.stringify(musicAnchors.map((v) => (v == null ? null : Math.round(v * 10) / 10)))}，自由播放）`)
        return null
      }
      const result = picked.alignment
      if (picked.anchor !== '包络') {
        mvLog(`现场版检测：${input.bvid} buffer=${buffer.duration.toFixed(1)}s 入口 p60=${mvEntryP60.toFixed(2)} p35=${mvEntryP35.toFixed(2)} abs=${mvEntryAbs.toFixed(2)}｜首句歌词=${firstVocal != null ? firstVocal.toFixed(2) : '无'} → offset=${result.offsetSeconds}s（锚=${picked.anchor}，候选 ${JSON.stringify(musicAnchors.map((v) => (v == null ? null : Math.round(v * 10) / 10)))}）`)
      }
      mvLog(`现场版声乐补偿：${input.bvid} ${input.candidateType} → offset=${result.offsetSeconds}s conf=${result.confidence.toFixed(2)} method=${result.method}`)
      memoryCache.set(key, { ...result, candidateType: input.candidateType })
      negativeCache.delete(key)
      persist()
      return result
    } catch (error) {
      mvLog(`现场版补偿失败：${input.bvid} ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  })()
  inFlight.set(flightKey, promise)
  try {
    return await promise
  } finally {
    if (inFlight.get(flightKey) === promise) inFlight.delete(flightKey)
  }
}

/** 歌词文件里的元数据/署名行标记（词曲编录混…）。必须同时覆盖日文/繁体写法：
 *  QQ 日文歌词常用「作詞：」，只列简体「作词」会让署名行被当成首句歌词——
 *  现场版补偿的「首句歌词锚」随之算错（实测 ヒビカセ：`作詞：れをる`@9.39s 被判成
 *  首句 → 锚 +22.6s 超限放弃；真实首句 @28.19s 时锚为 +3.8s，可用）。
 *  末尾的 `(?:[・·、,，/／&＆+＋] 标记)*` 覆盖「作詞・作曲：」这类叠写署名。 */
const LYRIC_CREDIT_MARKER = '(?:词|詞|曲|编曲|編曲|作词|作詞|作曲|演唱|唱|歌手|专辑|專輯|制作|製作|混音|母带|母帶|录音|錄音|作|编|編|监制|監製|訳詞|译词|lyrics|composed|arranged|music|produced|words|by|ti|ar|al|offset)'
const LYRIC_CREDIT_LINE_RE = new RegExp(
  `^${LYRIC_CREDIT_MARKER}(?:\\s*[・·、,，/／&＆+＋]\\s*${LYRIC_CREDIT_MARKER})*\\s*[:：]`,
  'i',
)

/** 取本地歌词里第一条有文本的歌词行时间（秒）；无歌词/纯伴奏返回 null */
export function firstLyricTime(lyrics?: LyricLine[]): number | null {
  if (!Array.isArray(lyrics)) return null
  let best: number | null = null
  for (const line of lyrics) {
    if (!line || !line.text || !String(line.text).trim()) continue
    const t = line.time ?? 0
    if (t < 0) continue
    const text = String(line.text).trim()
    // 跳过元数据/署名行：词/曲/编曲等（「词：Vaundy」「作詞：れをる」）；以及开头的
    // "歌名 - 歌手"标题行（歌词正文极少在 2s 内出现带连字符的行，实测首句被 [00:00.8]宮 - Vaundy 抢先）
    if (LYRIC_CREDIT_LINE_RE.test(text)) continue
    if (t < 2 && /^.{1,40}[-—–]\s*.{1,40}$/.test(text)) continue
    // 0.5s 内的行几乎都是元数据/翻译/词级时间残留（网易云 JSON 行 t=0 的「作词: …」），
    // 真实首句歌词几乎不会这么早——跳过可避免首句被抢（实测取到 0.02s → 补偿偏移超限被弃）
    if (t < 0.5) continue
    if (best == null || t < best) best = t
  }
  return best
}

/**
 * 媒体元素兜底的提速前置：先试 `decodeAudioUrl` 整曲直解（MV 音频在对齐链路里通常
 * 已被 automix/MV 侧分析下载到 electron 缓存，waveforge-media:// fetch + decodeAudioData
 * 全曲解码约 1-2s），失败（协议不可用/解码不支持/403）再退 8 倍速实时采样（~30s）。
 * 实测 Ghost 案例：兜底走实时采样拖了 30s 才对上，而音频文件其实已在本地。
 */
async function sampleMediaEnvelopeFast(url: string, signal?: AbortSignal): Promise<{ frameRms: number[]; frameRate: number } | null> {
  try {
    const { buffer } = await decodeAudioUrl(url, signal)
    const envelope = computeFrameEnvelope(buffer)
    if (envelope.frameRms.length < 300) return null
    return { frameRms: envelope.frameRms, frameRate: envelope.frameRate }
  } catch {
    return null
  }
}

async function sampleMediaEnvelope(url: string, signal?: AbortSignal): Promise<{ frameRms: number[]; frameRate: number } | null> {
  if (typeof Audio === 'undefined' || typeof window === 'undefined') return null
  const AudioContextCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextCtor) return null
  const media = new Audio()
  media.crossOrigin = 'anonymous'
  media.preload = 'auto'
  media.src = url
  media.playbackRate = 8
  const context = new AudioContextCtor()
  let source: MediaElementAudioSourceNode | null = null
  let analyser: AnalyserNode | null = null
  let silent: GainNode | null = null
  const abort = () => media.pause()
  signal?.addEventListener('abort', abort, { once: true })
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('MV media metadata timed out')), 15_000)
      const done = () => { window.clearTimeout(timer); resolve() }
      const fail = () => { window.clearTimeout(timer); reject(new Error(media.error?.message || 'MV media failed to load')) }
      media.addEventListener('loadedmetadata', done, { once: true })
      media.addEventListener('error', fail, { once: true })
    })
    if (signal?.aborted) return null
    source = context.createMediaElementSource(media)
    analyser = context.createAnalyser()
    analyser.fftSize = 2048
    silent = context.createGain()
    silent.gain.value = 0
    source.connect(analyser)
    analyser.connect(silent)
    silent.connect(context.destination)
    if (context.state === 'suspended') await context.resume()
    const frameRate = 10
    const maxDuration = Math.min(Number.isFinite(media.duration) ? media.duration : 240, 240)
    const frameRms = new Array(Math.max(1, Math.ceil(maxDuration * frameRate))).fill(0)
    const samples = new Float32Array(analyser.fftSize)
    await media.play()
    const wallDeadline = performance.now() + 35_000
    while (!media.ended && media.currentTime < maxDuration && performance.now() < wallDeadline) {
      if (signal?.aborted) return null
      analyser.getFloatTimeDomainData(samples)
      let sum = 0
      for (let index = 0; index < samples.length; index += 1) sum += samples[index] * samples[index]
      const frame = Math.min(frameRms.length - 1, Math.max(0, Math.round(media.currentTime * frameRate)))
      frameRms[frame] = Math.max(frameRms[frame], Math.sqrt(sum / samples.length))
      await new Promise(resolve => window.setTimeout(resolve, 20))
    }
    if (media.currentTime < Math.min(maxDuration, 30)) return null
    for (let index = 1; index < frameRms.length; index += 1) {
      if (frameRms[index] === 0) frameRms[index] = frameRms[index - 1]
    }
    return { frameRms, frameRate }
  } catch {
    return null
  } finally {
    signal?.removeEventListener('abort', abort)
    media.pause()
    media.removeAttribute('src')
    media.load()
    try { source?.disconnect(); analyser?.disconnect(); silent?.disconnect() } catch {}
    void context.close()
  }
}

async function mediaEnvelopeAlignmentFallback(
  songUrl: string,
  videoUrl: string,
  signal?: AbortSignal,
): Promise<MvAlignment | null> {
  // 双路提速：优先整曲直解（electron 缓存命中时 1-2s），失败才退 8 倍速实时采样（~30s）
  const [song, mv] = await Promise.all([
    sampleMediaEnvelopeFast(songUrl, signal).then(r => r ?? sampleMediaEnvelope(songUrl, signal)),
    sampleMediaEnvelopeFast(videoUrl, signal).then(r => r ?? sampleMediaEnvelope(videoUrl, signal)),
  ])
  if (!song || !mv || Math.abs(song.frameRate - mv.frameRate) > 0.01) return null
  const result = envelopeOffsetOf(mv.frameRms, song.frameRms, song.frameRate)
  if (!Number.isFinite(result.offset) || Math.abs(result.offset) > MAX_SANE_OFFSET_SECONDS) return null
  const aligned = buildEnvelopeAlignment(result.offset, result.peak, result.prominence)
  if (!aligned) {
    mvLog(`媒体元素包络对齐拒绝：offset=${result.offset.toFixed(2)}s peak=${result.peak.toFixed(3)} 突出度=${result.prominence.toFixed(3)}（峰值/突出度不足，自由播放）`)
    return null
  }
  mvLog(`媒体元素包络对齐：offset=${aligned.offsetSeconds.toFixed(2)}s peak=${result.peak.toFixed(3)} 突出度=${result.prominence.toFixed(3)} → conf=${aligned.confidence.toFixed(2)}`)
  return aligned
}

async function detectAlignment(input: MvAlignmentInput, signal?: AbortSignal): Promise<MvAlignment | null> {
  // 1. 字幕对齐（快）：本地歌词 + MV CC 字幕文本匹配
  if (input.lyrics && input.lyrics.length > 0) {
    const subResult = await detectViaSubtitles(input, signal)
    if (subResult) return subResult
  }
  // 2. 节拍对齐（通用）：Python beat 服务分析 MV 音频轨 ↔ 歌曲节拍互相关
  return detectViaBeats(input, signal)
}

/**
 * MV 分析结果的模式签名：区分「按歌曲拍点模式分析」与「无模式/规则网格」的结果。
 * 预载早期（歌曲分析未缓存时）会产出无模式的规则网格结果；若它在缓存里被带模式的
 * 调用命中，会把按拍点模式的分析永远挡掉（detectOffsetFromBeats 对规则网格 vs
 * 漂移真实节拍必失败）→ 对齐永远算不出。签名不一致 → 强制重算。
 */
function mvPatternSignature(beats: number[] | undefined): string | undefined {
  if (!Array.isArray(beats) || beats.length < 8) return undefined
  const first = beats[0]
  const last = beats[beats.length - 1]
  return `pattern:${beats.length}:${first?.toFixed(3)}:${last?.toFixed(3)}`
}

/** 从歌曲分析提取逐拍能量权重（打破拍周期混叠）；beatFeatures 缺失/无效时返回 undefined */
function beatWeightsOf(analysis: TrackAnalysis | null | undefined): number[] | undefined {
  if (!analysis || !Array.isArray(analysis.beatFeatures) || analysis.beatFeatures.length < 8) return undefined
  const weights = analysis.beatFeatures.map((frame) => {
    const energy = typeof frame.energy === 'number' ? frame.energy : typeof frame.loudness === 'number' ? frame.loudness : 0
    return energy > 0 ? energy : 1
  })
  return weights
}

/**
 * 预加载 (song, MV) 的 MV 侧节拍分析：提前下载 + 浏览器解码 + 网格构建。
 * 切到下一曲时 ensureMvAlignment 的 MV 侧 analyze 命中缓存 → 对齐秒算，
 * 视频可直接跳转到对齐位置（冷启动首曲等"先播后对齐"场景由调用方在对齐
 * 就绪后一次性 seek 校正）。
 * 幂等：已对齐 / 已在途 / 输入无效时直接返回。歌曲侧分析由 automix 缓存，
 * 这里只跑 MV 侧慢路径（B 站 DASH 音频是 AAC/MP4，必须浏览器解码）。
 */
export async function prewarmMvBeatAnalysis(input: {
  songKey: string
  /** 可选：App 的稳定 trackKey（automix 分析缓存键），用于取歌曲 BPM hint */
  trackKey?: string
  bvid: string
  videoUrl: string
  duration?: number
  /** 候选视频类型：live/cover/二创与音源不同录音，不预载对齐 */
  candidateType?: string
}): Promise<void> {
  const { songKey, bvid } = input
  if (!songKey || !bvid || bvid.startsWith('fallback-')) return
  if (input.candidateType === 'live' || input.candidateType === 'cover' || input.candidateType === 'instrumental') return
  if (!input.videoUrl || !input.videoUrl.startsWith('http')) return
  if (getMvAlignment(songKey, bvid)) return
  const key = `${songKey}|${bvid}`
  const existing = prewarmInFlight.get(key)
  if (existing) return existing
  const job = (async () => {
    // 歌曲侧分析若已缓存（automix 分析当前/下一曲时通常已就绪），取真实拍点模式
    // 作 MV 网格参考（对变速鲁棒）+ 逐拍能量权重（打破混叠）+ BPM 兜底；未缓存则 MV 走自检。
    let bpmHint: number | undefined
    let beatTimesHint: number[] | undefined
    let beatWeightsHint: number[] | undefined
    try {
      const songAnalysis =
        (await autoMixAnalysisService.getCached(input.songKey)) ||
        (input.trackKey ? await autoMixAnalysisService.getCached(input.trackKey) : null)
      if (songAnalysis?.estimatedBpm && songAnalysis.estimatedBpm > 0) bpmHint = songAnalysis.estimatedBpm
      if (Array.isArray(songAnalysis?.beats) && songAnalysis.beats.length >= 8) {
        beatTimesHint = songAnalysis.beats
        beatWeightsHint = beatWeightsOf(songAnalysis)
      }
    } catch {
      /* 歌曲分析不可得：MV 网格走自检，commit 时再精算 */
    }
    await autoMixAnalysisService.analyze({
      trackKey: `mv-align-video:${songKey}:${bvid}`,
      url: input.videoUrl,
      duration: input.duration,
      bpmHint,
      beatTimesHint,
      beatWeightsHint,
      sourceSignature: mvPatternSignature(beatTimesHint),
    }).catch(() => { /* 预加载失败静默：commit 时正常路径会再算 */ })
  })()
  prewarmInFlight.set(key, job)
  try {
    await job
  } finally {
    prewarmInFlight.delete(key)
  }
}

// ===== 字幕对齐 =====

function normalizeText(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/[\s·•\-–—()（）\[\]【】「」『』<>《》"'`,.，。！？!?&/|:：~～♪♫…]+/g, '')
    .replace(/[a-zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]+/g, (m) => m.replace(/[āáǎà]/g, 'a').replace(/[ēéěè]/g, 'e').replace(/[īíǐì]/g, 'i').replace(/[ōóǒò]/g, 'o').replace(/[ūúǔù]/g, 'u').replace(/[ǖǘǚǜ]/g, 'ü'))
}

/** 提取内容词：CJK 段切字符 bigram（跨语序的翻译仍共享大量 bigram——"奔向夜晚"
 *  vs "向夜晚飞奔而去"共享 向夜/夜晚；整段当一个词则语序一变就零交集），
 *  拉丁词保持整词（长度 ≥2）。翻译口径差异（不同译者的用词/语序）会破坏整行
 *  文本匹配，但内容词集合仍高度重叠，按词命中率匹配可跨译者对齐。 */
function contentTokens(s: string): string[] {
  const raw = (s || '').toLowerCase()
  const tokens: string[] = []
  for (const m of raw.matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+|[a-zü][a-zü]+/gu)) {
    const seg = m[0]
    if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+$/u.test(seg)) {
      if (seg.length === 1) { tokens.push(seg); continue }
      for (let i = 0; i + 2 <= seg.length; i += 1) tokens.push(seg.slice(i, i + 2))
    } else if (seg.length >= 2) {
      tokens.push(seg)
    }
  }
  return Array.from(new Set(tokens))
}

/** 内容词命中率：|A∩B| / min(|A|,|B|)。0-1，双方都空返回 0。 */
function tokenOverlap(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0
  const setB = new Set(b)
  let hit = 0
  for (const t of new Set(a)) if (setB.has(t)) hit += 1
  return hit / Math.min(new Set(a).size, setB.size)
}

/** AI 字幕轨的「歌词性」判定（真实 12 样本标定）：音乐/环境声识别行（♪音乐♪、
 *  掌声等）占比 >0.5，或去重内容词 <20 个 → 判非歌词（闲聊转写/纯环境识别）。
 *  人工歌词轨（ai=0）不套此判据——人工字幕即使短也是真词。 */
export function isLyricLikeSubtitle(lines: BilibiliSubtitleLine[]): boolean {
  const contents = lines
    .map((l) => String(l?.content || '').replace(/[♪♫\s]/g, '').trim())
    .filter((c) => c.length > 0)
  if (contents.length < 10) return true // 行太少不足以判非歌词，放行由匹配数闸门兜底
  const ambient = contents.filter((c) => c === '音乐' || c === '音乐声' || c === 'music' || c === 'music声' || c === '掌声' || c === '歌声' || c === '欢呼' || c === ' applause').length
  if (ambient / contents.length > 0.5) return false
  const vocab = new Set<string>()
  for (const c of contents) for (const t of contentTokens(c)) vocab.add(t)
  if (vocab.size < 20) return false
  return true
}

/** 字幕行时间 ↔ 本地歌词行时间文本匹配，取偏移中位数；匹配数或离散度过低返回 null */
export function detectOffsetFromSubtitles(
  songLyrics: LyricLine[],
  subLines: BilibiliSubtitleLine[],
): MvAlignment | null {
  if (!songLyrics.length || !subLines.length) return null
  // 歌词云：正文与翻译都参与匹配（英文歌 + 中文翻译 CC 是常见组合，
  // 实测 Villain 官方 MV 只挂翻译 CC——只比原文会导致"明明同源却无法对齐"）。
  const lyricEntries = songLyrics
    .flatMap((l) => {
      const entries: Array<{ timeSeconds: number; norm: string }> = []
      const text = String(l.text || '').trim()
      const translation = String((l as { translation?: string }).translation || '').trim()
      if (text) entries.push({ timeSeconds: l.time, norm: normalizeText(text) })
      if (translation && normalizeText(translation) !== (text ? normalizeText(text) : '')) {
        entries.push({ timeSeconds: l.time, norm: normalizeText(translation) })
      }
      return entries
    })
    .filter((e) => e.norm.length >= 2)
  if (lyricEntries.length < 3) return null

  const offsets: number[] = []
  const matchedPairs: Array<{ songTime: number; offset: number }> = []
  // 双语 CC 行（"原文\n翻译"同格）先按换行拆成语段分别匹配——整体规范化后 overlap
  // 恒 ≈0.5（原文/翻译各半），会被 0.55 覆盖度闸门全部拒掉（合成数据实测双语 CC
  // 对齐完全失效）。每段独立匹配、共享同一字幕时间。
  const subSegments: Array<{ from: number; norm: string }> = []
  for (const sub of subLines) {
    const parts = String(sub.content || '').split(/\n+/)
    if (parts.length > 1) {
      let pushed = false
      for (const part of parts) {
        const norm = normalizeText(part)
        if (norm.length >= 2) {
          subSegments.push({ from: sub.from, norm })
          pushed = true
        }
      }
      if (pushed) continue
    }
    subSegments.push({ from: sub.from, norm: normalizeText(sub.content) })
  }
  // 第一遍：整行文本匹配（精确/包含，原有口径）
  for (const seg of subSegments) {
    const norm = seg.norm
    if (norm.length < 2) continue
    // 精确相等优先；否则**包含匹配**——CC 字幕常把一句歌词拆成 2~3 段逐段显示
    //（各段与视频同步，只是同一句拆开），段落文本是整句的子串；偶尔也反过来
    //（一句歌词被合并进一条长字幕）。文本冗余行（副歌重复）按"字幕时间最近的歌词行"取。
    let best: { timeSeconds: number; score: number } | null = null
    for (const e of lyricEntries) {
      let score = 0
      if (e.norm === norm) {
        score = 1
      } else if (e.norm.includes(norm) || norm.includes(e.norm)) {
        const overlap = Math.min(e.norm.length, norm.length) / Math.max(e.norm.length, norm.length)
        if (overlap < 0.55) continue // 覆盖度太低（碎片化噪音词）不匹配
        score = overlap
      } else {
        continue
      }
      // 就近惩罚：同词多行（副歌重复）时取时间最接近的，避免对到别的副歌句
      const timePenalty = Math.abs(e.timeSeconds - seg.from) / 120
      if (!best || score - timePenalty > best.score) {
        best = { timeSeconds: e.timeSeconds, score: score - timePenalty }
      }
    }
    if (!best) continue
    const offset = seg.from - best.timeSeconds
    // 剔除明显越界的匹配（字幕与歌词行整体偏移应在合理前摇范围内）
    if (Math.abs(offset) > MAX_SANE_OFFSET_SECONDS) continue
    offsets.push(offset)
    matchedPairs.push({ songTime: best.timeSeconds, offset })
  }
  // 第二遍（翻译口径容忍）：整行匹配数不足时降级到内容词命中率。不同译者对同一句
  // 的用词/语序不同（"奔向夜晚" vs "向夜晚飞奔而去"），单对 overlap 常不足 0.6，
  // 逐对判定漏配太多。改用**全局扫描**：对每个候选偏移（±45s、0.5s 步长），统计全部
  // CC 段与「该偏移下时间最近的歌词行」的内容词命中率之和——正确偏移下全局总分
  // 显著高于错误偏移（与包络互相关同构，全局证据远强于单对）。取总分峰的偏移中位数。
  let usedTokenScan = false
  if (offsets.length < 3) {
    const entryTokens = lyricEntries.map((e) => ({ timeSeconds: e.timeSeconds, tokens: contentTokens(e.norm) })).filter((e) => e.tokens.length >= 2)
    const segTokens = subSegments.map((s) => ({ from: s.from, tokens: contentTokens(s.norm) })).filter((s) => s.tokens.length >= 2)
    if (entryTokens.length >= 3 && segTokens.length >= 3) {
      let bestOffset: number | null = null
      let bestScore = 0
      for (let cand = -45; cand <= 45; cand += 0.5) {
        let total = 0
        let hits = 0
        for (const seg of segTokens) {
          const alignedAt = seg.from - cand
          // 对齐位置 ±3s 窗口内取 **overlap 最高**的歌词行：同时间戳常有 text+translation
          // 两个 entry（日文原文+中文翻译），中文 CC 段配日文行 overlap=0、配翻译行才有分
          // ——按「距离最近」取会永远命中先遍历的 text 行（实测场景1 全灭的根因）。
          let bestOverlap = 0
          let bestTime: number | null = null
          for (const e of entryTokens) {
            const d = Math.abs(e.timeSeconds - alignedAt)
            if (d > 3) continue
            const overlap = tokenOverlap(seg.tokens, e.tokens)
            if (overlap > bestOverlap) { bestOverlap = overlap; bestTime = e.timeSeconds }
          }
          if (bestTime != null && bestOverlap >= 0.45) { total += bestOverlap; hits += 1 }
        }
        // 总分相同时偏好命中数多的（更多行参与=更稳）。
        // 门槛 hits>=2 且总分 >=1.2：跨译者单对 overlap 常在 0.3-0.8 波动（语序差异），
        // 要求 3 对以上会漏掉真实对齐（合成数据 5 对里只有 2-3 对 ≥0.45）；
        // 全局扫描的正确偏移总分显著高于错误偏移，2 对强证据（≥1.2 总分）已可区分。
        const score = total + hits * 0.01
        if (hits >= 2 && total >= 1.2 && score > bestScore) {
          bestScore = score
          bestOffset = cand
        }
      }
      if (bestOffset != null) {
        // 按最优偏移重收集配对（供漂移拟合与置信度）：同扫描逻辑取窗口内 overlap 最高行
        for (const seg of segTokens) {
          const alignedAt = seg.from - bestOffset
          let bestOverlap = 0
          let bestTime: number | null = null
          for (const e of entryTokens) {
            const d = Math.abs(e.timeSeconds - alignedAt)
            if (d > 3) continue
            const overlap = tokenOverlap(seg.tokens, e.tokens)
            if (overlap > bestOverlap) { bestOverlap = overlap; bestTime = e.timeSeconds }
          }
          if (bestTime != null && bestOverlap >= 0.45) {
            const offset = seg.from - bestTime
            if (Math.abs(offset) > MAX_SANE_OFFSET_SECONDS) continue
            offsets.push(offset)
            matchedPairs.push({ songTime: bestTime, offset })
          }
        }
        if (offsets.length >= 2) {
          usedTokenScan = offsets.length < 3
          const sorted0 = [...offsets].sort((a, b) => a - b)
          const median0 = sorted0[Math.floor(sorted0.length / 2)]
          const spread0 = sorted0[Math.floor((3 * sorted0.length) / 4)] - sorted0[Math.floor(sorted0.length / 4)]
          mvLog(`字幕翻译口径对齐：整行匹配不足，全局内容词扫描 offset=${median0}s（总分=${bestScore.toFixed(2)}，${offsets.length} 段，IQR=${spread0.toFixed(1)}）`)
        }
      }
    }
  }
  // 最低配对数：整行匹配 ≥3；翻译口径（内容词全局扫描）置信度低一档，≥2 对即可，
  // 但给 confidence 打折（扫描分支已有总分+spread 双门槛兜质量）。
  const minPairs = usedTokenScan ? 2 : 3
  if (offsets.length < minPairs) return null

  const sorted = [...offsets].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  // 离散度：|中位数偏移与四分位距|（对少量异常匹配鲁棒）
  const q1 = sorted[Math.floor(sorted.length / 4)]
  const q3 = sorted[Math.floor((3 * sorted.length) / 4)]
  const spread = q3 - q1
  if (spread > 3) return null

  // 渐进漂移检测：字幕组逐句微偏（压帧/不同源时间轴）会让 offset 随歌曲时间线性
  // 累积（合成数据实测 0.2s/句 × 30 句 = 6s 漂移，恒定中位数在中段错 ±3s）。
  // 对（歌词行时间 → offset）做线性拟合：斜率显著且拟合不差时产出首尾两个锚点
  // （segments），同步层 offsetAt 按位置插值逐段纠正；否则维持恒定偏移。
  const pairs = matchedPairs
    .filter((p) => Number.isFinite(p.songTime) && Number.isFinite(p.offset))
  if (pairs.length >= 5) {
    const meanT = pairs.reduce((s, p) => s + p.songTime, 0) / pairs.length
    const meanO = pairs.reduce((s, p) => s + p.offset, 0) / pairs.length
    let sTT = 0
    let sTO = 0
    for (const p of pairs) {
      sTT += (p.songTime - meanT) ** 2
      sTO += (p.songTime - meanT) * (p.offset - meanO)
    }
    const slope = sTT > 0 ? sTO / sTT : 0
    // 双门槛：斜率（s/s）本身微小（句距秒级下每句 0.2s ≈ 斜率 0.02），单看斜率会
    // 误触发；结合「总漂移量 = |slope| × 歌曲跨度 ≥1.5s」（可感知的错位）才纠。
    if (pairs.length >= 2) {
      const times0 = pairs.map((p) => p.songTime)
      const span = Math.max(...times0) - Math.min(...times0)
      const totalDrift = Math.abs(slope) * span
      if (Math.abs(slope) >= 0.008 && totalDrift >= 1.5) {
        // 拟合优度（相关系数平方）：太散的匹配不产漂移锚
        let sOO = 0
        for (const p of pairs) sOO += (p.offset - meanO) ** 2
        const r2 = sTT > 0 && sOO > 0 ? (sTO * sTO) / (sTT * sOO) : 0
        if (r2 >= 0.5) {
          const times = pairs.map((p) => p.songTime)
          const tMin = Math.min(...times)
          const tMax = Math.max(...times)
          const anchor = (t: number) => ({ songTime: Math.round(t * 10) / 10, offsetSeconds: Math.round((meanO + slope * (t - meanT)) * 100) / 100, correlation: 1 })
          const segments = [anchor(tMin), anchor(tMax)]
          mvLog(`字幕漂移拟合：斜率=${slope.toFixed(3)}s/s 总漂移=${totalDrift.toFixed(1)}s r²=${r2.toFixed(2)}（${pairs.length} 对）→ 分段锚 [${tMin.toFixed(0)}s→${segments[0].offsetSeconds}s, ${tMax.toFixed(0)}s→${segments[1].offsetSeconds}s]`)
          return { offsetSeconds: median, confidence: Math.max(0, Math.min(1, 0.35 + 0.1 * offsets.length - 0.06 * spread)), method: 'subtitle', segments }
        }
      }
    }
  }

  // 低样本封顶（304 对真实语料标定）：n_pairs 是可靠性的最强预测器——n≥7 的 10 条
  // 全部正确（多投稿偏移收敛），n≤5 的 5 条里 4 条可疑（LOFI 改编偏 4.6s、重复结构假
  // 锁 22.99s、双语轨弱侧偏 4.1s）。低样本（<6 对）置信度封顶 0.55（同步层弱对齐档，
  // 追频容差自动放宽），扫描路径（无整行匹配佐证）再降 0.05——真实偏移靠多投稿收敛
  // 站得住，假对齐被 conf<0.6 挡在应用门槛外也不可惜（宁缺毋滥）。
  let confidence = Math.max(0, Math.min(1, 0.35 + 0.1 * offsets.length - 0.06 * spread))
  if (offsets.length < 6) confidence = Math.min(confidence, usedTokenScan ? 0.5 : 0.55)
  return { offsetSeconds: median, confidence, method: 'subtitle', ...(usedTokenScan ? { source: 'subtitle-scan' as const } : {}) }
}

async function detectViaSubtitles(input: MvAlignmentInput, signal?: AbortSignal): Promise<MvAlignment | null> {
  try {
    const info = await getBilibiliSubtitles(input.bvid, input.cid, signal)
    if (info.code !== 0 || !info.subtitles.length) return null
    // 多字幕逐条试配而非只选一条：双语/多语视频常同时挂「原文 CC + 翻译 CC」，
    // pickBestSubtitle 的语言偏好猜错（如本地歌词只有日文原文而偏好选了中文翻译 CC）
    // 会让字幕对齐整体失效。每条字幕各算一次，取置信度最高者；偏好序只作并列打破。
    const pref = getBilibiliWatchSettings().subtitlePreference
    const ordered = [...info.subtitles].sort((a, b) => {
      const chosenA = pickBestSubtitle([a, b], pref) === a ? -1 : 1
      return chosenA
    })
    let best: { result: MvAlignment; index: number } | null = null
    for (let i = 0; i < ordered.length; i += 1) {
      if (signal?.aborted) return null
      const chosen = ordered[i]
      if (!chosen?.cacheKey) continue
      const lines = await getBilibiliSubtitleJson(chosen.cacheKey, signal).catch(() => null)
      const clean = cleanSubtitleLines(lines)
      if (!clean.length) continue
      // AI 字幕歌词性预检（真实数据 P1，12 样本实测）：AI 转写轨分两种——纯音乐/环境声
      // 识别（「♪ 音乐 ♪」×186/200、去重词 14 个）和现场闲聊转写（「紧张紧张呢」「家庭
      // 作业」）。两者都不是歌词，拿去文本对齐会产出完全错误的偏移。判据：音乐/环境
      // 声行占比 >0.5 或去重内容词 <20 → 不用于对齐（仍可用于显示，clean 原样保留）。
      if (chosen.aiType === 1 && !isLyricLikeSubtitle(clean)) {
        mvLog(`AI 字幕非歌词（音乐/环境声识别或闲聊转写）→ 跳过对齐：${chosen.lanDoc || chosen.lan}`)
        continue
      }
      const result = detectOffsetFromSubtitles(input.lyrics || [], clean)
      if (result && (!best || result.confidence > best.result.confidence)) {
        best = { result, index: i }
      }
    }
    if (!best) return null
    if (best.index > 0) {
      mvLog(`字幕多选一：偏好序首选外的第 ${best.index + 1} 条字幕置信度更高（conf=${best.result.confidence.toFixed(2)} offset=${best.result.offsetSeconds}s）`)
    }
    return best.result
  } catch {
    return null
  }
}

// ===== 节拍对齐 =====

/**
 * 歌曲节拍序列 ↔ MV 节拍序列互相关求偏移。
 * 逐对计算 δ = mvBeat - songBeat 的直方图（0.25s 桶）定位峰值偏移，再在峰值桶中心
 * ±0.25s 内 0.02s 步进精化，对取得最大匹配数的偏移取平均（均匀节拍网格的 ±半拍
 * 歧义取中心即精确偏移）。
 * 判定（宽容度）：真对齐时「匹配率」（MV 节拍能在容差内命中歌曲节拍的比例）高，
 * 且命中对的「节拍下标差」恒定；现场变速/翻唱 → 匹配率低或下标差漂移；随机 → 下标差
 * 杂乱。二者因任一不足被拒绝（返回 null → 调用方不操作、自由播放）。
 */
export function detectOffsetFromBeats(songBeats: number[], mvBeats: number[]): MvAlignment | null {
  const S = [...songBeats.filter((t) => Number.isFinite(t))].sort((a, b) => a - b)
  const M = mvBeats.filter((t) => Number.isFinite(t))
  if (S.length < 10 || M.length < 10) return null

  const BUCKET = 0.25
  const hist = new Map<number, number>()
  for (const m of M) {
    for (const s of S) {
      const delta = m - s
      if (Math.abs(delta) > MAX_SANE_OFFSET_SECONDS) continue
      const bucket = Math.round(delta / BUCKET)
      hist.set(bucket, (hist.get(bucket) || 0) + 1)
    }
  }
  if (hist.size === 0) return null
  let peakBucket = 0
  let peakCount = 0
  for (const [bucket, count] of hist) {
    if (count > peakCount) {
      peakCount = count
      peakBucket = bucket
    }
  }
  const peakCenter = peakBucket * BUCKET

  // 精化（两级）：先以 0.02s 步进找**匹配数最多**的偏移候选（容差 0.15s）；
  // 均匀节拍网格下大量相邻候选并列最优（±半拍歧义），旧实现取并列候选的平均——
  // 量化到 0.02s 步进，真值可偏 0.05-0.1s（用户实测"对齐差一点点"）。
  // v2：并列区间确定后，收集该区间内**全部命中对**的残差 δ = mvBeat - 最近songBeat - 基准，
  // 用残差均值（最小二乘意义的中心）把 offset 从 0.02s 步进精修到亚 0.01s 级。
  const TOL = 0.15
  let bestMatches = 0
  let bestOffsets: number[] = []
  for (let d = -0.25; d <= 0.25 + 1e-9; d += 0.02) {
    const offset = peakCenter + d
    let matches = 0
    for (const m of M) {
      if (nearestIndex(S, m - offset, TOL) >= 0) matches += 1
    }
    if (matches > bestMatches) {
      bestMatches = matches
      bestOffsets = [offset]
    } else if (matches === bestMatches && bestMatches > 0) {
      bestOffsets.push(offset)
    }
  }
  if (bestMatches === 0) return null
  // 残差精修：以并列区间中点为基准，收集命中对的 (m - 最近 songBeat)，其均值即
  // 基准相对真值的系统性偏差（TOL 内所有命中对的残差中心 = 最小二乘 offset）；
  // 残差样本过少（< 50% 命中数，异常）时退回并列平均。
  const baseOffset = bestOffsets[Math.floor(bestOffsets.length / 2)]
  let residualSum = 0
  let residualCount = 0
  for (const m of M) {
    const j = nearestIndex(S, m - baseOffset, TOL)
    if (j >= 0) {
      residualSum += m - S[j] - baseOffset
      residualCount += 1
    }
  }
  const bestOffset = residualCount >= Math.max(5, bestMatches * 0.5)
    ? baseOffset + residualSum / residualCount
    : bestOffsets.reduce((a, b) => a + b, 0) / bestOffsets.length
  if (Math.abs(bestOffset) > MAX_SANE_OFFSET_SECONDS) return null

  const minLen = Math.min(S.length, M.length)
  const matchRatio = bestMatches / minLen
  if (matchRatio < 0.5) return null

  // 节拍下标差一致性：真对齐时每个命中对的 (歌曲下标 - MV下标) 恒定（±2 内）。
  // 随机命中 → 下标差杂乱；现场变速 → 随时间漂移。此判别把"随机撞上"与真对齐分开。
  const indexDiffs: number[] = []
  for (let i = 0; i < M.length; i++) {
    const j = nearestIndex(S, M[i] - bestOffset, TOL)
    if (j >= 0) indexDiffs.push(j - i)
  }
  if (indexDiffs.length < Math.max(5, minLen * 0.4)) return null
  const diffCounts = new Map<number, number>()
  for (const d of indexDiffs) diffCounts.set(d, (diffCounts.get(d) || 0) + 1)
  let mode = 0
  let modeCount = 0
  for (const [d, c] of diffCounts) {
    if (c > modeCount) {
      modeCount = c
      mode = d
    }
  }
  const consistent = indexDiffs.filter((d) => Math.abs(d - mode) <= 2).length / indexDiffs.length
  if (consistent < 0.6) return null

  const confidence = Math.max(0, Math.min(1, 0.3 + matchRatio * 0.6 + consistent * 0.3))
  const result = { offsetSeconds: Math.round(bestOffset * 100) / 100, confidence, method: 'beat' as const }
  mvLog(`互相关求偏移：peakBucket=${(peakBucket * BUCKET).toFixed(2)}s 精化=${bestOffset.toFixed(2)}s matchRatio=${matchRatio.toFixed(2)} 下标差一致=${consistent.toFixed(2)} → ${result.offsetSeconds}s conf=${result.confidence.toFixed(2)}`)
  return result
}

/** 在升序数组里二分找距 target 最近的元素下标；|差值| > tol 返回 -1 */
function nearestIndex(sortedAsc: number[], target: number, tol: number): number {
  let lo = 0
  let hi = sortedAsc.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sortedAsc[mid] < target) lo = mid + 1
    else hi = mid
  }
  let best = lo
  if (lo > 0 && Math.abs(sortedAsc[lo - 1] - target) < Math.abs(sortedAsc[lo] - target)) best = lo - 1
  return Math.abs(sortedAsc[best] - target) <= tol ? best : -1
}

async function detectViaBeats(input: MvAlignmentInput, signal?: AbortSignal): Promise<MvAlignment | null> {
  const songUrl = input.songUrl || ''
  const videoUrl = input.videoUrl || ''
  if (!songUrl.startsWith('http') || !videoUrl.startsWith('http')) return null

  try {
    // 1. 歌曲节拍：优先复用 automix 已缓存的同曲分析（App trackKey 命中；automix 的音频
    //    按曲目身份下载，不受 audio.src 过渡竞态影响）。songKey 与 automix trackKey 是
    //    两套键（实测 qq:646755675 ≠ qq-002L2DQS2FWzn1），songKey 只作自建缓存键。
    const cachedSongAnalysis = input.trackKey ? await autoMixAnalysisService.getCached(input.trackKey) : null
    const songAnalysis = cachedSongAnalysis || await autoMixAnalysisService.analyze({
      trackKey: input.songKey,
      url: songUrl,
      duration: input.songDuration,
      signal,
    })
    const songBeats = songAnalysis?.beats || null
    if (!songBeats || songBeats.length < 10) {
      mvLog(`节拍对齐中止：${input.bvid} 歌曲节拍不足（${songBeats?.length || 0}）`)
      return null
    }
    mvLog(`歌曲分析：${input.songKey} beats=${songBeats.length} 首拍=${songBeats[0].toFixed(2)}s BPM=${songAnalysis?.estimatedBpm} provider=${songAnalysis?.provider} 有rmsEnvelope=${Array.isArray(songAnalysis?.rmsEnvelope) && (songAnalysis?.rmsEnvelope?.length || 0) > 0}`)
    // 歌曲分析健全性：分析时长与歌曲元数据明显不符 = 脏缓存/错源音频（实测过渡竞态把
    // 上一首 162.2s 的分析缓存在 5АМ 的 songKey 下——缓存键只含 trackKey+时长不含 URL，
    // 脏数据长期存活——节拍/包络结论全废、错误偏移入缓存）。拒用并放弃对齐（自由播放）。
    if (input.songDuration > 0 && (songAnalysis?.duration ?? 0) > 0 && Math.abs((songAnalysis?.duration ?? 0) - input.songDuration) > 5) {
      mvLog(`歌曲分析时长不符：${input.bvid} 分析=${(songAnalysis?.duration ?? 0).toFixed(1)}s 歌曲元数据=${input.songDuration}s（脏缓存/错源，拒用）`)
      return null
    }

    // 2. MV 音频轨节拍：走 analyze 全链路（Python → Electron worker → 浏览器
    //    decodeAudioData，最后者原生支持 m4a/aac——B站 DASH 音频轨是 m4s/aac，
    //    Python/librosa 打不开，必须靠浏览器解码兜底）。
    //    传 bpmHint=歌曲 BPM + beatTimesHint=歌曲真实拍点：MV 与歌曲同源，直接按
    //    歌曲拍点模式在 MV onset 上滑动相关求偏移——规则网格在歌曲变速/漂移时失配
    //    （实测累积漂移可达 4s+），真实拍点模式对变速鲁棒。
    // 歌曲 RMS 包络（包络互相关求偏移最鲁棒——安静前奏/节拍混叠下 onset 相关会
    // 偏晚 ~10s）。优先用歌曲分析的 rmsEnvelope（浏览器回退路径），否则解码歌曲音频
    // 自行计算（一次对齐只算一次，结果缓存在 mvAlignment）。
    let songRms: number[] | undefined
    if (Array.isArray(songAnalysis.rmsEnvelope) && songAnalysis.rmsEnvelope.length > 0) {
      songRms = songAnalysis.rmsEnvelope
      mvLog(`歌曲包络来源：分析结果 rmsEnvelope（${songRms.length} 帧）`)
    } else if (songUrl.startsWith('http')) {
      try {
        // 与 computeLiveCompensation/候选探针同路同键（getSongEnvelope 记忆化 +
        // songKey 缓存键）：现场版补偿与拍点路径共用同一次解码——此前这条分支
        // 直调 decodeSongEnvelope 且用 env:<hash> 键，同一首歌的包络被解码/计算两遍。
        const decoded = await getSongEnvelope(songUrl, signal, input.songKey, input.songDuration)
        songRms = decoded?.frameRms
        if (songRms) mvLog(`歌曲包络来源：解码歌曲音频（${songRms.length} 帧）`)
      } catch (error) {
        mvLog(`歌曲包络解码失败：${error instanceof Error ? error.message : String(error)}（回退音乐起始锚点）`)
      }
    }
    const mvAnalysis = await autoMixAnalysisService.analyze({
      trackKey: `mv-align-video:${input.songKey}:${input.bvid}`,
      url: videoUrl,
      duration: input.songDuration,
      bpmHint: songAnalysis.estimatedBpm && songAnalysis.estimatedBpm > 0 ? songAnalysis.estimatedBpm : undefined,
      beatTimesHint: songBeats,
      beatWeightsHint: beatWeightsOf(songAnalysis),
      rmsEnvelopeHint: songRms,
      sourceSignature: mvPatternSignature(songBeats),
      signal,
    })
    // 段落支持率输入：MV 侧 rmsEnvelope（browser-fallback 分析产出）+ 歌曲侧包络，
    // 与包络互相关同口径（50fps 帧级，非 10fps 盒平均——分段相关在帧级即可，避免再解码）
    const mvRmsForSupport = Array.isArray(mvAnalysis?.rmsEnvelope) && mvAnalysis.rmsEnvelope.length > 0 ? mvAnalysis.rmsEnvelope : undefined
    const songRmsForSupport = songRms
    // 人声频段二次意见：全带包络弱相关时（欢呼/观众噪声污染的现场），
    // 用 200-4kHz 频段包络重做互相关——俺の彼女 巡演实测该口径段支持率 0.44 vs 全带 0.22。
    // 人声频段二次意见（懒求值）：只有全带支持率未过线时才需要 200-4kHz 频段包络
    //（观众欢呼/掌声能量在频段外，现场场景该口径显著更可信——俺の彼女 实测 0.44 vs 全带 0.22）。
    // 惰性解码函数：官方 MV（绝大多数对齐）支持率一次过线 → 这两次整曲解码 + Goertzel
    // 频段包络完全省掉；解码失败返回 null（二次意见静默跳过）。
    const mvRmsForVocalBand = mvRmsForSupport
    const songRmsForVocalBand = songRmsForSupport
    const getVocalBandEnvelopes = async (): Promise<{ mvVocalRms?: number[]; songVocalRms?: number[] }> => {
      if (!mvRmsForVocalBand || !songRmsForVocalBand) return {}
      try {
        const [mvBuf, songBuf] = await Promise.all([
          decodeAudioUrl(videoUrl, signal),
          (async () => {
            const local = await window.electron?.audioDownload?.prepare?.(songUrl, input.songKey || `env:${songUrl.length}`, { expectedDuration: input.songDuration })
            const media = local ? await window.electron?.audioDownload?.getMediaUrl?.(local) : null
            return decodeAudioUrl(media || songUrl, signal)
          })().catch(() => null),
        ])
        return {
          mvVocalRms: computeVocalBandEnvelope(mvBuf.buffer).vocalRms,
          songVocalRms: songBuf ? computeVocalBandEnvelope(songBuf.buffer).vocalRms : undefined,
        }
      } catch {
        return {} /* 频段包络不可得 → 跳过二次意见 */
      }
    }
    const mvBeats = mvAnalysis?.beats || null
    if (!mvBeats || mvBeats.length < 10) {
      mvLog(`节拍对齐中止：${input.bvid} MV 节拍不足（${mvBeats?.length || 0}）；尝试媒体元素包络`)
      return mediaEnvelopeAlignmentFallback(songUrl, videoUrl, signal)
    }
    // 网格需与 MV 音频贴合：锚点/混叠失败的网格（gridOnsetConfidence 低）即使自洽
    // 也会让互相关算出错误偏移并套用——置信度低于阈值时拒绝对齐（自由播放，不乱跳）。
    if ((mvAnalysis?.confidence ?? 0) < 0.15) {
      // 包络兜底：网格置信度低但**包络强相关且峰突出**（peak≥0.6 = MV 与歌曲同录音，
      // prominence≥门槛 = argmax 不是落在重复段上的假峰，如官方 MV 音频 librosa 解不了
      // （metadata-only）时网格天然失效，动测 0.027）→ 用包络偏移。突出度不足的偏移
      // 是"抛硬币"选的（实测 Одна -1.8s、真实 ≈+3s）→ 拒绝，退媒体元素包络或自由播放。
      const envelopeResult = mvAnalysis?.envelopePeak != null && mvAnalysis.envelopeOffset != null
        ? buildEnvelopeAlignment(mvAnalysis.envelopeOffset, mvAnalysis.envelopePeak, mvAnalysis.envelopeProminence ?? 0)
        : null
      if (envelopeResult) {
        mvLog(`包络兜底对齐：${input.bvid} 网格 ${(mvAnalysis?.confidence ?? 0).toFixed(3)} 弱但包络 peak=${mvAnalysis!.envelopePeak!.toFixed(2)} 突出度=${(mvAnalysis!.envelopeProminence ?? 0).toFixed(2)} → offset=${envelopeResult.offsetSeconds.toFixed(2)}s conf=${envelopeResult.confidence.toFixed(2)}（MV 节拍分析不可用）`)
        return envelopeResult
      }
      if (mvAnalysis?.envelopePeak != null && mvAnalysis.envelopeOffset != null) {
        mvLog(`包络兜底拒绝：${input.bvid} peak=${mvAnalysis.envelopePeak.toFixed(2)} 突出度=${(mvAnalysis.envelopeProminence ?? 0).toFixed(2)} 不足（argmax 落在重复段/弱峰）；尝试媒体元素包络`)
      }
      mvLog(`节拍对齐拒绝：${input.bvid} MV 网格置信度 ${(mvAnalysis?.confidence ?? 0).toFixed(3)} < 0.15；尝试媒体元素包络`)
      return mediaEnvelopeAlignmentFallback(songUrl, videoUrl, signal)
    }
    mvLog(`MV 网格：${input.bvid} conf=${mvAnalysis.confidence.toFixed(3)} beats=${mvBeats.length}（锚点/偏移见 findBeatPatternGrid 日志）`)

  const result = detectOffsetFromBeats(songBeats, mvBeats)
  // 非官方/非歌词视频且 CC 内容与歌词不符（剪辑/二创/直播切片）时，节拍自洽≠同一录音：
  // 拒绝 beat-only 偏移，退回包络兜底（包络强相关才可信），否则自由播放。
  if (result && result.method === 'beat' && input.candidateType === 'other' && input.ccVerification === 'mismatch') {
    mvLog(`拒绝节拍对齐：${input.bvid} type=other cc=mismatch（节拍自洽≠同一录音）`)
    return mediaEnvelopeAlignmentFallback(songUrl, videoUrl, signal)
  }
  // 拍点提示路径（beatTimesHint）下 MV 节拍 = 歌曲节拍 + 网格偏移，上面的
  // detectOffsetFromBeats 是**循环自证**：拿"歌曲拍+δ"对"歌曲拍"互相关，δ 恒全中 →
  // matchRatio/下标差一致/conf 恒≈1（俺の彼女 现场 MV 因此以 conf=1.00 入缓存 30 天，
  // 歌词越播越偏）。该路径的对齐改由**包络证据链**裁决（现场/翻唱与录音室是不同
  // 录音，节拍网格必然有出入，但响度结构逐段对应）：
  //   1. 包络互相关峰（搜索范围已扩到 +90s：现场 MV 常带几十秒开场，俺の彼女 真偏移
  //      +54.7s 曾被 ±45s 上限截断，永远对不上）；
  //   2. 段落支持率：恒定偏移下 30s 段相关 >0.4 的占比——真对齐唯一判别式（实测真峰
  //      0.44 唯一过线，窗内假峰全 0.00；全曲峰会被弱段拉平，单看峰值不够）；
  //   3. 恒定偏移预查：偏移处必须落在 MV 时长内（负值同理），越界直接拒。
  // 仅限 browser-fallback 拍点网格——Python/Electron 分析的 MV 节拍是真实检测，
  // detectOffsetFromBeats 对它们是有效校验。
  const patternDerived = mvAnalysis.provider === 'browser-fallback'
    && typeof mvAnalysis.sourceSignature === 'string'
    && mvAnalysis.sourceSignature.startsWith('pattern:')
  if (patternDerived) {
    const envOffset = mvAnalysis.envelopeOffset
    if (envOffset != null && mvAnalysis.envelopePeak != null) {
      const support = mvRmsForSupport && songRmsForSupport
        ? envelopeSegmentSupport(mvRmsForSupport, songRmsForSupport, 50, envOffset)
        : { ratio: 0, mean: 0, segments: 0 }
      // 人声频段二次意见：全带支持率未过线但频段包络可用时，用 200-4kHz 包络重算——
      // 观众欢呼/掌声能量在频段外，现场场景该口径显著更可信（俺の彼女 实测 0.44 vs 0.22）。
      // 取两者较大者作为结构证据（频段包络通过闸门时日志注明口径）。懒解码：只在此处
      // （全带证据不足）才花两次整曲解码，官方 MV 的常规对齐完全不付这笔开销。
      let vocalSupplement = false
      if (mvRmsForSupport && songRmsForSupport && support.ratio < ENVELOPE_SEGMENT_SUPPORT_MIN) {
        const { mvVocalRms, songVocalRms } = await getVocalBandEnvelopes()
        if (mvVocalRms && songVocalRms) {
          const vocal = envelopeSegmentSupport(mvVocalRms, songVocalRms, 50, envOffset)
          if (vocal.ratio > support.ratio) {
            vocalSupplement = vocal.ratio >= ENVELOPE_SEGMENT_SUPPORT_MIN
            support.ratio = vocal.ratio
            support.mean = vocal.mean
            support.segments = vocal.segments
          }
        }
      }
      const offsetInRange = Math.abs(envOffset) <= MAX_ENVELOPE_OFFSET_SECONDS
        && (envOffset >= 0 ? envOffset <= (mvAnalysis.duration ?? Infinity) : -envOffset <= (songAnalysis.duration ?? Infinity))
      // 同录音（peak≥0.6 且突出度达标）或 结构证实（段落支持率过线）→ 采纳包络偏移
      const strongEnvelope = mvAnalysis.envelopePeak >= 0.6 && (mvAnalysis.envelopeProminence ?? 0) >= ENVELOPE_PROMINENCE_MIN
      const structureConfirmed = offsetInRange && support.ratio >= ENVELOPE_SEGMENT_SUPPORT_MIN
      // 投票一致性救援（194 对 live 基准两轮复现：净增 2TP/0FP）：峰 0.45-0.6 的 live
      // （现场录音动态压扁/副歌重复结构稀释突出度），但其分段局部峰与全曲峰一致（≤5s）
      // 时，"多数段独立找到同一偏移"是峰可信的旁证 → 采纳。与峰矛盾（>5s）的投票说明
      // 峰落在重复段上，维持拒绝。
      const voteConsistent = !strongEnvelope && !structureConfirmed
        && offsetInRange
        && mvAnalysis.envelopePeak >= 0.45
        && mvAnalysis.envelopeVoteOffset != null
        && Math.abs(mvAnalysis.envelopeVoteOffset - envOffset) <= 5
      // 分段锚点统计：采纳路径的分段锚点与模型特征共用一次计算（现场改编区
      // 讲段/即兴/变速在全局锚处相关塌陷；锚点统计也是裁决模型的特征之一）。
      const evidenceAnchors = mvRmsForSupport && songRmsForSupport
        ? envelopeSegmentAnchors(mvRmsForSupport, songRmsForSupport, 50, envOffset)
        : []
      const evidenceInput = buildEvidenceModelInput({
        peak: mvAnalysis.envelopePeak ?? 0,
        prom: mvAnalysis.envelopeProminence ?? 0,
        supportRatio: support.ratio,
        supportSegments: support.segments,
        voteOffset: mvAnalysis.envelopeVoteOffset,
        envOffset,
        songDuration: songAnalysis.duration,
        mvDuration: mvAnalysis.duration,
        anchors: evidenceAnchors,
      })
      if (strongEnvelope || structureConfirmed || voteConsistent) {
        // 模型否决（veto）：闸门放行但证据组合分极低且 peak<0.6（非同录音铁证）
        // → 拒绝。训练标定（206 金样本）：砍 10/12 误放（翻唱/混剪错放 → 歌词错位），
        // 0 漏救。同录音铁证（peak≥0.6）不受否决——那是最强的独立证据。
        const evidenceScore = scoreEvidenceAlignment(evidenceInput)
        if (!strongEnvelope && evidenceScore < EVIDENCE_MODEL_VETO_SCORE && mvAnalysis.envelopePeak < 0.6) {
          mvLog(`证据模型否决：${input.bvid} 闸门${strongEnvelope ? '同录音' : structureConfirmed ? '结构证实' : '投票一致'}放行但组合分=${evidenceScore.toFixed(3)}<${EVIDENCE_MODEL_VETO_SCORE}（peak=${mvAnalysis.envelopePeak.toFixed(2)} 支持=${support.ratio.toFixed(2)} 投票Δ=${evidenceInput.voteOffDelta.toFixed(1)}s 锚=${evidenceInput.anchors}）→ 自由播放（疑似翻唱/混剪错放）`)
          return null
        }
        // 投票真值仲裁（分档，6248 对 votes-cache 标定）：
        //   · 峰<0.45 → 无条件信投票（簇票==2 弱簇矛盾时真值 71% 在投票侧，全量验证 11:0）
        //   · 峰 0.45-0.6 → 需支持率<0.45（此档矛盾对真值多在峰侧——簇票≥3 时投票≈峰影子，
        //     真值 83% 在峰位；支持率低才说明峰的结构证实不足）
        // 峰≥0.6（同录音）时峰恒优先——投票以峰为先验 ±5s 扫描，强峰证据下投票无独立信息量。
        let chosenOffset = envOffset
        let arbitrated = false
        if (!strongEnvelope
          && mvAnalysis.envelopeVoteOffset != null
          && Math.abs(mvAnalysis.envelopeVoteOffset - envOffset) > 1.5) {
          const unconditional = mvAnalysis.envelopePeak < 0.45
          const supportWeak = support.ratio < 0.45
          if (unconditional || (mvAnalysis.envelopePeak < 0.6 && supportWeak)) {
            chosenOffset = mvAnalysis.envelopeVoteOffset
            arbitrated = true
            mvLog(`投票真值仲裁：${input.bvid} 峰=${envOffset.toFixed(2)}s(peak=${mvAnalysis.envelopePeak!.toFixed(2)} 支持率=${support.ratio.toFixed(2)}) 与段投票 ${mvAnalysis.envelopeVoteOffset.toFixed(2)}s 矛盾 → 信投票（${unconditional ? '弱峰无条件档' : '弱证实档'}）`)
          }
        }
        // 弱支持档（支持率采纳且峰<0.6）置信度封顶 0.55：误差审计显示该档 24% 误差>1s
        // （强支持档 0%），同步层虽只按 0.5 门槛消费，日志/诊断可据此分辨"弱对齐"
        const confidence = Math.max(0.5, Math.min(
          (mvAnalysis.envelopePeak < 0.6 && support.ratio < 0.5) ? 0.55 : 0.8,
          0.4 + (mvAnalysis.envelopePeak! - 0.6) + support.ratio * 0.5))
        // 分段锚点：现场改编区（讲段/即兴/变速）在全局锚处相关塌陷，恒定偏移逐句漂。
        // 提取段相关 ≥0.5 的局部偏移锚（跳变防护内含），改编区由相邻锚插值过渡；
        // 全曲均匀贴合（锚点全部≈全局锚）或锚点过少时省略 segments（与常数无差别，省序列化）。
        let segments: MvAlignmentSegment[] | undefined
        if (evidenceAnchors.length >= 2) {
          const driftSpread = Math.max(...evidenceAnchors.map((a) => a.offsetSeconds)) - Math.min(...evidenceAnchors.map((a) => a.offsetSeconds))
          if (driftSpread >= 0.3) {
            segments = evidenceAnchors.map((a) => ({ songTime: Math.round(a.songTime * 10) / 10, offsetSeconds: Math.round(a.offsetSeconds * 100) / 100, correlation: Math.round(a.correlation * 100) / 100 }))
            mvLog(`分段锚点：${input.bvid} ${evidenceAnchors.length} 个锚（跨度 ${driftSpread.toFixed(2)}s）[${evidenceAnchors.map((a) => `${a.songTime.toFixed(0)}s→${a.offsetSeconds.toFixed(1)}s(r${a.correlation.toFixed(2)})`).join(' ')}]`)
          }
        }
        mvLog(`拍点网格对齐（包络证实）：${input.bvid} 偏移=${chosenOffset.toFixed(2)}s peak=${mvAnalysis.envelopePeak!.toFixed(2)} 突出度=${(mvAnalysis.envelopeProminence ?? 0).toFixed(2)} 段落支持=${support.ratio.toFixed(2)}（${support.segments} 段${vocalSupplement ? '，人声频段' : ''}）→ conf=${confidence.toFixed(2)}${strongEnvelope ? '（同录音）' : '（结构证实）'}${arbitrated ? '（投票仲裁）' : ''}${segments ? ` 分段=${segments.length}` : ''}`)
        return { offsetSeconds: Math.round(chosenOffset * 100) / 100, confidence, method: 'envelope', prominence: Math.round((mvAnalysis.envelopeProminence ?? 0) * 100) / 100, ...(segments ? { segments } : {}) }
      }
      // 包络与结构都不支持：拍点网格偏移是循环自证抛硬币 → 不对齐。
      // 模型翻案（rescue）保险带：规则闸门拒绝但证据组合分高（≥0.7）且投票-峰
      // 偏移一致（≤1.5s，排除"峰落在重复段上"的抛硬币形态）→ 弱对齐采纳，conf
      // 封顶 0.55（同步层追频容差自动放宽到 1.2s）。本标定集（206 金样本）上闸门
      // 拒绝子集无漏救——该分支覆盖的是标定集未见的组合，故三重门槛从严。
      const rescueScore = scoreEvidenceAlignment(evidenceInput)
      if (rescueScore >= EVIDENCE_MODEL_RESCUE_SCORE
        && offsetInRange
        && mvAnalysis.envelopeVoteOffset != null
        && Math.abs(mvAnalysis.envelopeVoteOffset - envOffset) <= EVIDENCE_MODEL_RESCUE_MAX_VOTE_DELTA) {
        // 锚点仲裁：翻案是"规则闸门拒绝后的非常规采纳"，偏移再用段锚中位复核——
        // 有强锚（≥2 个锚贴同一偏移 ±2s）且与峰偏移矛盾（>2s）时信锚（多段独立
        // 找到的偏移比全曲峰更能对抗重复结构假峰）；锚与峰一致或无锚 → 用峰偏移。
        let rescueOffset = envOffset
        const strongAnchors = evidenceAnchors.filter((a) => a.correlation >= 0.5)
        if (strongAnchors.length >= 2) {
          const anchorMedian = [...strongAnchors.map((a) => a.offsetSeconds)].sort((x, y) => x - y)[Math.floor(strongAnchors.length / 2)]
          if (Math.abs(anchorMedian - envOffset) > 2) {
            mvLog(`翻案锚点仲裁：${input.bvid} 峰偏移=${envOffset.toFixed(2)}s 与 ${strongAnchors.length} 个强锚中位=${anchorMedian.toFixed(2)}s 矛盾 → 信锚`)
            rescueOffset = anchorMedian
          }
        }
        mvLog(`证据模型翻案：${input.bvid} 闸门拒绝但组合分=${rescueScore.toFixed(3)}≥${EVIDENCE_MODEL_RESCUE_SCORE} 且投票一致（Δ=${Math.abs(mvAnalysis.envelopeVoteOffset! - envOffset).toFixed(2)}s）→ 弱对齐采纳 offset=${rescueOffset.toFixed(2)}s conf=0.55`)
        return { offsetSeconds: Math.round(rescueOffset * 100) / 100, confidence: 0.55, method: 'envelope', source: 'model-rescue', prominence: Math.round((mvAnalysis.envelopeProminence ?? 0) * 100) / 100 }
      }
      mvLog(`拍点网格拒绝：${input.bvid} 包络 peak=${mvAnalysis.envelopePeak!.toFixed(2)} 段落支持=${support.ratio.toFixed(2)} 偏移=${envOffset.toFixed(2)}s（范围合规=${offsetInRange}${rescueScore < EVIDENCE_MODEL_RESCUE_SCORE ? ` 模型分=${rescueScore.toFixed(2)}` : ' 模型分过线但投票不一致'}）→ 自由播放（循环自证分不可信）`)
      return null
    }
    // 无包络证据（歌曲包络解码失败等）：只信网格-MV onset 贴合度，门槛提到入库线
    if (!result || mvAnalysis.confidence < MIN_ALIGNMENT_CONFIDENCE) {
      mvLog(`拍点对齐拒绝：${input.bvid} 无包络证据且网格贴合度 ${(mvAnalysis?.confidence ?? 0).toFixed(3)} < ${MIN_ALIGNMENT_CONFIDENCE} → 尝试媒体元素包络`)
      return mediaEnvelopeAlignmentFallback(songUrl, videoUrl, signal)
    }
    // 主路径模型否决：Python/Electron 真实节拍检测下 matchRatio/下标差已做双判据，
    // 但「不同录音的两个规则节拍网格侥幸互中」（EDM/流行曲常态，复算数据 1020 组
    // 双弱组合是风险池）仍可能全绿。证据模型作为最后一道独立否决：组合分极低且
    // 峰<0.6（非同录音）时拒绝——无离线标定数据，只上 veto 不上 rescue（保守）。
    if (mvRmsForSupport && songRmsForSupport && (mvAnalysis.envelopePeak ?? 0) < 0.6) {
      const mainSupport = envelopeSegmentSupport(mvRmsForSupport, songRmsForSupport, 50, result.offsetSeconds)
      const mainPathAnchors = envelopeSegmentAnchors(mvRmsForSupport, songRmsForSupport, 50, result.offsetSeconds)
      const mainInput = buildEvidenceModelInput({
        peak: mvAnalysis.envelopePeak ?? 0,
        prom: mvAnalysis.envelopeProminence ?? 0,
        supportRatio: mainSupport.ratio,
        supportSegments: mainSupport.segments,
        voteOffset: mvAnalysis.envelopeVoteOffset,
        envOffset: result.offsetSeconds,
        songDuration: songAnalysis.duration,
        mvDuration: mvAnalysis.duration,
        anchors: mainPathAnchors,
      })
      const mainScore = scoreEvidenceAlignment(mainInput)
      if (mainScore < EVIDENCE_MODEL_VETO_SCORE) {
        mvLog(`主路径模型否决：${input.bvid} 节拍网格放行但组合分=${mainScore.toFixed(3)}<${EVIDENCE_MODEL_VETO_SCORE}（peak=${(mvAnalysis.envelopePeak ?? 0).toFixed(2)} 支持=${mainSupport.ratio.toFixed(2)}）→ 自由播放（不同录音的规则节拍侥幸互中）`)
        return null
      }
    }
    return { ...result, confidence: Math.min(result.confidence, mvAnalysis.confidence) }
  }
  return result
  } catch (error) {
    mvLog(`节拍对齐异常：${input.bvid} ${error instanceof Error ? error.message : String(error)}；尝试媒体元素包络`)
    if (songUrl.startsWith('http') && videoUrl.startsWith('http')) {
      return mediaEnvelopeAlignmentFallback(songUrl, videoUrl, signal)
    }
    return null
  }
}
