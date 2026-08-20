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
    officialVerifyType: number // -1 未知 / 0 未认证 / 1 个人认证 / 2 机构认证
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
  /** 复审拿到的作者认证：-1 未知 / 0 未认证 / 1 个人 / 2 机构 */
  officialVerifyType: number
  manualZhSubtitle: boolean
  autoSubtitle: boolean
  /** 复审拿到的 cid（供播放地址使用，0 = 未复审） */
  cid?: number
  type: CandidateType
}

export type BilibiliMatchStatus = 'auto' | 'confirm' | 'none' | 'error'

export interface BilibiliMatchResult {
  status: BilibiliMatchStatus
  /** status==='auto' 时存在 */
  best?: CandidateScore
  /** 候选列表（confirm 态展示，最多 5 条） */
  candidates: CandidateScore[]
  /** 全部排序候选（自动回退链：首选失败时依次尝试，跳过失效/受限/黑名单） */
  fallbackChain: CandidateScore[]
  error?: string
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
}

export const WATCH_SETTINGS_EVENT = 'bilibili-settings-changed'
const SETTINGS_KEY = 'bilibili_watch_settings'

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
  forceAutoPlayHighest: true,
}

export function getBilibiliWatchSettings(): BilibiliWatchSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return { ...DEFAULT_WATCH_SETTINGS }
    return { ...DEFAULT_WATCH_SETTINGS, ...(JSON.parse(raw) as Partial<BilibiliWatchSettings>) }
  } catch {
    return { ...DEFAULT_WATCH_SETTINGS }
  }
}

export function saveBilibiliWatchSettings(patch: Partial<BilibiliWatchSettings>): BilibiliWatchSettings {
  const next = { ...getBilibiliWatchSettings(), ...patch }
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next))
  } catch {
    // 忽略存储失败
  }
  window.dispatchEvent(new CustomEvent(WATCH_SETTINGS_EVENT, { detail: next }))
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
  '翻唱', 'cover', '教学', '教程', '讲解', '指弹', '演奏', '钢琴', '吉他',
  '笛子', '古筝', '二胡', '萨克斯', '伴奏', 'remix', '鬼畜', '修复', '卡拉ok', 'k歌',
  '鼓谱', '架子鼓', '弹唱', '跟练', '扒谱', '练唱', '音游', '手元', '谱面', '全连', 'gameplay',
  '学日语', '学唱歌', '听歌学', '纯人声', '红石音乐',
]
/** 合集/盘点类标题：包含多首歌，通常不是单曲正片 */
const COMPILATION_MARKERS = ['合集', '串烧', '盘点', '榜单', '精选歌', '歌单', '经典歌曲', '怀旧金曲', 'top50', 'top10', '100首', '50首']
const POSITIVE_EXTRA_MARKERS = ['歌词', '字幕', '4k', '1080p', '正式版', '预告', '中字', '高清', '超清']
/** 正片增强标记：动漫/剧集主题曲 MV、加长版、完整版更可能是完整正片（用户反馈红莲华场景） */
const POSITIVE_SONG_MARKERS = ['主题曲', '主題曲', '主题歌', '主題歌', 'テーマソング', '加长版', '加長版', '完整版']
const LIVE_MARKERS = ['live', '现场', '演唱会', 'livehouse', '音乐节', 'live版']
/** 乐器/曲谱类标题（演奏向，多为翻弹/教学，非正片） */
const INSTRUMENT_MARKERS = [
  '钢琴', '吉他', '指弹', '演奏', '笛子', '古筝', '二胡', '萨克斯', '伴奏', '鼓谱', '架子鼓', '扒谱',
  '琴谱', '乐谱', '简谱', '口琴', '尤克里里', 'ukulele', '小提琴', '大提琴', '长笛', '琵琶', '古琴', '箫', '笛',
  '吉他谱', '钢琴谱', '铃铛', '竖琴', '扬琴', '手风琴',
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
  const segments = full.split(/\s+(?:feat(?:uring)?|ft)\.?\s+|\s*&\s*|,|，|、|;|；|\||\//gi)
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
  'qq音乐', '官方频道', 'official', 'jvr',
  // 动漫/游戏音乐官方渠道：官方发布或高播放的一般都是精品（HOYO-MiX/原神/崩坏/鸣潮/明日方舟/pjsk 等）
  'hoyomix', 'hoyo-mix', '米哈游', 'mihoyo', '原神', '崩坏', '星穹铁道', '绝区零',
  '鸣潮', '库洛', 'kuro games', '明日方舟', 'arknights', '鹰角', 'hypergryph',
  'project_sekai', 'project sekai', '世界计划', 'プロジェクトセカイ', 'sega',
  'cygames', '赛马娘', '公主连结', 'fgo', 'bang dream', 'bangdream', 'lovelive', 'ラブライブ',
  '初音ミク', 'vocaloid', '歌姬计划',
]

/** 精品社区/资讯站频道（非官方但内容质量稳定：翻译组、游戏资讯站等），加分低于官方 */
const QUALITY_COMMUNITY_KEYWORDS = [
  '汉化组', '字幕组', 'Project_SEKAI资讯站', 'pjsk', 'sekaiofficial',
]

/** 候选类型识别（标题标记驱动） */
export function classifyCandidateType(title: string): CandidateType {
  const t = normalizeText(title)
  if (INSTRUMENT_MARKERS.some((m) => t.includes(m))) return 'instrumental'
  if (/翻唱|cover|弹唱/.test(t)) return 'cover'
  if (LIVE_MARKERS.some((m) => t.includes(m))) return 'live'
  if (OFFICIAL_MARKERS.some((m) => t.includes(m)) || MV_MARKERS.some((m) => t.includes(m))) return 'official'
  if (/歌词|字幕/.test(t)) return 'lyrics'
  return 'other'
}

export function scoreCandidate(
  video: BilibiliVideo,
  ctx: MatchContext,
  extra?: {
    rank?: number
    officialVerifyType?: number
    manualZhSubtitle?: boolean
    autoSubtitle?: boolean
    preference?: MatchPreference
    /** 多 P 视频的选中分 P 时长（用于时长贴近评分） */
    effectiveDuration?: number
  },
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
    ccSubtitle: Boolean(extra?.manualZhSubtitle || extra?.autoSubtitle),
  }

  // 硬淘汰：任一歌名变体未完整出现在视频标题 → 无关视频，直接丢弃
  if (!songTitleVariants.length || !songTitleVariants.some((t) => titleNorm.includes(t))) {
    return { video, score: -Infinity, signals, rank, officialVerifyType: extra?.officialVerifyType ?? -1, manualZhSubtitle: false, autoSubtitle: false, type: classifyCandidateType(video.title) }
  }

  let score = 100 // 歌名完整命中
  // 歌手名自动拆解（跨平台）：feat/分隔符拆多歌手 + 去括号中文翻译变体
  const artistNames: string[] = []
  for (const a of ctx.artists) {
    for (const name of expandArtistNames(String(a))) {
      const n = normalizeText(name)
      if (n.length >= 2 && !artistNames.includes(n)) artistNames.push(n)
    }
  }
  const artistNormList = artistNames
  // 歌手别名匹配：标题写「宇多田ヒカル」而歌手字段是「宇多田光」也能命中。
  // 查表键优先原始名，其次规范化名；QQ 音乐等平台的歌手字段常带「 (中文名｡)」后缀，
  // 规范化后仍包含纯日文名（如「ずっと真夜中でいいのに」），故再做"规范化名包含表键"兜底。
  const aliasNormList: string[] = []
  const pushAlias = (alias: string): void => {
    const n = normalizeText(alias)
    if (n.length >= 2) aliasNormList.push(n)
  }
  for (const a of ctx.artists) {
    for (const name of expandArtistNames(String(a))) {
      const norm = normalizeText(name)
      for (const key of [name, norm]) {
        for (const alias of ARTIST_ALIASES[key] || []) pushAlias(alias)
      }
      // 兜底：规范化歌手名包含某个表键 → 收集其别名（ZUTOMAYO 官方 MV 场景）
      if (norm.length >= 2) {
        for (const key of Object.keys(ARTIST_ALIASES)) {
          const kn = normalizeText(key)
          if (kn.length >= 2 && norm.includes(kn)) {
            for (const alias of ARTIST_ALIASES[key]) pushAlias(alias)
          }
        }
      }
    }
  }
  if (artistNormList.some((a) => titleNorm.includes(a)) || aliasNormList.some((a) => titleNorm.includes(a))) {
    score += 20
    signals.hasArtist = true
  }

  // 官号识别（借鉴 ECHO findArtistEvidence）：作者名命中歌手/别名 → 音乐人本人官号，强正片信号。
  // 作者名完全等于歌手（或别名）最高置信；包含歌手次之（如「周杰伦官方」）。官方频道关键词在下方单独计分。
  const authorNorm = normalizeText(video.author)
  if (artistNormList.some((a) => authorNorm === a) || aliasNormList.some((a) => authorNorm === a)) {
    score += 25
    signals.uploaderMatchesArtist = true
  } else if (artistNormList.some((a) => authorNorm.includes(a)) || aliasNormList.some((a) => authorNorm.includes(a))) {
    score += 15
    signals.uploaderMatchesArtist = true
  }

  // 精确命中：标题主体与歌名完全一致（如「晴天」或「周杰伦 - 晴天」），高置信正片
  const exactTitle = normalizeText(video.title.replace(/^(【[^】]*】)?\s*/, '').trim())
  if (exactTitle === songTitleNorm) score += 30
  // 标题即「歌手 - 歌名」形态（无任何多余标记），视为完整正片
  const dashForm = titleNorm.replace(/^([^-]{2,20})-([^-]{1,20})$/, '$1-$2')
  if (dashForm !== titleNorm && artistNormList.some((a) => titleNorm.startsWith(a))) score += 15

  // 歌名不含歌手（无歌手证据）：可能是同名的其它歌曲（货不对板防御，任何歌名长度都适用——
  // 否则同名不同歌手的官方 MV 会靠官方/播放加成胜出，如 SawanoHiroyuki 与 NMIXX 的 Roller Coaster）
  if (!signals.hasArtist) score -= 35
  // 短歌名易撞车：额外重罚
  if (songTitleNorm.length <= 4 && !signals.hasArtist) score -= 15
  // 未命中歌手 + 却带官方/MV 标记 → 极可能是"别的歌手的官方MV"（张冠李戴，如王艺瑾-喜欢你），再重罚
  if (!signals.hasArtist && (signals.officialMarker || signals.mvMarker)) score -= 40

  // 分区
  if (video.typename === '音乐') score += 15
  else if (video.typename && ['影视剪辑', '日常', '游戏', '知识', '生活'].includes(video.typename)) score -= 20

  // 标题标记
  for (const m of OFFICIAL_MARKERS) if (titleNorm.includes(m)) score += 25
  for (const m of MV_MARKERS) if (titleNorm.includes(m)) score += 15
  for (const m of NEGATIVE_MARKERS) if (titleNorm.includes(m)) score -= 35
  for (const m of COMPILATION_MARKERS) if (titleNorm.includes(m)) score -= 60
  for (const m of POSITIVE_EXTRA_MARKERS) if (titleNorm.includes(m)) score += 10
  // 正片增强：主题曲/加长版/完整版 → 完整正片信号（独立加权，避免和正向标记叠加混淆）
  for (const m of POSITIVE_SONG_MARKERS) if (titleNorm.includes(m)) score += 12
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
  if (LIVE_MARKERS.some((m) => titleNorm.includes(m)) && (extra?.preference ?? 'balanced') !== 'live') score -= 5

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

  // OP/ED 但视频是 TV 版短时长（约 1分30秒 ±20秒 = 70~110s）：虽然相关但是片头片尾短版，
  // 听歌要的是完整版 → 降级，让同曲的完整版/MV 排到前面
  if (isOpEdTitle && compareDuration >= 70 && compareDuration <= 110) score -= 25

  // 播放量（对数加权，热门更可能是正片）
  if (video.play > 0) score += Math.min(30, Math.log10(video.play) * 6)

  // 搜索排名（B 站相关度顺序是强信号，靠前的轻微加权）
  score += Math.max(0, 15 - rank) * 0.8

  // 官方频道关键词（作者名命中，authorNorm 已在歌手匹配段计算）
  if (OFFICIAL_CHANNEL_KEYWORDS.some((k) => authorNorm.includes(k))) score += 25
  // 精品社区/资讯站频道（翻译组、游戏资讯站等，非官方但质量稳定）
  if (QUALITY_COMMUNITY_KEYWORDS.some((k) => authorNorm.includes(k))) score += 15

  // 复审增强
  const officialVerifyType = extra?.officialVerifyType ?? -1
  const manualZhSubtitle = Boolean(extra?.manualZhSubtitle)
  const autoSubtitle = Boolean(extra?.autoSubtitle)
  if (officialVerifyType === 2) score += 30
  else if (officialVerifyType === 1) score += 15
  // 官号 + 个人认证：作者=歌手且通过个人认证 → 音乐人本人官方账号，额外加成
  if (signals.uploaderMatchesArtist && officialVerifyType === 1) score += 10
  // CC 字幕（B 站字幕）权重：人工中文字幕最高，AI 字幕次之
  if (manualZhSubtitle) score += 25
  else if (autoSubtitle) score += 10

  // 偏好加权
  const preference = extra?.preference ?? 'balanced'
  const type = classifyCandidateType(video.title)
  score += preferenceAdjustment(type, preference, signals)

  return { video, score, signals, rank, officialVerifyType, manualZhSubtitle, autoSubtitle, type }
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
  const strong =
    candidate.signals.officialMarker ||
    candidate.officialVerifyType >= 1 ||
    candidate.manualZhSubtitle ||
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

const TOP_CONFIRM_COUNT = 8
const REVIEW_TOP_N = 8

/** 复审 view/字幕的全局 bvid 缓存（跨歌曲复用，1h TTL；LRU 上限防无界增长） */
const reviewCache = new Map<string, { at: number; officialVerifyType: number; cid: number; manualZh: boolean; autoZh: boolean; effectiveDuration: number }>()
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
  const rawArtists = (song.artists || []).filter((a) => String(a).trim().length > 0)
  // 歌手名自动拆解（feat/分隔/括号翻译），避免平台特有后缀（如「 (永远是深夜有多好｡)」）拉低搜索召回
  const artists: string[] = []
  for (const a of rawArtists) {
    for (const name of expandArtistNames(String(a))) {
      if (!artists.includes(name)) artists.push(name)
    }
  }
  const artist = artists.join(' ')
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
  // 2. 逐个歌手 + 歌手别名尝试（如 宇多田光 ↔ 宇多田ヒカル，B 站标题两种写法都常见）
  const artistVariants: string[] = []
  for (const a of artists) {
    const q = `${title} ${a}`.trim()
    if (q && !queries.includes(q)) queries.push(q)
    const aliases = ARTIST_ALIASES[a] || []
    for (const alias of aliases) {
      const aq = `${title} ${alias}`.trim()
      if (aq && !queries.includes(aq) && !artistVariants.includes(aq)) artistVariants.push(aq)
    }
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
  return queries
}

/** 近重复标题去重（规范化后相同者只留播放量最高的） */
export function dedupeCandidates<T extends { video: BilibiliVideo }>(list: T[]): T[] {
  const seen = new Map<string, T>()
  for (const c of list) {
    const norm = normalizeText(c.video.title)
    const prev = seen.get(norm)
    if (!prev || (c.video.play || 0) > (prev.video.play || 0)) seen.set(norm, c)
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

/** 复审候选（view 拿 cid/作者认证 + 字幕），带全局 bvid 缓存 */
async function reviewCandidates(
  candidates: CandidateScore[],
  ctx: MatchContext,
  preference: MatchPreference,
  signal?: AbortSignal,
): Promise<CandidateScore[]> {
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
                for (const s of subInfo.subtitles) {
                  if (/zh|中文/i.test(`${s.lan}${s.lanDoc}`)) {
                    if (s.aiType === 0) manualZh = true
                    else autoZh = true
                  }
                }
              }
            }
          }
          cached = { at: Date.now(), officialVerifyType, cid, manualZh, autoZh, effectiveDuration }
          reviewCache.set(bvid, cached)
          pruneReviewCache()
        } catch {
          cached = { at: Date.now(), officialVerifyType: -1, cid: 0, manualZh: false, autoZh: false, effectiveDuration: 0 }
          reviewCache.set(bvid, cached)
          pruneReviewCache()
        }
      }
      const { manualZhSubtitle, autoSubtitle } = applyPreferenceToReview(cached, preference)
      const rescored = scoreCandidate(candidate.video, ctx, {
        rank: candidate.rank,
        officialVerifyType: cached.officialVerifyType,
        manualZhSubtitle,
        autoSubtitle,
        preference,
        effectiveDuration: cached.effectiveDuration,
      })
      return { ...rescored, cid: cached.cid }
    }),
  )
  const reviewedSet = new Set(reviewed.map((c) => c.video.bvid))
  const rest = candidates.filter((c) => !reviewedSet.has(c.video.bvid))
  return [...reviewed, ...rest].sort((a, b) => b.score - a.score)
}

export async function findBestBilibiliMv(
  song: MatchContext,
  opts?: { signal?: AbortSignal; settings?: Partial<BilibiliWatchSettings> },
): Promise<BilibiliMatchResult> {
  const settings = { ...DEFAULT_WATCH_SETTINGS, ...(opts?.settings || getBilibiliWatchSettings()) }
  // 缓存键必须包含设置指纹：偏好/门槛/模板/强制最高分不同 → 匹配结果（排序与门槛判定）不同
  const settingsFingerprint = [
    settings.matchPreference,
    settings.autoPlayStrictness,
    settings.keywordTemplate,
    settings.customKeywordTemplate,
    settings.forceAutoPlayHighest ? 'force' : 'gate',
  ].join('|')
  const cacheKey = `${songKeyOf(song)}::${settingsFingerprint}`
  const cached = matchCache.get(cacheKey)
  if (cached && Date.now() - cached.at < MATCH_CACHE_TTL) return cached.result
  const result = await findBestBilibiliMvUncached(song, cacheKey, settings, opts?.signal)
  matchCache.set(cacheKey, { at: Date.now(), result })
  pruneMatchCache()
  return result
}

async function findBestBilibiliMvUncached(
  song: MatchContext,
  cacheKey: string,
  settings: BilibiliWatchSettings,
  signal?: AbortSignal,
): Promise<BilibiliMatchResult> {
  // override/黑名单按歌曲存储键读写（与缓存键分离：不含设置指纹）
  const songKey = songKeyOf(song)
  const empty = (error?: string): BilibiliMatchResult => ({ status: 'error', candidates: [], fallbackChain: [], error })
  const blacklist = new Set(getBilibiliBlacklist(songKey))

  // 0. 用户手动选择记忆 → 直接播（可关闭）
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
          const scored = await reviewCandidates([scoreCandidate(video, song, { officialVerifyType: view.data.owner.officialVerifyType, preference: settings.matchPreference })], song, settings.matchPreference, signal)
          const best = scored[0]
          if (best) {
            return { status: 'auto', best, candidates: [best], fallbackChain: [best] }
          }
        }
      } catch {
        // 覆盖视频失效 → 清除记忆走正常搜索
        clearBilibiliOverride(songKey)
      }
    }
  }

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
  if (!videos.length) return empty('搜索失败，请稍后重试')

  // 2. 初筛打分（硬淘汰无关 + 黑名单剔除 + 排名信号）
  let candidates = videos
    .map((v, index) => scoreCandidate(v, song, { rank: index, preference: settings.matchPreference }))
    .filter((c) => c.score !== -Infinity && !blacklist.has(c.video.bvid))
  // 近重复标题去重（保留播放量最高）
  candidates = dedupeCandidates(candidates).sort((a, b) => b.score - a.score)

  if (!candidates.length) return { status: 'none', candidates: [], fallbackChain: [] }

  // 3. TOP-5 复审（作者认证 + 字幕，全局 bvid 缓存）
  candidates = await reviewCandidates(candidates, song, settings.matchPreference, signal)

  // 4. 排序取最佳 + 门槛判定（forceAutoPlayHighest 开启时直接播评分最高，跳过确认）
  const fallbackChain = candidates
  const best = fallbackChain[0]
  const topCandidates = fallbackChain.slice(0, TOP_CONFIRM_COUNT)
  if (!best) return { status: 'none', candidates: [], fallbackChain: [] }
  if (settings.forceAutoPlayHighest || shouldAutoPlay(best, settings.autoPlayStrictness)) {
    return { status: 'auto', best, candidates: topCandidates, fallbackChain }
  }
  return { status: 'confirm', candidates: topCandidates, fallbackChain }
}
