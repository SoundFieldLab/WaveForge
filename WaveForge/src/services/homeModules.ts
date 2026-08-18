import type { MusicPlatform } from './platforms'
export type HomeModuleType =
  | 'netease_new_songs'
  | 'netease_hot_songs'
  | 'netease_rising_songs'
  | 'netease_daily_recommend'
  | 'netease_private_fm'
  | 'netease_radar'
  | 'netease_playlists'
  | 'qq_new_songs'
  | 'qq_hot_songs'
  | 'qq_rising_songs'
  | 'qq_guess_you_like'
  | 'qq_daily_30'
  | 'qq_playlists'
  | 'qq_ai_playlists'
  | 'apple_hot_songs'
  | 'apple_new_songs'
  | 'apple_playlists'
  | 'kugou_hot_songs'
  | 'kugou_new_songs'
  | 'kugou_playlists'
  | 'soda_hot_songs'
  | 'soda_new_songs'
  | 'spotify_hot_songs'
  | 'spotify_new_songs'
  | 'spotify_playlists'

export interface HomeModuleDefinition {
  id: HomeModuleType
  name: string
  description: string
  platform: MusicPlatform
  type: 'song-list' | 'playlist-grid'
  loginRequired?: boolean
  officialSkill?: boolean
}

export const MAX_HOME_MODULES = 6

export const HOME_MODULES: HomeModuleDefinition[] = [
  { id: 'netease_daily_recommend', name: '每日推荐', description: '账号每日歌曲推荐', platform: 'netease', type: 'song-list', loginRequired: true },
  { id: 'netease_private_fm', name: '私人 FM', description: '连续生成的个性化电台', platform: 'netease', type: 'song-list', loginRequired: true },
  { id: 'netease_radar', name: '私人雷达', description: '从账号雷达歌单读取歌曲', platform: 'netease', type: 'song-list', loginRequired: true },
  { id: 'netease_playlists', name: '推荐歌单', description: '账号推荐与热门歌单', platform: 'netease', type: 'playlist-grid' },
  { id: 'netease_new_songs', name: '最新音乐', description: '网易云近期上新的歌曲', platform: 'netease', type: 'song-list' },
  { id: 'netease_hot_songs', name: '热歌榜', description: '当前最受欢迎的歌曲', platform: 'netease', type: 'song-list' },
  { id: 'netease_rising_songs', name: '飙升榜', description: '热度快速上升的歌曲', platform: 'netease', type: 'song-list' },
  { id: 'qq_guess_you_like', name: '猜你喜欢', description: 'QQ 音乐账号 99 号个性化电台', platform: 'qq', type: 'song-list', loginRequired: true },
  { id: 'qq_daily_30', name: '每日 30 首', description: '官方每日推荐，无法使用时由猜你喜欢补齐', platform: 'qq', type: 'song-list', loginRequired: true },
  { id: 'qq_ai_playlists', name: 'AI 推荐歌单', description: 'QQ 音乐官方 Skills 个性化歌单', platform: 'qq', type: 'playlist-grid', loginRequired: true, officialSkill: true },
  { id: 'qq_playlists', name: '推荐歌单', description: '个性化、编辑与热门歌单', platform: 'qq', type: 'playlist-grid' },
  { id: 'qq_new_songs', name: '最新音乐', description: 'QQ 音乐近期上新的歌曲', platform: 'qq', type: 'song-list' },
  { id: 'qq_hot_songs', name: '热歌榜', description: 'QQ 音乐热歌排行', platform: 'qq', type: 'song-list' },
  { id: 'qq_rising_songs', name: '飙升榜', description: 'QQ 音乐飙升排行', platform: 'qq', type: 'song-list' },
  { id: 'apple_hot_songs', name: '热歌榜', description: 'Apple Music 各地区热门歌曲', platform: 'apple', type: 'song-list' },
  { id: 'apple_new_songs', name: '最新音乐', description: 'Apple Music 热门新歌', platform: 'apple', type: 'song-list' },
  { id: 'apple_playlists', name: '推荐歌单', description: 'Apple 编辑精选与热门歌单', platform: 'apple', type: 'playlist-grid' },
  { id: 'kugou_hot_songs', name: '酷狗热歌榜', description: '酷狗 TOP500 实时榜单', platform: 'kugou', type: 'song-list' },
  { id: 'kugou_new_songs', name: '酷狗新歌榜', description: '酷狗近期新歌', platform: 'kugou', type: 'song-list' },
  { id: 'kugou_playlists', name: '酷狗推荐歌单', description: '酷狗热门歌单', platform: 'kugou', type: 'playlist-grid' },
  { id: 'soda_hot_songs', name: '抖音热歌', description: '抖音热门音乐', platform: 'soda', type: 'song-list' },
  { id: 'soda_new_songs', name: '抖音新歌', description: '抖音近期热门新歌', platform: 'soda', type: 'song-list' },
  { id: 'spotify_hot_songs', name: 'Spotify 热歌', description: 'Spotify 当前热门歌曲', platform: 'spotify', type: 'song-list', loginRequired: true },
  { id: 'spotify_new_songs', name: 'Spotify 新发行', description: 'Spotify 最新发行', platform: 'spotify', type: 'song-list', loginRequired: true },
  { id: 'spotify_playlists', name: 'Spotify 歌单', description: 'Spotify 编辑精选歌单', platform: 'spotify', type: 'playlist-grid', loginRequired: true },
]

export const HOME_MODULE_BY_ID = Object.fromEntries(
  HOME_MODULES.map(module => [module.id, module])
) as Record<HomeModuleType, HomeModuleDefinition>

const validModuleIds = new Set<HomeModuleType>(HOME_MODULES.map(module => module.id))

export const sanitizeHomeModules = (
  value: string | null,
  platform?: MusicPlatform
): HomeModuleType[] => {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed)
      ? parsed.filter((id): id is HomeModuleType =>
          validModuleIds.has(id) && (!platform || HOME_MODULE_BY_ID[id as HomeModuleType].platform === platform)
        ).slice(0, MAX_HOME_MODULES)
      : []
  } catch {
    return []
  }
}

export const getDefaultHomeModules = (platform: MusicPlatform, loggedIn: boolean): HomeModuleType[] => {
  if (platform === 'netease') {
    return loggedIn
      ? ['netease_daily_recommend', 'netease_private_fm', 'netease_playlists']
      : ['netease_new_songs', 'netease_hot_songs', 'netease_rising_songs']
  }
  if (platform === 'apple') {
    return ['apple_hot_songs', 'apple_new_songs', 'apple_playlists']
  }
  // 新三平台：未登录也能看到平台公开热门内容（Spotify 需登录，显示登录引导）
  if (platform === 'spotify') {
    return loggedIn
      ? ['spotify_new_songs', 'spotify_hot_songs', 'spotify_playlists']
      : ['spotify_hot_songs', 'spotify_new_songs']
  }
  if (platform === 'kugou') {
    return ['kugou_hot_songs', 'kugou_new_songs', 'kugou_playlists']
  }
  if (platform === 'soda') {
    return ['soda_hot_songs', 'soda_new_songs']
  }
  return loggedIn
    ? ['qq_guess_you_like', 'qq_daily_30', 'qq_playlists']
    : ['qq_new_songs', 'qq_hot_songs', 'qq_rising_songs']
}
