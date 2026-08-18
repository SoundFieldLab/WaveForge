export type DesktopWidgetType =
  | 'datetime' | 'weather' | 'dayProgress' | 'calendar' | 'notes' | 'memo' | 'habits' | 'countdown'
  | 'recentlyPlayed' | 'dailyRecommendations' | 'playQueue' | 'favoriteSongs'
  | 'playlistShortcuts' | 'listeningStats' | 'musicCalendar' | 'artistUpdates'
  | 'spectrum' | 'quickLauncher' | 'systemStatus' | 'volumeControl'
export type DesktopWidgetSide = 'left' | 'right'
export type DesktopWeatherLocationMode = 'auto' | 'manual'
export type DesktopLyricStyle = 'traditional' | 'modern'

export interface DesktopCustomizationSettings {
  left: DesktopWidgetType[]
  right: DesktopWidgetType[]
  desktopLyricStyle: DesktopLyricStyle
  traditionalLyricSize: number
  modernLyricSize: number
  backgroundDim: number
  backgroundBlur: number
  weatherLocationMode: DesktopWeatherLocationMode
  weatherCountryCode: string
  weatherCountry: string
  weatherProvinceCode: string
  weatherProvince: string
  weatherCityCode: string
  weatherCity: string
  weatherDistrictCode: string
  weatherDistrict: string
  weatherLatitude: number | null
  weatherLongitude: number | null
}

export const DESKTOP_CUSTOMIZATION_STORAGE_KEY = 'desktopCustomization'
export const DESKTOP_CUSTOMIZATION_EVENT = 'desktopCustomizationChanged'

// 卡片在桌面侧栏中的高度估算，仅用于自动选择较空的一侧；不限制添加数量。
const DESKTOP_WIDGET_ESTIMATED_HEIGHT: Record<DesktopWidgetType, number> = {
  datetime: 116,
  weather: 178,
  dayProgress: 176,
  calendar: 236,
  notes: 150,
  memo: 142,
  habits: 158,
  countdown: 150,
  recentlyPlayed: 226,
  dailyRecommendations: 132,
  playQueue: 226,
  favoriteSongs: 132,
  playlistShortcuts: 150,
  listeningStats: 152,
  musicCalendar: 138,
  artistUpdates: 188,
  spectrum: 142,
  quickLauncher: 138,
  systemStatus: 148,
  volumeControl: 126,
}

export const getDesktopWidgetEstimatedUsage = (
  widgets: DesktopWidgetType[],
  viewportWidth = window.innerWidth,
) => {
  const narrowMultiplier = viewportWidth < 1000 ? 1.1 : viewportWidth < 1280 ? 1.04 : 1
  const cardsHeight = widgets.reduce((sum, widget) => sum + DESKTOP_WIDGET_ESTIMATED_HEIGHT[widget] * narrowMultiplier, 0)
  return Math.ceil(cardsHeight + Math.max(0, widgets.length - 1) * 12)
}

const DEFAULT_SETTINGS: DesktopCustomizationSettings = {
  left: [],
  right: [],
  desktopLyricStyle: 'traditional',
  traditionalLyricSize: 1.95,
  modernLyricSize: 2.2,
  backgroundDim: 0,
  backgroundBlur: 0,
  weatherLocationMode: 'auto',
  weatherCountryCode: 'CN',
  weatherCountry: '中国',
  weatherProvinceCode: '',
  weatherProvince: '',
  weatherCityCode: '',
  weatherCity: '',
  weatherDistrictCode: '',
  weatherDistrict: '',
  weatherLatitude: null,
  weatherLongitude: null,
}

const isWidgetType = (value: unknown): value is DesktopWidgetType =>
  value === 'datetime'
  || value === 'weather'
  || value === 'dayProgress'
  || value === 'calendar'
  || value === 'notes'
  || value === 'memo'
  || value === 'habits'
  || value === 'countdown'
  || value === 'recentlyPlayed'
  || value === 'dailyRecommendations'
  || value === 'playQueue'
  || value === 'favoriteSongs'
  || value === 'playlistShortcuts'
  || value === 'listeningStats'
  || value === 'musicCalendar'
  || value === 'artistUpdates'
  || value === 'spectrum'
  || value === 'quickLauncher'
  || value === 'systemStatus'
  || value === 'volumeControl'

const normalizeWidgets = (value: unknown): DesktopWidgetType[] => {
  if (!Array.isArray(value)) return []

  const migrated = value.map(item => item === 'focusTimer' ? 'datetime' : item === 'weekStrip' ? 'calendar' : item)
  return migrated.filter(isWidgetType).filter((widget, index, widgets) => widgets.indexOf(widget) === index)
}

const normalizeNumber = (value: unknown, fallback: number, min: number, max: number) => {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

const normalizeCoordinate = (value: unknown, min: number, max: number) => {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) && number >= min && number <= max ? number : null
}

const loadLegacyNumber = (key: string, fallback: number, min: number, max: number) =>
  normalizeNumber(localStorage.getItem(key), fallback, min, max)

export const loadDesktopCustomization = (): DesktopCustomizationSettings => {
  try {
    const legacyBackgroundDim = loadLegacyNumber('desktopBackgroundDim', DEFAULT_SETTINGS.backgroundDim, 0, 70)
    const legacyBackgroundBlur = loadLegacyNumber('desktopBackgroundBlur', DEFAULT_SETTINGS.backgroundBlur, 0, 20)
    const saved = localStorage.getItem(DESKTOP_CUSTOMIZATION_STORAGE_KEY)
    if (!saved) return { ...DEFAULT_SETTINGS, backgroundDim: legacyBackgroundDim, backgroundBlur: legacyBackgroundBlur }

    const parsed = JSON.parse(saved) as Partial<DesktopCustomizationSettings>
    return {
      left: normalizeWidgets(parsed.left),
      right: normalizeWidgets(parsed.right),
      desktopLyricStyle: parsed.desktopLyricStyle === 'modern' ? 'modern' : 'traditional',
      traditionalLyricSize: normalizeNumber(parsed.traditionalLyricSize, DEFAULT_SETTINGS.traditionalLyricSize, 1.2, 3.2),
      modernLyricSize: normalizeNumber(parsed.modernLyricSize, DEFAULT_SETTINGS.modernLyricSize, 1.4, 4.2),
      backgroundDim: normalizeNumber(parsed.backgroundDim, legacyBackgroundDim, 0, 70),
      backgroundBlur: normalizeNumber(parsed.backgroundBlur, legacyBackgroundBlur, 0, 20),
      weatherLocationMode: parsed.weatherLocationMode === 'manual' ? 'manual' : 'auto',
      weatherCountryCode: typeof parsed.weatherCountryCode === 'string' ? parsed.weatherCountryCode : 'CN',
      weatherCountry: typeof parsed.weatherCountry === 'string' ? parsed.weatherCountry : '中国',
      weatherProvinceCode: typeof parsed.weatherProvinceCode === 'string' ? parsed.weatherProvinceCode : '',
      weatherProvince: typeof parsed.weatherProvince === 'string' ? parsed.weatherProvince : '',
      weatherCityCode: typeof parsed.weatherCityCode === 'string' ? parsed.weatherCityCode : '',
      weatherCity: typeof parsed.weatherCity === 'string' ? parsed.weatherCity : '',
      weatherDistrictCode: typeof parsed.weatherDistrictCode === 'string' ? parsed.weatherDistrictCode : '',
      weatherDistrict: typeof parsed.weatherDistrict === 'string' ? parsed.weatherDistrict : '',
      weatherLatitude: normalizeCoordinate(parsed.weatherLatitude, -90, 90),
      weatherLongitude: normalizeCoordinate(parsed.weatherLongitude, -180, 180),
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export const saveDesktopCustomization = (settings: DesktopCustomizationSettings) => {
  localStorage.setItem(DESKTOP_CUSTOMIZATION_STORAGE_KEY, JSON.stringify(settings))
  localStorage.setItem('desktopBackgroundDim', String(settings.backgroundDim))
  localStorage.setItem('desktopBackgroundBlur', String(settings.backgroundBlur))
  window.dispatchEvent(new CustomEvent(DESKTOP_CUSTOMIZATION_EVENT, { detail: settings }))
  window.dispatchEvent(new CustomEvent('desktopBackgroundDimChanged', { detail: settings.backgroundDim }))
  window.dispatchEvent(new CustomEvent('desktopBackgroundBlurChanged', { detail: settings.backgroundBlur }))
}
