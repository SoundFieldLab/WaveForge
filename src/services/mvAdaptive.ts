/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 */
/**
 * MV 匹配「自适应层」（与世俱进，2026-10-23）。
 *
 * 动机：静态规则模型（bilibiliApi 的 marker/alias/权重表）由开发手动维护，随平台生态
 * 演化必然滞后——新 UP、新叫法、新写法要等下一次人工修订才被认识。本模块让匹配系统
 * 从三类**本地信号**持续自学习（零网络、零遥测、用户无感）：
 *
 *   1. 词汇学习（vocabulary）：用户手动选择某视频 / 自动匹配被真实播放后，标题里的
 *      歌手别名、歌名变体被抽进词典。下次匹配时词典命中获得置信加成——平台新叫法
 *      （新的歌手拉丁写法、缩写、汉化组译名）第一次出现就被记住。
 *   2. 查询效果（query effectiveness）：每个 (歌曲 → 胜出查询) 记录下来；同首歌再次
 *      匹配时胜出查询排到队首——少走弯路，对 alias 型歌名（βiοs→Bios 类）收益最大。
 *   3. 时效先验（recency prior）：播放量先验按投稿年龄衰减——3 年以上的旧视频先验
 *      打折，新投稿/新内容自然上浮，避免"老视频躺赢"。
 *
 * 边界：所有学习产物都在 localStorage（LRU 上限），纯本地；不修改静态规则模型本身，
 * 只做**加法修正**（词典加成 / 查询排序 / 时效因子），保证可回退（清空即回原状）。
 */

const ADAPTIVE_STORE_KEY = 'mv_adaptive_model'
const ADAPTIVE_STORE_VERSION = 1

/** 各桶上限（防 localStorage 无界增长；LRU 淘汰） */
const MAX_VOCAB = 400
const MAX_QUERY_WINS = 300

interface AdaptiveVocabEntry {
  /** 学到的别名（规范化后） */
  alias: string
  /** 关联的规范名（歌手主名/歌名主形） */
  canonical: string
  /** 学习来源次数（手动选择 +2，自动播放成功 +1） */
  hits: number
  lastAt: number
}

interface AdaptiveQueryWin {
  /** 胜出查询（原样，直接可用于 buildQueries） */
  query: string
  bvid: string
  hits: number
  lastAt: number
}

interface AdaptiveStore {
  v: number
  /** 歌手别名：normAlias → entry */
  artistVocab: Record<string, AdaptiveVocabEntry>
  /** 歌名变体：normVariant → entry（canonical = 平台歌名主体） */
  songVocab: Record<string, AdaptiveVocabEntry>
  /** 查询胜出：songKey → entry */
  queryWins: Record<string, AdaptiveQueryWin>
}

interface AdaptiveStoreInternal extends AdaptiveStore {
  /** 内部 LRU 访问序（非持久化语义，仅修剪用） */
  _order?: string[]
}

function readStore(): AdaptiveStoreInternal {
  try {
    const raw = localStorage.getItem(ADAPTIVE_STORE_KEY)
    if (!raw) return { v: ADAPTIVE_STORE_VERSION, artistVocab: {}, songVocab: {}, queryWins: {} }
    const parsed = JSON.parse(raw)
    if (!parsed || parsed.v !== ADAPTIVE_STORE_VERSION) return { v: ADAPTIVE_STORE_VERSION, artistVocab: {}, songVocab: {}, queryWins: {} }
    return {
      v: ADAPTIVE_STORE_VERSION,
      artistVocab: parsed.artistVocab || {},
      songVocab: parsed.songVocab || {},
      queryWins: parsed.queryWins || {},
    }
  } catch {
    return { v: ADAPTIVE_STORE_VERSION, artistVocab: {}, songVocab: {}, queryWins: {} }
  }
}

function writeStore(store: AdaptiveStoreInternal): void {
  try {
    localStorage.setItem(ADAPTIVE_STORE_KEY, JSON.stringify(store))
  } catch {
    /* 存储失败静默：自适应层不致命 */
  }
}

/** LRU 修剪：按 lastAt 淘汰最旧，保持桶内 ≤max */
function prune<T extends { lastAt: number }>(bucket: Record<string, T>, max: number): void {
  const entries = Object.entries(bucket)
  if (entries.length <= max) return
  entries.sort((a, b) => b[1].lastAt - a[1].lastAt)
  const kept = entries.slice(0, max)
  for (const key of Object.keys(bucket)) delete bucket[key]
  for (const [key, value] of kept) bucket[key] = value
}

/** 轻量规范化（与匹配器 normalizeText 子集对齐：小写/去空白/去常见标点）。 */
export function normalizeAdaptive(value: string): string {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[（()）\[\]【】《》<>{}"''“”·…!！?？,，.。｡;；:：\-—_／/\\|&*^%$#@~`+=～~]/g, '')
    .replace(/\s+/g, '')
}

// ==================== 1) 词汇学习 ====================

/** 词汇加成档位：hits ≥3 强证据 +14，≥1 弱证据 +8（远低于静态规则的强信号，只做 tie-break）。 */
export const ADAPTIVE_VOCAB_TIERS: ReadonlyArray<{ min: number; score: number }> = [
  { min: 3, score: 14 },
  { min: 1, score: 8 },
]

/**
 * 学习歌手别名：来源 = 用户手动选择（weight=2）或播放成功（weight=1）。
 * 提取：视频作者名 ↔ 平台歌手主名；标题歌名变体 ↔ 平台歌名。
 * 只学「有判别力」的映射：别名长度 ≥2、≠规范名、非通用词。
 */
export function learnFromMatch(input: {
  platformArtist?: string
  videoAuthor: string
  platformSongTitle?: string
  videoTitle: string
  weight: number
}): void {
  const store = readStore()
  const now = Date.now()
  const generic = /^(群星|V\.?A\.?|various.?artists|ost|原声带|anime|アニメ)$/i
  // 歌手别名：作者名与平台歌手名都有效且不同 → 学映射
  const author = String(input.videoAuthor || '').trim()
  const artist = String(input.platformArtist || '').trim()
  if (author.length >= 2 && author.length <= 30 && artist && !generic.test(artist) && normalizeAdaptive(author) !== normalizeAdaptive(artist)) {
    const key = normalizeAdaptive(author)
    const prev = store.artistVocab[key]
    store.artistVocab[key] = {
      alias: author,
      canonical: artist,
      hits: Math.min(99, (prev?.hits || 0) + input.weight),
      lastAt: now,
    }
  }
  // 歌名变体：视频标题中的「」/《》片段 ↔ 平台歌名主体
  const title = String(input.videoTitle || '')
  const song = String(input.platformSongTitle || '').trim()
  if (song.length >= 2) {
    const quoted = [...title.matchAll(/[「『《]([^「」『』《》]{2,60})[」』》》]/g)].map((m) => m[1])
    const songNorm = normalizeAdaptive(song)
    for (const candidate of quoted) {
      const candNorm = normalizeAdaptive(candidate)
      if (candNorm.length < 2 || candNorm === songNorm || songNorm.includes(candNorm) || candNorm.includes(songNorm)) continue
      // 与歌名无重叠的引号片段可能是作品名/栏目名——只保留「编辑距离意义上接近」的变体：
      // 简化判据：共享 ≥60% 字符（CJK）或前缀重叠（拉丁）
      const overlap = [...new Set(candNorm)].filter((ch) => songNorm.includes(ch)).length
      const close = candNorm.startsWith(songNorm.slice(0, Math.min(4, songNorm.length))) || overlap / Math.max(1, [...new Set(candNorm)].length) >= 0.6
      if (!close) continue
      const prev = store.songVocab[candNorm]
      store.songVocab[candNorm] = {
        alias: candidate,
        canonical: song,
        hits: Math.min(99, (prev?.hits || 0) + input.weight),
        lastAt: now,
      }
      break
    }
  }
  prune(store.artistVocab, MAX_VOCAB)
  prune(store.songVocab, MAX_VOCAB)
  writeStore(store)
}

/** 查询歌手别名词典：视频作者是否匹配某条学到的别名（返回对应规范名）。 */
export function lookupLearnedArtistAlias(videoAuthor: string): { canonical: string; score: number } | null {
  const store = readStore()
  const key = normalizeAdaptive(videoAuthor)
  const entry = store.artistVocab[key]
  if (!entry) return null
  for (const tier of ADAPTIVE_VOCAB_TIERS) {
    if (entry.hits >= tier.min) return { canonical: entry.canonical, score: tier.score }
  }
  return null
}

/** 查询歌名变体词典：候选标题是否包含某条学到的歌名变体（返回对应规范歌名）。 */
export function lookupLearnedSongVariant(candidateTitle: string): { canonical: string; score: number } | null {
  const store = readStore()
  const titleNorm = normalizeAdaptive(candidateTitle)
  if (!titleNorm) return null
  for (const entry of Object.values(store.songVocab)) {
    const aliasNorm = normalizeAdaptive(entry.alias)
    if (aliasNorm && titleNorm.includes(aliasNorm)) {
      for (const tier of ADAPTIVE_VOCAB_TIERS) {
        if (entry.hits >= tier.min) return { canonical: entry.canonical, score: tier.score }
      }
    }
  }
  return null
}

/** 平台歌名是否有学到的变体（buildQueries 追加召回查询用）。 */
export function getLearnedSongVariants(songTitle: string, limit = 2): string[] {
  const store = readStore()
  const songNorm = normalizeAdaptive(songTitle)
  if (!songNorm) return []
  const out: string[] = []
  for (const entry of Object.values(store.songVocab)) {
    const canonNorm = normalizeAdaptive(entry.canonical)
    if (canonNorm === songNorm && entry.hits >= 1) {
      out.push(entry.alias)
      if (out.length >= limit) break
    }
  }
  return out
}

/** 平台歌手名是否有学到的别名（buildQueries 追加查询用）。 */
export function getLearnedArtistAliases(artist: string, limit = 2): string[] {
  const store = readStore()
  const artistNorm = normalizeAdaptive(artist)
  if (!artistNorm) return []
  const out: string[] = []
  for (const entry of Object.values(store.artistVocab)) {
    if (normalizeAdaptive(entry.canonical) === artistNorm && entry.hits >= 1) {
      out.push(entry.alias)
      if (out.length >= limit) break
    }
  }
  return out
}

// ==================== 2) 查询效果追踪 ====================

/**
 * 记录查询胜出：歌曲匹配流程结束后调用（best 视频真实来源的查询）。
 * 同首歌下次匹配时该查询置顶——省 1-2 次弯路查询。
 */
export function recordQueryWin(songKey: string, query: string, bvid: string): void {
  if (!songKey || !query || !bvid) return
  const store = readStore()
  const prev = store.queryWins[songKey]
  store.queryWins[songKey] = {
    query,
    bvid,
    hits: Math.min(99, (prev?.hits || 0) + 1),
    lastAt: Date.now(),
  }
  prune(store.queryWins, MAX_QUERY_WINS)
  writeStore(store)
}

/** 查询歌曲的胜出查询（未记录/已过期 30 天返回 null）。 */
export function getQueryWin(songKey: string): { query: string; bvid: string } | null {
  const store = readStore()
  const entry = store.queryWins[songKey]
  if (!entry) return null
  if (Date.now() - entry.lastAt > 30 * 24 * 60 * 60 * 1000) return null
  return { query: entry.query, bvid: entry.bvid }
}

// ==================== 3) 时效先验 ====================

/**
 * 投稿时效因子（乘在播放量先验上）：
 *   ≤1 年 1.0；1-3 年线性降到 0.85；>3 年 0.85 → 0.7（5 年后触底）。
 * 平台趋势性内容（新番 OP）老视频的播放先验理应衰减；常青内容（经典 OP）靠
 * 基础播放量绝对值仍能保持竞争力——衰减只影响同分边缘排序。
 */
export function recencyFactor(pubdateSec: number | undefined, nowMs = Date.now()): number {
  if (!pubdateSec || pubdateSec <= 0) return 1.0
  const ageYears = (nowMs - pubdateSec * 1000) / (365.25 * 24 * 3600 * 1000)
  if (ageYears <= 1) return 1.0
  if (ageYears <= 3) return 1.0 - 0.15 * ((ageYears - 1) / 2)
  return Math.max(0.7, 0.85 - 0.075 * (ageYears - 3))
}

// ==================== 管理 ====================

/** 清空自适应层（与 clearAllMvMatchCache 联动调用）。 */
export function clearAdaptiveModel(): void {
  try {
    localStorage.removeItem(ADAPTIVE_STORE_KEY)
  } catch {
    /* 忽略 */
  }
}

/** 自适应层数据规模（设置页展示/诊断用）。 */
export function getAdaptiveModelStats(): { artists: number; songVariants: number; queryWins: number } {
  const store = readStore()
  return {
    artists: Object.keys(store.artistVocab).length,
    songVariants: Object.keys(store.songVocab).length,
    queryWins: Object.keys(store.queryWins).length,
  }
}
