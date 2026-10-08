/**
 * 音乐平台抽象层（第三平台：Apple Music）
 *
 * WaveForge 的"平台"曾长期是散落在 40+ 文件里的 'netease' | 'qq' 字面量。
 * 本模块集中定义：
 * 1. MusicPlatform —— 平台联合类型（新增平台只需在此加一个成员）
 * 2. PlatformCapabilities / PLATFORM_CAPABILITIES —— 平台能力注册表。
 *    UI 全部共享，按能力增减功能：对比某平台与网易云/QQ 的能力差，UI 自然增删。
 * 3. 平台级工具函数（标签 / cookie / 播放载体判定）
 */

export type MusicPlatform = 'netease' | 'qq' | 'apple' | 'spotify' | 'kugou' | 'soda'

export const MUSIC_PLATFORMS: readonly MusicPlatform[] = ['netease', 'qq', 'apple', 'spotify', 'kugou', 'soda']

export const PLATFORM_LABELS: Record<MusicPlatform, string> = {
  netease: '网易云音乐',
  qq: 'QQ音乐',
  apple: 'Apple Music',
  spotify: 'Spotify',
  kugou: '酷狗音乐',
  soda: '汽水音乐',
}

export interface PlatformVisualMetadata {
  label: string
  shortLabel: string
  color: string
  background: string
}

/** 所有平台都提供本地文字视觉信息，避免依赖跨站图标。 */
export const PLATFORM_VISUAL_METADATA: Record<MusicPlatform, PlatformVisualMetadata> = {
  netease: { label: '网易云音乐', shortLabel: '网', color: '#fff', background: '#d81e2b' },
  qq: { label: 'QQ音乐', shortLabel: 'QQ', color: '#102a1d', background: '#31c27c' },
  apple: { label: 'Apple Music', shortLabel: 'AM', color: '#fff', background: '#fa2d48' },
  spotify: { label: 'Spotify', shortLabel: 'S', color: '#082515', background: '#1db954' },
  kugou: { label: '酷狗音乐', shortLabel: '酷', color: '#fff', background: '#ff7a00' },
  soda: { label: '汽水音乐', shortLabel: '汽', color: '#06263a', background: '#38bdf8' },
}

export function getPlatformVisualMetadata(platform: MusicPlatform): PlatformVisualMetadata {
  return PLATFORM_VISUAL_METADATA[platform]
}

export function platformLabel(platform: MusicPlatform | string | undefined | null): string {
  if (platform && platform in PLATFORM_LABELS) return PLATFORM_LABELS[platform as MusicPlatform]
  return '未知平台'
}

/** 探索页区块 ID（与 ExploreSettingsPanel 的 ExploreSectionId 同构）。
 *  kugouLibrary/kugouPlaylistTags/kugouCategories/kugouLongaudio 是酷狗官方客户端
 *  「乐库/歌单/分类/听书」对应的独立板块，只出现在 kugou 的能力表里，
 *  其它平台的区块列表不受影响。（kugouYouth「刷歌」按产品决策已下线：
 *  上游 /youth 动态流对本账号恒为空，入口无内容可展示。）
 *  保留 'kugouYouth' 于联合类型仅为兼容旧 localStorage 偏好，运行时会过滤。 */
export type ExploreSectionId =
  | 'discover'
  | 'journey'
  | 'playlists'
  | 'charts'
  | 'newSongs'
  | 'albums'
  | 'channels'
  | 'kugouLibrary'
  | 'kugouPlaylistTags'
  | 'kugouCategories'
  | 'kugouLongaudio'
  | 'kugouYouth'

export interface PlatformCapabilities {
  /** 是否提供登录能力 */
  login: boolean
  /** 个人中心（用户资料页） */
  profile: boolean
  /** 用户歌单（查看） */
  userPlaylists: boolean
  createPlaylist: boolean
  /** 修改自建歌单名称/描述 */
  updatePlaylist: boolean
  deletePlaylist: boolean
  /** 搜索公开歌单 */
  searchPlaylists: boolean
  /** 生成可靠的公开歌单链接 */
  sharePlaylist: boolean
  /** 从自建歌单移除曲目 */
  removeTracksFromPlaylist: boolean
  /** 歌单加歌 */
  addTracksToPlaylist: boolean
  /** 收藏他人歌单 */
  subscribePlaylist: boolean
  /** 我喜欢 / 音乐库歌曲 */
  likedSongs: boolean
  /** 单曲喜欢/取消喜欢 */
  likeSong: boolean
  /**
   * 单曲「取消喜欢」。与 likeSong 分开是因为**上游能力不对等**：
   * 酷狗只有加歌端点（/v6/add_song），取消喜欢只回执不落库 —— 若沿用一个位，
   * 播放页径向菜单会在已喜欢时给出"从喜欢歌单中移除"并 toast 成功，实为假成功
   * （2026-09-27 审计：右键菜单已特判隐藏，径向菜单漏了）。
   */
  unlikeSong: boolean
  /** 探索页 */
  explore: boolean
  /** 探索页可用的区块（按能力增减） */
  exploreSections: readonly ExploreSectionId[]
  search: boolean
  searchSuggest: boolean
  lyrics: boolean
  comments: boolean
  /** 个性化每日推荐（未登录/不支持时可用公开榜单兜底） */
  dailyRecommend: boolean
  charts: boolean
  channels: boolean
  newSongs: boolean
  albums: boolean
  mv: boolean
  /** 每日签到 / 打卡 */
  signin: boolean
  /** 关注 / 粉丝 */
  social: boolean
  /** 听歌排行 */
  rank: boolean
  recentPlayed: boolean
  artistDetail: boolean
  albumDetail: boolean
  similarSongs: boolean
  /** 连续电台（FM / 猜你喜欢） */
  radio: boolean
  /** 是否可直接作为音频播放载体（apple 需跨平台匹配到 netease/qq 播放） */
  playAsCarrier: boolean
  audioQuality: boolean
}

const NETEASE_CAPABILITIES: PlatformCapabilities = {
  login: true,
  profile: true,
  userPlaylists: true,
  createPlaylist: true,
  updatePlaylist: true,
  deletePlaylist: true,
  searchPlaylists: true,
  sharePlaylist: true,
  removeTracksFromPlaylist: true,
  addTracksToPlaylist: true,
  subscribePlaylist: true,
  likedSongs: true,
  likeSong: true,
  unlikeSong: true,
  explore: true,
  exploreSections: ['discover', 'journey', 'playlists', 'charts', 'newSongs', 'albums', 'channels'],
  search: true,
  searchSuggest: true,
  lyrics: true,
  comments: true,
  dailyRecommend: true,
  charts: true,
  channels: true,
  newSongs: true,
  albums: true,
  mv: true,
  signin: false,
  social: true,
  rank: true,
  recentPlayed: true,
  artistDetail: true,
  albumDetail: true,
  similarSongs: true,
  radio: true,
  playAsCarrier: true,
  audioQuality: true,
}

const QQ_CAPABILITIES: PlatformCapabilities = {
  ...NETEASE_CAPABILITIES,
  updatePlaylist: false,
  // 显式声明取消喜欢（QQ 走 music.musicasset.SongFavWrite 真删）；
  // 不写就会随网易云能力变化被牵连（2026-09-27 复查建议）
  unlikeSong: true,
  signin: false,
  social: true,
  // QQ 无听歌排行 / 云盘
  rank: false,
}

const APPLE_CAPABILITIES: PlatformCapabilities = {
  login: true,
  profile: true,
  userPlaylists: true,
  createPlaylist: true,
  updatePlaylist: true,
  deletePlaylist: true,
  searchPlaylists: true,
  sharePlaylist: true,
  removeTracksFromPlaylist: true,
  addTracksToPlaylist: true,
  // Apple Music 无"收藏他人歌单"概念（资料库歌单即我的歌单）
  subscribePlaylist: false,
  likedSongs: true,
  likeSong: true,
  unlikeSong: true,
  explore: true,
  // 探索页区块：无旅程 / 无声音频道（Apple 无公开的 FM/分类频道接口）
  exploreSections: ['discover', 'playlists', 'charts', 'newSongs', 'albums'],
  search: true,
  searchSuggest: false,
  lyrics: true,
  comments: false,
  dailyRecommend: false,
  charts: true,
  channels: false,
  newSongs: true,
  albums: true,
  mv: false,
  signin: false,
  social: false,
  rank: false,
  recentPlayed: true,
  artistDetail: true,
  albumDetail: true,
  similarSongs: false,
  radio: false,
  playAsCarrier: false,
  audioQuality: true,
}

const SPOTIFY_CAPABILITIES: PlatformCapabilities = {
  login: true,
  profile: true,
  userPlaylists: true,
  createPlaylist: true,
  updatePlaylist: true,
  deletePlaylist: false, // Spotify Web API 无删除歌单接口
  searchPlaylists: true,
  sharePlaylist: true,
  removeTracksFromPlaylist: true,
  addTracksToPlaylist: true,
  subscribePlaylist: true, // follow/unfollow
  likedSongs: true,
  likeSong: true,
  unlikeSong: true,
  explore: true,
  // Spotify 官方 API：new releases / featured playlists / categories / 榜单
  exploreSections: ['discover', 'playlists', 'charts', 'newSongs', 'albums'],
  search: true,
  searchSuggest: false,
  lyrics: true, // 官方无歌词，走 Lrclib/AMLL 兜底
  comments: false,
  dailyRecommend: true,
  charts: true,
  channels: false,
  newSongs: true,
  albums: true,
  mv: false,
  signin: false,
  social: false,
  rank: false,
  recentPlayed: true,
  artistDetail: true,
  albumDetail: true,
  similarSongs: false,
  radio: false,
  playAsCarrier: false, // 官方流受 DRM 保护，始终由网易云/QQ 匹配播放
  audioQuality: false,
}

const KUGOU_CAPABILITIES: PlatformCapabilities = {
  login: true,
  profile: true,
  userPlaylists: true, // H5 签名网关
  createPlaylist: false, // 仅概念版凭据可用（getPlatformCapabilities 动态放行 /v5/add_list）
  updatePlaylist: false, // 上游未提供重命名/改简介端点
  deletePlaylist: false,
  searchPlaylists: false,
  sharePlaylist: false,
  removeTracksFromPlaylist: false, // 仅概念版凭据可用（按 fileid 移除）
  addTracksToPlaylist: true, // /v6/add_song
  subscribePlaylist: false, // 仅概念版凭据可用（add_list type=1 / v2/delete_list）
  likedSongs: true, // "我喜欢"歌单
  likeSong: true, // /v6/add_song
  unlikeSong: false, // 上游无移除端点（只回执不落库）
  explore: true,
  // 酷狗官方客户端一级分区：音乐（推荐 / 乐库 / 歌单 / 频道 / 分类）/ 听书 / 刷歌；
  // 探索页由 KugouExplorePage 按分区收纳（不再是通用板块瀑布），目录类接口用概念版通道。
  // 「刷歌」(kugouYouth) 已按产品决策下线：上游动态流恒空，入口不提供。
  exploreSections: [
    'discover',
    'kugouLibrary',
    'kugouPlaylistTags',
    'channels',
    'kugouCategories',
    'kugouLongaudio',
  ],
  search: true,
  searchSuggest: false,
  lyrics: true,
  // 概念版 /mcomment/v1/cmtlist 可读（设备凭据即可）；点赞/回复/发表上游未提供 → UI 只读并注明
  comments: true,
  dailyRecommend: true,
  charts: true,
  // 频道走概念版 /youth/v2/channel/channel_all_list：无订阅账号返回空列表（UI 空态），能力本身存在
  channels: true,
  newSongs: true,
  albums: true, // mobilecdn /api/v3/album/list + album/info + album/song
  mv: false,
  signin: false,
  social: false,
  rank: false,
  recentPlayed: false,
  artistDetail: true, // mobilecdn /api/v3/singer/info + singer/song
  albumDetail: true,
  similarSongs: true, // 同歌手热门歌曲（singer/song）+ 榜单相关探索
  radio: false,
  playAsCarrier: true, // H5 签名网关可原生播放（需登录）；未登录时由上层匹配播放
  audioQuality: false,
}

const SODA_CAPABILITIES: PlatformCapabilities = {
  login: true,
  profile: true,
  userPlaylists: true, // 逆向 Web API：用户歌单获取（含虚拟歌单）
  createPlaylist: true, // 客户端 CreatePlaylist → POST /luna/pc/me/playlist（2026-10-08 修正：此前误判为无此端点）
  updatePlaylist: false,
  deletePlaylist: true, // 客户端 MDeletePlaylists → POST /luna/pc/me/playlist/delete
  searchPlaylists: false,
  sharePlaylist: false,
  removeTracksFromPlaylist: false,
  addTracksToPlaylist: true, // me/playlist/media/append 加歌
  subscribePlaylist: true, // collection 收藏/取消收藏歌单
  likedSongs: true, // "我喜欢"虚拟歌单 qishui-liked
  likeSong: true, // collection/media 喜欢写入
  unlikeSong: true,
  explore: true,
  // 探索页区块：无旅程/频道；albums = 新碟派生聚合区块（payload.albums 由曲目字段聚拢，游客模式为空自动隐藏）
  exploreSections: ['discover', 'playlists', 'charts', 'newSongs', 'albums'],
  search: true,
  searchSuggest: true, // 派生联想：/api/soda/search/suggest 从搜索结果聚拢歌曲名/歌手名/专辑名候选
  lyrics: true,
  comments: true, // luna/pc/comments 读取与发表
  dailyRecommend: true, // 登录 feed 日推；未登录回退公开热歌
  charts: true,
  channels: false,
  newSongs: true,
  albums: true, // 无独立专辑实体：搜索与新碟区块均走「曲目字段派生聚拢」（专辑名+封面键去重）
  mv: false,
  signin: false,
  social: false,
  rank: false,
  recentPlayed: true, // 登录态 recent 接口
  artistDetail: true, // 按歌手名检索热门歌曲（无独立艺人 ID）
  albumDetail: true,
  similarSongs: true, // 同歌手热门 + 日推组合的相关探索
  radio: false,
  playAsCarrier: true, // 逆向 Web API 音源（免费/试听流可播）；失败时上层降级网易云/QQ
  audioQuality: true, // /api/soda/song/url quality 选档（standard|high|lossless|hires，会员闸门内就近落档）
}

export const PLATFORM_CAPABILITIES: Record<MusicPlatform, PlatformCapabilities> = {
  netease: NETEASE_CAPABILITIES,
  qq: QQ_CAPABILITIES,
  apple: APPLE_CAPABILITIES,
  spotify: SPOTIFY_CAPABILITIES,
  kugou: KUGOU_CAPABILITIES,
  soda: SODA_CAPABILITIES,
}

export function getPlatformCapabilities(platform: MusicPlatform): PlatformCapabilities {
  // 酷狗按当前凭据动态判定：概念版扫码凭据支持移除（按 fileid）、新建/收藏歌单（cloudlist），
  // 网页 cookie 通道没有这些写接口
  if (platform === 'kugou') {
    let conceptCredential = false
    try { conceptCredential = Boolean(localStorage.getItem('kugou_concept_credential')) } catch { /* 忽略 */ }
    return conceptCredential
      ? {
          ...KUGOU_CAPABILITIES,
          unlikeSong: true,
          removeTracksFromPlaylist: true,
          createPlaylist: true,
          subscribePlaylist: true,
        }
      : KUGOU_CAPABILITIES
  }
  return PLATFORM_CAPABILITIES[platform] || NETEASE_CAPABILITIES
}

export interface PlatformFavoriteLabels {
  add: string
  remove: string
  collection: string
}

const PLATFORM_FAVORITE_LABELS: Record<MusicPlatform, PlatformFavoriteLabels> = {
  netease: { add: '我喜欢', remove: '从喜欢歌单中移除', collection: '我喜欢的音乐' },
  qq: { add: '我喜欢', remove: '从喜欢歌单中移除', collection: '我喜欢的歌曲' },
  apple: { add: '喜爱歌曲', remove: '从喜爱歌曲中移除', collection: '喜爱歌曲' },
  spotify: { add: '保存到音乐库', remove: '从音乐库中移除', collection: '音乐库歌曲' },
  kugou: { add: '我喜欢', remove: '从喜欢歌单中移除', collection: '我喜欢' },
  soda: { add: '我喜欢', remove: '从喜欢中移除', collection: '我喜欢' },
}

/** 收藏/资料库在各平台的用户可见名称，避免菜单各自硬编码。 */
export function getPlatformFavoriteLabels(platform: MusicPlatform): PlatformFavoriteLabels {
  return PLATFORM_FAVORITE_LABELS[platform] || PLATFORM_FAVORITE_LABELS.netease
}

// ─────────────────────────── 平台排序（用户自定义，三模式继承） ───────────────────────────

const PLATFORM_ORDER_KEY = 'waveforge:platformOrder'
export const PLATFORM_ORDER_EVENT = 'waveforge-platform-order-changed'

/** 用户自定义平台顺序（缺省 = MUSIC_PLATFORMS 默认顺序） */
export function getPlatformOrder(): MusicPlatform[] {
  try {
    const raw = localStorage.getItem(PLATFORM_ORDER_KEY)
    if (!raw) return [...MUSIC_PLATFORMS]
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return [...MUSIC_PLATFORMS]
    const valid = parsed.filter((p): p is MusicPlatform => MUSIC_PLATFORMS.includes(p as MusicPlatform))
    // 补全缺失平台，去重
    const set = new Set(valid)
    const merged = [...valid, ...MUSIC_PLATFORMS.filter(p => !set.has(p))]
    return merged
  } catch {
    return [...MUSIC_PLATFORMS]
  }
}

/** 保存用户平台顺序（触发 PLATFORM_ORDER_EVENT） */
export function setPlatformOrder(order: MusicPlatform[]): void {
  const valid = order.filter((p, i, arr) => MUSIC_PLATFORMS.includes(p) && arr.indexOf(p) === i)
  if (valid.length === 0) return
  try {
    localStorage.setItem(PLATFORM_ORDER_KEY, JSON.stringify(valid))
    window.dispatchEvent(new CustomEvent(PLATFORM_ORDER_EVENT, { detail: { order: valid } }))
  } catch {
    // 忽略
  }
}

// ─────────────────────────── 平台可见性（隐藏平台） ───────────────────────────

const HIDDEN_PLATFORMS_KEY = 'waveforge:hiddenPlatforms'
export const PLATFORM_VISIBILITY_EVENT = 'waveforge-platform-visibility-changed'

/** 用户手动隐藏的平台列表（默认空 = 全部显示） */
export function getHiddenPlatforms(): MusicPlatform[] {
  try {
    const raw = localStorage.getItem(HIDDEN_PLATFORMS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((item): item is MusicPlatform => MUSIC_PLATFORMS.includes(item as MusicPlatform))
      : []
  } catch {
    return []
  }
}

/** 当前应显示的平台列表（按用户自定义顺序，至少保留一个平台） */
export function getVisiblePlatforms(): MusicPlatform[] {
  const hidden = new Set(getHiddenPlatforms())
  const order = getPlatformOrder()
  const visible = order.filter(platform => !hidden.has(platform))
  return visible.length > 0 ? visible : ['netease']
}

export function isPlatformVisible(platform: MusicPlatform): boolean {
  return getVisiblePlatforms().includes(platform)
}

/** 设置某平台是否隐藏（hidden=true 隐藏）。禁止隐藏最后一个可见平台。 */
export function setPlatformHidden(platform: MusicPlatform, hidden: boolean): void {
  const current = new Set(getHiddenPlatforms())
  if (hidden) {
    current.add(platform)
  } else {
    current.delete(platform)
  }
  const nextHidden = [...current]
  // 至少保留一个平台
  if (MUSIC_PLATFORMS.every(item => nextHidden.includes(item))) return
  localStorage.setItem(HIDDEN_PLATFORMS_KEY, JSON.stringify(nextHidden))
  window.dispatchEvent(new CustomEvent(PLATFORM_VISIBILITY_EVENT, { detail: { hidden: nextHidden } }))
}

/** 平台 cookie/token（spotify 走 OAuth token，apple 走 Developer Token + Media-User-Token） */
export function getPlatformCookie(platform: MusicPlatform): string {
  if (platform === 'qq') {
    return localStorage.getItem('qq_cookie') || localStorage.getItem('qqCookie') || ''
  }
  if (platform === 'apple') return ''
  if (platform === 'spotify') return localStorage.getItem('spotify_access_token') || ''
  if (platform === 'kugou') return localStorage.getItem('kugou_cookie') || ''
  if (platform === 'soda') return localStorage.getItem('soda_token') || ''
  return localStorage.getItem('netease_cookie') || localStorage.getItem('neteaseCookie') || ''
}
