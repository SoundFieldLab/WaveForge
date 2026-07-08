import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Trash2, FolderOpen, Image, ListMusic, AlertCircle, HardDrive, Clock, Check } from 'lucide-react'
import { cacheManager } from '../services/cacheManager'
import GlobalToast from './GlobalToast'

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
  
  const [accentColor, setAccentColor] = useState(() => {
    const saved = localStorage.getItem('accentColor')
    return saved || '#3B82F6'
  })
  
  const [cacheStats, setCacheStats] = useState({
    coverCount: 0,
    coverSize: 0,
    playlistCount: 0,
    playlistSize: 0,
    errorLogCount: 0,
    errorLogSize: 0,
    totalSize: 0
  })
  
  const [cacheDir, setCacheDir] = useState('')
  
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
      setCacheDir(cacheManager.getCacheDirectory())
      setAutoClearSettings(cacheManager.getAutoClearSettings())
      setDaysUntilNextClear(cacheManager.getDaysUntilNextClear())
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
  
  const refreshStats = () => {
    const stats = cacheManager.getCacheStats()
    setCacheStats(stats)
  }
  
  const handleClearCovers = () => {
    cacheManager.clearCovers()
    refreshStats()
    showToastMessage('封面缓存清理成功')
  }
  
  const handleClearPlaylists = () => {
    cacheManager.clearPlaylists()
    refreshStats()
    showToastMessage('歌单列表缓存清理成功')
  }
  
  const handleClearErrorLogs = () => {
    cacheManager.clearErrorLogs()
    refreshStats()
    showToastMessage('错误日志清理成功')
  }
  
  const handleClearAll = () => {
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
      // 第二次点击，执行清理
      cacheManager.clearAll()
      refreshStats()
      showToastMessage('所有缓存清理成功')
      setClearAllConfirm(false)
      
      if (clearAllTimerRef.current) {
        clearTimeout(clearAllTimerRef.current)
      }
    }
  }
  
  const handleChangeCacheDir = () => {
    const newDir = prompt('请输入缓存目录路径：', cacheDir)
    if (newDir && newDir.trim()) {
      cacheManager.setCacheDirectory(newDir.trim())
      setCacheDir(newDir.trim())
      alert('缓存目录已更新！')
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
            className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[60]"
          />
          
          {/* 弹窗 */}
          <motion.div
            initial={{ x: '100%', opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: '100%', opacity: 0 }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            className="fixed right-0 top-0 h-full w-full max-w-lg z-[70] shadow-2xl overflow-hidden"
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
                  共 {cacheStats.coverCount + cacheStats.playlistCount} 项缓存
                </div>
              </div>
              
              {/* 缓存目录 */}
              <div className={`p-4 rounded-xl mb-6 ${bgCard} border ${borderColor}`}>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <FolderOpen className="w-4 h-4" style={{ color: accentColor }} />
                    <span className={`${textPrimary} text-sm font-medium`}>缓存目录</span>
                  </div>
                  <button
                    onClick={handleChangeCacheDir}
                    className={`px-3 py-1 text-xs rounded-full transition-colors ${textSecondary}`}
                    style={{ backgroundColor: `${accentColor}20` }}
                  >
                    更改
                  </button>
                </div>
                <div className={`${textSecondary} text-xs break-all`}>
                  {cacheDir}
                </div>
              </div>
              
              {/* 封面缓存 */}
              <div className={`p-4 rounded-xl mb-4 ${bgCard} border ${borderColor} relative`}>
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <div 
                      className="w-10 h-10 rounded-lg flex items-center justify-center"
                      style={{ backgroundColor: `${accentColor}20` }}
                    >
                      <Image className="w-5 h-5" style={{ color: accentColor }} />
                    </div>
                    <div>
                      <div className={`${textPrimary} text-sm font-medium`}>封面图片</div>
                      <div className={`${textTertiary} text-xs`}>
                        {cacheStats.coverCount} 张图片
                      </div>
                    </div>
                  </div>
                  <div className={`${textPrimary} text-sm font-bold`}>
                    {cacheManager.formatSize(cacheStats.coverSize)}
                  </div>
                </div>
                <div className={`${textSecondary} text-xs mb-2`}>
                  缓存封面图片可以加快加载速度，但会占用存储空间
                </div>
                {/* 垃圾桶按钮 - 右下角 */}
                <button
                  onClick={handleClearCovers}
                  disabled={cacheStats.coverCount === 0}
                  className={`absolute bottom-3 right-3 p-2 rounded-lg transition-all ${
                    cacheStats.coverCount === 0 
                      ? 'opacity-30 cursor-not-allowed' 
                      : 'hover:brightness-110 hover:scale-105'
                  }`}
                  style={{ 
                    backgroundColor: cacheStats.coverCount === 0 ? `${accentColor}10` : `${accentColor}20`,
                    color: accentColor
                  }}
                  title="清理封面缓存"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
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
                  disabled={cacheStats.playlistCount === 0}
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
                  disabled={cacheStats.errorLogCount === 0}
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
              
              {/* 自动清理设置 */}
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
                          每次关闭软件时自动清理
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
                          onClick={() => handleAutoClearSettingsChange({
                            ...autoClearSettings,
                            targets: {
                              ...autoClearSettings.targets,
                              covers: !autoClearSettings.targets.covers
                            }
                          })}
                          className={`w-full flex items-center gap-3 p-3 rounded-lg transition-all text-left ${bgCard}`}
                        >
                          <div 
                            className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-all`}
                            style={{
                              borderColor: autoClearSettings.targets.covers ? accentColor : playerTheme === 'dark' ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.3)',
                              backgroundColor: autoClearSettings.targets.covers ? accentColor : 'transparent'
                            }}
                          >
                            {autoClearSettings.targets.covers && <Check className="w-3 h-3 text-white" />}
                          </div>
                          <span className={`${textPrimary} text-sm`}>封面图片</span>
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
                disabled={cacheStats.totalSize === 0}
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
