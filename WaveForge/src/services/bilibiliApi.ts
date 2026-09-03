/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 */
/**
 * 哔哩哔哩「看歌」前端服务层
 *
 * - B 站登录态（localStorage cookie）与用户信息
 * - 后端 /api/bilibili/* 各接口的 TS 包装
 * - 核心：MV 自动匹配引擎（纯函数可单测）——
 *   硬淘汰 + 加权打分（歌名/歌手/官方标记/翻唱教学负向/相对时长/播放量/搜索排名/官方频道/字幕）
 *   + 候选类型分类 + 偏好加权 + 双重自动播放门槛 + 按歌缓存 + 手动选择记忆/黑名单。
 *   低置信绝不硬放（进入候选确认，音频照常播），杜绝"张冠李戴/低质"。
 * - 看歌设置（匹配偏好/自动门槛/视频结束行为/画质/字幕/关键词模板…）
 */

import { recordLogin, clearLoginExpiry, isLoginExpired } from './loginExpiry'
import { Converter } from 'opencc-js/t2cn'

export let BILI_API_BASE = 'http://localhost:3001/api/bilibili'

/** 覆盖 API 基址（测试/调试用；生产固定指向本机后端 3001） */
export function setBilibiliApiBaseForTest(base: string): void {
  BILI_API_BASE = base
}

// ===== 类型 =====

export interface BilibiliVideo {
  bvid: string
  aid?: number
  title: string
  /** 秒 */
  duration: number
  play: number
  danmaku?: number
  author: string
  mid?: number
  pic: string
  typename?: string
}

export interface BilibiliViewData {
  bvid: string
  cid: number
  title: string
  duration: number
  pic: string
  /** 播放量（view 接口 stat.view；手动记住的视频重建时用于信息展示） */
  play?: number
  /** 视频简介 */
  desc?: string
  /** 选集（多 P）信息：部分视频含 on vocal / off vocal 等版本 */
  pages?: Array<{ cid: number; page: number; part: string; duration: number }>
  owner: {
    mid: number
    name: string
    officialVerifyType: number // B 站原始值：-1 未认证/未知，0 个人认证，1 机构认证
  }
}

export interface BilibiliPlayInfo {
  code: number
  quality: number
  acceptQuality: number[]
  vipLimited: boolean
  cacheKey: string
  durlCount: number
  hasDolby?: boolean
  hasFlac?: boolean
  error?: string
}

export interface BilibiliSubtitleInfo {
  lan: string
  lanDoc: string
  /** 0 人工 / 1 AI */
  aiType: number
  cacheKey: string
}

export interface BilibiliSubtitleLine {
  from: number
  to: number
  content: string
}

/** B 站 AI 字幕噪音词：纯音乐/分类标签（如整段只有"♪音乐♪"），非歌词 */
const SUBTITLE_JUNK_WORDS = [
  '音乐', '纯音乐', '背景音乐', 'bgm', 'music',
  '歌词', '字幕', '无人声', '器乐', '伴奏',
  'instrumental', 'inst', '无言', '哼唱', '演唱', '歌唱',
]

/** 判断单行字幕是否为噪音行：剥掉所有符号/标点/空白（♪♫、括号、点号等）后只剩一个噪音词，或整行只有符号 */
function isJunkSubtitleLine(content: string): boolean {
  const raw = String(content || '').trim()
  if (!raw) return true
  const core = raw.replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase()
  if (!core) return true // 全是符号（如只有"♪"）→ 噪音
  return SUBTITLE_JUNK_WORDS.includes(core)
}

/** 清洗字幕行：去掉噪音行；整份字幕全是噪音则返回空（调用方视为无字幕，不显示） */
export function cleanSubtitleLines(lines: BilibiliSubtitleLine[] | undefined | null): BilibiliSubtitleLine[] {
  if (!Array.isArray(lines)) return []
  return lines.filter((l) => {
    const t = String(l?.content || '').trim()
    if (!t) return false
    return !isJunkSubtitleLine(t)
  })
}

export interface BilibiliUser {
  isLogin: boolean
  mid?: number
  uname?: string
  face?: string
  vipType?: number
  level?: number
}

/** 匹配输入：歌曲上下文 */
export interface MatchContext {
  songTitle: string
  artists: string[]
  /** 歌曲时长（秒） */
  songDuration: number
  platform?: string
  id?: string | number
  /** 可选版本目标；音乐平台能识别时用于区分 TV/SEKAI/Vocaloid 等录音 */
  targetVersion?: 'full-original' | 'tv-size' | 'sekai-version' | 'virtual-singer' | 'specific-performance'
  /** 可选作品/IP，用于高碰撞标题和游戏、动画主题曲消歧 */
  franchise?: string
}

export interface CandidateSignals {
  /** 标题含 官方/Official */
  officialMarker: boolean
  /** 标题含 MV/PV */
  mvMarker: boolean
  /** 标题命中负向标记（翻唱/教学/伴奏…） */
  negativeHit: boolean
  /** 标题含歌手 */
  hasArtist: boolean
  /** 相对时长贴近（偏离 ≤20%） */
  nearDuration: boolean
  /** 标题含 4K/1080P/高清/超清/120帧（任意偏好下基础加成） */
  hdMarker: boolean
  /** 作者名=歌手（音乐人官号） */
  uploaderMatchesArtist: boolean
  /** 作者名命中已知官方渠道，或命中当前艺人的官方频道别名 */
  officialChannel: boolean
  /** 复审拿到 B 站 CC 字幕（人工/AI 任一） */
  ccSubtitle: boolean
}

/** 候选类型（偏好加权 + 徽章/筛选用） */
export type CandidateType = 'official' | 'live' | 'cover' | 'instrumental' | 'lyrics' | 'other'

export interface CandidateScore {
  video: BilibiliVideo
  score: number
  signals: CandidateSignals
  /** 搜索返回序号（0 起，作相关度信号） */
  rank: number
  /** 复审拿到的作者认证（B 站原始值）：-1 未认证/未知，0 个人，1 机构 */
  officialVerifyType: number
  manualZhSubtitle: boolean
  autoSubtitle: boolean
  /** CC 字幕与歌词的比对结论（复审/重扫阶段填充；undefined 视同 unverified） */
  ccVerification?: CCVerification
  /** 复审拿到的 cid（供播放地址使用，0 = 未复审） */
  cid?: number
  /** 复审用的评分时长（多 P 视频为选中分 P 时长；重扫需还原同一评分口径） */
  effectiveDuration?: number
  type: CandidateType
}

/** CC 字幕内容与歌词的比对结论：
 * - match     字幕内容与歌词相符（抽样过半命中）→ CC 加分足额
 * - mismatch  字幕可比对但与歌词明显不符（直播切片/无关解说）→ CC 加分变惩罚
 * - unverified 无法验证（歌词缺失/纯音乐/语言体系不通/有效行太少）→ CC 加分大幅缩水 */
export type CCVerification = 'match' | 'mismatch' | 'unverified'

export type BilibiliMatchStatus = 'auto' | 'confirm' | 'none' | 'error'

export interface BilibiliMatchResult {
  status: BilibiliMatchStatus
  /** status==='auto' 时存在 */
  best?: CandidateScore
  /** 候选列表（confirm 态展示，最多 12 条） */
  candidates: CandidateScore[]
  /** 全部排序候选（自动回退链：首选失败时依次尝试，跳过失效/受限/黑名单） */
  fallbackChain: CandidateScore[]
  error?: string
  /** 匹配时有候选拿到 CC 但当时没有歌词可比（结果偏保守）；调用方拿到歌词后可重扫升级 */
  ccUnverifiedWithoutLyrics?: boolean
}

// ===== 看歌设置 =====

export type MatchPreference = 'official' | 'balanced' | 'live' | 'lyrics' | 'hd'
export type AutoPlayStrictness = 'strict' | 'standard' | 'relaxed'
export type VideoEndBehavior = 'next' | 'replay' | 'hold'
export type SubtitlePreference = 'zh-manual' | 'zh-any' | 'any' | 'off'
export type KeywordTemplate = 'auto' | 'title-artist' | 'title-mv' | 'custom'

export interface BilibiliWatchSettings {
  /** 匹配偏好：官方MV / 均衡 / 现场版 / 歌词字幕 / 高清 */
  matchPreference: MatchPreference
  /** 自动播放门槛：严格 / 标准 / 宽松 */
  autoPlayStrictness: AutoPlayStrictness
  /** 视频结束行为：下一首 / 重播 / 停在末帧 */
  videoEndBehavior: VideoEndBehavior
  /** 目标画质（16~127；auto=按登录/VIP 自动选最高可用） */
  targetQuality: 'auto' | 16 | 32 | 64 | 80 | 112 | 116 | 120 | 125 | 126 | 127
  /** 字幕语言偏好 */
  subtitlePreference: SubtitlePreference
  /** 字幕字号（px） */
  subtitleSize: number
  /** 播放中控件自动隐藏 */
  autoHideControls: boolean
  /** 使用记住的手动选择（override） */
  useRememberedOverride: boolean
  /** 搜索关键词模板：auto=按偏好组合 / 固定组合 / 自定义模板 */
  keywordTemplate: KeywordTemplate
  /** 自定义模板占位符：{title} 歌名、{artist} 歌手 */
  customKeywordTemplate: string
  /** 看歌模式默认播放系统赋分最高：开启后即使不是完美匹配也直接播放评分最高的视频（跳过候选确认） */
  forceAutoPlayHighest: boolean
  /** 置信度不足时显示候选预选；关闭时仍自动播放最高置信度视频 */
  showLowConfidenceCandidates: boolean
}

export const WATCH_SETTINGS_EVENT = 'bilibili-settings-changed'
const SETTINGS_KEY = 'bilibili_watch_settings'
const SETTINGS_SCHEMA_KEY = 'bilibili_watch_settings_schema'
const SETTINGS_SCHEMA_VERSION = 3

export const DEFAULT_WATCH_SETTINGS: BilibiliWatchSettings = {
  matchPreference: 'balanced',
  autoPlayStrictness: 'standard',
  videoEndBehavior: 'next',
  targetQuality: 'auto',
  subtitlePreference: 'zh-manual',
  subtitleSize: 18,
  autoHideControls: true,
  useRememberedOverride: true,
  keywordTemplate: 'auto',
  customKeywordTemplate: '{title} {artist} MV',
  forceAutoPlayHighest: false,
  showLowConfidenceCandidates: false,
}

export function getBilibiliWatchSettings(): BilibiliWatchSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return { ...DEFAULT_WATCH_SETTINGS }
    const stored = JSON.parse(raw) as Partial<BilibiliWatchSettings>
    const schemaVersion = Number(localStorage.getItem(SETTINGS_SCHEMA_KEY) || 0)
    if (schemaVersion < SETTINGS_SCHEMA_VERSION) {
      // v1 默认值曾为 true，无法区分用户主动选择与被动持久化；一次性迁移到安全默认。
      stored.forceAutoPlayHighest = false
      stored.showLowConfidenceCandidates = false
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(stored))
      localStorage.setItem(SETTINGS_SCHEMA_KEY, String(SETTINGS_SCHEMA_VERSION))
    }
    return { ...DEFAULT_WATCH_SETTINGS, ...stored }
  } catch {
    return { ...DEFAULT_WATCH_SETTINGS }
  }
}

export function saveBilibiliWatchSettings(patch: Partial<BilibiliWatchSettings>): BilibiliWatchSettings {
  const next = { ...getBilibiliWatchSettings(), ...patch }
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next))
    localStorage.setItem(SETTINGS_SCHEMA_KEY, String(SETTINGS_SCHEMA_VERSION))
  } catch {
    // 忽略存储失败
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(WATCH_SETTINGS_EVENT, { detail: next }))
  return next
}

// ===== 登录态与用户信息 =====

const BILI_COOKIE_KEY = 'bilibili_cookie'
const BILI_USER_KEY = 'bilibili_user'

export function getBilibiliCookie(): string {
  try {
    return localStorage.getItem(BILI_COOKIE_KEY) || ''
  } catch {
    return ''
  }
}

export function saveBilibiliCookie(cookie: string): void {
  try {
    localStorage.setItem(BILI_COOKIE_KEY, cookie)
  } catch {
    // 忽略存储失败
  }
}

export function clearBilibiliLocal(): void {
  try {
    localStorage.removeItem(BILI_COOKIE_KEY)
    localStorage.removeItem(BILI_USER_KEY)
  } catch {
    // 忽略
  }
}

export function isBilibiliLoggedIn(): boolean {
  return Boolean(getBilibiliCookie()) && !isLoginExpired('bilibili' as never)
}

export function saveBilibiliUser(user: BilibiliUser): void {
  try {
    localStorage.setItem(BILI_USER_KEY, JSON.stringify(user))
  } catch {
    // 忽略
  }
}

export function getStoredBilibiliUser(): BilibiliUser | null {
  try {
    const raw = localStorage.getItem(BILI_USER_KEY)
    return raw ? (JSON.parse(raw) as BilibiliUser) : null
  } catch {
    return null
  }
}

export function recordBilibiliLogin(): void {
  recordLogin('bilibili' as never)
}

export function clearBilibiliLoginExpiry(): void {
  clearLoginExpiry('bilibili' as never)
}

/** 剩余登录天数（未记录返回 null） */
export function getBilibiliRemainingDays(): number | null {
  try {
    const raw = localStorage.getItem('wf_login_expiry_bilibili')
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (typeof parsed?.expiresAt !== 'number') return null
    const ms = parsed.expiresAt - Date.now()
    return ms > 0 ? Math.ceil(ms / 86400000) : 0
  } catch {
    return null
  }
}

// ===== 后端接口包装 =====

/** 数据类接口自动携带本地登录 cookie（服务器重启后依赖 localStorage 恢复登录态） */
function appendCookie(url: string): string {
  if (/\/login\/qr\//.test(url) || /\/cookie/.test(url)) return url
  const cookie = getBilibiliCookie()
  if (!cookie) return url
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}cookie=${encodeURIComponent(cookie)}`
}

async function fetchJson<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(appendCookie(url), init)
  if (!res.ok) {
    let message = `HTTP ${res.status}`
    try {
      const body = await res.json()
      message = body?.error || body?.message || message
    } catch {
      // 保持默认消息
    }
    throw new Error(message)
  }
  return (await res.json()) as T
}

/** 不因非 2xx 抛错的 JSON 请求（个人主页登录受限接口：未登录时返回 code:-101 供前端判断） */
async function fetchJsonLoose<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(appendCookie(url), init)
  const text = await res.text()
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`HTTP ${res.status}`)
  }
}

export function searchBilibiliVideos(keyword: string, page = 1, signal?: AbortSignal): Promise<{ code: number; results: BilibiliVideo[] }> {
  return fetchJson(`${BILI_API_BASE}/search?keyword=${encodeURIComponent(keyword)}&page=${page}`, { signal })
}

export function getBilibiliView(bvid: string, signal?: AbortSignal): Promise<{ code: number; data: BilibiliViewData }> {
  return fetchJson(`${BILI_API_BASE}/view?bvid=${encodeURIComponent(bvid)}`, { signal })
}

export function getBilibiliPlayUrl(bvid: string, cid: number, qn = 80, signal?: AbortSignal): Promise<BilibiliPlayInfo> {
  return fetchJson(`${BILI_API_BASE}/playurl?bvid=${encodeURIComponent(bvid)}&cid=${cid}&qn=${qn}`, { signal })
}

export function getBilibiliSubtitles(bvid: string, cid: number, signal?: AbortSignal): Promise<{ code: number; subtitles: BilibiliSubtitleInfo[] }> {
  return fetchJson(`${BILI_API_BASE}/subtitles?bvid=${encodeURIComponent(bvid)}&cid=${cid}`, { signal })
}

export function getBilibiliSubtitleJson(key: string, signal?: AbortSignal): Promise<BilibiliSubtitleLine[]> {
  return fetchJson(`${BILI_API_BASE}/subtitle?key=${encodeURIComponent(key)}`, { signal })
}

// ===== 弹幕 =====

export interface BilibiliDanmakuItem {
  time: number
  /** 1/6 滚动 4 底部 5 顶部 7 高级 */
  mode: number
  fontSize: number
  color: number
  text: string
  /** 自己发送的弹幕：加描边框突出显示 */
  border?: boolean
}

export function getBilibiliDanmaku(cid: number, signal?: AbortSignal): Promise<{ code: number; danmaku: BilibiliDanmakuItem[] }> {
  // fetchJsonLoose：弹幕非阻塞，服务端 502/风控时不抛异常，交由调用方静默降级
  return fetchJsonLoose(`${BILI_API_BASE}/danmaku?cid=${cid}`, { signal })
}

// ===== B 站交互（发弹幕/评论/投币/点赞/收藏，需 B 站登录 cookie） =====

/** 发送弹幕（同步 B 站）。progress 为视频内秒数，服务端转毫秒 */
export function sendBilibiliDanmaku(opts: {
  cid: number
  bvid?: string
  aid?: string | number
  msg: string
  progress: number
  color?: number
  fontsize?: number
  mode?: number
}): Promise<{ code: number; message?: string; data?: unknown }> {
  const cookie = getBilibiliCookie()
  return fetchJson(`${BILI_API_BASE}/danmaku`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...opts,
      cookie,
      progress: Math.max(0, Math.round((opts.progress || 0) * 1000)),
    }),
  })
}

export interface BilibiliComment {
  rpid: number
  mid: number
  root: number
  parent: number
  count: number
  rcount: number
  like: number
  /** 1 = 当前用户已点赞 */
  action?: number
  ctime: number
  /** B 站返回的正文在 content.message（嵌套结构） */
  content?: { message?: string; members?: unknown[] }
  member?: {
    uname?: string
    avatar?: string
    level_info?: { current_level?: number }
    sex?: string
    sign?: string
  }
  reply?: { count: number }
  replies?: BilibiliComment[]
  /** 是否本人评论（本地比对 mid 后标记） */
  isMine?: boolean
  /** 归一化后的评论正文（content.message 兜底 message） */
  message?: string
}

/** 评论列表（type=1 视频，按热度分页） */
export function getBilibiliComments(aid: string | number, pn = 1, signal?: AbortSignal): Promise<{
  code: number
  replies?: BilibiliComment[]
  cursor?: unknown
}> {
  return fetchJson(`${BILI_API_BASE}/comments?aid=${encodeURIComponent(String(aid))}&pn=${pn}`, { signal })
}

/** 某条评论的回复 */
export function getBilibiliCommentReplies(aid: string | number, rpid: string | number, pn = 1, signal?: AbortSignal): Promise<{
  code: number
  replies?: BilibiliComment[]
}> {
  return fetchJson(`${BILI_API_BASE}/comment/replies?aid=${encodeURIComponent(String(aid))}&rpid=${encodeURIComponent(String(rpid))}&pn=${pn}`, { signal })
}

/** 发评论 / 回复（root+parent 存在即为回复） */
export function postBilibiliComment(opts: {
  aid: string | number
  message: string
  root?: string | number
  parent?: string | number
}): Promise<{ code: number; message?: string; data?: unknown }> {
  const cookie = getBilibiliCookie()
  return fetchJson(`${BILI_API_BASE}/comment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...opts, cookie }),
  })
}

/** 删除评论（需为本人） */
export function deleteBilibiliComment(aid: string | number, rpid: string | number): Promise<{ code: number; message?: string }> {
  const cookie = getBilibiliCookie()
  return fetchJson(`${BILI_API_BASE}/comment/del`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ aid, rpid, cookie }),
  })
}

/** 评论点赞/取消（action 1 点赞 2 取消） */
export function likeBilibiliComment(aid: string | number, rpid: string | number, action: 1 | 2 = 1): Promise<{ code: number; message?: string }> {
  const cookie = getBilibiliCookie()
  return fetchJson(`${BILI_API_BASE}/comment/like`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ aid, rpid, action, cookie }),
  })
}

/** 投币（multiply 1/2，selectLike 1=同时点赞） */
export function coinBilibiliVideo(aid: string | number, multiply = 1, selectLike = 0): Promise<{ code: number; message?: string; data?: unknown }> {
  const cookie = getBilibiliCookie()
  return fetchJson(`${BILI_API_BASE}/coin`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ aid, multiply, selectLike, cookie }),
  })
}

/** 视频点赞/取消（like 1 点赞 2 取消） */
export function likeBilibiliVideo(aid: string | number, like: 1 | 2 = 1): Promise<{ code: number; message?: string }> {
  const cookie = getBilibiliCookie()
  return fetchJson(`${BILI_API_BASE}/like`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ aid, like, cookie }),
  })
}

/** 收藏/取消收藏（addMediaIds 添加进收藏夹，delMediaIds 取消） */
export function favBilibiliVideo(aid: string | number, opts: { addMediaIds?: string | number; delMediaIds?: string | number } = {}): Promise<{ code: number; message?: string; data?: unknown }> {
  const cookie = getBilibiliCookie()
  return fetchJson(`${BILI_API_BASE}/fav`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ aid, ...opts, cookie }),
  })
}

export interface BilibiliInteractionState {
  isLike: number
  coin: number
  todayCoins: number
  favoured: number
  favFolders: Array<{ id: number; name: string }>
}

/** 交互状态汇总：点赞态/投币数/今日剩余硬币/收藏态/收藏夹列表 */
export function getBilibiliInteraction(aid: string | number, signal?: AbortSignal): Promise<{ code: number; data?: BilibiliInteractionState }> {
  return fetchJson(`${BILI_API_BASE}/interaction?aid=${encodeURIComponent(String(aid))}`, { signal })
}

/** 弹幕设置（参考 B 站网页版：不透明度/字号/显示区域/同屏数/速度/滚动方式/屏蔽词） */
export interface DanmakuSettings {
  enabled: boolean
  /** 不透明度 0-100 */
  opacity: number
  /** 字号基准（px，按画布宽度等比缩放） */
  fontSize: number
  /** 显示区域占视频高度百分比 0-100 */
  displayArea: number
  /** 同屏弹幕上限 */
  maxOnScreen: number
  /** 滚动速度倍率 0.5-2 */
  speed: number
  /** 显示滚动弹幕 */
  showScroll: boolean
  /** 显示顶部弹幕 */
  showTop: boolean
  /** 显示底部弹幕 */
  showBottom: boolean
  /** 屏蔽关键词（逗号/空格分隔） */
  shieldKeywords: string
}

export const DEFAULT_DANMAKU_SETTINGS: DanmakuSettings = {
  enabled: true,
  opacity: 80,
  fontSize: 22,
  displayArea: 40,
  maxOnScreen: 50,
  speed: 1,
  showScroll: true,
  showTop: true,
  showBottom: true,
  shieldKeywords: '',
}

const DANMAKU_SETTINGS_KEY = 'bilibili_danmaku_settings'
export const DANMAKU_SETTINGS_EVENT = 'bilibili-danmaku-settings-changed'

export function getDanmakuSettings(): DanmakuSettings {
  try {
    const raw = localStorage.getItem(DANMAKU_SETTINGS_KEY)
    if (!raw) return { ...DEFAULT_DANMAKU_SETTINGS }
    return { ...DEFAULT_DANMAKU_SETTINGS, ...(JSON.parse(raw) as Partial<DanmakuSettings>) }
  } catch {
    return { ...DEFAULT_DANMAKU_SETTINGS }
  }
}

export function saveDanmakuSettings(patch: Partial<DanmakuSettings>): DanmakuSettings {
  const next = { ...getDanmakuSettings(), ...patch }
  try {
    localStorage.setItem(DANMAKU_SETTINGS_KEY, JSON.stringify(next))
  } catch {
    // 忽略存储失败
  }
  window.dispatchEvent(new CustomEvent(DANMAKU_SETTINGS_EVENT, { detail: next }))
  return next
}

export function generateBilibiliQr(): Promise<{ code: number; url: string; qrcodeKey: string }> {
  return fetchJson(`${BILI_API_BASE}/login/qr/generate`)
}

export function checkBilibiliQr(key: string): Promise<{ code: number; status: 'ok' | 'pending' | 'scanned' | 'expired' | 'unknown'; cookie?: string }> {
  return fetchJson(`${BILI_API_BASE}/login/qr/check?key=${encodeURIComponent(key)}`)
}

export function setBilibiliServerCookie(cookie: string): Promise<{ code: number; ok: boolean }> {
  return fetchJson(`${BILI_API_BASE}/cookie`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cookie }),
  })
}

export function logoutBilibiliServer(): Promise<{ code: number; ok: boolean }> {
  return fetchJson(`${BILI_API_BASE}/cookie`, { method: 'DELETE' })
}

export function getBilibiliUser(signal?: AbortSignal): Promise<BilibiliUser> {
  return fetchJson(`${BILI_API_BASE}/user`, { signal })
}

// ===== B 站个人主页 =====

export interface BilibiliSpaceUser {
  mid: number
  name: string
  face: string
  sign: string
  level: number
  vipType: number
  fans: number
  attention: number
  likes: number
  /** B 站原始认证值：-1 未认证/未知，0 个人认证，1 机构认证 */
  officialVerify: number
  /** 个人主页皮肤横幅（部分用户设置） */
  topPhoto?: string
}

export interface BilibiliSpaceVideo extends BilibiliVideo {
  pubdate?: number
}

export interface BilibiliFavFolder {
  id: number
  title: string
  mediaCount: number
  cover: string
}

export interface BilibiliHistoryItem extends BilibiliVideo {
  progress?: number
  viewAt?: number
}

export interface BilibiliFollowUser {
  mid: number
  uname: string
  face: string
  sign?: string
}

export interface BilibiliListData<T> {
  list: T[]
  total?: number
  folderTitle?: string
  /** 历史 cursor 分页游标（B 站 history/cursor 不认 pn，翻页用 max/view_at） */
  cursor?: { max?: number; viewAt?: number } | null
  /** 是否还有下一页 */
  hasMore?: boolean
}

export function getBilibiliSpaceAcc(mid: number, signal?: AbortSignal): Promise<{ code: number; data: BilibiliSpaceUser }> {
  return fetchJson(`${BILI_API_BASE}/space/acc?mid=${mid}`, { signal })
}

export function getBilibiliSpaceVideos(mid: number, pn = 1, ps = 10, signal?: AbortSignal): Promise<{ code: number; data: BilibiliListData<BilibiliSpaceVideo> }> {
  return fetchJson(`${BILI_API_BASE}/space/videos?mid=${mid}&pn=${pn}&ps=${ps}`, { signal })
}

export function getBilibiliFavFolders(mid: number, signal?: AbortSignal): Promise<{ code: number; data: { list: BilibiliFavFolder[] } }> {
  return fetchJsonLoose(`${BILI_API_BASE}/fav/folders?mid=${mid}`, { signal })
}

export function getBilibiliFavList(mediaId: number, pn = 1, ps = 10, signal?: AbortSignal): Promise<{ code: number; data: BilibiliListData<BilibiliSpaceVideo> }> {
  return fetchJsonLoose(`${BILI_API_BASE}/fav/list?mediaId=${mediaId}&pn=${pn}&ps=${ps}`, { signal })
}

export function getBilibiliHistory(cursor?: { max?: number; viewAt?: number } | null, ps = 15, signal?: AbortSignal): Promise<{ code: number; data: BilibiliListData<BilibiliHistoryItem> }> {
  const params = new URLSearchParams({ ps: String(ps) })
  if (cursor?.max) params.set('max', String(cursor.max))
  if (cursor?.viewAt) params.set('viewAt', String(cursor.viewAt))
  return fetchJsonLoose(`${BILI_API_BASE}/history?${params.toString()}`, { signal })
}

export function getBilibiliFollowings(mid: number, pn = 1, ps = 12, signal?: AbortSignal): Promise<{ code: number; data: { list: BilibiliFollowUser[]; total: number } }> {
  return fetchJsonLoose(`${BILI_API_BASE}/followings?mid=${mid}&pn=${pn}&ps=${ps}`, { signal })
}

/** 播放流地址（经后端代理，带 Range 支持 seek）；type=video|audio（DASH 音画分离） */
export function bilibiliStreamUrl(cacheKey: string, type: 'video' | 'audio' = 'video'): string {
  return `${BILI_API_BASE}/stream?key=${encodeURIComponent(cacheKey)}&type=${type}`
}

export const QUALITY_LABELS: Record<number, string> = {
  16: '360P',
  32: '480P',
  64: '720P',
  80: '1080P',
  112: '1080P+',
  116: '1080P60',
  120: '4K',
  125: 'HDR 真彩',
  126: '杜比视界',
  127: '杜比音效',
}

/** 画质分档标签 + 是否会员专享 */
export const QUALITY_TIERS: Array<{ qn: number; label: string; requiresVip?: boolean }> = [
  { qn: 127, label: '杜比音效', requiresVip: true },
  { qn: 126, label: '杜比视界', requiresVip: true },
  { qn: 125, label: 'HDR 真彩', requiresVip: true },
  { qn: 120, label: '4K 超高清', requiresVip: true },
  { qn: 116, label: '1080P 60帧' },
  { qn: 112, label: '1080P 高码率', requiresVip: true },
  { qn: 80, label: '1080P 高清' },
  { qn: 64, label: '720P 准高清' },
  { qn: 32, label: '480P 标清' },
  { qn: 16, label: '360P 流畅' },
]

export function qualityLabel(quality: number): string {
  return QUALITY_LABELS[quality] || `${quality}P`
}

/** 按字幕偏好挑选：人工中文 > 中文(含AI) > 人工任意 > 首条；off 返回 null */
export function pickBestSubtitle(subtitles: BilibiliSubtitleInfo[], preference: SubtitlePreference = 'zh-manual'): BilibiliSubtitleInfo | null {
  if (!subtitles.length || preference === 'off') return null
  const isZh = (s: BilibiliSubtitleInfo) => /zh|中文/i.test(`${s.lan}${s.lanDoc}`)
  if (preference === 'zh-manual') {
    return subtitles.find((s) => s.aiType === 0 && isZh(s)) ||
      subtitles.find((s) => isZh(s)) ||
      subtitles.find((s) => s.aiType === 0) ||
      subtitles[0] ||
      null
  }
  if (preference === 'zh-any') {
    return subtitles.find((s) => isZh(s)) || subtitles[0] || null
  }
  // 'any'
  return subtitles[0] || null
}

export function formatBiliTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${String(secs).padStart(2, '0')}`
}

/** B 站图片 URL 归一化：协议相对（//）补 https，http 升级 https */
export function resolveBiliPic(url: string): string {
  if (!url) return ''
  if (url.startsWith('//')) return `https:${url}`
  if (url.startsWith('http://')) return `https://${url.slice(7)}`
  return url
}

// ===== 匹配引擎 =====

/** 繁转简转换器（B 站官方 MV 标题常用繁体，平台歌名是简体，匹配前统一） */
const twToCn = Converter({ from: 'tw', to: 'cn' })
const hkToCn = Converter({ from: 'hk', to: 'cn' })

/** 文本规范化：繁转简、全角转半角、去空白与标点、小写 */
export function normalizeText(input: string): string {
  const half = String(input || '')
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
  const simplified = twToCn(hkToCn(half))
  return simplified
    .toLowerCase()
    // 含半角句号 ｡（U+FF61）：QQ 音乐等平台的日文歌手名常用「｡」收尾
    .replace(/[（()）\[\]【】《》<>{}"''“”·…!！?？,，.。｡;；:：\-—_/\\|&*^%$#@~`+=]/g, '')
    .replace(/\s+/g, '')
}

/** 清洗歌名：剥离括号后缀（如（Live）/（伴奏）/ (remix)），保留主体 */
export function cleanSongTitle(title: string): string {
  let cleaned = String(title || '').trim()
  cleaned = cleaned.replace(/[（(][^（）()]*[）)]\s*$/, '').trim()
  return cleaned
}

const OFFICIAL_MARKERS = ['官方', 'official']
const MV_MARKERS = ['mv', 'pv', '音乐录影带']
const NEGATIVE_MARKERS = [
  '翻唱', 'cover', '教学', '教程', '讲解', '指弹', '演奏', '钢琴', '吉他', '翻弹',
  '笛子', '古筝', '二胡', '萨克斯', '伴奏', 'remix', '鬼畜', '修复', '卡拉ok', 'k歌',
  '鼓谱', '架子鼓', '弹唱', '跟练', '扒谱', '练唱', '音游', '手元', '谱面', '全连', 'gameplay',
  '学日语', '学唱歌', '听歌学', '纯人声', '消音', '伴唱消除', '红石音乐', '歌ってみた', '歌ってみました',
  'guitar', 'piano', 'fingerstyle', 'drum', 'violin', 'cello', 'bass', '贝斯', 'flute', 'sax', 'saxophone',
  'instrumental', 'karaoke', 'playthrough', 'trumpet', 'trombone', 'harmonica', 'bassboost',
  '舞蹈', '跳舞', '翻跳', '踊ってみた', 'dance cover',
  '两三键', 'sky studio', '新手进阶', '教你', '学唱', '零基础', '一学就会', '入门教程', '简谱教程',
]
/** 花絮、玩法和解说等相关视频不是目标录音，不能靠标题与播放量进入高置信区。 */
const NON_MUSIC_CONTENT_MARKERS = [
  '花絮', '幕后', '制作特辑', '创作故事', '访谈', '采访', 'reaction', '反应',
  '玩法预告', '实机预告', '游戏预告', '宣传片', '探险指南', '攻略', '任务线', '剧情解析', '武器展示',
  'adventure guide', 'gameplay trailer', 'weapon showcase', 'behind the scenes', 'making of',
]
const ALTERNATE_VERSION_MARKERS = [
  'acoustic', 'unplugged', 'stripped', 'one take', 'singthrough', 'first take',
  'remix', '重混音', '混音版', 'arrange', '现场', '演唱会', '演出', 'live版', 'colorful live', 'magical mirai', '魔法未来', '歌ってみた', '翻唱',
]
const DERIVED_EXTENDED_MARKERS = ['加长', '延长', 'extended', 'loop', '循环', '完整版自制', '民间完整版']
/** 合集/盘点类标题：包含多首歌，通常不是单曲正片 */
const COMPILATION_MARKERS = ['合集', '串烧', '盘点', '榜单', '精选歌', '歌单', '经典歌曲', '怀旧金曲', 'top50', 'top10', '100首', '50首']
const POSITIVE_EXTRA_MARKERS = ['歌词', '字幕', '4k', '1080p', '正式版', '中字', '高清', '超清']
/** 正片增强标记：动漫/剧集主题曲 MV、加长版、完整版更可能是完整正片（用户反馈红莲华场景） */
const POSITIVE_SONG_MARKERS = ['主题曲', '主題曲', '主题歌', '主題歌', 'テーマソング', '加长版', '加長版', '完整版']
const LIVE_MARKERS = ['live', '现场', '演唱会', 'livehouse', '音乐节', 'live版', 'the first take', 'first take', '一発撮り', 'ファーストテイク']
/** 乐器/曲谱类标题（演奏向，多为翻弹/教学，非正片） */
const INSTRUMENT_MARKERS = [
  '钢琴', '吉他', '指弹', '演奏', '笛子', '古筝', '二胡', '萨克斯', '伴奏', '鼓谱', '架子鼓', '扒谱',
  '琴谱', '乐谱', '简谱', '口琴', '尤克里里', 'ukulele', '小提琴', '大提琴', '长笛', '琵琶', '古琴', '箫', '笛',
  '吉他谱', '钢琴谱', '铃铛', '竖琴', '扬琴', '手风琴',
  'guitar', 'piano', 'fingerstyle', 'drum', 'violin', 'cello', 'bass', '贝斯', 'flute', 'sax', 'saxophone',
  'instrumental', 'karaoke', 'playthrough', 'trumpet', 'trombone', 'harmonica',
]

/**
 * 常用歌手名变体（中文 ↔ 日文假名/原文 等）。B 站标题两种写法都常见，
 * 多元查询时额外尝试别名，提升召回。覆盖常见日音/华语艺人。
 */
const ARTIST_ALIASES: Record<string, string[]> = {
  宇多田光: ['宇多田ヒカル', 'Utada', 'Hikaru Utada', 'Utada Hikaru'],
  宇多田ヒカル: ['宇多田光', 'Utada', 'Hikaru Utada', 'Utada Hikaru'],
  // Utada 与 宇多田光 是同一歌手的两个账户（英文名/中文名）：互认命中官号提分，避免只认其中一个漏掉官方 MV
  Utada: ['宇多田光', '宇多田ヒカル', 'Hikaru Utada', 'Utada Hikaru'],
  'Hikaru Utada': ['宇多田光', '宇多田ヒカル', 'Utada'],
  'Utada Hikaru': ['宇多田光', '宇多田ヒカル', 'Utada'],
  米津玄師: ['米津玄师', '米津玄師'],
  米津玄师: ['米津玄師'],
  中島美嘉: ['中岛美嘉', '中島美嘉'],
  中岛美嘉: ['中島美嘉'],
  滨崎步: ['浜崎あゆみ', '滨崎步'],
  浜崎あゆみ: ['滨崎步'],
  中島美雪: ['中岛美雪', '中島みゆき'],
  中岛美雪: ['中島みゆき'],
  中島みゆき: ['中岛美雪'],
  五輪真弓: ['五轮真弓'],
  五轮真弓: ['五輪真弓'],
  山口百恵: ['山口百惠'],
  山口百惠: ['山口百恵'],
  澤野弘之: ['泽野弘之', '澤野弘之', 'SawanoHiroyuki', 'sawanohiroyuki'],
  泽野弘之: ['澤野弘之', 'SawanoHiroyuki', 'sawanohiroyuki'],
  'SawanoHiroyuki[nZk]': ['泽野弘之', '澤野弘之', 'SawanoHiroyuki', 'sawanohiroyuki', '泽野弘之nZk'],
  SawanoHiroyuki: ['泽野弘之', '澤野弘之', 'SawanoHiroyuki[nZk]'],
  久石譲: ['久石让'],
  久石让: ['久石譲'],
  坂本龍一: ['坂本龙一'],
  坂本龙一: ['坂本龍一'],
  手嶌葵: ['手嶌葵', '手岛葵'],
  手岛葵: ['手嶌葵'],
  西野カナ: ['西野加奈'],
  西野加奈: ['西野カナ'],
  きゃりーぱみゅぱみゅ: ['凯莉葩缪葩缪'],
  少女時代: ['少女时代'],
  少女时代: ['少女時代'],
  ビッグバン: ['BIGBANG'],
  BIGBANG: ['ビッグバン'],
  防弹少年团: ['BTS', '방탄소년단'],
  BTS: ['防弹少年团', '방탄소년단'],
  黒猫チェルシー: [],
  // ずっと真夜中でいいのに（ZUTOMAYO）：官方 MV 标题/频道常用英文名与中文名，而平台歌手字段是日文名，
  // 跨书写系统必须走别名，否则官方正片在标题与 UP 主上都认不出歌手（详见 test/bilibiliMatch.test.ts 跨脚本用例）
  'ずっと真夜中でいいのに': ['ZUTOMAYO', '永远是深夜有多好', '永遠是深夜有多好'],
  'ずっと真夜中でいいのに。': ['ZUTOMAYO', '永远是深夜有多好', '永遠是深夜有多好'],
  ZUTOMAYO: ['ずっと真夜中でいいのに', '永远是深夜有多好', '永遠是深夜有多好'],
  永远是深夜有多好: ['ずっと真夜中でいいのに', 'ZUTOMAYO'],
  永遠是深夜有多好: ['ずっと真夜中でいいのに', 'ZUTOMAYO'],
  ヨアソビ: ['YOASOBI'],
  YOASOBI: ['ヨアソビ'],
  藤井風: ['藤井风', 'Fujii Kaze'],
  藤井风: ['藤井風', 'Fujii Kaze'],
  'Fujii Kaze': ['藤井風', '藤井风'],
  星野源: ['Hoshino Gen'],
  'Hoshino Gen': ['星野源'],
  あいみょん: ['Aimyon', '爱缪'],
  Aimyon: ['あいみょん', '爱缪'],
  爱缪: ['あいみょん', 'Aimyon'],
  ヨルシカ: ['Yorushika'],
  Yorushika: ['ヨルシカ'],
  Ado: ['アド'],
  アド: ['Ado'],
  優里: ['Yuuri'],
  Yuuri: ['優里'],
  // Project SEKAI（pjsk）五个乐队：平台可能用日文名/英文名/简称，B 站标题常见英文或日文写法
  'Leo/need': ['レオニード', 'LeoNeed', 'Leo need'],
  レオニード: ['Leo/need', 'LeoNeed'],
  'MORE MORE JUMP!': ['モアモアジャンプ', 'MMJ', 'MORE MORE JUMP'],
  モアモアジャンプ: ['MORE MORE JUMP!', 'MMJ'],
  'Vivid BAD SQUAD': ['ビビッドバッドスクワッド', 'VBS'],
  ビビッドバッドスクワッド: ['Vivid BAD SQUAD', 'VBS'],
  'Wonderlands×Showtime': ['ワンダーランズ×ショウタイム', 'WxS', 'Wonderlands Showtime', 'ワンダショ'],
  'ワンダーランズ×ショウタイム': ['Wonderlands×Showtime', 'WxS', 'ワンダショ'],
  '25時、ナイトコードで。': ['25時、Nightcordで。', 'Nightcord at 25:00', 'ニーゴ', '25时、ナイトコードで'],
  '25時、Nightcordで。': ['25時、ナイトコードで。', 'ニーゴ', '25时'],
  'Nightcord at 25:00': ['25時、ナイトコードで。', 'ニーゴ', '25时'],
  'プロジェクトセカイ': ['Project SEKAI', '世界计划', 'pjsk', '世界計畫'],
  'Project SEKAI': ['プロジェクトセカイ', '世界计划', 'pjsk', '世界計畫'],
  世界计划: ['プロジェクトセカイ', 'Project SEKAI', 'pjsk'],
  'VALORANT Music': ['VALORANT', '无畏契约', '拳头游戏音乐', 'Riot Games', '拳头游戏'],
  VALORANT: ['VALORANT Music', '无畏契约', '拳头游戏音乐', 'Riot Games', '拳头游戏'],
}

export interface ResolvedArtistNames {
  raw: string[]
  normalized: string[]
  aliases: string[]
}

/** 统一解析平台歌手字段及别名，供搜索、标题和上传者证据共用。 */
export function resolveArtistNames(artists: string[]): ResolvedArtistNames {
  const raw: string[] = []
  const normalized: string[] = []
  const aliases: string[] = []
  const pushUnique = (list: string[], value: string): void => {
    if (value && !list.includes(value)) list.push(value)
  }
  const pushAlias = (value: string): void => {
    const norm = normalizeText(value)
    if (norm.length >= 2) pushUnique(aliases, norm)
  }

  for (const artist of artists || []) {
    for (const name of expandArtistNames(String(artist))) {
      pushUnique(raw, name)
      const norm = normalizeText(name)
      if (norm.length >= 2) pushUnique(normalized, norm)
      for (const key of [name, norm]) {
        for (const alias of ARTIST_ALIASES[key] || []) pushAlias(alias)
      }
    }
  }
  return { raw, normalized, aliases }
}

export type ExactTitleMatch = 'none' | 'title-only' | 'artist-title'

/** 识别低噪声标题；分隔符必须从原始标题解析，不能在 normalizeText 后判断。 */
export function classifyExactTitleMatch(title: string, songTitle: string, artistNames: ResolvedArtistNames): ExactTitleMatch {
  const songNorm = normalizeText(cleanSongTitle(songTitle))
  const cleaned = String(title || '').replace(/^(?:【[^】]*】\s*)+/, '').trim()
  if (normalizeText(cleaned) === songNorm) return 'title-only'
  const parts = cleaned.split(/\s*[-–—:：]\s*/).map((part) => normalizeText(part)).filter(Boolean)
  if (parts.length !== 2) return 'none'
  const names = [...artistNames.normalized, ...artistNames.aliases]
  const isArtist = (value: string) => names.some((name) => value === name)
  if ((isArtist(parts[0]) && parts[1] === songNorm) || (parts[0] === songNorm && isArtist(parts[1]))) return 'artist-title'
  return 'none'
}

/** 播放量是质量先验而非正确性证明：按数量级递减增长，并在超高播放处封顶。 */
export function playCountScore(play: unknown): number {
  const value = Number(play)
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.min(90, Math.log10(value) * 13)
}

function uploaderMatchesName(authorNorm: string, name: string): boolean {
  if (!name) return false
  if (authorNorm === name) return true
  return [`${name}官方`, `${name}official`, `${name}channel`, `${name}频道`].some((value) => authorNorm === value)
}

/** B 站认证原始值：0 个人认证，1 机构认证。 */
export function verificationScore(type: number): number {
  if (type === 1) return 30
  if (type === 0) return 15
  return 0
}

/** 稳定排序：综合分相同时，优先可靠来源、播放量、原搜索顺序。 */
export function compareCandidates(a: CandidateScore, b: CandidateScore): number {
  const aScore = Number.isNaN(a.score) ? -Infinity : a.score
  const bScore = Number.isNaN(b.score) ? -Infinity : b.score
  if (aScore !== bScore) return aScore < bScore ? 1 : -1
  const aSource = (a.signals.officialChannel ? 3 : 0) + (a.officialVerifyType === 1 ? 2 : a.officialVerifyType === 0 ? 1 : 0) + (a.signals.uploaderMatchesArtist ? 1 : 0)
  const bSource = (b.signals.officialChannel ? 3 : 0) + (b.officialVerifyType === 1 ? 2 : b.officialVerifyType === 0 ? 1 : 0) + (b.signals.uploaderMatchesArtist ? 1 : 0)
  if (aSource !== bSource) return bSource - aSource
  const aPlay = Number.isFinite(a.video.play) ? a.video.play : 0
  const bPlay = Number.isFinite(b.video.play) ? b.video.play : 0
  if (aPlay !== bPlay) return bPlay - aPlay
  if (a.rank !== b.rank) return a.rank - b.rank
  return a.video.bvid.localeCompare(b.video.bvid)
}

/**
 * 自动拆解歌手名（跨平台适配）：
 * - 多歌手分隔：feat/ft、&、,，、、；等 → 拆成多个歌手名
 * - 括号中文/英文翻译：如「ずっと真夜中でいいのに。 (永远是深夜有多好｡)」→ 同时产出
 *   原串与去括号主体（两者都是候选，匹配标题/UP主/搜索词时任一命中即算）
 * 覆盖网易云/QQ音乐/酷狗等平台对同一艺人返回不同字段格式的情况。
 * 注意：不做「/」切分——Leo/need 等乐队名自带斜杠，误切会破坏完整乐队名。
 */
export function expandArtistNames(raw: string): string[] {
  const result: string[] = []
  const full = String(raw || '').trim()
  if (!full) return result
  // 完整串保留为第一个元素（有的歌手名本身含 "/" 如组合名，不能拆没），
  // 同时按常见分隔拆分多人合唱（xx/xx/xx/xx → 几个歌手一起唱）
  result.push(full)
  // 完整串也生成去括号变体：B 站搜索把 "(K)NoW_NAME" 这类带括号的查询当分组语法，
  // 直接 0 结果（实测 rainy tone (K)NoW_NAME → 0，rainy tone NoW_NAME → 20 条含正主）
  const fullNoParen = full.replace(/[（(][^（）()]*[）)]/g, '').trim()
  if (fullNoParen && fullNoParen !== full && !result.includes(fullNoParen)) result.push(fullNoParen)
  // 保留带斜杠的正式艺人名（Leo/need、AC/DC）；只有斜杠两侧有空格时才视作多人分隔。
  const segments = full.split(/\s+(?:feat(?:uring)?|ft)\.?\s+|\s*&\s*|,|，|、|;|；|\||\s+\/\s+/gi)
  for (const seg of segments) {
    const trimmed = seg.trim()
    if (!trimmed || trimmed === full) continue
    result.push(trimmed)
    // 去括号翻译变体（保留原串；若括号内才是主体，原串命中也不受影响）
    const noParen = trimmed.replace(/[（(][^（）()]*[）)]/g, '').trim()
    if (noParen && noParen !== trimmed) result.push(noParen)
  }
  return result
}

/** 官方/唱片公司频道关键词（作者名命中即视为官方来源强信号） */
const OFFICIAL_CHANNEL_KEYWORDS = [
  '杰威尔', '索尼音乐', 'sonymusic', '环球音乐', 'universalmusic', '华纳音乐', 'warnermusic',
  '滚石', '相信音乐', '福茂', '华研', 'avex', '艾回', '太合', '摩登天空', '网易云音乐',
  'qq音乐', 'jvr',
]

/** 精品社区/资讯站频道（非官方但内容质量稳定：翻译组、游戏资讯站等），加分低于官方 */
const QUALITY_COMMUNITY_KEYWORDS = [
  '汉化组', '字幕组', 'Project_SEKAI资讯站', 'pjsk', 'sekaiofficial',
]

interface ScopedOfficialSource {
  mid: number
  scopes?: string[]
}

/** 经真实账号页核验的稳定 MID。带 scopes 的来源只对相关艺人/IP 生效。 */
const VERIFIED_OFFICIAL_SOURCES: ScopedOfficialSource[] = [
  { mid: 486906719 },
  { mid: 669334488 },
  { mid: 147546636, scopes: ['valorant', '无畏契约'] },
  { mid: 2135890650, scopes: ['valorant', '无畏契约', 'riotgames', '拳头游戏'] },
  { mid: 27534330, scopes: ['崩坏3', 'honkaiimpact'] },
  { mid: 1636034895, scopes: ['绝区零', 'zenlesszonezero'] },
  { mid: 161775300, scopes: ['明日方舟', 'arknights'] },
  { mid: 349984754, scopes: ['永劫无间', 'naraka'] },
  { mid: 108532523, scopes: ['英雄联盟', 'leagueoflegends'] },
  { mid: 177291194, scopes: ['deco27'] },
  { mid: 203655966, scopes: ['ピノキオピー', 'pinocchiop'] },
  { mid: 26040194, scopes: ['稲葉曇', 'inabakumori'] },
  { mid: 400813602, scopes: ['yoasobi', 'ayase'] },
]

function matchesVerifiedOfficialSource(video: BilibiliVideo, ctx: MatchContext, artists: ResolvedArtistNames): boolean {
  if (!video.mid) return false
  const source = VERIFIED_OFFICIAL_SOURCES.find((entry) => entry.mid === video.mid)
  if (!source) return false
  if (!source.scopes?.length) return true
  const context = normalizeText([ctx.franchise || '', ...artists.raw, ...artists.aliases].join(' '))
  return source.scopes.some((scope) => context.includes(normalizeText(scope)))
}

export function hasLiveMarker(title: string): boolean {
  const raw = String(title || '')
  const normalized = normalizeText(raw)
  return /(^|[^a-z])live([^a-z]|$)/i.test(raw)
    || LIVE_MARKERS.filter((marker) => marker !== 'live').some((marker) => normalized.includes(normalizeText(marker)))
}

const FRANCHISE_ALIASES: Record<string, string[]> = {
  valorant: ['无畏契约', '瓦罗兰特'],
  'leagueoflegends': ['英雄联盟', 'lol'],
  'genshinimpact': ['原神'],
  'honkaiimpact3rd': ['崩坏3'],
  'honkai:starrail': ['崩坏星穹铁道', '星穹铁道'],
  'zenlesszonezero': ['绝区零'],
  arknights: ['明日方舟'],
  'wutheringwaves': ['鸣潮'],
  naraka: ['永劫无间'],
  'nier:automata': ['尼尔机械纪元', '尼尔自动人形', '2b'],
  'eldenring': ['艾尔登法环'],
  'finalfantasyxiv': ['最终幻想14', 'ff14'],
  'persona5': ['女神异闻录5', 'p5'],
  'cowboybebop': ['星际牛仔'],
  'projectsekai': ['世界计划', 'プロジェクトセカイ', 'pjsk'],
}

function resolveFranchiseNames(franchise?: string): string[] {
  const raw = String(franchise || '').trim()
  if (!raw) return []
  const key = normalizeText(raw)
  return [raw, ...(FRANCHISE_ALIASES[key] || [])]
}

/** 候选类型识别（标题标记驱动） */
export function classifyCandidateType(title: string): CandidateType {
  const t = normalizeText(title)
  if (INSTRUMENT_MARKERS.some((m) => t.includes(m))) return 'instrumental'
  if (/翻唱|cover|弹唱|歌ってみた/.test(t)) return 'cover'
  if (hasLiveMarker(title)) return 'live'
  if (OFFICIAL_MARKERS.some((m) => t.includes(m)) || MV_MARKERS.some((m) => t.includes(m))) return 'official'
  if (/歌词|字幕/.test(t)) return 'lyrics'
  return 'other'
}

// ===== CC 字幕 ↔ 歌词内容比对 =====
// 背景（用户实测 Starboy →「一滴泪」直播切片）：人工 CC 字幕 +25 会把"标题完美但内容无关"
// 的视频推上最佳（245 分）。CC 字幕必须验证内容是否真是这首歌，才能决定给足额加分、缩水还是惩罚。

/** 歌词/字幕里的制作人员信息行（非演唱正文，比对前剔除，防止歌词前奏 credits 拉低命中）。
 *  CJK credits 需带分隔符（"作词："），避免误伤以"作词人"开头的真实歌词行 */
const LYRIC_CREDIT_RE = /^(作词|作詞|作曲|编曲|編曲|填詞|填词|监制|監製|制作|製作|演唱|演奏|混音|母带|母帶|和声|和聲|录音|錄音|配唱|词曲)[:：\s]|^(作词|作詞|作曲|编曲|編曲|填詞|填词|词曲)$|^(lyrics?|music|composed?|written?|produced?|performed?|arranged?|mixed?|mastered?)\s*(by|:)\s*/i

/** CJK（汉字+假名）判定：字幕/歌词的书写体系分 side 用 */
const CJK_RE = /[\u4e00-\u9fff\u3040-\u30ff\u3400-\u4dbf]/

export interface SubtitleVerifyResult {
  verdict: CCVerification
  /** 实际参与判定的采样段数 */
  sampled: number
  /** 其中与歌词命中（bigram 包含率达标）的段数 */
  matched: number
  /** 与歌词书写体系可比对的有效字幕段数（0 = 语言不通/无有效内容） */
  comparable: number
}

/** 字符 bigram 集合（规范化后的文本按 2-gram 切，容忍翻译措辞差异的模糊比对基础） */
function bigramSetOf(norm: string): Set<string> {
  const set = new Set<string>()
  for (let i = 0; i < norm.length - 1; i += 1) set.add(norm.slice(i, i + 2))
  return set
}

/** 段落被歌词云包含的程度：|seg ∩ lyrics| / |seg|（0~1，越高越像同一段词） */
function containmentOf(segNorm: string, lyricBigrams: Set<string>): number {
  const segBigrams = bigramSetOf(segNorm)
  if (!segBigrams.size) return 0
  let hit = 0
  for (const bg of segBigrams) if (lyricBigrams.has(bg)) hit += 1
  return hit / segBigrams.size
}

/** 单段是否有效可比：规范化后 ≥6 字（过滤"哈哈"/"谢谢"类无信息量短行） */
function isVerifiableSegment(norm: string): boolean {
  return norm.length >= 6
}

/** 判断规范化段与歌词云是否可比对（至少共享一种书写体系） */
function isComparableSegment(segNorm: string, lyricHasCJK: boolean, lyricHasLatin: boolean): boolean {
  const segCJK = CJK_RE.test(segNorm)
  const segLatin = /[a-z]/.test(segNorm)
  return (segCJK && lyricHasCJK) || (segLatin && lyricHasLatin)
}

/**
 * CC 字幕内容 ↔ 歌词比对（纯函数，可单测）。
 *
 * 设计要点（对应真实误伤场景）：
 * - **前段说话、后面正片**（Live 前奏问候/混剪片头）：按时间轴等距抽样、天然跳过片头，
 *   且"命中过半"才判 match——片头几行闲聊不影响整体判定；
 * - **双语/翻译字幕**：一行多段（B 站 CC 常见 `原文\n译文`）拆开逐段比对，与歌词任一
 *   书写体系（CJK/拉丁）相同即参与判定——中文翻译字幕对英文歌词不可字面比对，
 *   故调用方应把平台歌词的翻译文本一并传入（flattenLyricLinesForMatch 已含 translation）；
 * - **翻译措辞因人而异**：bigram 包含率（非全等）做模糊命中，改写少量字仍命中；
 * - **人工填充的无关字幕**（直播切片的聊天/导流）：可比对却几乎不命中 → mismatch 惩罚；
 * - **AI 字幕整段"♪音乐♪"**：清洗后无有效行 → unverified（不奖不罚）。
 */
export function compareSubtitleWithLyrics(
  /** 字幕行：兼容原始 BilibiliSubtitleLine（content）与复审缓存的规范化段（text） */
  subLines: Array<{ from?: number; content?: string; text?: string }> | undefined | null,
  lyricsText: string | undefined | null,
): SubtitleVerifyResult {
  const unverified = (sampled = 0, comparable = 0): SubtitleVerifyResult => ({ verdict: 'unverified', sampled, matched: 0, comparable })

  // 1. 歌词云：剔 credits 行 → 规范化 → bigram 集合。过短（纯音乐/空壳歌词）无法验证。
  const lyricBody = String(lyricsText || '')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !LYRIC_CREDIT_RE.test(s))
  const lyricNorm = normalizeText(lyricBody.join(''))
  if (lyricNorm.length < 40) return unverified()
  const lyricBigrams = bigramSetOf(lyricNorm)
  const lyricHasCJK = CJK_RE.test(lyricNorm)
  const lyricHasLatin = /[a-z]/.test(lyricNorm)

  // 2. 字幕段：清洗噪音行（♪音乐♪ 等）→ 拆双语段 → 规范化 → 过滤短行/credits → 去重
  const segs: Array<{ from: number; norm: string }> = []
  const seenSeg = new Set<string>()
  for (const line of subLines || []) {
    for (const raw of String(line?.content ?? (line?.text || '')).split(/\n/)) {
      const trimmed = raw.trim()
      if (!trimmed || LYRIC_CREDIT_RE.test(trimmed)) continue
      const norm = normalizeText(trimmed)
      if (!isVerifiableSegment(norm) || seenSeg.has(norm)) continue
      seenSeg.add(norm)
      segs.push({ from: Number(line?.from) || 0, norm })
    }
  }

  // 3. 只留与歌词可比对（共享书写体系）的段：中文翻译字幕 vs 英文原文歌词 → 不可比 → unverified
  const comparableSegs = segs.filter((s) => isComparableSegment(s.norm, lyricHasCJK, lyricHasLatin))
  if (!comparableSegs.length) return unverified(0, 0)

  // 4. 时间轴抽样：跳过首行（常为片头/标题问候），等距最多取 8 段——
  //    Live 前段说话/混剪片头只占少数采样，正片歌词段占多数即可判 match
  const sorted = [...comparableSegs].sort((a, b) => a.from - b.from)
  const pool = sorted.length > 4 ? sorted.slice(1) : sorted
  const SAMPLE_MAX = 8
  const samples: Array<{ from: number; norm: string }> = []
  if (pool.length <= SAMPLE_MAX) {
    samples.push(...pool)
  } else {
    for (let i = 0; i < SAMPLE_MAX; i += 1) {
      const seg = pool[Math.min(pool.length - 1, Math.round(((i + 0.5) * pool.length) / SAMPLE_MAX))]
      if (seg && !samples.includes(seg)) samples.push(seg)
    }
  }
  if (!samples.length) return unverified(0, comparableSegs.length)

  // 5. 判定：命中（包含率 ≥0.6）过半 → match；可比样本 ≥3 且全不命中 → mismatch；中间态 → unverified
  const CONTAIN_THRESHOLD = 0.6
  let matched = 0
  for (const s of samples) {
    if (containmentOf(s.norm, lyricBigrams) >= CONTAIN_THRESHOLD) matched += 1
  }
  const ratio = matched / samples.length
  if (ratio >= 0.5) return { verdict: 'match', sampled: samples.length, matched, comparable: comparableSegs.length }
  if (matched === 0 && samples.length >= 3) return { verdict: 'mismatch', sampled: samples.length, matched, comparable: comparableSegs.length }
  return unverified(samples.length, comparableSegs.length)
}

/**
 * 把平台歌词行（LyricLine 结构鸭子类型：text + translation）压平成比对用文本。
 * 正文与翻译都进歌词云：英文歌 + 中文 CC 字幕时，字幕可与中文翻译歌词比对。
 */
export function flattenLyricLinesForMatch(lines: Array<{ text?: string; translation?: string }> | undefined | null): string {
  if (!Array.isArray(lines)) return ''
  const parts: string[] = []
  for (const l of lines) {
    const text = String(l?.text || '').trim()
    const translation = String(l?.translation || '').trim()
    if (text) parts.push(text)
    if (translation && translation !== text) parts.push(translation)
  }
  return parts.join('\n')
}

export type RecordingTarget = NonNullable<MatchContext['targetVersion']>

export function inferRecordingTarget(ctx: MatchContext): RecordingTarget | undefined {
  if (ctx.targetVersion) return ctx.targetVersion
  if (/\b(?:tv\s*(?:size|ver(?:sion)?))\b|电视版|tv版/i.test(ctx.songTitle)) return 'tv-size'
  const artistNames = resolveArtistNames(ctx.artists || []).normalized
  const artistsText = normalizeText((ctx.artists || []).join(' '))
  if (/leoneed|moremorejump|vividbadsquad|wonderlands×?showtime|25时ナイトコード|25時ナイトコード/.test(artistsText)) return 'sekai-version'
  const virtualSingerNames = ['初音ミク', '鏡音リン', '镜音铃', '鏡音レン', '镜音连', '巡音ルカ', '巡音流歌', '歌愛ユキ', '歌爱雪', '重音テト', 'gumi', 'flower', 'vocaloid', 'utau'].map(normalizeText)
  const virtualSinger = artistNames.some((artist) => virtualSingerNames.includes(artist))
  if (virtualSinger && (ctx.artists || []).length >= 2) return 'virtual-singer'
  return undefined
}

export interface ScoreCandidateOptions {
  rank?: number
  officialVerifyType?: number
  manualZhSubtitle?: boolean
  autoSubtitle?: boolean
  preference?: MatchPreference
  /** 多 P 视频的选中分 P 时长（用于时长贴近评分） */
  effectiveDuration?: number
  /** CC 字幕与歌词的比对结论（缺省视为 unverified 缩水档） */
  ccVerification?: CCVerification
}

export function scoreCandidate(
  video: BilibiliVideo,
  ctx: MatchContext,
  extra?: ScoreCandidateOptions,
): CandidateScore {
  const songTitleRaw = cleanSongTitle(ctx.songTitle)
  const songTitleNorm = normalizeText(songTitleRaw)
  // 歌名变体：不同平台对同一首歌可能带括号翻译（如「メディアノーチェ (Medianoche)」），
  // 去括号主体也是独立候选——B 站标题通常只写其中一种写法，任一命中即可过硬淘汰。
  // 注意不可按长度 ≥2 过滤：单字歌名（如「恋」）会被整个排除导致全部硬淘汰。
  const songTitleBaseNorm = normalizeText(songTitleRaw.replace(/[（(][^（）()]*[）)]/g, '').trim())
  const songTitleVariants = [...new Set([songTitleNorm, songTitleBaseNorm].filter((t) => t.length >= 1))]
  const titleNorm = normalizeText(video.title)
  const rank = extra?.rank ?? 0
  const signals: CandidateSignals = {
    officialMarker: OFFICIAL_MARKERS.some((m) => titleNorm.includes(m)),
    mvMarker: MV_MARKERS.some((m) => titleNorm.includes(m)),
    negativeHit: NEGATIVE_MARKERS.some((m) => titleNorm.includes(m)),
    hasArtist: false,
    nearDuration: false,
    hdMarker: /4k|1080p|高清|超清|120帧|120fps|高帧率/.test(titleNorm),
    uploaderMatchesArtist: false,
    officialChannel: false,
    ccSubtitle: Boolean(extra?.manualZhSubtitle || extra?.autoSubtitle),
  }
  const officialVerifyType = extra?.officialVerifyType ?? -1
  const manualZhSubtitle = Boolean(extra?.manualZhSubtitle)
  const autoSubtitle = Boolean(extra?.autoSubtitle)
  const ccVerification = extra?.ccVerification ?? 'unverified'
  const effectiveDuration = extra?.effectiveDuration

  // 硬淘汰：任一歌名变体未完整出现在视频标题 → 无关视频，直接丢弃
  if (!songTitleVariants.length || !songTitleVariants.some((t) => titleNorm.includes(t))) {
    return { video, score: -Infinity, signals, rank, officialVerifyType, manualZhSubtitle, autoSubtitle, ccVerification, effectiveDuration, type: classifyCandidateType(video.title) }
  }

  let score = 100 // 歌名完整命中
  const resolvedArtists = resolveArtistNames(ctx.artists)
  const artistNormList = resolvedArtists.normalized
  const aliasNormList = resolvedArtists.aliases
  if (artistNormList.some((a) => titleNorm.includes(a)) || aliasNormList.some((a) => titleNorm.includes(a))) {
    score += 15
    signals.hasArtist = true
  }

  // 官号识别（借鉴 ECHO findArtistEvidence）：作者名命中歌手/别名 → 音乐人本人官号，强正片信号。
  // 作者名完全等于歌手（或别名）最高置信；包含歌手次之（如「周杰伦官方」）。官方频道关键词在下方单独计分。
  const authorNorm = normalizeText(video.author)
  if (artistNormList.some((a) => authorNorm === a) || aliasNormList.some((a) => authorNorm === a)) {
    score += 25
    signals.uploaderMatchesArtist = true
  } else if (artistNormList.some((a) => uploaderMatchesName(authorNorm, a)) || aliasNormList.some((a) => uploaderMatchesName(authorNorm, a))) {
    score += 15
    signals.uploaderMatchesArtist = true
  }
  signals.officialChannel = matchesVerifiedOfficialSource(video, ctx, resolvedArtists)
    || OFFICIAL_CHANNEL_KEYWORDS.some((k) => authorNorm.includes(normalizeText(k)))
    || aliasNormList.some((alias) => authorNorm === alias)

  // 官方标记只有与艺人本人上传者相互印证时才成为可靠来源信号。
  if (signals.officialMarker && signals.uploaderMatchesArtist) score += 20

  // 纯歌名只有弱奖励；正确艺人-歌名结构才是高置信正片证据。
  const exactTitleMatch = classifyExactTitleMatch(video.title, songTitleRaw, resolvedArtists)
  if (exactTitleMatch === 'title-only') score += 10
  else if (exactTitleMatch === 'artist-title') score += 25

  // 标题明确把另一首歌放进书名号，而目标歌名只出现在附带说明中，通常是专辑/彩蛋提及。
  const rawVideoTitle = String(video.title || '')
  const quotedTitles = [...rawVideoTitle.matchAll(/[《「『“\"]([^》」』”\"]{2,80})[》」』”\"]/g)]
  const firstQuotedIndex = quotedTitles[0]?.index ?? -1
  const targetAppearsBeforeQuote = firstQuotedIndex > 0
    && songTitleVariants.some((variant) => normalizeText(rawVideoTitle.slice(0, firstQuotedIndex)).includes(variant))
  const quotedTitleNorms = quotedTitles.map((match) => normalizeText(match[1])).filter(Boolean)
  if (quotedTitleNorms.length && !targetAppearsBeforeQuote
    && !quotedTitleNorms.some((quoted) => songTitleVariants.some((variant) => quoted.includes(variant)))) {
    score -= 85
  }

  // 「其他歌手 | 歌名 | 作品名」形态：首段通常是演唱者。首段不匹配目标艺人/IP时降权。
  if (!signals.hasArtist && /[|｜]/.test(video.title)) {
    const segments = String(video.title || '')
      .replace(/^(?:【[^】]*】\s*)+/, '')
      .split(/[|｜]/)
      .map((part) => part.trim())
      .filter(Boolean)
    const songSegmentIndex = segments.findIndex((part) => songTitleVariants.some((variant) => normalizeText(part) === variant))
    if (songSegmentIndex > 0) {
      const lead = normalizeText(segments[0])
      const franchiseNames = resolveFranchiseNames(ctx.franchise).map(normalizeText)
      const isExpectedSource = artistNormList.some((artist) => lead.includes(artist))
        || aliasNormList.some((alias) => lead.includes(alias))
        || franchiseNames.some((name) => lead.includes(name))
        || /官方|字幕|歌词|mv|pv|4k|1080p|hires|无损/.test(lead)
      if (lead.length >= 2 && !isExpectedSource) score -= 65
    }
  }

  // 歌名不含歌手（无歌手证据）：可能是同名的其它歌曲（货不对板防御，任何歌名长度都适用——
  // 否则同名不同歌手的官方 MV 会靠官方/播放加成胜出，如 SawanoHiroyuki 与 NMIXX 的 Roller Coaster）。
  // 惩罚按播放量软化：低播放同名视频才是"同名不同歌"的高风险区；高播放（≥1万）且歌名
  // 精确命中的视频通常就是正主（用户实测：13.2 万播放的官方向 MV 应胜过 2 千播放的纯音频
  // 搬运，尽管标题没写歌手）。live/翻唱/语言不一致等仍由各自扣分兜底。
  if (!signals.hasArtist) score -= (video.play || 0) >= 10000 ? 0 : 35
  // 短歌名易撞车：额外重罚
  if (songTitleNorm.length <= 4 && !signals.hasArtist) score -= 15
  // 未命中歌手 + 却带官方/MV 标记 → 极可能是"别的歌手的官方MV"（张冠李戴，如王艺瑾-喜欢你），再重罚
  if (!signals.hasArtist && (signals.officialMarker || signals.mvMarker)) score -= 40
  // 无歌手命中 + live 标记 → "别人的演唱会现场"（如日语曲匹配到张国荣热情演唱会），同级别重罚
  if (!signals.hasArtist && hasLiveMarker(video.title)) score -= 30
  // 「他人《歌名》」形态：书名号前的文本通常是演唱者（如「张国荣Leslie《春夏秋冬》」）。
  // 去掉【..】与画质/规格标签后仍有实质文本、且不含本曲歌手/别名 → 明确演唱者不符。
  // 书名号会被 normalizeText 剥掉，须在原始标题上检测。
  // 例外：知名作曲家（泽野弘之/久石让/坂本龙一/菅野よう子等）署名不算"他人"——
  // 这些作曲家合作曲极多，B 站标题带他们名字反而是"这首歌是他的作品"的正向信号
  // （如 Do As Infinity 的《Alive》歌手列表没泽野弘之，但他确是作曲，B 站用户也认）。
  const COMPOSER_AFFINITY = ['泽野弘之', 'sawano', '久石让', 'hisashi', '坂本龙一', 'ryuichi', '菅野よう子', 'yoko kanno', '梶浦由記', 'yuki kajiura', '鹭巢诗郎', 'shiro sagisu', '泽野']
  if (!signals.hasArtist) {
    const rawTitle = String(video.title || '')
    const bracketMatches = rawTitle.match(/《[^《》]{1,60}》/g) || []
    for (const bracket of bracketMatches) {
      const inner = normalizeText(bracket.slice(1, -1)).replace(/\s+/g, '')
      if (!songTitleVariants.some((t) => t.replace(/\s+/g, '') === inner)) continue
      const prefix = normalizeText(rawTitle.slice(0, rawTitle.indexOf(bracket)))
        .replace(/【[^】]*】/g, '')
        .replace(/4k\d*fps?|1080p|hi-?res|khz|\d+bit|mad|hdr|高清|超清|修复|重制|字幕|中字/g, '')
        .replace(/\s+/g, '')
      if (prefix.length >= 2
        && !artistNormList.some((a) => prefix.includes(a))
        && !aliasNormList.some((a) => prefix.includes(a))) {
        const composerHit = COMPOSER_AFFINITY.some((c) => prefix.includes(normalizeText(c)))
        if (!composerHit) score -= 45
        else score += 5 // 作曲家署名：轻加，鼓励这类"虽无歌手但确是本曲作品"的视频
      }
      break
    }
  }
  // 「歌名+额外词」在书名号/方括号内、且无本曲歌手 → 同名不同歌风险。
  // 区分两类：(1) 歌名后紧跟**别的歌的歌名扩展**（如 BIGBANG《春夏秋冬(Still Life)》——
  // (Still Life) 是 BIGBANG 那首歌的专属后缀，不是本曲）；(2) 歌名后紧跟别的媒体的标题
  // （如《春夏秋冬代行者 春之舞》——是动画不是歌）。已知媒体/乐器限定词（字幕/现场/4K/
  // 吉他/cover/完整版等）不算——那是同一首歌的不同形态。不罚已命中本曲歌手的候选。
  if (!signals.hasArtist) {
    const rawTitle = String(video.title || '')
    const qualifierRe = /字幕|中字|歌词|现场|live|演唱会|版|ver|mv|pv|音乐|完整|加长|高清|超清|4k|1080p|120帧|官方|伴奏|纯音乐|纯享|instrumental|钢琴|吉他|guitar|piano|指弹|演奏|cover|翻唱|弹唱|ktv|卡啦|试听|修复|重制|remaster|hi-?res|无损|杜比|环绕|8d|remix|混音|剪辑|合集|纯音乐|女声|男声|歌词排版|字幕组|中英/i
    const innerMatches = rawTitle.match(/[《【]([^》】]{1,60})[》】]/g) || []
    for (const bracket of innerMatches) {
      const innerNorm = normalizeText(bracket.replace(/[《》【】]/g, ''))
      const variant = songTitleVariants.find((t) => innerNorm.startsWith(t))
      if (!variant) continue
      const remainder = innerNorm.slice(variant.length)
      if (remainder.length >= 2 && !qualifierRe.test(remainder)) {
        score -= 25
      }
      break
    }
  }
  // 「歌名 - 其他歌手」直接形态（如「春夏秋冬 - 张国荣」——演唱者不是本曲歌手）。
  // 无书名号/方括号时上面的「他人《歌名》」检测不到；这里按"标题前半是歌名、后半是
  // 另一个人名"判罚。后半命中本曲歌手/别名或媒体限定词（MV/歌词/字幕/现场/版等）不罚。
  // 含书名号/方括号的标题走上面的括号检测，不重复判罚。
  if (!signals.hasArtist) {
    const songRe = songTitleVariants.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a, b) => b.length - a.length).join('|')
    // 先剥离前置规格/限定标记（【4K】【HI-RES】…）与括号注释，露出「歌名 - 人名」主干
    const cleaned = String(video.title || '')
      .replace(/【[^】]*】/g, ' ')
      .replace(/（[^）]*）/g, ' ')
      .replace(/\([^)]*\)/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    const dashForm = cleaned.match(new RegExp(`^(${songRe})\\s*[-–—:：·]\\s*([^-\\s《》【】\\[\\]（）()]{2,24})$`, 'i'))
    if (dashForm) {
      const trailing = normalizeText(dashForm[2])
      const isArtist = artistNormList.some((a) => trailing.includes(a) || a.includes(trailing))
        || aliasNormList.some((a) => trailing.includes(a))
      const isQualifier = /字幕|歌词|mv|pv|版|ver|现场|live|演唱会|完整|加长|4k|1080p|高清|伴奏|纯音乐|纯享|instrumental|翻唱|cover|歌词排版|中字|试听|remaster|hi-?res|无损|混音|合唱|钢琴|吉他|小提琴/i.test(trailing)
      if (!isArtist && !isQualifier) score -= 30
    }
  }
  // 「…歌名）-后缀」形态：括号后紧跟连字符+名字（如「harunaziakufuyu(春夏秋冬）-Riko/nico」）
  // 是"歌名-上传者/翻唱者"的命名习惯（自译/翻唱/搬运），后缀不是本曲歌手 → 货不对板风险。
  // 标准「歌手 - 歌名」形态（带空格连字符）不受影响；后缀命中歌名/歌手/别名也不罚。
  if (!signals.hasArtist) {
    const appendMatch = String(video.title || '').match(/[）)]\s*-\s*([^\-[\]【】()（）]{1,24})/i)
    if (appendMatch) {
      const suffixNorm = normalizeText(appendMatch[1])
      const isSongSuffix = songTitleVariants.some((t) => t === suffixNorm || t.includes(suffixNorm) || suffixNorm.includes(t))
      if (suffixNorm.length >= 2 && !isSongSuffix && !artistNormList.includes(suffixNorm) && !aliasNormList.includes(suffixNorm)) {
        score -= 15
      }
    }
  }
  // 语言一致性辅助信号：歌手/歌名含假名（日文曲）而候选标题与作者完全无假名且未命中歌手
  // → 大概率是中文同名曲（正确的候选也可能无假名，如 romaji 写法，故仅作辅助降权）
  const KANA_RE = /[\u3040-\u309F\u30A0-\u30FF]/
  if (!signals.hasArtist
    && KANA_RE.test(artistNormList.join('') + songTitleNorm)
    && !KANA_RE.test(titleNorm + authorNorm)) {
    score -= 15
  }
  // 「【人名】歌名」前缀：日系标题常以【】标注演唱者/翻唱者（如【黒音さや】rainy tone——
  // 黒音さや是翻唱者，不是本曲歌手 NIKIIE/(K)NoW_NAME）。【】内是媒体/规格限定词
  // （4K/字幕/官方/MAD/卡拉OK 等）不算；命中本曲歌手/别名不算。未命中歌手时降权，
  // 避免"无翻唱字样"的翻唱视频压过原唱。
  if (!signals.hasArtist) {
    const rawTitle = String(video.title || '')
    const lead = rawTitle.match(/^【([^】]{1,24})】/)
    if (lead) {
      const leadNorm = normalizeText(lead[1])
      const isArtist = artistNormList.some((a) => leadNorm.includes(a) || a.includes(leadNorm))
        || aliasNormList.some((a) => leadNorm.includes(a))
      const isQualifier = /4k|1080p|高清|超清|字幕|中字|歌词|mv|pv|官方|现场|live|演唱会|完整|加长|伴奏|纯音乐|纯享|instrumental|钢琴|吉他|guitar|piano|指弹|演奏|翻唱|cover|カバー|卡拉ok|ktv|ニコカラ|nico|投屏|mad|手书|剪辑|修复|重制|hi-?res|无损|试听|合集|中文|日语|日文|双语|中英|中日|竖屏|横屏|收藏|自用|搬运/i.test(leadNorm)
      if (leadNorm.length >= 2 && !isArtist && !isQualifier) score -= 30
    }
  }

  // 分区
  if (video.typename === '音乐') score += 15
  else if (video.typename && ['影视剪辑', '日常', '游戏', '知识', '生活'].includes(video.typename)) score -= 20

  // 标题自称“官方”只能作为弱内容标记，不能替代账号来源证据。
  for (const m of OFFICIAL_MARKERS) if (titleNorm.includes(m)) score += 8
  for (const m of MV_MARKERS) if (titleNorm.includes(m)) score += 15
  for (const m of NEGATIVE_MARKERS) if (titleNorm.includes(m)) score -= 35
  for (const m of COMPILATION_MARKERS) if (titleNorm.includes(m)) score -= 60
  for (const m of POSITIVE_EXTRA_MARKERS) if (titleNorm.includes(m)) score += 10
  // 正片增强：主题曲/加长版/完整版 → 完整正片信号（独立加权，避免和正向标记叠加混淆）
  for (const m of POSITIVE_SONG_MARKERS) if (titleNorm.includes(m)) score += 12
  // 完整版/加长版 + 歌手命中 + 播放 ≥1万 + 非现场/非翻唱 → 完整正片本体，强优先。
  // （用户实测：58.2万播放的《紅蓮華》加长版应胜过 97.8万播放的 4K 重制/其它版本——
  // 加长版就是官方 MV 本体，播放量到量级后应稳压"更花哨但非本体"的版本。）
  if (signals.hasArtist && (video.play || 0) >= 10000
    && /完整版|加长版|加長版|完整フル|フルバージョン/.test(titleNorm)
    && !hasLiveMarker(video.title)
    && !/翻唱|cover|カバー/.test(titleNorm)) {
    score += 25
  }
  // OP/ED（动漫片头/片尾主题曲）：与歌曲主题直接相关，权重提升。
  // normalizeText 会把「【OP】LiSA」黏成 "oplisa" 破坏词边界，所以用原始标题做边界匹配；
  // 允许带集数（OP1/ED2），防误伤 "operation"/"editor"/"open" 等单词。
  const isOpEdTitle = /(^|[^a-z0-9])(op|ed)\d*([^a-z0-9]|$)/i.test(video.title)
  if (isOpEdTitle) score += 18
  // 高清/高帧率权重：4K/1080P/高清/超清/120帧 命中 → 高质量正片信号，任意偏好下基础加成；
  // 4K/120帧 属 premium 标记额外加成（'hd' 偏好在 preferenceAdjustment 另计 +20）
  if (signals.hdMarker) score += 12
  if (/4k|120帧|120fps/.test(titleNorm)) score += 6
  // 翻译群体（熟肉/双语/中字/字幕组/汉化组，如 MCE 汉化组）：高质量翻译版，权重高于普通歌词字幕
  if (/熟肉|双语|中文字幕|中日字幕|字幕组|汉化组/.test(titleNorm)) score += 25
  // 翻唱/cover：B 站标题常有【翻唱】/「cover」前缀，官方与现场之外再重罚（多语言标题都覆盖）
  if (/翻唱|cover|カバー|カバー曲|模仿|弹唱/.test(titleNorm)) score -= 30
  // 舞蹈练习/翻跳/自用类：练舞、翻跳、宅舞、镜面（练习）、舞蹈教学、自用 → 非官方 MV
  if (/练舞|翻跳|宅舞|舞蹈教学|镜面|自用|多人舞/.test(titleNorm)) score -= 30
  // 变速/变调/升降调版本：非原版处理（nightcore/slowed/sped/变速/降调/升调/变调/key up/down），
  // 除非别无选择否则不用 → 重罚（比合集更重，仍保留为最后候选，避免被硬淘汰）
  if (/降调|升调|升降调|变调|变速|降速|加速|慢速|慢放|快放|放慢|加快|提速|减速|变速版|变调版|slowed|sped|nightcore|speed ?(up|down)|key ?(down|up)|降key|升key|降Key|升Key|降KEY|升KEY/.test(titleNorm)) score -= 70
  // 歌手+歌名+MV 三要素齐备：官方正片强信号
  if (signals.hasArtist && signals.mvMarker) score += 10
  // live 只计一次（"演唱会现场版"会同时命中 现场/演唱会 两个标记，不应叠加）；
  // 均衡偏好下轻微降权，live 偏好下不降（用户明确要现场版）
  if (hasLiveMarker(video.title) && (extra?.preference ?? 'balanced') !== 'live') score -= 5

  // 非音乐内容即使标题、时长和播放量都接近，也只能作为低优先级相关视频。
  if (NON_MUSIC_CONTENT_MARKERS.some((marker) => titleNorm.includes(normalizeText(marker)))) score -= 90
  const hasAlternateVersion = ALTERNATE_VERSION_MARKERS.some((marker) => titleNorm.includes(normalizeText(marker)))
  const hasDerivedExtension = DERIVED_EXTENDED_MARKERS.some((marker) => titleNorm.includes(normalizeText(marker)))
  const penalizeAlternateVersion = (): void => {
    if (hasAlternateVersion) score -= 45
    if (hasDerivedExtension) score -= 55
  }
  const targetVersion = inferRecordingTarget(ctx)
  if (targetVersion === 'full-original') {
    penalizeAlternateVersion()
  } else if (targetVersion === 'tv-size') {
    const isDerivative = signals.negativeHit || classifyCandidateType(video.title) === 'instrumental'
    if (!isDerivative && /tv\s*(size|ver)|电视版|tv版/i.test(video.title)) score += 35
    if (!isDerivative && video.duration >= 70 && video.duration <= 110) score += 25
  } else if (targetVersion === 'virtual-singer') {
    penalizeAlternateVersion()
    if (/世界计划|project\s*sekai|pjsk|2dmv|3dmv|sekai\s*ver/i.test(video.title + video.author)) score -= 55
    if (/初音ミク|gumi|歌愛ユキ|flower|重音テト|vocaloid|utau/i.test(video.title)) score += 20
  } else if (targetVersion === 'sekai-version') {
    penalizeAlternateVersion()
    if (/世界计划|project\s*sekai|pjsk|2dmv|3dmv|sekai\s*ver/i.test(video.title + video.author)) score += 35
    if (/game\s*size|游戏短版|短版/i.test(video.title)) score -= 25
  } else if (targetVersion === 'specific-performance') {
    const primaryPerformer = artistNormList[0]
    if (primaryPerformer && titleNorm.includes(primaryPerformer)) score += 35
    else score -= 55
  }

  const franchiseNorms = resolveFranchiseNames(ctx.franchise).map(normalizeText).filter((name) => name.length >= 2)
  const hasFranchise = franchiseNorms.some((name) => titleNorm.includes(name))
  if (hasFranchise) score += 25
  // 短而泛化的英文标题极易撞到问答、预告和其他游戏；可信来源只能证明上传者身份，
  // 不能证明这是当前艺人的同名作品，因此仍需艺人或 IP 证据。
  const genericTitle = /^[a-z0-9 ]+$/i.test(songTitleRaw) && songTitleRaw.trim().split(/\s+/).length <= 3
  if (genericTitle && !signals.hasArtist && !hasFranchise) score -= 45

  const songDur = Math.max(1, ctx.songDuration || 0)
  // 多 P 视频用选中分 P 的时长评分（视频总时长对多版本视频无意义）
  const compareDuration = extra?.effectiveDuration || video.duration || 0
  const diffRatio = Math.abs(compareDuration - songDur) / songDur
  if (diffRatio <= 0.1) {
    score += 40
    signals.nearDuration = true
  } else if (diffRatio <= 0.2) score += 20
  else if (diffRatio <= 0.3) score += 5
  else if (diffRatio <= 0.5) score -= 15
  else score -= 35

  // OP/ED 但视频是 TV 版短时长：输入本身要求 TV size 时是精确版本，否则作为完整版的降级候选。
  if (isOpEdTitle && compareDuration >= 70 && compareDuration <= 110 && targetVersion !== 'tv-size') score -= 25

  // 播放量只作为质量先验；曲线在超高播放处继续保留小幅区分。
  score += playCountScore(video.play)

  // 搜索排名（B 站相关度顺序偏"标题精确命中"而非"MV 质量"，只作弱信号）
  score += Math.max(0, 15 - rank) * 0.5

  // 官方频道与精品社区来源
  if (signals.officialChannel) score += 25
  if (QUALITY_COMMUNITY_KEYWORDS.some((k) => authorNorm.includes(normalizeText(k)))) score += 15

  // 复审增强：B 站原始认证值为 -1 未认证、0 个人、1 机构。
  score += verificationScore(officialVerifyType)
  if (signals.uploaderMatchesArtist && officialVerifyType >= 0) score += 10
  // 机构认证与上下文官号/艺人别名相互印证，优先于仅标题干净的转载。
  if (officialVerifyType === 1 && (signals.officialChannel || signals.uploaderMatchesArtist)) score += 10
  // CC 字幕权重（分档）：内容与歌词比对后 match 足额 / unverified 缩水 / mismatch 反罚。
  // 背景（Starboy →「一滴泪」直播切片）：人工 CC +25 无差别加分曾把无关视频推上最佳（245 分）——
  // CC 只证明"有字幕"，不证明"是这首歌"，必须验证内容后才值得高分。
  if (manualZhSubtitle) score += ccVerification === 'match' ? 25 : ccVerification === 'mismatch' ? -20 : 8
  else if (autoSubtitle) score += ccVerification === 'match' ? 10 : ccVerification === 'mismatch' ? -8 : 3

  // 偏好加权
  const preference = extra?.preference ?? 'balanced'
  const type = classifyCandidateType(video.title)
  score += preferenceAdjustment(type, preference, signals)

  return { video, score, signals, rank, officialVerifyType, manualZhSubtitle, autoSubtitle, ccVerification, effectiveDuration, type }
}

/** 偏好加权：不同用户想要不同类型的视频 */
export function preferenceAdjustment(type: CandidateType, preference: MatchPreference, signals?: CandidateSignals): number {
  switch (preference) {
    case 'official':
      return type === 'official' ? 25 : type === 'live' ? -10 : type === 'cover' || type === 'instrumental' ? -15 : 0
    case 'live':
      // 与 official 偏好对称：live 偏好下官方 MV 轻微降权，保证现场版能胜出
      return type === 'live' ? 25 : type === 'official' ? -10 : type === 'cover' || type === 'instrumental' ? -15 : 0
    case 'lyrics':
      return type === 'lyrics' ? 20 : type === 'official' ? 5 : 0
    case 'hd':
      return signals?.hdMarker ? 20 : 0
    case 'balanced':
    default:
      // 均衡下维持基础评分：官方零调整、现场轻微降、翻唱/演奏已在负向标记中重罚
      return type === 'live' ? -5 : 0
  }
}

/**
 * 自动播放判定（门槛随 strictness）：
 * - strict  严格：score≥260 或（score≥200 且 官方标记/认证/人工字幕）
 * - standard 标准：score≥230 或（score≥150 且 官方标记/认证/人工字幕）
 * - relaxed 宽松：score≥190 或（score≥120 且 官方标记/认证/人工字幕）
 * 额外：类型为官方且歌手+歌名+时长贴近（明显正片）时降低自动播放门槛。
 */
export function shouldAutoPlay(candidate: CandidateScore, strictness: AutoPlayStrictness = 'standard'): boolean {
  // 明确的翻唱、伴奏、教学/变速等负向类型不能仅靠播放量越过自动播放门槛。
  if (candidate.signals.negativeHit || candidate.type === 'cover' || candidate.type === 'instrumental') return false
  // 人工 CC 字幕只有内容验证过与歌词相符才算"强信号"（未验证的 CC 不再单独撑起自动播放）
  const strong =
    candidate.signals.officialChannel ||
    candidate.officialVerifyType === 1 ||
    (candidate.manualZhSubtitle && candidate.ccVerification === 'match') ||
    candidate.signals.uploaderMatchesArtist
  // 歌手+歌名+MV/官方 且时长贴近 → 高置信正片
  const obviousOfficial = candidate.type === 'official' && candidate.signals.hasArtist && candidate.signals.nearDuration
  switch (strictness) {
    case 'strict':
      return candidate.score >= 260 || (candidate.score >= 200 && strong) || (obviousOfficial && candidate.score >= 200)
    case 'relaxed':
      return candidate.score >= 190 || (candidate.score >= 120 && strong) || (obviousOfficial && candidate.score >= 150)
    case 'standard':
    default:
      return candidate.score >= 230 || (candidate.score >= 150 && strong) || (obviousOfficial && candidate.score >= 180)
  }
}

// ===== 按歌缓存 + 手动选择记忆 + 黑名单 =====

const MATCH_CACHE_TTL = 24 * 60 * 60 * 1000
const MATCH_SCORE_VERSION = 'v6-audited-identity'
/** 匹配缓存 LRU 上限（防止长时间会话无界增长） */
const MATCH_CACHE_MAX = 60
const matchCache = new Map<string, { at: number; result: BilibiliMatchResult }>()

function pruneMatchCache() {
  if (matchCache.size <= MATCH_CACHE_MAX) return
  const sorted = [...matchCache.entries()].sort((a, b) => a[1].at - b[1].at)
  while (matchCache.size > MATCH_CACHE_MAX && sorted.length) {
    const oldest = sorted.shift()
    if (oldest) matchCache.delete(oldest[0])
  }
}

export function songKeyOf(song: MatchContext): string {
  const id = song.id != null && song.id !== '' ? String(song.id) : ''
  const title = normalizeText(song.songTitle)
  if (song.platform && id) return `${song.platform}:${id}`
  return `t:${title}:${normalizeText((song.artists || []).join(','))}`
}

export function getBilibiliOverride(songKey: string): string | null {
  try {
    return localStorage.getItem(`bilibili_override_${songKey}`)
  } catch {
    return null
  }
}

export function setBilibiliOverride(songKey: string, bvid: string): void {
  try {
    localStorage.setItem(`bilibili_override_${songKey}`, bvid)
  } catch {
    // 忽略
  }
}

export function clearBilibiliOverride(songKey: string): void {
  try {
    localStorage.removeItem(`bilibili_override_${songKey}`)
  } catch {
    // 忽略
  }
}

// ===== 看歌本地标记库（用户手动指定某视频作为某歌的 MV） =====

export interface LocalMvMark {
  songKey: string
  songTitle: string
  artist: string
  bvid: string
  videoTitle: string
  pic: string
  author: string
  markedAt: number
}

const LOCAL_MV_MARKS_KEY = 'bilibili_local_mv_marks'

export function getLocalMvMarks(): LocalMvMark[] {
  try {
    const raw = localStorage.getItem(LOCAL_MV_MARKS_KEY)
    const parsed = raw ? (JSON.parse(raw) as LocalMvMark[]) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function getLocalMvMark(songKey: string): LocalMvMark | null {
  return getLocalMvMarks().find((m) => m.songKey === songKey) || null
}

/** 保存标记：同时写入 override（下次匹配直接播该视频） */
export function saveLocalMvMark(mark: Omit<LocalMvMark, 'markedAt'>): void {
  const list = getLocalMvMarks().filter((m) => m.songKey !== mark.songKey)
  list.unshift({ ...mark, markedAt: Date.now() })
  try {
    localStorage.setItem(LOCAL_MV_MARKS_KEY, JSON.stringify(list))
  } catch {
    // 忽略
  }
  setBilibiliOverride(mark.songKey, mark.bvid)
}

/** 移除标记：仅当 override 指向该 bvid 时一并清除 override */
export function removeLocalMvMark(songKey: string): void {
  const mark = getLocalMvMark(songKey)
  const list = getLocalMvMarks().filter((m) => m.songKey !== songKey)
  try {
    localStorage.setItem(LOCAL_MV_MARKS_KEY, JSON.stringify(list))
  } catch {
    // 忽略
  }
  if (mark && getBilibiliOverride(songKey) === mark.bvid) clearBilibiliOverride(songKey)
}

/** 该歌的黑名单 bvid 列表（"不喜欢"记忆，匹配/回退时排除） */
export function getBilibiliBlacklist(songKey: string): string[] {
  try {
    const raw = localStorage.getItem(`bilibili_blacklist_${songKey}`)
    const parsed = raw ? (JSON.parse(raw) as string[]) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function addBilibiliBlacklist(songKey: string, bvid: string): string[] {
  const next = Array.from(new Set([...getBilibiliBlacklist(songKey), bvid]))
  try {
    localStorage.setItem(`bilibili_blacklist_${songKey}`, JSON.stringify(next))
  } catch {
    // 忽略
  }
  return next
}

// ===== 全流程：查找并匹配当前歌曲的 B 站视频 =====

const TOP_CONFIRM_COUNT = 12
const REVIEW_TOP_N = 8

/** 复审缓存的字幕条目：清洗后的分段（原始内容，供歌词比对），有 CC 才抓取 */
interface ReviewSubtitleSegment { from: number; text: string }
/** 复审 view/字幕的全局 bvid 缓存（跨歌曲复用，1h TTL；LRU 上限防无界增长） */
const reviewCache = new Map<string, { at: number; officialVerifyType: number; cid: number; manualZh: boolean; autoZh: boolean; effectiveDuration: number; subLines?: ReviewSubtitleSegment[] }>()

/**
 * 清除 MV 匹配缓存：24h 内存匹配结果 + 复审缓存 + 手动标记/黑名单（localStorage）。
 * 匹配结果异常（评分规则更新 / 候选变化 / 用户想换一个视频）时使用；清除后重搜生效。
 */
export function clearAllMvMatchCache(): void {
  matchCache.clear()
  reviewCache.clear()
  try {
    const keys: string[] = []
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i)
      if (k && (k.startsWith('bilibili_override_') || k.startsWith('bilibili_blacklist_'))) keys.push(k)
    }
    for (const k of keys) localStorage.removeItem(k)
  } catch {
    /* 忽略 */
  }
}
const REVIEW_CACHE_TTL = 60 * 60 * 1000
const REVIEW_CACHE_MAX = 400

function pruneReviewCache() {
  const now = Date.now()
  for (const [key, entry] of reviewCache) {
    if (now - entry.at > REVIEW_CACHE_TTL) reviewCache.delete(key)
  }
  if (reviewCache.size > REVIEW_CACHE_MAX) {
    const sorted = [...reviewCache.entries()].sort((a, b) => a[1].at - b[1].at)
    while (reviewCache.size > REVIEW_CACHE_MAX && sorted.length) {
      const oldest = sorted.shift()
      if (oldest) reviewCache.delete(oldest[0])
    }
  }
}

/** 按偏好构建搜索关键词列表（多元拆分：原文标题+歌手 → 逐歌手 → 仅标题 → 标题+MV → 偏好词） */
export function buildQueries(song: MatchContext, settings?: Pick<BilibiliWatchSettings, 'matchPreference' | 'keywordTemplate' | 'customKeywordTemplate'>): string[] {
  const title = cleanSongTitle(song.songTitle)
  const resolvedArtists = resolveArtistNames(song.artists || [])
  const artists = resolvedArtists.raw
  const artist = (song.artists || []).map((value) => String(value).trim()).filter(Boolean).join(' ')
  const template = settings?.keywordTemplate ?? 'auto'
  if (template === 'custom') {
    const custom = (settings?.customKeywordTemplate || '').trim()
    if (custom) {
      const rendered = custom.replace(/\{title\}/g, title).replace(/\{artist\}/g, artist).trim()
      if (rendered) return [rendered]
    }
  }
  if (template === 'title-artist') return [artist ? `${title} ${artist}`.trim() : title]
  if (template === 'title-mv') return [`${title} MV`]

  const queries: string[] = []
  // 1. 原文标题 + 全部歌手（首选；日韩等原文标题直接搜原文，中文仅作辅助）
  if (artist) queries.push(`${title} ${artist}`.trim())
  const franchiseNames = resolveFranchiseNames(song.franchise)
  for (const franchise of franchiseNames) queries.push(`${title} ${franchise}`.trim())
  // 2. 逐个歌手 + 歌手别名尝试（如 宇多田光 ↔ 宇多田ヒカル，B 站标题两种写法都常见）
  const artistVariants: string[] = []
  for (const a of artists) {
    const q = `${title} ${a}`.trim()
    if (q && !queries.includes(q)) queries.push(q)
  }
  for (const aliasNorm of resolvedArtists.aliases.slice(0, 4)) {
    const alias = Object.values(ARTIST_ALIASES).flat().find((value) => normalizeText(value) === aliasNorm) || aliasNorm
    const aq = `${title} ${alias}`.trim()
    if (aq && !queries.includes(aq) && !artistVariants.includes(aq)) artistVariants.push(aq)
  }
  // 别名查询放在歌手主查询之后、仅标题之前
  for (const aq of artistVariants) queries.push(aq)
  // 3. 仅原文标题
  if (!queries.includes(title)) queries.push(title)
  // 4. 标题 + MV
  queries.push(`${title} MV`)

  const preference = settings?.matchPreference ?? 'balanced'
  if (preference === 'official') queries.push(`${title} ${artist} 官方`.trim(), `${title} 官方MV`.trim())
  else if (preference === 'live') queries.push(`${title} ${artist} 现场`.trim(), `${title} 演唱会`.trim())
  else if (preference === 'lyrics') queries.push(`${title} 歌词`.trim(), `${title} 字幕`.trim())
  else if (preference === 'hd') queries.push(`${title} 4K`.trim(), `${title} 高清`.trim())

  // Project SEKAI（pjsk）乐队：追加游戏关键词查询，召回官方 2DMV/资讯站精品上传
  if (artists.some((a) => /leoneed|more\s*more\s*jump|vivid\s*bad\s*squad|wonderlands|ナイトコード|25時/i.test(String(a)))) {
    queries.push(`${title} 世界计划`.trim(), `${title} pjsk`.trim(), `${title} Project SEKAI`.trim())
  }
  const uniqueQueries: string[] = []
  const seenQueries = new Set<string>()
  for (const query of queries) {
    const key = normalizeText(query)
    if (!key || seenQueries.has(key)) continue
    seenQueries.add(key)
    uniqueQueries.push(query)
  }
  return uniqueQueries.slice(0, 10)
}

/** 近重复标题去重：保留综合评分更高者（评分含时长贴近/歌手/播放量）。
 *  纯按播放量去重会把"时长精确匹配的正片"丢掉——如「NIKIIE-春夏秋冬」(306s=歌曲时长)
 *  与「【nikiie】春夏秋冬」(209s) 规范化后同名，保留高播放版会让时长贴近的加分消失。 */
export function dedupeCandidates<T extends { video: BilibiliVideo; score?: number }>(list: T[]): T[] {
  const seen = new Map<string, T>()
  for (const c of list) {
    const norm = normalizeText(c.video.title)
    const prev = seen.get(norm)
    if (!prev || (c.score ?? -Infinity) > (prev.score ?? -Infinity)) seen.set(norm, c)
  }
  return Array.from(seen.values())
}

/**
 * 从多 P（选集）视频中挑选最匹配歌曲的分 P：
 * 分 P 标题命中歌名/歌手加分；有演唱版（on vocal / オンボーカル / 原唱）优先；
 * 伴奏/无演唱（off vocal / インスト / カラオケ）降权；纯编号标题不参与。
 */
export function pickBestPage(
  pages: BilibiliViewData['pages'],
  ctx: { songTitle: string; artists: string[] },
): number {
  if (!pages || pages.length <= 1) return 0
  const songNorm = normalizeText(cleanSongTitle(ctx.songTitle))
  const artistNormList = ctx.artists.map((a) => normalizeText(a)).filter((a) => a.length >= 2)
  let bestIndex = 0
  let bestScore = -Infinity
  pages.forEach((p, index) => {
    const partNorm = normalizeText(p.part || '')
    if (!partNorm || /^\d{1,3}$/.test(partNorm)) return // 纯编号分 P 不参与
    let score = 0
    if (songNorm && partNorm.includes(songNorm)) score += 30
    if (artistNormList.some((a) => partNorm.includes(a))) score += 10
    if (/on\s*vocal|オンボーカル|ボーカル|原唱|mv|music\s*video|完整版|正式版/.test(partNorm)) score += 25
    if (/off\s*vocal|インスト|inst|instrumental|伴奏|カラオケ|karaoke|純音乐|纯音乐|无人声/.test(partNorm)) score -= 35
    if (score > bestScore) {
      bestScore = score
      bestIndex = index
    }
  })
  return bestIndex
}

/** 按偏好调整后的字幕标记 */
function applyPreferenceToReview(review: { manualZh: boolean; autoZh: boolean }, preference: MatchPreference): { manualZhSubtitle: boolean; autoSubtitle: boolean } {
  if (preference === 'lyrics') {
    // 歌词/字幕偏好下，AI 字幕也可作为正向信号
    return { manualZhSubtitle: review.manualZh, autoSubtitle: review.autoZh || review.manualZh }
  }
  return { manualZhSubtitle: review.manualZh, autoSubtitle: review.autoZh }
}

/** 复审候选（view 拿 cid/作者认证 + 字幕 + CC 内容歌词比对），带全局 bvid 缓存。
 *  lyricsText：平台歌词（含翻译，flattenLyricLinesForMatch 产物）；为空时 CC 一律按 unverified 缩水档，
 *  绝不为验证歌词额外等待网络——验证是"顺路"增强，不能拖慢匹配。 */
async function reviewCandidates(
  candidates: CandidateScore[],
  ctx: MatchContext,
  preference: MatchPreference,
  signal?: AbortSignal,
  lyricsText?: string,
): Promise<CandidateScore[]> {
  // 复审候选数固定为 8；每个候选可能包含 view、字幕目录和一条字幕正文请求。
  const top = candidates.slice(0, REVIEW_TOP_N)
  const reviewed = await Promise.all(
    top.map(async (candidate) => {
      const bvid = candidate.video.bvid
      let cached = reviewCache.get(bvid)
      if (!cached || Date.now() - cached.at > REVIEW_CACHE_TTL) {
        try {
          const view = await getBilibiliView(bvid, signal)
          let officialVerifyType = -1
          let cid = 0
          let effectiveDuration = 0
          let manualZh = false
          let autoZh = false
          let subLines: ReviewSubtitleSegment[] | undefined
          if (view.code === 0) {
            officialVerifyType = view.data.owner.officialVerifyType
            // 多 P（选集）视频：选择最匹配歌曲的分 P —— 该 P 的 cid 直接用于播放，
            // 该 P 时长用于评分（视频总时长对多版本合集无意义，避免错误重罚）
            if (Array.isArray(view.data.pages) && view.data.pages.length > 1) {
              const bestIndex = pickBestPage(view.data.pages, ctx)
              const chosen = view.data.pages[bestIndex]
              if (chosen) {
                cid = chosen.cid
                effectiveDuration = chosen.duration || 0
              }
            }
            if (!cid) cid = view.data.cid
            if (!effectiveDuration) effectiveDuration = view.data.duration || 0
            if (cid) {
              const subInfo = await getBilibiliSubtitles(bvid, cid, signal).catch(
                () => ({ code: -1, subtitles: [] as BilibiliSubtitleInfo[] }),
              )
              if (subInfo.code === 0 && subInfo.subtitles.length) {
                let chosenSub: BilibiliSubtitleInfo | null = null
                for (const s of subInfo.subtitles) {
                  if (/zh|中文/i.test(`${s.lan}${s.lanDoc}`)) {
                    if (s.aiType === 0) manualZh = true
                    else autoZh = true
                    // 比对用字幕内容：优先人工字幕，其次 AI 字幕（只取一条，不额外多打请求）
                    if (!chosenSub || s.aiType === 0) chosenSub = s
                  }
                }
                // CC 内容抓取：仅限有 CC 的候选（多数视频 0 次），且与复审并行不串行；
                // 内容进 1h 全局缓存——预加载时抓过，切歌命中 24h 匹配缓存后重扫零网络
                if ((manualZh || autoZh) && chosenSub) {
                  const json = await getBilibiliSubtitleJson(chosenSub.cacheKey, signal).catch(() => [])
                  subLines = (cleanSubtitleLines(json) || [])
                    .flatMap((l) => String(l?.content || '').split('\n').map((part) => ({ from: Number(l?.from) || 0, text: part.trim() })))
                    .filter((s) => s.text)
                }
              }
            }
          }
          cached = { at: Date.now(), officialVerifyType, cid, manualZh, autoZh, effectiveDuration, subLines }
          reviewCache.set(bvid, cached)
          pruneReviewCache()
        } catch {
          cached = { at: Date.now(), officialVerifyType: -1, cid: 0, manualZh: false, autoZh: false, effectiveDuration: 0 }
          reviewCache.set(bvid, cached)
          pruneReviewCache()
        }
      }
      const { manualZhSubtitle, autoSubtitle } = applyPreferenceToReview(cached, preference)
      // CC 内容 ↔ 歌词比对：有 CC 且有歌词才可比；无歌词时按 unverified 缩水档（不惩罚）
      let ccVerification: CCVerification = 'unverified'
      if ((cached.manualZh || cached.autoZh) && lyricsText) {
        ccVerification = compareSubtitleWithLyrics(cached.subLines, lyricsText).verdict
      }
      const rescored = scoreCandidate(candidate.video, ctx, {
        rank: candidate.rank,
        officialVerifyType: cached.officialVerifyType,
        manualZhSubtitle,
        autoSubtitle,
        preference,
        effectiveDuration: cached.effectiveDuration,
        ccVerification,
      })
      return { ...rescored, cid: cached.cid, effectiveDuration: cached.effectiveDuration, ccVerification }
    }),
  )
  const reviewedSet = new Set(reviewed.map((c) => c.video.bvid))
  const rest = candidates.filter((c) => !reviewedSet.has(c.video.bvid))
  return [...reviewed, ...rest].sort(compareCandidates)
}

/** 缓存命中但匹配时无歌词可比的候选：拿到歌词后用复审缓存的字幕内容纯本地重扫（零网络、微秒级）。
 *  记忆视频仍无条件置顶；门槛按设置重算（重扫后过线则 confirm 升为 auto）。
 *  reviewLookup 供测试注入复审缓存桩（生产默认 reviewCache）。 */
export function rescoreResultWithLyrics(
  result: BilibiliMatchResult,
  song: MatchContext,
  settings: Pick<BilibiliWatchSettings, 'matchPreference' | 'autoPlayStrictness' | 'forceAutoPlayHighest'>,
  lyricsText: string,
  overrideBvid: string,
  reviewLookup: (bvid: string) => { manualZh?: boolean; autoZh?: boolean; subLines?: Array<{ from?: number; text?: string }>; cid?: number } | undefined = (bvid) => reviewCache.get(bvid),
): BilibiliMatchResult {
  if (!result.ccUnverifiedWithoutLyrics || !result.fallbackChain.length) return result
  const preference = settings.matchPreference
  const rescored = result.fallbackChain.map((c) => {
    const rc = reviewLookup(c.video.bvid)
    let ccVerification: CCVerification = 'unverified'
    if (rc && (rc.manualZh || rc.autoZh)) ccVerification = compareSubtitleWithLyrics(rc?.subLines, lyricsText).verdict
    const s = scoreCandidate(c.video, song, {
      rank: c.rank,
      officialVerifyType: c.officialVerifyType,
      manualZhSubtitle: c.manualZhSubtitle,
      autoSubtitle: c.autoSubtitle,
      preference,
      effectiveDuration: c.effectiveDuration,
      ccVerification,
    })
    return { ...s, cid: c.cid ?? rc?.cid ?? 0, effectiveDuration: c.effectiveDuration, ccVerification }
  }).sort(compareCandidates)
  let chain = rescored
  let best = rescored[0]
  if (overrideBvid) {
    const remembered = rescored.find((c) => c.video.bvid === overrideBvid)
    if (remembered) {
      chain = [remembered, ...rescored.filter((c) => c.video.bvid !== overrideBvid)]
      best = remembered
    }
  }
  let status: BilibiliMatchStatus
  if (!best) status = 'none'
  else if (overrideBvid) status = 'auto'
  else if (settings.forceAutoPlayHighest || shouldAutoPlay(best, settings.autoPlayStrictness)) status = 'auto'
  else status = 'confirm'
  const ccUnverifiedWithoutLyrics = rescored.some((c) => (c.manualZhSubtitle || c.autoSubtitle) && c.ccVerification === 'unverified') && !lyricsText
  return { status, best, candidates: chain.slice(0, TOP_CONFIRM_COUNT), fallbackChain: chain, ccUnverifiedWithoutLyrics: ccUnverifiedWithoutLyrics || undefined }
}

export async function findBestBilibiliMv(
  song: MatchContext,
  opts?: {
    signal?: AbortSignal
    settings?: Partial<BilibiliWatchSettings>
    /** 同步取当前歌歌词（含翻译，flattenLyricLinesForMatch 产物）。仅用于 CC 字幕内容验证：
     *  匹配时已加载就传入（验证 +25/-20 分档），没加载就返回空（unverified 缩水档）——绝不为此等待网络。 */
    lyricsProvider?: () => string | null | undefined
  },
): Promise<BilibiliMatchResult> {
  const settings = { ...DEFAULT_WATCH_SETTINGS, ...(opts?.settings || getBilibiliWatchSettings()) }
  // 缓存键必须包含设置指纹：偏好/门槛/模板/强制最高分不同 → 匹配结果（排序与门槛判定）不同
  // 手动选择记忆（override）也入指纹：用户换了记忆视频后不能继续命中旧缓存（旧 best 会盖过新选择）
  const songKey = songKeyOf(song)
  const overrideBvid = settings.useRememberedOverride ? (getBilibiliOverride(songKey) || '') : ''
  const settingsFingerprint = [
    MATCH_SCORE_VERSION,
    settings.matchPreference,
    settings.autoPlayStrictness,
    settings.keywordTemplate,
    settings.customKeywordTemplate,
    settings.forceAutoPlayHighest ? 'force' : 'gate',
    overrideBvid,
  ].join('|')
  const cacheKey = `${songKey}::${settingsFingerprint}`
  const cached = matchCache.get(cacheKey)
  if (cached && Date.now() - cached.at < MATCH_CACHE_TTL) {
    // 命中缓存但当时无歌词可比：现在有歌词了 → 用缓存的字幕内容零网络重扫升级（CC 验证分档生效）
    const lyricsText = String(opts?.lyricsProvider?.() || '').trim()
    if (lyricsText && cached.result.ccUnverifiedWithoutLyrics) {
      const upgraded = rescoreResultWithLyrics(cached.result, song, settings, lyricsText, overrideBvid)
      if (upgraded !== cached.result) matchCache.set(cacheKey, { at: cached.at, result: upgraded })
      return upgraded
    }
    return cached.result
  }
  const result = await findBestBilibiliMvUncached(song, cacheKey, settings, opts?.signal, opts?.lyricsProvider)
  matchCache.set(cacheKey, { at: Date.now(), result })
  pruneMatchCache()
  return result
}

async function findBestBilibiliMvUncached(
  song: MatchContext,
  cacheKey: string,
  settings: BilibiliWatchSettings,
  signal?: AbortSignal,
  lyricsProvider?: () => string | null | undefined,
): Promise<BilibiliMatchResult> {
  // override/黑名单按歌曲存储键读写（与缓存键分离：不含设置指纹）
  const songKey = songKeyOf(song)
  const empty = (error?: string): BilibiliMatchResult => ({ status: 'error', candidates: [], fallbackChain: [], error })
  const blacklist = new Set(getBilibiliBlacklist(songKey))
  // 歌词同步取一次（调用方已加载就用；没有就整轮按 unverified 缩水档，不等待网络）
  const lyricsText = String(lyricsProvider?.() || '').trim()
  /** 匹配轮次收尾：无歌词时有候选拿着 CC 缩水分 → 标记，供拿到歌词后零网络重扫升级 */
  const finish = (result: BilibiliMatchResult): BilibiliMatchResult => {
    if (!lyricsText && result.fallbackChain.some((c) => (c.manualZhSubtitle || c.autoSubtitle) && c.ccVerification === 'unverified')) {
      result.ccUnverifiedWithoutLyrics = true
    }
    return result
  }

  // 0. 用户手动选择记忆：优先播放该视频，但不短路——完整搜索照常跑，
  //    候选列表保留全部结果（否则列表只剩记忆视频一个，用户无法换回其他 MV）。
  let rememberedOverride: CandidateScore | null = null
  if (settings.useRememberedOverride) {
    const overrideBvid = getBilibiliOverride(songKey)
    if (overrideBvid) {
      try {
        const view = await getBilibiliView(overrideBvid, signal)
        if (view.code === 0 && view.data.cid) {
          const video: BilibiliVideo = {
            bvid: overrideBvid,
            title: view.data.title,
            duration: view.data.duration,
            play: view.data.play || 0,
            author: view.data.owner.name,
            pic: view.data.pic,
          }
          const scored = await reviewCandidates([scoreCandidate(video, song, { officialVerifyType: view.data.owner.officialVerifyType, preference: settings.matchPreference })], song, settings.matchPreference, signal, lyricsText)
          rememberedOverride = scored[0] || null
        }
      } catch {
        // 覆盖视频失效 → 清除记忆走正常搜索
        clearBilibiliOverride(songKey)
      }
    }
  }
  /** 记忆视频直接播放（搜索失败/无候选时也要能放记忆的视频） */
  const rememberedOnly = (): BilibiliMatchResult | null =>
    rememberedOverride ? finish({ status: 'auto', best: rememberedOverride, candidates: [rememberedOverride], fallbackChain: [rememberedOverride] }) : null

  // 1. 偏好感知多查询搜索（前两页提升召回）
  const queries = buildQueries(song, settings)
  const seenBvids = new Set<string>()
  let videos: BilibiliVideo[] = []
  for (const query of queries) {
    try {
      const [r1, r2] = await Promise.all([
        searchBilibiliVideos(query, 1, signal),
        searchBilibiliVideos(query, 2, signal).catch(() => ({ code: -1, results: [] as BilibiliVideo[] })),
      ])
      const merged = [...(r1.code === 0 ? r1.results : []), ...(r2.code === 0 ? r2.results : [])]
      for (const v of merged) {
        if (!v.bvid || seenBvids.has(v.bvid)) continue
        seenBvids.add(v.bvid)
        videos.push(v)
      }
    } catch (error) {
      if (signal?.aborted) return empty()
      // 单查询失败不阻断（风控/超时降级继续）
    }
    if (videos.length >= 60) break
  }
  if (!videos.length) return rememberedOnly() || empty('搜索失败，请稍后重试')

  // 2. 初筛打分（硬淘汰无关 + 黑名单剔除 + 排名信号）
  let candidates = videos
    .map((v, index) => scoreCandidate(v, song, { rank: index, preference: settings.matchPreference }))
    .filter((c) => c.score !== -Infinity && !blacklist.has(c.video.bvid))
    .sort(compareCandidates)

  if (!candidates.length) return rememberedOnly() || { status: 'none', candidates: [], fallbackChain: [] }

  // 3. 前 8 名复审（作者认证 + 字幕 + CC 内容歌词比对，全局 bvid 缓存）。
  // 同标题稿件必须先完成来源复审再去重，否则社区转载可能在官号认证加分前将其挤掉。
  candidates = await reviewCandidates(candidates, song, settings.matchPreference, signal, lyricsText)
  candidates = dedupeCandidates(candidates).sort(compareCandidates)

  // 4. 排序取最佳 + 门槛判定（forceAutoPlayHighest 开启时直接播评分最高，跳过确认）
  let fallbackChain = candidates
  let best = fallbackChain[0]
  if (rememberedOverride) {
    // 记忆视频前置为 best（用户显式选择，无条件播放），但完整候选链保留——
    // 记忆视频失效时可沿链回退，用户也能在列表里换回其他 MV
    fallbackChain = [rememberedOverride, ...fallbackChain.filter((c) => c.video.bvid !== rememberedOverride.video.bvid)]
    best = rememberedOverride
  }
  const topCandidates = fallbackChain.slice(0, TOP_CONFIRM_COUNT)
  if (rememberedOverride || !best) {
    if (!best) return { status: 'none', candidates: [], fallbackChain: [] }
    return finish({ status: 'auto', best, candidates: topCandidates, fallbackChain })
  }
  if (settings.forceAutoPlayHighest || shouldAutoPlay(best, settings.autoPlayStrictness)) {
    return finish({ status: 'auto', best, candidates: topCandidates, fallbackChain })
  }
  return finish({ status: 'confirm', candidates: topCandidates, fallbackChain })
}
