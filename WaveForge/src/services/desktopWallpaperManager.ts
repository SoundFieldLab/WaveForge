// 桌面模式壁纸管理器 - 独立于简约模式
export interface DesktopWallpaperFile {
  id: string
  type: 'image' | 'video'
  dataUrl: string
  format: string
  size: number
  name: string
  addedAt: number
}

export interface DesktopLiveWallpaperSource {
  kind: 'wallpaper-engine'
  sourceType: 'video' | 'web'
  url: string
  path: string
  title?: string
  id?: string // 壁纸 ID，用于跳过不支持的视频
}

export type DesktopWallpaperMode = 'single' | 'slideshow' | 'random-api'
export type DesktopWallpaperPlayMode = 'single' | 'sequential' | 'random' // 单张/顺序循环/随机循环
export type DesktopWallpaperSwitchMode = 'manual' | 'interval' | 'on-startup' // 手动/定时切换/启动时切换
export type RandomImageSource = 'bing' | 'landscape' | 'anime' | 'custom'

export interface DesktopWallpaperSettings {
  mode: DesktopWallpaperMode
  playMode: DesktopWallpaperPlayMode // 新增：播放模式
  switchMode: DesktopWallpaperSwitchMode
  intervalMinutes: number // 定时切换的时间间隔（分钟）
  currentIndex: number
  randomImageSource: RandomImageSource
  wallpaperEngineEnabled: boolean
  customApiUrl: string
  lastWallpaperSource: 'custom-upload' | 'random-api' | 'wallpaper-engine-manual' | 'none' // 记住用户上一次选择的壁纸来源
}

const STORAGE_KEY = 'desktop_wallpapers'
const SETTINGS_KEY = 'desktop_wallpaper_settings'
const MAX_FILES = 12
const MAX_FILE_SIZE = 1024 * 1024 * 1024 // 1GB

type ElectronWallpaperResult = {
  success: boolean
  path?: string
  fileUrl?: string
  dataUrl?: string
  error?: string
  wallpaperEngine?: {
    path?: string
    fileUrl?: string
    mediaUrl?: string
    sourceType: string
    title?: string
    unsupported?: boolean
  }
}

/**
 * 将本地壁纸路径规范化为渲染进程可直接使用的 URL，重点容错 UNC 网络路径：
 * - 已是 URL（data:/http:/https:/blob:/file:/waveforge-media:）原样返回
 * - UNC 路径（\\server\share\file.png）转为 file://server/share/file.png
 * - 其他本地路径保持原样（通常主进程已附带 fileUrl / dataUrl）
 */
export function toWallpaperUrl(raw: string | null | undefined): string {
  if (!raw) return ''
  const value = raw.trim()
  if (/^(data:|https?:|blob:|file:|waveforge-media:)/i.test(value)) return value
  // UNC：\\server\share\... -> file://server/share/...
  if (/^\\\\[^\\]+\\/.test(value)) {
    return `file:${value.replace(/\\/g, '/')}`
  }
  return value
}

function wallpaperResultToSource(result: ElectronWallpaperResult): string | DesktopLiveWallpaperSource | null {
  console.log('[wallpaperResultToSource] Processing result:', result)
  if (!result.success) return null
  const engine = result.wallpaperEngine
  console.log('[wallpaperResultToSource] Engine data:', engine)
  
  // 检查是否是不支持的壁纸类型
  if (engine?.unsupported) {
    console.warn('[wallpaperResultToSource] Unsupported wallpaper detected! Type:', engine.sourceType, 'Path:', engine.path)
    // 触发警告通知（携带 sourceType 供渲染端展示更准确的提示）
    setTimeout(() => {
      console.log('[wallpaperResultToSource] Dispatching unsupportedWallpaper event')
      window.dispatchEvent(new CustomEvent('unsupportedWallpaper', {
        detail: { sourceType: engine.sourceType, path: engine.path, title: engine.title }
      }))
    }, 100)
    // 返回系统壁纸作为回退（若为 UNC 路径则规范化为 file:// 形式）
    return toWallpaperUrl(result.dataUrl || result.fileUrl || result.path) || null
  }
  
  if (engine && (engine.sourceType === 'video' || engine.sourceType === 'web')) {
    return {
      kind: 'wallpaper-engine',
      sourceType: engine.sourceType,
      url: toWallpaperUrl(engine.mediaUrl || engine.fileUrl || engine.path) || '',
      path: engine.path || '',
      title: engine.title
    }
  }
  return toWallpaperUrl(result.dataUrl || result.fileUrl || result.path) || null
}

// 随机图片API配置 - 使用可用的API
const RANDOM_IMAGE_APIS: Record<RandomImageSource, string> = {
  'bing': 'https://bingw.jasonzeng.dev/?index=random',
  'landscape': 'https://tu.ltyuanfang.cn/api/fengjing.php',
  'anime': 'https://acg.yaohud.cn/dm/adaptive.php',
  'custom': '' // 使用用户自定义URL
}

class DesktopWallpaperManager {
  private wallpapers: DesktopWallpaperFile[] = []
  private settings: DesktopWallpaperSettings = {
    mode: 'single',
    playMode: 'single', // 默认单张播放
    switchMode: 'manual',
    intervalMinutes: 30,
    currentIndex: 0,
    randomImageSource: 'bing',
    wallpaperEngineEnabled: false,
    customApiUrl: '',
    lastWallpaperSource: 'none' // 默认没有选择
  }
  private switchTimer: number | null = null
  private currentRandomImageUrl: string | null = null

  constructor() {
    this.loadFromStorage()
  }

  private loadFromStorage() {
    try {
      const wallpapersData = localStorage.getItem(STORAGE_KEY)
      if (wallpapersData) {
        this.wallpapers = JSON.parse(wallpapersData)
      }

      const settingsData = localStorage.getItem(SETTINGS_KEY)
      if (settingsData) {
        this.settings = { ...this.settings, ...JSON.parse(settingsData) }
      }

      const wallpaperSyncEnabled = localStorage.getItem('wallpaperSyncEnabled')
      if (wallpaperSyncEnabled !== null) {
        this.settings.wallpaperEngineEnabled = JSON.parse(wallpaperSyncEnabled)
      }
    } catch (error) {
      console.error('加载桌面壁纸数据失败:', error)
    }
  }

  private saveToStorage() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.wallpapers))
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings))
    } catch (error) {
      console.error('保存桌面壁纸数据失败:', error)
    }
  }

  async addWallpaper(file: File): Promise<{ success: boolean; error?: string }> {
    if (this.wallpapers.length >= MAX_FILES) {
      return { success: false, error: `最多只能上传 ${MAX_FILES} 个文件` }
    }

    if (file.size > MAX_FILE_SIZE) {
      return { success: false, error: '文件大小不能超过 1GB' }
    }

    const isImage = file.type.startsWith('image/')
    const isVideo = file.type.startsWith('video/')

    if (!isImage && !isVideo) {
      return { success: false, error: '只支持图片和视频文件' }
    }

    try {
      const dataUrl = await this.fileToDataUrl(file)
      const wallpaper: DesktopWallpaperFile = {
        id: `desktop_wp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        type: isImage ? 'image' : 'video',
        dataUrl,
        format: file.type.split('/')[1] || 'unknown',
        size: file.size,
        name: file.name,
        addedAt: Date.now()
      }

      this.wallpapers.push(wallpaper)
      this.saveToStorage()
      return { success: true }
    } catch (error) {
      console.error('上传文件失败:', error)
      return { success: false, error: '文件读取失败' }
    }
  }

  private fileToDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
  }

  async removeWallpaper(id: string) {
    this.wallpapers = this.wallpapers.filter(w => w.id !== id)
    
    // 调整当前索引
    if (this.settings.currentIndex >= this.wallpapers.length) {
      this.settings.currentIndex = Math.max(0, this.wallpapers.length - 1)
    }
    
    this.saveToStorage()
  }

  getWallpapers(): DesktopWallpaperFile[] {
    return this.wallpapers
  }

  getSettings(): DesktopWallpaperSettings {
    return { ...this.settings }
  }

  saveSettings(settings: Partial<DesktopWallpaperSettings>) {
    this.settings = { ...this.settings, ...settings }
    this.saveToStorage()
  }

  async setCurrentWallpaper(index: number) {
    if (index >= 0 && index < this.wallpapers.length) {
      this.settings.currentIndex = index
      this.settings.lastWallpaperSource = 'custom-upload' // 记录用户选择了自定义上传壁纸
      this.saveToStorage()
    }
  }

  async getCurrentWallpaper(): Promise<DesktopWallpaperFile | DesktopLiveWallpaperSource | string | null> {
    // 第一优先级：Wallpaper Engine 实时联动（同步功能）
    // 只要同步开启，就无视其他所有壁纸设置
    if (this.settings.wallpaperEngineEnabled) {
      // 尝试通过 Electron API 获取系统壁纸
      if (window.electron?.wallpaper?.getCurrentWallpaper) {
        try {
          const result = await window.electron.wallpaper.getCurrentWallpaper()
          const wallpaperSource = wallpaperResultToSource(result)
          if (wallpaperSource) {
            console.log('✅ 成功获取系统壁纸（实时联动）:', wallpaperSource)
            return wallpaperSource
          }
        } catch (error) {
          console.error('❌ 获取系统壁纸失败:', error)
        }
      }
      
      // 降级：检查 localStorage 中的壁纸路径（用于开发环境）
      const wpePath = localStorage.getItem('currentWallpaperPath')
      if (wpePath) {
        return wpePath
      }
      
      // 如果实时联动失败，返回 null
      return null
    }
    
    // 第二优先级：同步关闭后，根据用户上一次的选择来决定使用哪个壁纸
    
    // 如果用户上一次选择的是"浏览壁纸引擎"的壁纸
    if (this.settings.lastWallpaperSource === 'wallpaper-engine-manual') {
      const selectedWeWallpaper = localStorage.getItem('selectedWeWallpaper')
      if (selectedWeWallpaper) {
        console.log('✅ 使用手动选择的 WallpaperEngine 壁纸:', selectedWeWallpaper)
        // 尝试从缓存的壁纸列表中找到这个壁纸
        const cachedWallpapers = localStorage.getItem('weWallpapersCache')
        if (cachedWallpapers) {
          try {
            const wallpapers = JSON.parse(cachedWallpapers)
            const selected = wallpapers.find((w: any) => w.id === selectedWeWallpaper)
            if (selected) {
              // 根据壁纸类型返回正确的格式
              if (selected.type === 'video') {
                // 视频壁纸 - 返回 DesktopLiveWallpaperSource
                const mediaUrl = `http://localhost:3001/api/wallpaper-engine/media?id=${selected.id}&file=${encodeURIComponent(selected.file)}`
                return {
                  kind: 'wallpaper-engine',
                  sourceType: 'video',
                  url: mediaUrl,
                  path: selected.path,
                  title: selected.title
                } as DesktopLiveWallpaperSource
              } else if (selected.type === 'image') {
                // 图片壁纸 - 返回真实文件 URL（容错 UNC 路径）
                return toWallpaperUrl(`http://localhost:3001/api/wallpaper-engine/media?id=${selected.id}&file=${encodeURIComponent(selected.file)}`)
              } else {
                // 其他类型使用预览图
                return toWallpaperUrl(`http://localhost:3001${selected.preview}`)
              }
            }
          } catch (error) {
            console.error('解析缓存的壁纸列表失败:', error)
          }
        }
      }
    }
    
    // 如果用户上一次选择的是"自定义壁纸"，或者没有找到手动选择的 WallpaperEngine 壁纸
    // 使用自定义壁纸或随机 API

    // 如果用户上一次选择的是随机 API
    if (this.settings.lastWallpaperSource === 'random-api') {
      return await this.fetchRandomImage()
    }

    // 如果用户上一次选择的是自定义上传壁纸
    if (this.settings.lastWallpaperSource === 'custom-upload') {
      if (this.wallpapers.length === 0) {
        return null
      }

      if (this.settings.mode === 'slideshow') {
        // 幻灯片模式随机选择
        const randomIndex = Math.floor(Math.random() * this.wallpapers.length)
        return this.wallpapers[randomIndex]
      }

      return this.wallpapers[this.settings.currentIndex] || this.wallpapers[0]
    }

    // 默认行为（兼容旧版本）：根据 mode 决定
    // 随机API模式
    if (this.settings.mode === 'random-api') {
      return await this.fetchRandomImage()
    }

    // 用户上传的自定义壁纸
    if (this.wallpapers.length === 0) {
      return null
    }

    if (this.settings.mode === 'slideshow') {
      // 幻灯片模式随机选择
      const randomIndex = Math.floor(Math.random() * this.wallpapers.length)
      return this.wallpapers[randomIndex]
    }

    return this.wallpapers[this.settings.currentIndex] || this.wallpapers[0]
  }

  private async fetchRandomImage(): Promise<string | null> {
    const source = this.settings.randomImageSource

    if (source === 'custom') {
      // 使用自定义API URL
      return this.settings.customApiUrl || null
    }

    const apiUrl = RANDOM_IMAGE_APIS[source]
    if (!apiUrl) return null

    try {
      // 所有API现在都直接返回图片URL
      return apiUrl
    } catch (error) {
      console.error('获取随机图片失败:', error)
    }

    return null
  }

  async startAutoSwitch() {
    this.stopAutoSwitch()

    // 定时切换模式
    if (this.settings.switchMode === 'interval' && (this.settings.playMode === 'sequential' || this.settings.playMode === 'random')) {
      const intervalMs = this.settings.intervalMinutes * 60 * 1000
      this.switchTimer = window.setInterval(() => {
        this.switchToNext()
      }, intervalMs)
    }
    
    // 启动时切换模式
    if (this.settings.switchMode === 'on-startup' && (this.settings.playMode === 'sequential' || this.settings.playMode === 'random')) {
      await this.switchToNext()
    }
  }

  stopAutoSwitch() {
    if (this.switchTimer !== null) {
      clearInterval(this.switchTimer)
      this.switchTimer = null
    }
  }

  async switchToNext() {
    if (this.settings.mode === 'random-api') {
      // 随机API模式，触发重新获取
      this.currentRandomImageUrl = null
      window.dispatchEvent(new Event('desktopWallpaperChanged'))
      return
    }

    if (this.wallpapers.length === 0) return

    // 根据播放模式切换
    if (this.settings.playMode === 'random') {
      // 随机选择
      this.settings.currentIndex = Math.floor(Math.random() * this.wallpapers.length)
    } else if (this.settings.playMode === 'sequential') {
      // 顺序切换
      this.settings.currentIndex = (this.settings.currentIndex + 1) % this.wallpapers.length
    }
    // 'single' 模式不自动切换

    this.saveToStorage()
    window.dispatchEvent(new Event('desktopWallpaperChanged'))
  }

  async switchOnStartup() {
    // 不再需要这个方法，逻辑已经合并到 startAutoSwitch
  }

  async resetToDefault() {
    this.wallpapers = []
    this.settings = {
      mode: 'single',
      playMode: 'single',
      switchMode: 'manual',
      intervalMinutes: 30,
      currentIndex: 0,
      randomImageSource: 'bing',
      wallpaperEngineEnabled: false,
      customApiUrl: '',
      lastWallpaperSource: 'none'
    }
    this.saveToStorage()
    this.stopAutoSwitch()
  }

  formatSize(bytes: number): string {
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  }
}

export const desktopWallpaperManager = new DesktopWallpaperManager()




