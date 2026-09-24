import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Trash2, FolderOpen, ListMusic, AlertCircle, HardDrive, Clock, Check, Image as ImageIcon } from 'lucide-react'
import { cacheManager } from '../services/cacheManager'
import { indexedDBCache } from '../services/indexedDBCache'
import { clearArtworkMemoryCache, clearBackendImageCache } from '../services/artworkLoader'
import { clearUserPlaylistsMemoryCache } from '../services/playlistService'
import { clearCoverPaletteCache } from '../utils/coverPalette'
import { clearAllMvMatchCache } from '../services/bilibiliApi'
import { clearDesktopMusicActivity } from '../services/desktopMusicActivity'
import GlobalToast from './GlobalToast'
import { useTvBack } from '../tv/tvCore'
import { isDesktop } from '../platform'

interface CacheClearModalProps {
  show: boolean
  onClose: () => void
  playerTheme?: 'light' | 'dark'
}

export default function CacheClearModal({ show, onClose, playerTheme = 'dark' }: CacheClearModalProps) {
  const textPrimary = playerTheme === 'dark' ? 'text-white' : 'text-black'
  const textSecondary = playerTheme === 'dark' ? 'text-white/60' : 'text-black/60'
  const textTertiary = playerTheme === 'dark' ? 'text-white/40' : 'text-black/40'
  const bgCard = playerTheme === 'dark' ? 'bg-white/5' : 'bg-black/5'
  const borderColor = playerTheme === 'dark' ? 'border-white/10' : 'border-black/10'
  
  // TV 遥控器 BACK 关闭弹窗（必须带 show 守卫：本组件经 SettingsPanel 常驻挂载，
  // 无守卫会在隐藏时也消费 BACK 键，导致全场景 BACK 失效、无注册弹窗关不掉）
  useTvBack(() => {
    if (show) {
      onClose()
      return true
    }
    return false
  })
  const [accentColor, setAccentColor] = useState(() => {
    const saved = localStorage.getItem('accentColor')
    return saved || '#3B82F6'
  })
  
  const [cacheStats, setCacheStats] = useState({
    coverCount: 0,
    coverSize: 0,
    playlistCount: 0,
    playlistSize: 0,
    lyricsCount: 0,
    lyricsSize: 0,
    errorLogCount: 0,
    errorLogSize: 0,
    audioCount: 0,
    audioSize: 0,
    analysisCount: 0,
    analysisSize: 0,
    transitionCount: 0,
    transitionSize: 0,
    metadataCount: 0,
    metadataSize: 0,
    totalSize: 0
  })
  
  const [cacheDir, setCacheDir] = useState('')
  const [audioCacheDir, setAudioCacheDir] = useState('')
  
  const [autoClearSettings, setAutoClearSettings] = useState(() => 
    cacheManager.getAutoClearSettings()
  )
  
  const [daysUntilNextClear, setDaysUntilNextClear] = useState<number | null>(null)
  
  // Toast 消息状态
  const [toastMessage, setToastMessage] = useState('')
  const [showToast, setShowToast] = useState(false)
  const toastTimerRef = useRef<NodeJS.Timeout | null>(null)
  
  // 清理所有缓存的二次确认状态
  const [clearAllConfirm, setClearAllConfirm] = useState(false)
  const [busyTarget, setBusyTarget] = useState<string | null>(null)
  const [failedTargets, setFailedTargets] = useState<string[]>([])
  const clearAllTimerRef = useRef<NodeJS.Timeout | null>(null)
  
  const showToastMessage = (message: string) => {
    // 清除之前的定时器
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current)
    }
    
    setToastMessage(message)
    setShowToast(true)
    
    // 3秒后自动隐藏
    toastTimerRef.current = setTimeout(() => {
      setShowToast(false)
    }, 3000)
  }
  
  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current)
      }
      if (clearAllTimerRef.current) {
        clearTimeout(clearAllTimerRef.current)
      }
    }
  }, [])
  
  useEffect(() => {
    if (show) {
      refreshStats()
      setAutoClearSettings(cacheManager.getAutoClearSettings())
      setDaysUntilNextClear(cacheManager.getDaysUntilNextClear())
      
      if (isDesktop() && window.electron?.config) {
        window.electron.config.getCachePath().then(setCacheDir).catch(err => {
          console.error('Failed to get cache path:', err)
          setCacheDir('')
        })
      } else {
        setCacheDir('')
      }
      
    }
  }, [show])
  
  useEffect(() => {
    const handleAccentColorChange = (e: Event) => {
      const customEvent = e as CustomEvent
      if (customEvent.detail) {
        setAccentColor(customEvent.detail)
      }
    }
    window.addEventListener('accentColorChanged', handleAccentColorChange)
    return () => window.removeEventListener('accentColorChanged', handleAccentColorChange)
  }, [])
  
  const refreshStats = async () => {
    const [localStats, indexedStats, metadataStats] = await Promise.all([
      Promise.resolve(cacheManager.getCacheStats()),
      indexedDBCache.getCacheStats().catch(() => ({ coverCount: 0, coverSize: 0, playlistCount: 0, playlistSize: 0, lyricsCount: 0, lyricsSize: 0, metadataCount: 0, metadataSize: 0 })),
      cacheManager.getMetadataCacheStats().catch(() => ({ count: 0, size: 0 })),
    ])
    const audioStats = await window.electron?.audioDownload?.getStats().catch(() => null) || null
    const analysisStats = await window.electron?.analysis?.getCacheStats().catch(() => null) || null
    const transitionStats = await window.electron?.render?.getCacheStats().catch(() => null) || null
    const trackStemStats = await window.electron?.trackStems?.getCacheStats?.().catch(() => null) || null
    if (audioStats) setAudioCacheDir(audioStats.cachePath)

    const coverCount = localStats.coverCount + indexedStats.coverCount
    const coverSize = localStats.coverSize + indexedStats.coverSize
    const playlistCount = localStats.playlistCount + indexedStats.playlistCount
    setCacheStats({
      coverCount,
      coverSize,
      playlistCount,
      playlistSize: localStats.playlistSize + indexedStats.playlistSize,
      lyricsCount: indexedStats.lyricsCount,
      lyricsSize: indexedStats.lyricsSize,
      errorLogCount: localStats.errorLogCount,
      errorLogSize: localStats.errorLogSize,
      audioCount: audioStats?.fileCount || 0,
      audioSize: audioStats?.totalSize || 0,
      analysisCount: analysisStats?.fileCount || 0,
      analysisSize: analysisStats?.totalSize || 0,
      transitionCount: (transitionStats?.count || 0) + (trackStemStats?.count || 0),
      transitionSize: (transitionStats?.size || 0) + (trackStemStats?.size || 0),
      metadataCount: metadataStats.count,
      metadataSize: metadataStats.size,
      totalSize: coverSize + localStats.playlistSize + indexedStats.playlistSize + indexedStats.lyricsSize + metadataStats.size + localStats.errorLogSize
        + (audioStats?.totalSize || 0) + (analysisStats?.totalSize || 0) + (transitionStats?.size || 0) + (trackStemStats?.size || 0),
    })
  }

  const runTarget = async (target: string, action: () => Promise<void> | void, success: string) => {
    if (busyTarget) return
    setBusyTarget(target)
    setFailedTargets(previous => previous.filter(item => item !== target))
    try {
      await action()
      // 统计刷新失败不应卡住弹窗：busyTarget 的复位在函数末尾，异常会跳过它导致所有按钮永久禁用
      try { await refreshStats() } catch { /* 忽略统计失败 */ }
      showToastMessage(success)
    } catch (error) {
      console.error(`缓存清理失败 [${target}]:`, error)
      setFailedTargets(previous => previous.includes(target) ? previous : [...previous, target])
      showToastMessage(`${target}清理失败，可重试`)
    } finally {
      setBusyTarget(null)
    }
  }

  const handleClearCovers = async () => runTarget('封面', async () => {
    cacheManager.clearCovers()
    clearArtworkMemoryCache()
    await indexedDBCache.clearCovers()
    await clearBackendImageCache()
  }, '封面缓存清理成功')

  const handleClearPlaylists = async () => runTarget('歌单列表', async () => {
    cacheManager.clearPlaylists()
    clearUserPlaylistsMemoryCache()
    await indexedDBCache.clearPlaylists()
  }, '歌单列表缓存清理成功')

  const handleClearLyrics = async () => runTarget('歌词', async () => {
    window.dispatchEvent(new Event('waveforge:lyrics-cache-cleared'))
    await indexedDBCache.clearLyrics()
  }, '歌词缓存清理成功')

  const handleClearMetadata = async () => runTarget('歌曲信息', () => cacheManager.clearMetadata(), '歌曲信息缓存清理成功')

  const handleClearErrorLogs = async () => runTarget('错误日志', () => cacheManager.clearErrorLogs(), '错误日志清理成功')

  const handleClearAudioCache = async () => {
    if (!window.electron?.audioDownload) return
    await runTarget('音频', async () => {
      const result = await window.electron!.audioDownload!.clearCache()
      if (!result.success) throw new Error('音频缓存清理失败')
    }, '音频缓存清理成功')
  }

  const handleClearAnalysisCache = async () => {
    if (!window.electron?.analysis) return
    await runTarget('分析', async () => {
      const result = await window.electron!.analysis!.clearCache()
      if (!result.success) throw new Error(result.error || '分析缓存清理失败')
    }, '分析缓存清理成功')
  }

  const handleClearTransitionCache = async () => {
    if (!window.electron?.render) return
    await runTarget('过渡', async () => {
      window.dispatchEvent(new Event('waveforge:track-stem-cache-clearing'))
      const [renderResult, stemResult, trackStemResult] = await Promise.all([
        window.electron!.render!.clearCache(),
        window.electron!.stems?.clearCache?.() ?? Promise.resolve({ success: true, cleared: 0 }),
        window.electron!.trackStems?.clearCache?.() ?? Promise.resolve({ success: true, cleared: 0 }),
      ])
      if (!renderResult.success || !stemResult.success || !trackStemResult.success) throw new Error('过渡音频缓存清理失败')
    }, '过渡音频与分轨缓存清理成功')
  }
  
  const handleClearAll = async () => {
    if (busyTarget) return
    if (!clearAllConfirm) {
      // 第一次点击，进入确认状态
      setClearAllConfirm(true)
      
      // 5秒后自动取消确认状态
      if (clearAllTimerRef.current) {
        clearTimeout(clearAllTimerRef.current)
      }
      clearAllTimerRef.current = setTimeout(() => {
        setClearAllConfirm(false)
      }, 5000)
    } else {
      const failed: string[] = []
      setBusyTarget('全部')
      setFailedTargets([])
      window.dispatchEvent(new Event('waveforge:track-stem-cache-clearing'))
      cacheManager.clearAll()
      clearArtworkMemoryCache()
      clearUserPlaylistsMemoryCache()
      clearCoverPaletteCache()
      window.dispatchEvent(new Event('waveforge:lyrics-cache-cleared'))
      const clearTarget = async (target: string, action: () => Promise<unknown>) => {
        try {
          await action()
        } catch (error) {
          failed.push(target)
          console.error(`缓存清理失败 [${target}]:`, error)
        }
      }
      // 先前未接入「清理所有缓存」的几类本地缓存：MV 匹配覆盖/黑名单、桌面收听统计
      await clearTarget('MV 匹配', () => { clearAllMvMatchCache(); return Promise.resolve() })
      await clearTarget('收听统计', () => { clearDesktopMusicActivity(); return Promise.resolve() })
      await clearTarget('IndexedDB', () => indexedDBCache.clearAll())
      await clearTarget('后端图片代理', () => clearBackendImageCache())
      await clearTarget('歌曲信息', () => cacheManager.clearMetadata())
      // GPU 着色/合成缓存（ShaderCache + GPUCache）：新后端从干净状态重建
      if (window.electron?.system?.clearGpuCache) {
        await clearTarget('GPU 着色', async () => {
          const result = await window.electron!.system!.clearGpuCache()
          if (!result.success) throw new Error('GPU 着色缓存清理失败')
        })
      }
      if (window.electron?.audioDownload) {
        await clearTarget('音频', async () => {
          const result = await window.electron!.audioDownload!.clearCache()
          if (!result.success) throw new Error('音频缓存清理失败')
        })
      }
      if (window.electron?.analysis) {
        await clearTarget('分析', async () => {
          const result = await window.electron!.analysis!.clearCache()
          if (!result.success) throw new Error(result.error || '分析缓存清理失败')
        })
      }
      if (window.electron?.render) {
        await clearTarget('过渡', async () => {
          const [renderResult, stemResult, trackStemResult] = await Promise.all([
            window.electron!.render!.clearCache(),
            window.electron!.stems?.clearCache?.() ?? Promise.resolve({ success: true, cleared: 0 }),
            window.electron!.trackStems?.clearCache?.() ?? Promise.resolve({ success: true, cleared: 0 }),
          ])
          if (!renderResult.success || !stemResult.success || !trackStemResult.success) throw new Error('过渡或分轨缓存清理失败')
        })
      }
      // 统计刷新失败不应卡住弹窗：busyTarget 的复位在函数末尾，异常会跳过它导致所有按钮永久禁用
      try { await refreshStats() } catch { /* 忽略统计失败 */ }
      setFailedTargets(failed)
      showToastMessage(failed.length ? `部分缓存清理失败：${failed.join('、')}，可重试` : '所有缓存清理成功')
      setClearAllConfirm(false)
      setBusyTarget(null)
      
      if (clearAllTimerRef.current) {
        clearTimeout(clearAllTimerRef.current)
      }
    }
  }
  
  
  const handleAutoClearSettingsChange = (newSettings: typeof autoClearSettings) => {
    setAutoClearSettings(newSettings)
    cacheManager.setAutoClearSettings(newSettings)
    setDaysUntilNextClear(cacheManager.getDaysUntilNextClear())
  }
  
  return (
    <AnimatePresence>
      {show && (
        <>
          {/* 隐藏number输入框的箭头样式 */}
          <style>{`
            input[type="number"]::-webkit-inner-spin-button,
            input[type="number"]::-webkit-outer-spin-button {
              -webkit-appearance: none;
              margin: 0;
            }
            input[type="number"] {
              -moz-appearance: textfield;
            }
          `}</style>
          
          {/* 背景遮罩 */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[600]"
          />
          
          {/* 弹窗 */}
          <motion.div
            initial={{ x: '100%', opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: '100%', opacity: 0 }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            className="fixed right-0 top-0 h-full w-full max-w-lg z-[610] shadow-2xl overflow-hidden"
            data-tv-scope
            style={{
              background: playerTheme === 'dark' 
                ? 'linear-gradient(135deg, rgba(30, 30, 40, 0.98) 0%, rgba(20, 20, 30, 0.98) 100%)'
                : 'linear-gradient(135deg, rgba(250, 250, 250, 0.98) 0%, rgba(240, 240, 240, 0.98) 100%)',
              backdropFilter: 'blur(20px)',
              WebkitBackdropFilter: 'blur(20px)',
            }}
          >
            {/* 头部 */}
            <div className={`p-6 border-b ${borderColor} flex items-center justify-between`}>
              <div className="flex items-center gap-3">
                <Trash2 className="w-6 h-6" style={{ color: accentColor }} />
                <h2 className={`text-2xl font-bold ${textPrimary}`}>缓存清理</h2>
              </div>
              <button
                onClick={onClose}
                className={`p-2 rounded-full transition-colors ${bgCard} hover:bg-white/10`}
              >
                <X className={`w-5 h-5 ${textPrimary}`} />
              </button>
            </div>
            
            {/* 内容区 */}
            <div className="overflow-y-auto h-[calc(100%-88px)] p-6" style={{ scrollbarWidth: 'thin' }}>
              {/* 总览 */}
              <div 
                className={`p-4 rounded-xl mb-6 ${bgCard} border ${borderColor}`}
              >
                <div className="flex items-center gap-3 mb-3">
                  <HardDrive className="w-5 h-5" style={{ color: accentColor }} />
                  <h3 className={`text-lg font-bold ${textPrimary}`}>缓存总览</h3>
                </div>
                <div className={`text-3xl font-bold ${textPrimary} mb-1`}>
                  {cacheManager.formatSize(cacheStats.totalSize)}
                </div>
                <div className={`${textSecondary} text-sm`}>
                  共 {cacheStats.coverCount + cacheStats.playlistCount + cacheStats.lyricsCount + cacheStats.metadataCount + cacheStats.errorLogCount + cacheStats.audioCount + cacheStats.analysisCount + cacheStats.transitionCount} 项缓存
                </div>
              </div>
              
              {/* 缓存目录 */}
              {isDesktop() && window.electron?.config?.getCachePath && (
              <div className={`p-4 rounded-xl mb-6 ${bgCard} border ${borderColor}`}>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <FolderOpen className="w-4 h-4" style={{ color: accentColor }} />
                    <span className={`${textPrimary} text-sm font-medium`}>缓存目录</span>
                  </div>
                  {window.electron?.config?.selectCachePath && (
                  <button
                    onClick={async () => {
                      const result = await window.electron?.config?.selectCachePath()
                      if (result) {
                        const refreshedPath = await window.electron?.config?.getCachePath().catch(() => result)
                        setCacheDir(refreshedPath || result)
                        showToastMessage('缓存目录已更新')
                      }
                    }}
                    className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors ${
                      playerTheme === 'dark' 
                        ? 'bg-white/10 hover:bg-white/15 text-white' 
                        : 'bg-black/10 hover:bg-black/15 text-black'
                    }`}
                  >
                    更改
                  </button>
                  )}
                </div>
                <div className={`${textSecondary} text-xs break-all`}>
                  {cacheDir || '加载中...'}
                </div>
              </div>
              )}
              
              {/* 封面缓存 */}
              <div className={`p-4 rounded-xl mb-4 ${bgCard} border ${borderColor} relative`}>
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accentColor}20` }}>
                      <ImageIcon className="w-5 h-5" style={{ color: accentColor }} />
                    </div>
                    <div><div className={`${textPrimary} text-sm font-medium`}>封面取色缓存</div><div className={`${textTertiary} text-xs`}>{cacheStats.coverCount} 张图片</div></div>
                  </div>
                  <div className={`${textPrimary} text-sm font-bold`}>{cacheManager.formatSize(cacheStats.coverSize)}</div>
                </div>
                <button onClick={handleClearCovers} disabled={cacheStats.coverCount === 0 || !!busyTarget} className="absolute bottom-3 right-3 p-2 rounded-lg transition-all disabled:opacity-30" style={{ backgroundColor: `${accentColor}20`, color: accentColor }} title="清理封面缓存"><Trash2 className="w-4 h-4" /></button>
              </div>

              {/* 歌单列表缓存 */}
              <div className={`p-4 rounded-xl mb-4 ${bgCard} border ${borderColor} relative`}>
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <div 
                      className="w-10 h-10 rounded-lg flex items-center justify-center"
                      style={{ backgroundColor: `${accentColor}20` }}
                    >
                      <ListMusic className="w-5 h-5" style={{ color: accentColor }} />
                    </div>
                    <div>
                      <div className={`${textPrimary} text-sm font-medium`}>歌单列表</div>
                      <div className={`${textTertiary} text-xs`}>
                        {cacheStats.playlistCount} 个列表
                      </div>
                    </div>
                  </div>
                  <div className={`${textPrimary} text-sm font-bold`}>
                    {cacheManager.formatSize(cacheStats.playlistSize)}
                  </div>
                </div>
                <div className={`${textSecondary} text-xs mb-2`}>
                  缓存歌单列表可以在下次登录时快速加载
                </div>
                {/* 垃圾桶按钮 - 右下角 */}
                <button
                  onClick={handleClearPlaylists}
                  disabled={cacheStats.playlistCount === 0 || !!busyTarget}
                  className={`absolute bottom-3 right-3 p-2 rounded-lg transition-all ${
                    cacheStats.playlistCount === 0 
                      ? 'opacity-30 cursor-not-allowed' 
                      : 'hover:brightness-110 hover:scale-105'
                  }`}
                  style={{ 
                    backgroundColor: cacheStats.playlistCount === 0 ? `${accentColor}10` : `${accentColor}20`,
                    color: accentColor
                  }}
                  title="清理歌单列表缓存"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
              
              {/* 错误日志 */}
              <div className={`p-4 rounded-xl mb-6 ${bgCard} border ${borderColor} relative`}>
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <div 
                      className="w-10 h-10 rounded-lg flex items-center justify-center"
                      style={{ backgroundColor: `${accentColor}20` }}
                    >
                      <AlertCircle className="w-5 h-5" style={{ color: accentColor }} />
                    </div>
                    <div>
                      <div className={`${textPrimary} text-sm font-medium`}>错误日志</div>
                      <div className={`${textTertiary} text-xs`}>
                        {cacheStats.errorLogCount} 条记录
                      </div>
                    </div>
                  </div>
                  <div className={`${textPrimary} text-sm font-bold`}>
                    {cacheManager.formatSize(cacheStats.errorLogSize)}
                  </div>
                </div>
                <div className={`${textSecondary} text-xs mb-2`}>
                  错误日志用于调试和问题排查
                </div>
                {/* 垃圾桶按钮 - 右下角 */}
                <button
                  onClick={handleClearErrorLogs}
                  disabled={cacheStats.errorLogCount === 0 || !!busyTarget}
                  className={`absolute bottom-3 right-3 p-2 rounded-lg transition-all ${
                    cacheStats.errorLogCount === 0 
                      ? 'opacity-30 cursor-not-allowed' 
                      : 'hover:brightness-110 hover:scale-105'
                  }`}
                  style={{ 
                    backgroundColor: cacheStats.errorLogCount === 0 ? `${accentColor}10` : `${accentColor}20`,
                    color: accentColor
                  }}
                  title="清理错误日志"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
              
              {/* 音频缓存 */}
              {window.electron?.audioDownload && (
                <div className={`p-4 rounded-xl mb-6 ${bgCard} border ${borderColor} relative`}>
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <div 
                        className="w-10 h-10 rounded-lg flex items-center justify-center"
                        style={{ backgroundColor: `${accentColor}20` }}
                      >
                        <ListMusic className="w-5 h-5" style={{ color: accentColor }} />
                      </div>
                      <div>
                        <div className={`${textPrimary} text-sm font-medium`}>音频缓存</div>
                        <div className={`${textTertiary} text-xs`}>
                          {cacheStats.audioCount} 个文件
                        </div>
                      </div>
                    </div>
                    <div className={`${textPrimary} text-sm font-bold`}>
                      {cacheManager.formatSize(cacheStats.audioSize)}
                    </div>
                  </div>
                  <div className={`${textSecondary} text-xs mb-2`}>
                    缓存音频文件用于无缝衔接播放（最大 2GB）
                  </div>
                  <div className={`${textTertiary} text-xs break-all mb-2`}>
                    {audioCacheDir}
                  </div>
                  {/* 垃圾桶按钮 - 右下角 */}
                  <button
                    onClick={handleClearAudioCache}
                    disabled={cacheStats.audioCount === 0 || !!busyTarget}
                    className={`absolute bottom-3 right-3 p-2 rounded-lg transition-all ${
                      cacheStats.audioCount === 0 
                        ? 'opacity-30 cursor-not-allowed' 
                        : 'hover:brightness-110 hover:scale-105'
                    }`}
                    style={{ 
                      backgroundColor: cacheStats.audioCount === 0 ? `${accentColor}10` : `${accentColor}20`,
                      color: accentColor
                    }}
                    title="清理音频缓存"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              )}

              <div className={`p-4 rounded-xl mb-6 ${bgCard} border ${borderColor} relative`}>
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-3"><div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accentColor}20` }}><ListMusic className="w-5 h-5" style={{ color: accentColor }} /></div><div><div className={`${textPrimary} text-sm font-medium`}>歌词缓存</div><div className={`${textTertiary} text-xs`}>{cacheStats.lyricsCount} 首歌曲</div></div></div>
                  <div className={`${textPrimary} text-sm font-bold`}>{cacheManager.formatSize(cacheStats.lyricsSize)}</div>
                </div>
                <div className={`${textSecondary} text-xs mb-2`}>最多保留 1000 首或 128MB，30 天未使用会自动清理</div>
                <button onClick={() => void handleClearLyrics()} disabled={cacheStats.lyricsCount === 0 || !!busyTarget} className="absolute bottom-3 right-3 p-2 rounded-lg transition-all disabled:opacity-30" style={{ backgroundColor: `${accentColor}20`, color: accentColor }} title="清理歌词缓存"><Trash2 className="w-4 h-4" /></button>
              </div>

              {window.electron?.render && (
                <div className={`p-4 rounded-xl mb-6 ${bgCard} border ${borderColor} relative`}>
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-3"><div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accentColor}20` }}><HardDrive className="w-5 h-5" style={{ color: accentColor }} /></div><div><div className={`${textPrimary} text-sm font-medium`}>过渡与歌曲分轨缓存</div><div className={`${textTertiary} text-xs`}>{cacheStats.transitionCount} 个文件</div></div></div>
                    <div className={`${textPrimary} text-sm font-bold`}>{cacheManager.formatSize(cacheStats.transitionSize)}</div>
                  </div>
                  <div className={`${textSecondary} text-xs mb-2`}>限制为 512MB，超过 24 小时未使用会自动清理</div>
                  <button onClick={() => void handleClearTransitionCache()} disabled={cacheStats.transitionCount === 0 || !!busyTarget} className="absolute bottom-3 right-3 p-2 rounded-lg transition-all disabled:opacity-30" style={{ backgroundColor: `${accentColor}20`, color: accentColor }} title="清理过渡与歌曲分轨缓存"><Trash2 className="w-4 h-4" /></button>
                </div>
              )}

              {window.electron?.analysis && (
                <div className={`p-4 rounded-xl mb-6 ${bgCard} border ${borderColor} relative`}>
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accentColor}20` }}><HardDrive className="w-5 h-5" style={{ color: accentColor }} /></div>
                      <div><div className={`${textPrimary} text-sm font-medium`}>音频分析缓存</div><div className={`${textTertiary} text-xs`}>{cacheStats.analysisCount} 个分析文件</div></div>
                    </div>
                    <div className={`${textPrimary} text-sm font-bold`}>{cacheManager.formatSize(cacheStats.analysisSize)}</div>
                  </div>
                  <div className={`${textSecondary} text-xs mb-2`}>节拍与段落分析缓存（自动按时间和容量清理）</div>
                  <button onClick={() => void handleClearAnalysisCache()} disabled={cacheStats.analysisCount === 0 || !!busyTarget} className="absolute bottom-3 right-3 p-2 rounded-lg transition-all disabled:opacity-30" style={{ backgroundColor: `${accentColor}20`, color: accentColor }} title="清理分析缓存"><Trash2 className="w-4 h-4" /></button>
                </div>
              )}
              
              <div className={`p-4 rounded-xl mb-6 ${bgCard} border ${borderColor} relative`}>
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-3"><div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accentColor}20` }}><ListMusic className="w-5 h-5" style={{ color: accentColor }} /></div><div><div className={`${textPrimary} text-sm font-medium`}>歌曲信息</div><div className={`${textTertiary} text-xs`}>{cacheStats.metadataCount} 条记录</div></div></div>
                  <div className={`${textPrimary} text-sm font-bold`}>{cacheManager.formatSize(cacheStats.metadataSize)}</div>
                </div>
                <div className={`${textSecondary} text-xs mb-2`}>歌曲元数据缓存，用于减少重复请求</div>
                <button onClick={() => void handleClearMetadata()} disabled={cacheStats.metadataCount === 0 || busyTarget !== null} className="absolute bottom-3 right-3 p-2 rounded-lg transition-all disabled:opacity-30" style={{ backgroundColor: `${accentColor}20`, color: accentColor }} title="清理歌曲信息缓存"><Trash2 className="w-4 h-4" /></button>
              </div>

              <div className={`p-4 rounded-xl mb-6 ${bgCard} border ${borderColor}`}>
                <div className="flex items-center gap-3 mb-4">
                  <Clock className="w-5 h-5" style={{ color: accentColor }} />
                  <h3 className={`text-lg font-bold ${textPrimary}`}>自动清理</h3>
                </div>
                
                {/* 启用自动清理 */}
                <div className="flex items-center justify-between mb-4">
                  <div>
                    <div className={`${textPrimary} text-sm font-medium mb-1`}>启用自动清理</div>
                    <div className={`${textSecondary} text-xs`}>
                      定期自动清理选定的缓存类型
                    </div>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={autoClearSettings.enabled}
                      onChange={(e) => handleAutoClearSettingsChange({
                        ...autoClearSettings,
                        enabled: e.target.checked
                      })}
                      className="sr-only peer"
                    />
                    <div 
                      className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all`}
                      style={{ backgroundColor: autoClearSettings.enabled ? accentColor : '' }}
                    ></div>
                  </label>
                </div>
                
                {autoClearSettings.enabled && (
                  <>
                    {/* 清理间隔 */}
                    <div className="mb-4">
                      <div className={`${textPrimary} text-sm font-medium mb-2`}>清理间隔</div>
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          min="1"
                          max="365"
                          value={autoClearSettings.days}
                          onChange={(e) => handleAutoClearSettingsChange({
                            ...autoClearSettings,
                            days: Math.max(1, Math.min(365, parseInt(e.target.value) || 14))
                          })}
                          className={`flex-1 px-3 py-2 rounded-lg ${bgCard} ${textPrimary} border ${borderColor} focus:outline-none`}
                          style={{ 
                            backgroundColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'
                          }}
                        />
                        <span className={`${textSecondary} text-sm`}>天</span>
                      </div>
                      {daysUntilNextClear !== null && (
                        <div className={`${textTertiary} text-xs mt-2`}>
                          距离下次清理还有 {daysUntilNextClear} 天
                        </div>
                      )}
                    </div>
                    
                    {/* 关闭时清理 */}
                    <div className="flex items-center justify-between mb-4">
                      <div>
                        <div className={`${textPrimary} text-sm font-medium mb-1`}>关闭时清理</div>
                        <div className={`${textSecondary} text-xs`}>
                          关闭时清理；若退出过快，下次启动会自动补全
                        </div>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input
                          type="checkbox"
                          checked={autoClearSettings.clearOnClose}
                          onChange={(e) => handleAutoClearSettingsChange({
                            ...autoClearSettings,
                            clearOnClose: e.target.checked
                          })}
                          className="sr-only peer"
                        />
                        <div 
                          className={`w-11 h-6 ${playerTheme === 'dark' ? 'bg-white/20' : 'bg-black/20'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all`}
                          style={{ backgroundColor: autoClearSettings.clearOnClose ? accentColor : '' }}
                        ></div>
                      </label>
                    </div>
                    
                    {/* 清理目标 */}
                    <div>
                      <div className={`${textPrimary} text-sm font-medium mb-2`}>清理目标</div>
                      <div className="space-y-2">
                        <button
                          onClick={() => handleAutoClearSettingsChange({ ...autoClearSettings, targets: { ...autoClearSettings.targets, covers: !autoClearSettings.targets.covers } })}
                          className={`w-full flex items-center gap-3 p-3 rounded-lg transition-all text-left ${bgCard}`}
                        >
                          <div className="w-5 h-5 rounded border-2 flex items-center justify-center transition-all" style={{ borderColor: autoClearSettings.targets.covers ? accentColor : 'rgba(128,128,128,0.35)', backgroundColor: autoClearSettings.targets.covers ? accentColor : 'transparent' }}>{autoClearSettings.targets.covers && <Check className="w-3 h-3 text-white" />}</div>
                          <span className={`${textPrimary} text-sm`}>封面取色缓存</span>
                        </button>
                        <button
                          onClick={() => handleAutoClearSettingsChange({
                            ...autoClearSettings,
                            targets: {
                              ...autoClearSettings.targets,
                              playlists: !autoClearSettings.targets.playlists
                            }
                          })}
                          className={`w-full flex items-center gap-3 p-3 rounded-lg transition-all text-left ${bgCard}`}
                        >
                          <div 
                            className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-all`}
                            style={{
                              borderColor: autoClearSettings.targets.playlists ? accentColor : playerTheme === 'dark' ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.3)',
                              backgroundColor: autoClearSettings.targets.playlists ? accentColor : 'transparent'
                            }}
                          >
                            {autoClearSettings.targets.playlists && <Check className="w-3 h-3 text-white" />}
                          </div>
                          <span className={`${textPrimary} text-sm`}>歌单列表</span>
                        </button>
                        {([
                          ['lyrics', '歌词'],
                          ['audio', '音频下载'],
                          ['analysis', '音频分析'],
                          ['transitions', '过渡音频'],
                          ['metadata', '歌曲信息'],
                        ] as const).map(([target, label]) => (
                          <button
                            key={target}
                            onClick={() => handleAutoClearSettingsChange({ ...autoClearSettings, targets: { ...autoClearSettings.targets, [target]: !autoClearSettings.targets[target] } })}
                            className={`w-full flex items-center gap-3 p-3 rounded-lg transition-all text-left ${bgCard}`}
                          >
                            <div className="w-5 h-5 rounded border-2 flex items-center justify-center transition-all" style={{ borderColor: autoClearSettings.targets[target] ? accentColor : 'rgba(128,128,128,0.35)', backgroundColor: autoClearSettings.targets[target] ? accentColor : 'transparent' }}>{autoClearSettings.targets[target] && <Check className="w-3 h-3 text-white" />}</div>
                            <span className={`${textPrimary} text-sm`}>{label}</span>
                          </button>
                        ))}

                        <button
                          onClick={() => handleAutoClearSettingsChange({
                            ...autoClearSettings,
                            targets: {
                              ...autoClearSettings.targets,
                              errorLogs: !autoClearSettings.targets.errorLogs
                            }
                          })}
                          className={`w-full flex items-center gap-3 p-3 rounded-lg transition-all text-left ${bgCard}`}
                        >
                          <div 
                            className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-all`}
                            style={{
                              borderColor: autoClearSettings.targets.errorLogs ? accentColor : playerTheme === 'dark' ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.3)',
                              backgroundColor: autoClearSettings.targets.errorLogs ? accentColor : 'transparent'
                            }}
                          >
                            {autoClearSettings.targets.errorLogs && <Check className="w-3 h-3 text-white" />}
                          </div>
                          <span className={`${textPrimary} text-sm`}>错误日志</span>
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
              
              {/* 清理所有 */}
              <motion.button
                onClick={handleClearAll}
                disabled={cacheStats.totalSize === 0 || !!busyTarget}
                animate={clearAllConfirm ? {
                  scale: [1, 1.05, 1, 1.05, 1],
                } : {}}
                transition={{
                  duration: 0.5,
                  repeat: clearAllConfirm ? Infinity : 0,
                  repeatDelay: 0.5
                }}
                className={`w-full py-3 rounded-xl font-medium transition-all ${
                  cacheStats.totalSize === 0 
                    ? 'opacity-50 cursor-not-allowed bg-red-500/20' 
                    : clearAllConfirm
                      ? 'bg-red-600 shadow-lg shadow-red-500/50'
                      : 'bg-red-500/80 hover:bg-red-500 hover:scale-[1.02]'
                } text-white`}
              >
                <div className="flex items-center justify-center gap-2">
                  <Trash2 className="w-5 h-5" />
                  <span>
                    {clearAllConfirm ? '再次点击确认清理所有缓存' : '清理所有缓存'}
                  </span>
                </div>
              </motion.button>
              
              <div className={`${textTertiary} text-xs text-center mt-3`}>
                {failedTargets.length > 0 && <div className="mb-2 text-red-400">失败目标：{failedTargets.join('、')}，点击对应垃圾桶可重试</div>}
                {clearAllConfirm 
                  ? '确认后将清理所有缓存，此操作不可恢复'
                  : '清理缓存后，下次加载时可能会稍慢'
                }
              </div>
            </div>
          </motion.div>
          
          {/* 全局 Toast 消息 */}
          <GlobalToast 
            show={showToast}
            message={toastMessage}
            type="success"
            onClose={() => setShowToast(false)}
          />
        </>
      )}
    </AnimatePresence>
  )
}
