import type { MusicPlatform } from './platforms'
import { isMusicPlatform } from './platformSync'
import type { ViewMode } from '../types/playbackNavigation'
import { loadDesktopCustomization } from './desktopCustomization'
import { prefetchExploreHome } from './exploreApi'
import { getUserPlaylists } from './playlistService'
import { ensureWeatherSnapshot, getCachedWeather } from './weatherService'

interface BackgroundPrefetchContext {
  viewMode: ViewMode
  neteaseLoggedIn: boolean
  qqLoggedIn: boolean
}

interface PrefetchJob {
  label: string
  run: () => Promise<unknown>
}

const PREFETCH_COOLDOWN = 5 * 60 * 1000
const JOB_TIMEOUT = 20_000
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

const getStoredUserId = (platform: MusicPlatform) =>
  localStorage.getItem(platform === 'qq' ? 'qq_user_id' : 'netease_user_id') || ''

const getAccountIdentity = (platform: MusicPlatform) =>
  `${platform}:${getStoredUserId(platform) || 'guest'}`

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
  if (!loggedIn || !userId) return null
  const username = localStorage.getItem(platform === 'qq' ? 'qq_username' : 'netease_username') || ''
  return {
    label: `${platform === 'qq' ? 'QQ音乐' : '网易云'}用户歌单`,
    run: () => getUserPlaylists(platform, userId, username)
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
  const weather = createWeatherJob()
  const neteaseExplore = createExploreJob('netease')
  const qqExplore = createExploreJob('qq')

  const identity = [
    context.viewMode,
    minimalPlatform,
    explorePlatform,
    desktopPlatform,
    getAccountIdentity('netease'),
    getAccountIdentity('qq'),
    context.neteaseLoggedIn ? 'netease-login' : 'netease-guest',
    context.qqLoggedIn ? 'qq-login' : 'qq-guest'
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
