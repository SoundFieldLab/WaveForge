import type { MusicPlatform } from './platforms'
import { isMusicPlatform } from './platformSync'
import type { ViewMode } from '../types/playbackNavigation'
import { loadDesktopCustomization } from './desktopCustomization'
import { prefetchExploreHome } from './exploreApi'
import { getUserPlaylists } from './playlistService'
import { preloadArtwork } from './artworkLoader'
import { ensureWeatherSnapshot, getCachedWeather } from './weatherService'

interface BackgroundPrefetchContext {
  viewMode: ViewMode
  neteaseLoggedIn: boolean
  qqLoggedIn: boolean
  appleLoggedIn?: boolean
  sodaLoggedIn?: boolean
  appleStorefront?: string
  sodaAccountId?: string
}

interface PrefetchJob {
  label: string
  run: () => Promise<unknown>
}

const PREFETCH_COOLDOWN = 5 * 60 * 1000
const JOB_TIMEOUT = 20_000
const MAX_ARTWORK_PER_PLATFORM = 40
const MAX_COMPLETED_ENTRIES = 32
const completedAt = new Map<string, number>()
const pending = new Map<string, Promise<void>>()

/** 控制完成记录的容量：超出上限时淘汰最旧的条目，防止长时间运行后无限增长。 */
const rememberCompleted = (identity: string): void => {
  completedAt.delete(identity)
  completedAt.set(identity, Date.now())
  while (completedAt.size > MAX_COMPLETED_ENTRIES) {
    const oldestKey = completedAt.keys().next().value
    if (oldestKey === undefined) break
    completedAt.delete(oldestKey)
  }
}

const getStoredUserId = (platform: MusicPlatform) => {
  const keyByPlatform: Partial<Record<MusicPlatform, string>> = {
    netease: 'netease_user_id',
    qq: 'qq_user_id',
    apple: 'apple_account_id',
    spotify: 'spotify_user_id',
    kugou: 'kugou_user_id',
    soda: 'soda_user_id',
  }
  return localStorage.getItem(keyByPlatform[platform] || '') || ''
}

const getAccountIdentity = (platform: MusicPlatform) => {
  if (platform === 'apple') {
    return `apple:${localStorage.getItem('appleAccountEmail') || localStorage.getItem('appleAccountName') || 'guest'}:${localStorage.getItem('appleStorefront') || 'cn'}`
  }
  if (platform === 'soda') return `soda:${localStorage.getItem('soda_user_id') || 'session'}`
  return `${platform}:${getStoredUserId(platform) || 'guest'}`
}

const addArtwork = (urls: string[], seen: Set<string>, value: unknown) => {
  const url = typeof value === 'string' ? value.trim() : ''
  if (!url || seen.has(url) || urls.length >= MAX_ARTWORK_PER_PLATFORM) return
  seen.add(url)
  urls.push(url)
}

export function collectPrefetchArtwork(payload: any, playlists: any[] = []): string[] {
  const urls: string[] = []
  const seen = new Set<string>()
  const addSong = (song: any) => addArtwork(urls, seen, song?.album?.picUrl || song?.coverUrl)
  for (const group of [payload?.dailySongs, payload?.radioSongs, payload?.newSongs]) {
    if (Array.isArray(group)) group.forEach(addSong)
  }
  for (const item of payload?.playlists || []) addArtwork(urls, seen, item?.coverUrl || item?.coverImgUrl)
  for (const item of payload?.albums || []) addArtwork(urls, seen, item?.coverUrl || item?.picUrl)
  for (const item of payload?.charts || []) {
    addArtwork(urls, seen, item?.coverUrl)
    if (Array.isArray(item?.songs)) item.songs.forEach(addSong)
  }
  for (const item of payload?.channels || []) addArtwork(urls, seen, item?.coverUrl)
  const qqNative = payload?.qqNative
  if (Array.isArray(qqNative?.daily30?.songs)) qqNative.daily30.songs.forEach(addSong)
  for (const module of qqNative?.modules || []) {
    for (const card of module?.cards || []) {
      addArtwork(urls, seen, card?.coverUrl || card?.playlist?.coverUrl)
      if (Array.isArray(card?.songs)) card.songs.forEach(addSong)
    }
  }
  for (const playlist of playlists) addArtwork(urls, seen, playlist?.coverImgUrl || playlist?.coverUrl)
  return urls
}

async function prefetchArtworkBatch(platform: MusicPlatform, urls: string[]): Promise<void> {
  for (let index = 0; index < urls.length; index += 4) {
    await Promise.all(urls.slice(index, index + 4).map(url => preloadArtwork(url, {
      role: 'card',
      priority: 'deferred',
      retries: 0,
      platform,
    }).catch(() => undefined)))
  }
}

const getConfiguredWeather = () => {
  const settings = loadDesktopCustomization()
  const enabled = settings.left.includes('weather') || settings.right.includes('weather')
  if (!enabled) return null
  if (settings.weatherLocationMode === 'auto') return settings
  const hasManualLocation = Boolean(
    settings.weatherDistrictCode || settings.weatherCityCode || settings.weatherProvinceCode ||
    settings.weatherDistrict || settings.weatherCity || settings.weatherProvince
  )
  return hasManualLocation ? settings : null
}

const withTimeout = async <T,>(label: string, request: Promise<T>): Promise<T> => {
  let timer = 0
  try {
    return await Promise.race([
      request,
      new Promise<T>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error(`${label}加载超时`)), JOB_TIMEOUT)
      })
    ])
  } finally {
    if (timer) window.clearTimeout(timer)
  }
}

const runJobs = async (jobs: PrefetchJob[]) => {
  // Run large background requests sequentially to avoid simultaneous response deserialization peaks.
  for (const job of jobs) {
    try {
      await withTimeout(job.label, job.run())
    } catch (error) {
      if ((error as Error)?.name !== 'AbortError') {
        console.debug(`[background prefetch] ${job.label} failed; continuing:`, error)
      }
    }
  }
}

const createExploreJob = (platform: MusicPlatform): PrefetchJob => ({
  label: `${platform === 'qq' ? 'QQ音乐' : '网易云'}探索与推荐`,
  run: () => prefetchExploreHome(platform)
})

const createPlaylistJob = (
  platform: MusicPlatform,
  loggedIn: boolean
): PrefetchJob | null => {
  const userId = getStoredUserId(platform)
  if (!loggedIn || ((platform === 'netease' || platform === 'qq') && !userId)) return null
  const username = localStorage.getItem(platform === 'qq' ? 'qq_username' : platform === 'netease' ? 'netease_username' : '') || ''
  return {
    label: `${platform === 'qq' ? 'QQ音乐' : platform === 'netease' ? '网易云' : platform}用户歌单`,
    run: async () => {
      const playlists = await getUserPlaylists(platform, userId, username)
      await prefetchArtworkBatch(platform, collectPrefetchArtwork(null, playlists))
      return playlists
    },
  }
}

const createArtworkJob = (platform: MusicPlatform, loggedIn: boolean): PrefetchJob | null => {
  if (!loggedIn) return null
  return {
    label: `${platform}封面预取`,
    run: async () => {
      const payload = await prefetchExploreHome(platform)
      await prefetchArtworkBatch(platform, collectPrefetchArtwork(payload))
      return payload
    },
  }
}

const createWeatherJob = (): PrefetchJob | null => {
  const settings = getConfiguredWeather()
  if (!settings) return null
  const cached = getCachedWeather(settings, true)
  if (cached && Date.now() - cached.updatedAt <= 10 * 60 * 1000) return null
  return {
    label: '桌面天气',
    run: () => ensureWeatherSnapshot(settings, { forceRefresh: true })
  }
}

async function runBackgroundPrefetch(context: BackgroundPrefetchContext): Promise<void> {
  const readCorePlatform = (key: string): 'netease' | 'qq' | null => {
    const value = localStorage.getItem(key)
    return isMusicPlatform(value) && (value === 'netease' || value === 'qq') ? value : null
  }
  const minimalPlatform = readCorePlatform('selectedPlatform')
  const explorePlatform = readCorePlatform('explorePlatform')
  const desktopPlatform = readCorePlatform('desktopModePlatform')
  const neteasePlaylist = createPlaylistJob('netease', context.neteaseLoggedIn)
  const qqPlaylist = createPlaylistJob('qq', context.qqLoggedIn)
  const applePlaylist = createPlaylistJob('apple', Boolean(context.appleLoggedIn))
  const sodaPlaylist = createPlaylistJob('soda', Boolean(context.sodaLoggedIn))
  const weather = createWeatherJob()
  const neteaseExplore = createExploreJob('netease')
  const qqExplore = createExploreJob('qq')
  const neteaseArtwork = createArtworkJob('netease', context.neteaseLoggedIn)
  const qqArtwork = createArtworkJob('qq', context.qqLoggedIn)
  const appleArtwork = createArtworkJob('apple', Boolean(context.appleLoggedIn))
  const sodaArtwork = createArtworkJob('soda', Boolean(context.sodaLoggedIn))

  const identity = [
    context.viewMode,
    minimalPlatform,
    explorePlatform,
    desktopPlatform,
    getAccountIdentity('netease'),
    getAccountIdentity('qq'),
    getAccountIdentity('apple'),
    getAccountIdentity('soda'),
    context.neteaseLoggedIn ? 'netease-login' : 'netease-guest',
    context.qqLoggedIn ? 'qq-login' : 'qq-guest',
    context.appleLoggedIn ? `apple-login:${context.appleStorefront || 'cn'}` : 'apple-guest',
    context.sodaLoggedIn ? `soda-login:${context.sodaAccountId || getAccountIdentity('soda')}` : 'soda-guest'
  ].join('|')

  const lastCompleted = completedAt.get(identity) || 0
  if (Date.now() - lastCompleted < PREFETCH_COOLDOWN) return
  const existing = pending.get(identity)
  if (existing) return existing

  const request = (async () => {
    let priorityJobs: PrefetchJob[] = []
    let secondaryJobs: PrefetchJob[] = []

    if (context.viewMode === 'desktop') {
      const activePlaylist = desktopPlatform === 'qq' ? qqPlaylist : desktopPlatform === 'netease' ? neteasePlaylist : null
      const alternatePlaylist = desktopPlatform === 'qq' ? neteasePlaylist : desktopPlatform === 'netease' ? qqPlaylist : null
      priorityJobs = [activePlaylist, alternatePlaylist, weather].filter((job): job is PrefetchJob => Boolean(job))
      secondaryJobs = desktopPlatform ? [neteaseExplore, qqExplore] : []
    } else if (context.viewMode === 'explore') {
      const activeExplore = explorePlatform === 'qq' ? qqExplore : explorePlatform === 'netease' ? neteaseExplore : null
      priorityJobs = [activeExplore].filter((job): job is PrefetchJob => Boolean(job))
      secondaryJobs = [
        explorePlatform === 'qq' ? neteaseExplore : explorePlatform === 'netease' ? qqExplore : null,
        explorePlatform ? neteasePlaylist : null,
        explorePlatform ? qqPlaylist : null,
        weather
      ].filter((job): job is PrefetchJob => Boolean(job))
    } else {
      const activeExplore = minimalPlatform === 'qq' ? qqExplore : minimalPlatform === 'netease' ? neteaseExplore : null
      const activePlaylist = minimalPlatform === 'qq' ? qqPlaylist : minimalPlatform === 'netease' ? neteasePlaylist : null
      priorityJobs = [activeExplore, activePlaylist].filter((job): job is PrefetchJob => Boolean(job))
      // 非网易云/QQ平台不误拉其他平台数据，仅保留天气预取。
      secondaryJobs = [weather].filter((job): job is PrefetchJob => Boolean(job))
    }

    await runJobs(priorityJobs)
    await runJobs(secondaryJobs)
    // 网易/QQ 只预取「当前三个视图真正指向的那个核心平台」：此前两个都登录时会把另一侧也
    // 全量预取（约 40 张封面 + 一次 /explore），与首屏封面加载、登录校验抢带宽；另一侧等
    // 用户切过去时再按需加载。Apple / 汽水是各视图内的次级来源，保持原有行为不动。
    const activeCorePlatforms = new Set([minimalPlatform, explorePlatform, desktopPlatform].filter(Boolean))
    const artworkJobs = [
      activeCorePlatforms.has('netease') ? neteaseArtwork : null,
      activeCorePlatforms.has('qq') ? qqArtwork : null,
      appleArtwork,
      sodaArtwork,
      applePlaylist,
      sodaPlaylist,
    ].filter((job): job is PrefetchJob => Boolean(job))
    await runJobs(artworkJobs)
    rememberCompleted(identity)
  })()

  pending.set(identity, request)
  try {
    await request
  } finally {
    if (pending.get(identity) === request) pending.delete(identity)
  }
}

export function scheduleBackgroundPrefetch(context: BackgroundPrefetchContext): () => void {
  let cancelled = false
  const start = () => {
    if (!cancelled) void runBackgroundPrefetch(context)
  }

  const idleWindow = window as Window & {
    requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number
    cancelIdleCallback?: (id: number) => void
  }
  let cancelInitialStart: () => void
  if (typeof idleWindow.requestIdleCallback === 'function') {
    const idleId = idleWindow.requestIdleCallback(start, { timeout: 800 })
    cancelInitialStart = () => idleWindow.cancelIdleCallback?.(idleId)
  } else {
    const timer = window.setTimeout(start, 250)
    cancelInitialStart = () => window.clearTimeout(timer)
  }

  const interval = window.setInterval(start, 10 * 60 * 1000)
  return () => {
    cancelled = true
    cancelInitialStart()
    window.clearInterval(interval)
  }
}
