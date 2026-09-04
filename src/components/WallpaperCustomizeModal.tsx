import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Upload, Trash2, Image as ImageIcon, Video, Check, RotateCcw, QrCode } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { wallpaperManager, WallpaperFile, WallpaperMode, WallpaperSwitchMode } from '../services/wallpaperManager'
import { isTvModeActive } from '../platform'
import { useTvBack } from '../tv/tvCore'

interface WallpaperCustomizeModalProps {
  show: boolean
  onClose: () => void
  playerTheme?: 'light' | 'dark'
}

export default function WallpaperCustomizeModal({ show, onClose, playerTheme = 'dark' }: WallpaperCustomizeModalProps) {
  // TV 遥控器 BACK：关闭壁纸自定义弹窗
  useTvBack(() => {
    if (show) {
      onClose()
      return true
    }
    return false
  }, [show, onClose])
  const textPrimary = playerTheme === 'dark' ? 'text-white' : 'text-black'
  const textSecondary = playerTheme === 'dark' ? 'text-white/60' : 'text-black/60'
  const textTertiary = playerTheme === 'dark' ? 'text-white/40' : 'text-black/40'
  const bgCard = playerTheme === 'dark' ? 'bg-white/5' : 'bg-black/5'
  const borderColor = playerTheme === 'dark' ? 'border-white/10' : 'border-black/10'
  
  const [accentColor, setAccentColor] = useState(() => {
    const saved = localStorage.getItem('accentColor')
    return saved || '#3B82F6'
  })

  const [wallpapers, setWallpapers] = useState<WallpaperFile[]>([])
  const [mode, setMode] = useState<WallpaperMode>('single')
  const [switchMode, setSwitchMode] = useState<WallpaperSwitchMode>('manual')
  const [intervalMinutes, setIntervalMinutes] = useState(30)
  const [currentIndex, setCurrentIndex] = useState(0)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string>('')
  // TV：手机扫码上传壁纸
  const [tvQrUrl, setTvQrUrl] = useState('')
  const [tvImporting, setTvImporting] = useState(false)
  const [tvWallpapers, setTvWallpapers] = useState<Array<{ name: string; url: string; uploadTime: number }>>([])
  const [tvError, setTvError] = useState('')
  
  const fileInputRef = useRef<HTMLInputElement>(null)

  // 加载数据
  useEffect(() => {
    if (show) {
      loadData()
    }
  }, [show])

  // 监听主题色变化
  useEffect(() => {
    const handleAccentColorChange = (e: Event) => {
      const customEvent = e as CustomEvent
      setAccentColor(customEvent.detail.color)
    }
    
    window.addEventListener('accentColorChanged', handleAccentColorChange)
    return () => window.removeEventListener('accentColorChanged', handleAccentColorChange)
  }, [])

  const loadData = async () => {
    const files = await wallpaperManager.getWallpapers()
    const settings = wallpaperManager.getSettings()
    
    setWallpapers(files)
    setMode(settings.mode)
    setSwitchMode(settings.switchMode)
    setIntervalMinutes(settings.intervalMinutes)
    setCurrentIndex(settings.currentIndex)
  }

  // TV：手机扫码上传壁纸（手机浏览器 → 设备 25567 → 设备存储 → 这里拉回导入 IndexedDB）
  useEffect(() => {
    if (!show || !isTvModeActive()) return
    void (async () => {
      try {
        const stRes = await fetch('http://localhost:3001/api/tv/remote-status', { cache: 'no-store' })
        const st = stRes.ok ? await stRes.json() : null
        const ip = st?.ips?.[0]?.address
        if (ip) setTvQrUrl(`http://${ip}:25567/wallpaper`)
      } catch {
        // ignore
      }
      try {
        const res = await fetch('http://localhost:3001/api/tv/wallpapers', { cache: 'no-store' })
        const data = res.ok ? await res.json() : null
        setTvWallpapers(data?.wallpapers || [])
      } catch {
        // ignore
      }
    })()
  }, [show])

  const importTvWallpapers = async () => {
    setTvImporting(true)
    setTvError('')
    try {
      // 已导入文件名记录在 localStorage，避免重复导入
      const importedKey = 'waveforge:tv-wallpapers-imported'
      let importedNames: string[] = []
      try {
        importedNames = JSON.parse(localStorage.getItem(importedKey) || '[]')
      } catch {
        // ignore
      }
      const res = await fetch('http://localhost:3001/api/tv/wallpapers', { cache: 'no-store' })
      const data = res.ok ? await res.json() : { wallpapers: [] }
      let imported = 0
      for (const wp of data.wallpapers || []) {
        if (importedNames.includes(wp.name)) continue
        const imgRes = await fetch('http://localhost:3001' + wp.url)
        if (!imgRes.ok) continue
        const blob = await imgRes.blob()
        const file = new File([blob], wp.name, { type: blob.type || 'image/jpeg' })
        const result = await wallpaperManager.addWallpaper(file)
        if (result.success) {
          imported++
          importedNames.push(wp.name)
        }
      }
      try {
        localStorage.setItem(importedKey, JSON.stringify(importedNames))
      } catch {
        // ignore
      }
      setTvWallpapers(data.wallpapers || [])
      if (imported === 0 && (data.wallpapers || []).length) setTvError('没有需要导入的新壁纸')
      await loadData()
    } catch (err) {
      setTvError(err instanceof Error ? err.message : '导入失败')
    } finally {
      setTvImporting(false)
    }
  }

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0) return

    setUploading(true)
    setError('')

    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      const result = await wallpaperManager.addWallpaper(file)
      
      if (!result.success) {
        setError(result.error || '上传失败')
        break
      }
    }

    setUploading(false)
    await loadData()
    
    // 触发壁纸变化事件，让首页立即更新
    window.dispatchEvent(new Event('wallpaperChanged'))
    
    // 清空 input
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  const handleDelete = async (id: string) => {
    await wallpaperManager.removeWallpaper(id)
    await loadData()
  }

  const handleSelectWallpaper = async (index: number) => {
    await wallpaperManager.setCurrentWallpaper(index)
    setCurrentIndex(index)
  }

  const handleSaveSettings = async () => {
    const settings = wallpaperManager.getSettings()
    settings.mode = mode
    settings.switchMode = switchMode
    settings.intervalMinutes = intervalMinutes
    wallpaperManager.saveSettings(settings)
    
    // 重启自动切换
    await wallpaperManager.startAutoSwitch()
    
    // 触发壁纸变化事件
    window.dispatchEvent(new Event('wallpaperChanged'))
    
    onClose()
  }

  const handleResetToDefault = async () => {
    if (confirm('确定要重置为默认背景吗？这将删除所有已上传的壁纸。')) {
      await wallpaperManager.resetToDefault()
      await loadData()
    }
  }

  const canUploadMore = wallpapers.length < 6

  return (
    <AnimatePresence>
      {show && (
        <>
          {/* 背景遮罩 */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[80]"
            onClick={onClose}
          />

          {/* 弹窗内容 */}
          <motion.div
            data-tv-scope
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            className="fixed inset-0 z-[90] flex items-center justify-center p-4 pointer-events-none"
          >
            <div
              className={`${bgCard} backdrop-blur-xl rounded-2xl border ${borderColor} max-w-4xl w-full max-h-[90vh] overflow-hidden pointer-events-auto`}
              onClick={(e) => e.stopPropagation()}
            >
              {/* 头部 */}
              <div className={`flex items-center justify-between p-6 border-b ${borderColor}`}>
                <div>
                  <h2 className={`text-2xl font-bold ${textPrimary}`}>自定义主页壁纸</h2>
                  <p className={`${textSecondary} text-sm mt-1`}>
                    上传图片或视频作为主页背景（最多6个文件）
                  </p>
                </div>
                <button
                  onClick={onClose}
                  className={`p-2 rounded-lg hover:bg-white/10 transition-colors ${textTertiary}`}
                >
                  <X className="w-6 h-6" />
                </button>
              </div>

              {/* 内容区 */}
              <div className="p-6 overflow-y-auto max-h-[calc(90vh-180px)]">
                {/* 上传区域 */}
                <div className="mb-6">
                  <h3 className={`text-lg font-semibold ${textPrimary} mb-3`}>
                    壁纸文件 ({wallpapers.length}/6)
                  </h3>
                  
                  {error && (
                    <div className="mb-4 p-3 bg-red-500/20 border border-red-500/30 rounded-lg text-red-400 text-sm">
                      {error}
                    </div>
                  )}

                  <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                    {/* 已上传的文件 */}
                    {wallpapers.map((wallpaper, index) => (
                      <div
                        key={wallpaper.id}
                        className={`relative ${bgCard} rounded-xl overflow-hidden border-2 transition-all cursor-pointer ${
                          currentIndex === index 
                            ? `border-[${accentColor}]` 
                            : borderColor
                        }`}
                        style={currentIndex === index ? { borderColor: accentColor } : {}}
                        onClick={() => handleSelectWallpaper(index)}
                      >
                        {/* 预览 */}
                        <div className="aspect-video bg-black/20 relative">
                          {wallpaper.type === 'image' ? (
                            <img
                              src={wallpaper.dataUrl}
                              alt="壁纸预览"
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <video
                              src={wallpaper.dataUrl}
                              className="w-full h-full object-cover"
                              muted
                              loop
                            />
                          )}
                          
                          {/* 选中标记 */}
                          {currentIndex === index && (
                            <div 
                              className="absolute top-2 right-2 w-6 h-6 rounded-full flex items-center justify-center"
                              style={{ backgroundColor: accentColor }}
                            >
                              <Check className="w-4 h-4 text-white" />
                            </div>
                          )}
                        </div>

                        {/* 文件信息 */}
                        <div className="absolute top-2 left-2 flex gap-1">
                          <div className="px-2 py-1 bg-black/60 backdrop-blur-sm rounded text-xs text-white font-medium flex items-center gap-1">
                            {wallpaper.type === 'image' ? (
                              <ImageIcon className="w-3 h-3" />
                            ) : (
                              <Video className="w-3 h-3" />
                            )}
                            {wallpaper.format.toUpperCase()}
                          </div>
                          <div className="px-2 py-1 bg-black/60 backdrop-blur-sm rounded text-xs text-white font-medium">
                            {wallpaperManager.formatSize(wallpaper.size)}
                          </div>
                        </div>

                        {/* 删除按钮 */}
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            handleDelete(wallpaper.id)
                          }}
                          className="absolute top-2 right-2 p-1.5 bg-red-500/80 hover:bg-red-500 backdrop-blur-sm rounded-lg transition-colors"
                        >
                          <Trash2 className="w-4 h-4 text-white" />
                        </button>
                      </div>
                    ))}

                    {/* 上传按钮 */}
                    {canUploadMore && (
                      <button
                        onClick={() => fileInputRef.current?.click()}
                        disabled={uploading}
                        className={`aspect-video ${bgCard} border-2 border-dashed ${borderColor} rounded-xl flex flex-col items-center justify-center gap-2 hover:bg-white/10 transition-all ${
                          uploading ? 'opacity-50 cursor-not-allowed' : ''
                        }`}
                      >
                        <Upload className={`w-8 h-8 ${textTertiary}`} />
                        <span className={`${textSecondary} text-sm`}>
                          {uploading ? '上传中...' : '点击上传'}
                        </span>
                        <span className={`${textTertiary} text-xs`}>
                          JPG, PNG, GIF, MP4
                        </span>
                      </button>
                    )}
                  </div>

                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".jpg,.jpeg,.png,.gif,.mp4"
                    multiple
                    onChange={handleFileSelect}
                    className="hidden"
                  />
                </div>

                {/* TV：手机扫码上传壁纸 */}
                {isTvModeActive() && (
                  <div className={`mb-6 rounded-xl ${bgCard} border ${borderColor} p-4`}>
                    <div className="flex items-center gap-3 mb-3">
                      <QrCode className="w-5 h-5" style={{ color: accentColor }} />
                      <h3 className={`text-base font-semibold ${textPrimary}`}>手机扫码上传壁纸</h3>
                    </div>
                    <p className={`text-xs ${textSecondary} mb-3 leading-5`}>
                      电视端无法直接选择本地图片。用手机扫下方二维码选图上传，上传后点「导入到电视」即可使用。
                    </p>
                    <div className="flex items-center gap-4">
                      {tvQrUrl ? (
                        <div className="shrink-0 rounded-lg bg-white p-2">
                          <QRCodeSVG value={tvQrUrl} size={120} level="M" />
                        </div>
                      ) : (
                        <div className={`shrink-0 w-[120px] h-[120px] rounded-lg ${bgCard} flex items-center justify-center text-xs ${textTertiary}`}>
                          获取地址中…
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        {tvWallpapers.length > 0 && (
                          <p className={`text-xs ${textSecondary} mb-2`}>已上传 {tvWallpapers.length} 张，等待导入</p>
                        )}
                        <button
                          onClick={() => void importTvWallpapers()}
                          disabled={tvImporting}
                          className="w-full rounded-xl px-4 py-2.5 text-sm font-semibold text-white transition-opacity disabled:opacity-50"
                          style={{ backgroundColor: accentColor }}
                        >
                          {tvImporting ? '导入中…' : '导入到电视'}
                        </button>
                        {tvError && <p className="text-red-400 text-xs mt-2">{tvError}</p>}
                      </div>
                    </div>
                  </div>
                )}

                {/* 切换模式 */}
                <div className="mb-6">
                  <h3 className={`text-lg font-semibold ${textPrimary} mb-3`}>切换模式</h3>
                  <div className="grid grid-cols-3 gap-3">
                    {[
                      { value: 'single' as WallpaperMode, label: '单张图片' },
                      { value: 'sequence' as WallpaperMode, label: '整体循环' },
                      { value: 'random' as WallpaperMode, label: '随机循环' },
                    ].map((option) => (
                      <button
                        key={option.value}
                        onClick={() => setMode(option.value)}
                        className={`p-4 rounded-xl border-2 transition-all ${
                          mode === option.value
                            ? `border-[${accentColor}]`
                            : `${bgCard} ${borderColor}`
                        }`}
                        style={mode === option.value ? { borderColor: accentColor } : {}}
                      >
                        <div className={`font-medium ${mode === option.value ? textPrimary : textSecondary}`}>
                          {option.label}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* 自动切换设置（仅在非单张模式下显示） */}
                {mode !== 'single' && (
                  <div className="mb-6">
                    <h3 className={`text-lg font-semibold ${textPrimary} mb-3`}>自动切换</h3>
                    
                    <div className="space-y-4">
                      {/* 切换时机 */}
                      <div>
                        <label className={`block ${textSecondary} text-sm mb-2`}>切换时机</label>
                        <div className="grid grid-cols-3 gap-3">
                          {[
                            { value: 'manual' as WallpaperSwitchMode, label: '手动切换' },
                            { value: 'interval' as WallpaperSwitchMode, label: '定时切换' },
                            { value: 'startup' as WallpaperSwitchMode, label: '启动时切换' },
                          ].map((option) => (
                            <button
                              key={option.value}
                              onClick={() => setSwitchMode(option.value)}
                              className={`p-3 rounded-lg border transition-all ${
                                switchMode === option.value
                                  ? `border-[${accentColor}]`
                                  : `${bgCard} ${borderColor}`
                              }`}
                              style={switchMode === option.value ? { borderColor: accentColor } : {}}
                            >
                              <div className={`text-sm font-medium ${switchMode === option.value ? textPrimary : textSecondary}`}>
                                {option.label}
                              </div>
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* 切换间隔（仅在定时切换时显示） */}
                      {switchMode === 'interval' && (
                        <div>
                          <label className={`block ${textSecondary} text-sm mb-2`}>
                            切换间隔（分钟）
                          </label>
                          <div className="flex gap-2">
                            {[10, 30, 60, 120].map((value) => (
                              <button
                                key={value}
                                onClick={() => setIntervalMinutes(value)}
                                className={`flex-1 p-3 rounded-lg border transition-all ${
                                  intervalMinutes === value
                                    ? `border-[${accentColor}]`
                                    : `${bgCard} ${borderColor}`
                                }`}
                                style={intervalMinutes === value ? { borderColor: accentColor } : {}}
                              >
                                <div className={`text-sm font-medium ${intervalMinutes === value ? textPrimary : textSecondary}`}>
                                  {value}分钟
                                </div>
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* 说明 */}
                <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
                  <h4 className={`${textPrimary} font-medium mb-2`}>使用说明</h4>
                  <ul className={`${textSecondary} text-sm space-y-1`}>
                    <li>• 支持格式：JPG、PNG、GIF、MP4</li>
                    <li>• 图片和视频最大 1GB</li>
                    <li>• 最多上传 6 个文件</li>
                    <li>• 单张模式：只显示选中的壁纸</li>
                    <li>• 整体循环：按顺序循环播放</li>
                    <li>• 随机循环：随机选择壁纸播放</li>
                  </ul>
                </div>
              </div>

              {/* 底部按钮 */}
              <div className={`flex items-center justify-between gap-3 p-6 border-t ${borderColor}`}>
                <button
                  onClick={handleResetToDefault}
                  className={`px-6 py-2.5 rounded-lg ${bgCard} ${textSecondary} hover:bg-white/10 transition-colors flex items-center gap-2`}
                  title="重置为默认背景"
                >
                  <RotateCcw className="w-4 h-4" />
                  重置默认
                </button>
                <div className="flex items-center gap-3">
                  <button
                    onClick={onClose}
                    className={`px-6 py-2.5 rounded-lg ${bgCard} ${textSecondary} hover:bg-white/10 transition-colors`}
                  >
                    取消
                  </button>
                  <button
                    onClick={handleSaveSettings}
                    className="px-6 py-2.5 rounded-lg text-white font-medium transition-all hover:opacity-90"
                    style={{ backgroundColor: accentColor }}
                  >
                    保存设置
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
