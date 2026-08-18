/**
 * 壁纸管理服务
 * 管理主页背景壁纸的上传、存储、切换
 * 使用 IndexedDB 存储大文件
 */

export type WallpaperMode = 'single' | 'sequence' | 'random'
export type WallpaperSwitchMode = 'manual' | 'interval' | 'startup'

export interface WallpaperFile {
  id: string
  type: 'image' | 'video'
  format: string // jpg, png, mp4, gif
  size: number // bytes
  dataUrl: string // base64 data URL 或 blob URL
  uploadTime: number
}

export interface WallpaperSettings {
  mode: WallpaperMode
  switchMode: WallpaperSwitchMode
  intervalMinutes: number // 自动切换间隔（分钟）
  currentIndex: number
  lastSwitchTime: number
}

class WallpaperManager {
  private readonly DB_NAME = 'WallpaperDB'
  private readonly DB_VERSION = 1
  private readonly STORE_NAME = 'wallpapers'
  private readonly SETTINGS_KEY = 'wallpaperSettings'
  private readonly MAX_FILES = 12
  private readonly MAX_IMAGE_SIZE = 1024 * 1024 * 1024 // 1GB
  private readonly MAX_VIDEO_SIZE = 1024 * 1024 * 1024 // 1GB
  private readonly ALLOWED_IMAGE_FORMATS = ['jpg', 'jpeg', 'png', 'gif']
  private readonly ALLOWED_VIDEO_FORMATS = ['mp4']
  
  private switchInterval: NodeJS.Timeout | null = null
  private db: IDBDatabase | null = null
  private dbInitialized: Promise<void>

  constructor() {
    this.dbInitialized = this.initDB()
  }

  /**
   * 初始化 IndexedDB
   */
  private async initDB(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.DB_NAME, this.DB_VERSION)
      
      request.onerror = () => {
        console.error('❌ IndexedDB 打开失败:', request.error)
        reject(request.error)
      }
      
      request.onsuccess = () => {
        this.db = request.result
        console.log('✅ IndexedDB 已初始化')
        resolve()
      }
      
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result
        
        // 创建对象存储
        if (!db.objectStoreNames.contains(this.STORE_NAME)) {
          const objectStore = db.createObjectStore(this.STORE_NAME, { keyPath: 'id' })
          objectStore.createIndex('uploadTime', 'uploadTime', { unique: false })
          console.log('✅ 创建了 wallpapers 对象存储')
        }
      }
    })
  }

  /**
   * 确保数据库已初始化
   */
  private async ensureDB(): Promise<IDBDatabase> {
    await this.dbInitialized
    if (!this.db) {
      throw new Error('数据库未初始化')
    }
    return this.db
  }

  /** 只读取排序后的键，避免为数量或当前项加载所有媒体内容。 */
  private async getWallpaperKeys(): Promise<IDBValidKey[]> {
    const db = await this.ensureDB()
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([this.STORE_NAME], 'readonly')
      const index = transaction.objectStore(this.STORE_NAME).index('uploadTime')
      const request = index.getAllKeys()
      request.onsuccess = () => resolve(request.result || [])
      request.onerror = () => reject(request.error)
    })
  }

  private async getWallpaperByKey(key: IDBValidKey): Promise<WallpaperFile | null> {
    const db = await this.ensureDB()
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([this.STORE_NAME], 'readonly')
      const request = transaction.objectStore(this.STORE_NAME).get(key)
      request.onsuccess = () => resolve(request.result || null)
      request.onerror = () => reject(request.error)
    })
  }

  async getWallpapers(): Promise<WallpaperFile[]> {
    try {
      const db = await this.ensureDB()
      return new Promise((resolve, reject) => {
        const transaction = db.transaction([this.STORE_NAME], 'readonly')
        const objectStore = transaction.objectStore(this.STORE_NAME)
        const request = objectStore.getAll()
        
        request.onsuccess = () => {
          const wallpapers = request.result || []
          // 按上传时间排序
          wallpapers.sort((a, b) => a.uploadTime - b.uploadTime)
          resolve(wallpapers)
        }
        
        request.onerror = () => {
          console.error('❌ 获取壁纸失败:', request.error)
          reject(request.error)
        }
      })
    } catch (error) {
      console.error('❌ 获取壁纸失败:', error)
      return []
    }
  }

  /**
   * 获取壁纸设置
   */
  getSettings(): WallpaperSettings {
    const saved = localStorage.getItem(this.SETTINGS_KEY)
    return saved ? JSON.parse(saved) : {
      mode: 'single' as WallpaperMode,
      switchMode: 'manual' as WallpaperSwitchMode,
      intervalMinutes: 30,
      currentIndex: 0,
      lastSwitchTime: Date.now()
    }
  }

  /**
   * 保存壁纸设置
   */
  saveSettings(settings: WallpaperSettings) {
    localStorage.setItem(this.SETTINGS_KEY, JSON.stringify(settings))
    console.log('✅ 壁纸设置已保存:', settings)
    
    // 重新启动定时器
    this.startAutoSwitch()
  }

  /**
   * 添加壁纸文件
   */
  async addWallpaper(file: File): Promise<{ success: boolean, error?: string }> {
    // 检查文件数量
    // Checking the count must not deserialize every large wallpaper record.
    const wallpaperKeys = await this.getWallpaperKeys()
    if (wallpaperKeys.length >= this.MAX_FILES) {
      return { success: false, error: `最多只能上传 ${this.MAX_FILES} 个文件` }
    }

    // 检查文件格式
    const format = file.name.split('.').pop()?.toLowerCase() || ''
    const isImage = this.ALLOWED_IMAGE_FORMATS.includes(format)
    const isVideo = this.ALLOWED_VIDEO_FORMATS.includes(format)
    
    if (!isImage && !isVideo) {
      return { success: false, error: `不支持的文件格式: ${format}` }
    }

    // 检查文件大小
    const maxSize = isImage ? this.MAX_IMAGE_SIZE : this.MAX_VIDEO_SIZE
    if (file.size > maxSize) {
      const maxSizeMB = maxSize / (1024 * 1024)
      return { success: false, error: `文件大小超过限制: ${maxSizeMB}MB` }
    }

    // 读取文件为 Blob URL（不转 base64，避免内存问题）
    try {
      const dataUrl = await this.fileToDataUrl(file)
      
      const wallpaper: WallpaperFile = {
        id: Date.now().toString(),
        type: isImage ? 'image' : 'video',
        format,
        size: file.size,
        dataUrl,
        uploadTime: Date.now()
      }

      // 保存到 IndexedDB
      const db = await this.ensureDB()
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction([this.STORE_NAME], 'readwrite')
        const objectStore = transaction.objectStore(this.STORE_NAME)
        const request = objectStore.add(wallpaper)
        
        request.onsuccess = () => {
          console.log(`✅ 已添加壁纸: ${format}, ${this.formatSize(file.size)}`)
          resolve()
        }
        
        request.onerror = () => {
          console.error('❌ 保存壁纸失败:', request.error)
          reject(request.error)
        }
      })
      
      return { success: true }
    } catch (error) {
      console.error('❌ 读取文件失败:', error)
      return { success: false, error: '读取文件失败: ' + (error as Error).message }
    }
  }

  /**
   * 删除壁纸文件
   */
  async removeWallpaper(id: string) {
    try {
      // 先获取删除前的壁纸列表和设置
      // Read only keys so deletion does not load every media payload.
      const wallpaperKeysBefore = await this.getWallpaperKeys()
      const settings = this.getSettings()

      const deletedIndex = wallpaperKeysBefore.findIndex(key => String(key) === id)
      const isDeletingCurrent = deletedIndex === settings.currentIndex
      const isDeletingFirst = deletedIndex === 0
      
      // 执行删除操作
      const db = await this.ensureDB()
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction([this.STORE_NAME], 'readwrite')
        const objectStore = transaction.objectStore(this.STORE_NAME)
        const request = objectStore.delete(id)
        
        request.onsuccess = () => {
          console.log('✅ 已删除壁纸:', id)
          resolve()
        }
        
        request.onerror = () => {
          console.error('❌ 删除壁纸失败:', request.error)
          reject(request.error)
        }
      })
      
      const wallpaperCountAfter = Math.max(0, wallpaperKeysBefore.length - (deletedIndex >= 0 ? 1 : 0))
      
      // 处理删除后的逻辑
      if (isDeletingCurrent) {
        // 删除的是当前正在使用的壁纸
        if (isDeletingFirst && wallpaperCountAfter === 0) {
          // 删除的是第一张且没有其他壁纸了，使用默认背景
          console.log('📌 删除了第一张壁纸且无其他壁纸，使用默认背景')
          settings.currentIndex = 0
          this.saveSettings(settings)
          window.dispatchEvent(new Event('wallpaperChanged'))
        } else if (wallpaperCountAfter > 0) {
          // 还有其他壁纸，自动选择第一张
          console.log('📌 删除了当前壁纸，自动切换到第一张')
          settings.currentIndex = 0
          this.saveSettings(settings)
          window.dispatchEvent(new Event('wallpaperChanged'))
        } else {
          // 没有壁纸了，使用默认背景
          console.log('📌 所有壁纸已删除，使用默认背景')
          settings.currentIndex = 0
          this.saveSettings(settings)
          window.dispatchEvent(new Event('wallpaperChanged'))
        }
      } else {
        // 删除的不是当前壁纸，只需调整索引
        if (deletedIndex < settings.currentIndex) {
          // 删除的壁纸在当前壁纸之前，索引需要减1
          settings.currentIndex = Math.max(0, settings.currentIndex - 1)
        }
        // 确保索引不超出范围
        if (settings.currentIndex >= wallpaperCountAfter && wallpaperCountAfter > 0) {
          settings.currentIndex = wallpaperCountAfter - 1
        }
        this.saveSettings(settings)
      }
    } catch (error) {
      console.error('❌ 删除壁纸失败:', error)
    }
  }

  /**
   * 获取当前壁纸
   */
  async getCurrentWallpaper(): Promise<WallpaperFile | null> {
    try {
      const keys = await this.getWallpaperKeys()
      const settings = this.getSettings()
      if (keys.length === 0) return null

      // Load exactly one payload instead of cloning all base64 wallpapers.
      const index = Math.min(Math.max(0, settings.currentIndex), keys.length - 1)
      return await this.getWallpaperByKey(keys[index])
    } catch (error) {
      console.error('❌ 获取当前壁纸失败:', error)
      return null
    }
  }

  /**
   * 切换到下一张壁纸
   */
  async nextWallpaper() {
    const wallpaperKeys = await this.getWallpaperKeys()
    if (wallpaperKeys.length === 0) return

    const settings = this.getSettings()

    if (settings.mode === 'sequence') {
      // 整体循环
      settings.currentIndex = (settings.currentIndex + 1) % wallpaperKeys.length
    } else if (settings.mode === 'random') {
      // 随机循环
      settings.currentIndex = Math.floor(Math.random() * wallpaperKeys.length)
    }
    
    settings.lastSwitchTime = Date.now()
    this.saveSettings(settings)
    
    window.dispatchEvent(new Event('wallpaperChanged'))
  }

  /**
   * 手动设置当前壁纸
   */
  async setCurrentWallpaper(index: number) {
    const wallpaperKeys = await this.getWallpaperKeys()
    if (index < 0 || index >= wallpaperKeys.length) return
    
    const settings = this.getSettings()
    settings.currentIndex = index
    settings.lastSwitchTime = Date.now()
    this.saveSettings(settings)
    
    window.dispatchEvent(new Event('wallpaperChanged'))
  }

  /**
   * 启动自动切换
   */
  async startAutoSwitch() {
    // 清除旧定时器
    if (this.switchInterval) {
      clearInterval(this.switchInterval)
      this.switchInterval = null
    }

    const settings = this.getSettings()
    
    // 只在 interval 模式下启动定时器
    if (settings.switchMode === 'interval' && settings.mode !== 'single') {
      const intervalMs = settings.intervalMinutes * 60 * 1000
      
      this.switchInterval = setInterval(() => {
        console.log('⏰ 自动切换壁纸')
        this.nextWallpaper()
      }, intervalMs)
      
      console.log(`✅ 已启动壁纸自动切换，间隔: ${settings.intervalMinutes} 分钟`)
    }
  }

  /**
   * 停止自动切换
   */
  stopAutoSwitch() {
    if (this.switchInterval) {
      clearInterval(this.switchInterval)
      this.switchInterval = null
      console.log('✅ 已停止壁纸自动切换')
    }
  }

  /**
   * 重置为默认背景（清空所有壁纸）
   */
  async resetToDefault() {
    try {
      const db = await this.ensureDB()
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction([this.STORE_NAME], 'readwrite')
        const objectStore = transaction.objectStore(this.STORE_NAME)
        const request = objectStore.clear()
        
        request.onsuccess = () => {
          console.log('✅ 已清空所有壁纸')
          resolve()
        }
        
        request.onerror = () => {
          console.error('❌ 清空壁纸失败:', request.error)
          reject(request.error)
        }
      })
      
      localStorage.removeItem(this.SETTINGS_KEY)
      this.stopAutoSwitch()
      window.dispatchEvent(new Event('wallpaperChanged'))
      console.log('✅ 已重置为默认背景')
    } catch (error) {
      console.error('❌ 重置失败:', error)
    }
  }

  /**
   * 在软件启动时切换壁纸（如果设置了）
   */
  async switchOnStartup() {
    const settings = this.getSettings()
    if (settings.switchMode === 'startup' && settings.mode !== 'single') {
      console.log('🚀 启动时切换壁纸')
      await this.nextWallpaper()
    }
  }

  /**
   * 文件转 Base64
   */
  private fileToDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onloadend = () => resolve(reader.result as string)
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
  }

  /**
   * 格式化文件大小
   */
  formatSize(bytes: number): string {
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB'
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB'
  }

  /**
   * 🔧 关闭数据库连接（用于清理资源）
   */
  close() {
    this.stopAutoSwitch()
    if (this.db) {
      this.db.close()
      this.db = null
      console.log('✅ WallpaperManager 数据库已关闭')
    }
  }
}

// 导出单例
export const wallpaperManager = new WallpaperManager()
