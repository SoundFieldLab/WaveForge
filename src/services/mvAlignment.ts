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
import { autoMixAnalysisService, decodeAudioUrl, computeFrameEnvelope, detectLiveMusicEntry, detectLiveMusicEntryAt, detectMusicStart, envelopeOffsetOf, ENVELOPE_PROMINENCE_MIN } from './autoMixAnalysisService'

export interface MvAlignment {
  /** MV 视频时间 - 歌曲音频时间的偏移（秒）：歌曲位置 s 对应视频位置 s + offsetSeconds */
  offsetSeconds: number
  /** 0-1 置信度 */
  confidence: number
  method: 'subtitle' | 'beat' | 'live-vocal' | 'envelope'
  /** 包络峰突出度（method=envelope 时携带）：主峰 − ±2s 外次峰，持久化迁移据此裁决可信度 */
  prominence?: number
}

/** 低于该置信度视为不可靠，调用方应自由播放、不做对齐校正 */
export const MIN_ALIGNMENT_CONFIDENCE = 0.5
/** 偏移量合理性上限：前摇超过 45s 基本是货不对板（别的现场/剪辑），不冒险对齐 */
const MAX_SANE_OFFSET_SECONDS = 45

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

const STORAGE_KEY = 'waveforge:mv-alignments:v2-seconds'
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
        map.set(key, { offsetSeconds: entry.offsetSeconds, confidence: entry.confidence, method: entry.method, prominence: entry.prominence, candidateType: entry.candidateType })
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

/** 取歌曲音频的帧 RMS 包络（50fps，与 MV 侧同口径）；失败返回 null（调用方降级）。 */
export async function getSongEnvelope(songUrl: string, signal?: AbortSignal): Promise<{ frameRms: number[]; frameRate: number } | null> {
  if (!songUrl || !(songUrl.startsWith('http') || songUrl.startsWith('blob:'))) return null
  const cached = songEnvelopeCache.get(songUrl)
  if (cached) return cached
  const existing = songEnvelopeInFlight.get(songUrl)
  if (existing) return existing
  const promise = (async () => {
    try {
      const { buffer } = await decodeAudioUrl(songUrl, signal)
      const envelope = computeFrameEnvelope(buffer)
      // 上限 8 条：一次会话里通常只有当前曲 + 预载下一曲
      if (songEnvelopeCache.size >= 8) {
        const oldest = songEnvelopeCache.keys().next().value
        if (oldest) songEnvelopeCache.delete(oldest)
      }
      songEnvelopeCache.set(songUrl, envelope)
      return envelope
    } catch {
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
): Promise<Map<string, number>> {
  const peaks = new Map<string, number>()
  const songEnvelope = await getSongEnvelope(songUrl, signal)
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
      const songEnv = input.songUrl ? await getSongEnvelope(input.songUrl, signal) : null

      // 锚 C（首选）：全曲包络互相关。现场/翻唱与音源虽是两条录音、节拍网格不可用，
      // 但同一首歌的**响度结构**仍逐段对应：相关峰过闸（buildEnvelopeAlignment：
      // peak≥0.6 且突出度≥0.05）即"结构对得上"，直接取该偏移。实测 ヒビカセ 武道馆现场
      // （qq:7420896 × BV1Lwz6YGEa6）：offset=+6.9s peak=0.69 prominence=0.10 → conf=0.69。
      // 闸门标定（97 组真实配对 / 290 负样本）：现规则通过 78% 真实配对、负样本 0 误通过；
      // 放宽到 peak≥0.55 且 prom≥0.03 可到 81%/0 误通过，但 0.55~0.6 段无法验证正确性，暂不放宽。
      let envelopeResult: MvAlignment | null = null
      if (songEnv) {
        const corr = envelopeOffsetOf(frameRms, songEnv.frameRms, songEnv.frameRate)
        envelopeResult = buildEnvelopeAlignment(corr.offset, corr.peak, corr.prominence)
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
  const [song, mv] = await Promise.all([
    sampleMediaEnvelope(songUrl, signal),
    sampleMediaEnvelope(videoUrl, signal),
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
  for (const sub of subLines) {
    const norm = normalizeText(sub.content)
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
      const timePenalty = Math.abs(e.timeSeconds - sub.from) / 120
      if (!best || score - timePenalty > best.score) {
        best = { timeSeconds: e.timeSeconds, score: score - timePenalty }
      }
    }
    if (!best) continue
    const offset = sub.from - best.timeSeconds
    // 剔除明显越界的匹配（字幕与歌词行整体偏移应在合理前摇范围内）
    if (Math.abs(offset) > MAX_SANE_OFFSET_SECONDS) continue
    offsets.push(offset)
  }
  if (offsets.length < 3) return null

  const sorted = [...offsets].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  // 离散度：|中位数偏移与四分位距|（对少量异常匹配鲁棒）
  const q1 = sorted[Math.floor(sorted.length / 4)]
  const q3 = sorted[Math.floor((3 * sorted.length) / 4)]
  const spread = q3 - q1
  if (spread > 3) return null

  const confidence = Math.max(0, Math.min(1, 0.35 + 0.1 * offsets.length - 0.06 * spread))
  return { offsetSeconds: median, confidence, method: 'subtitle' }
}

async function detectViaSubtitles(input: MvAlignmentInput, signal?: AbortSignal): Promise<MvAlignment | null> {
  try {
    const info = await getBilibiliSubtitles(input.bvid, input.cid, signal)
    if (info.code !== 0 || !info.subtitles.length) return null
    const pref = getBilibiliWatchSettings().subtitlePreference
    const chosen = pickBestSubtitle(info.subtitles, pref) || info.subtitles[0] || null
    if (!chosen) return null
    const lines = await getBilibiliSubtitleJson(chosen.cacheKey, signal)
    const clean = cleanSubtitleLines(lines)
    return detectOffsetFromSubtitles(input.lyrics || [], clean)
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

  // 精化：峰值桶中心 ±0.25s、0.02s 步进，统计容差 0.15s 内的匹配对；
  // 对取得最大匹配数的偏移取平均（半拍歧义取中心即精确偏移）
  const TOL = 0.15
  let bestMatches = 0
  let bestSum = 0
  let bestCount = 0
  for (let d = -0.25; d <= 0.25 + 1e-9; d += 0.02) {
    const offset = peakCenter + d
    let matches = 0
    for (const m of M) {
      if (nearestIndex(S, m - offset, TOL) >= 0) matches += 1
    }
    if (matches > bestMatches) {
      bestMatches = matches
      bestSum = offset
      bestCount = 1
    } else if (matches === bestMatches && bestMatches > 0) {
      bestSum += offset
      bestCount += 1
    }
  }
  if (bestMatches === 0) return null
  const bestOffset = bestSum / bestCount
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
        const localSong = await window.electron?.audioDownload?.prepare?.(songUrl, input.songKey)
        const mediaSong = localSong ? await window.electron?.audioDownload?.getMediaUrl?.(localSong) : null
        const songDecoded = await decodeAudioUrl(mediaSong || songUrl, signal)
        songRms = computeFrameEnvelope(songDecoded.buffer).frameRms
        mvLog(`歌曲包络来源：解码歌曲音频（${songDecoded.buffer.duration.toFixed(1)}s → ${songRms.length} 帧）`)
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
  return result
  } catch (error) {
    mvLog(`节拍对齐异常：${input.bvid} ${error instanceof Error ? error.message : String(error)}；尝试媒体元素包络`)
    if (songUrl.startsWith('http') && videoUrl.startsWith('http')) {
      return mediaEnvelopeAlignmentFallback(songUrl, videoUrl, signal)
    }
    return null
  }
}
