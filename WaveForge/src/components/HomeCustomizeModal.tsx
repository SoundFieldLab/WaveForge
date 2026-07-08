import { useState, useEffect } from 'react'
import { motion, AnimatePresence, Reorder } from 'framer-motion'
import { X, GripVertical, Check, Plus } from 'lucide-react'

interface HomeCustomizeModalProps {
  show: boolean
  onClose: () => void
  playerTheme?: 'light' | 'dark'
}

type HomeModuleType = 
  | 'netease_new_songs'
  | 'netease_hot_songs'
  | 'netease_rising_songs'
  | 'netease_daily_recommend'
  | 'netease_radar'
  | 'netease_playlists'
  | 'qq_guess_you_like'
  | 'qq_daily_30'
  | 'qq_playlists'

interface HomeModule {
  id: HomeModuleType
  name: string
  platform: 'netease' | 'qq'
  type: 'song-list' | 'playlist-grid'
}

const availableModules: HomeModule[] = [
  { id: 'netease_new_songs', name: '新歌榜', platform: 'netease', type: 'song-list' },
  { id: 'netease_hot_songs', name: '热歌榜', platform: 'netease', type: 'song-list' },
  { id: 'netease_rising_songs', name: '飙升榜', platform: 'netease', type: 'song-list' },
  { id: 'netease_daily_recommend', name: '每日推荐', platform: 'netease', type: 'song-list' },
  { id: 'netease_radar', name: '私人雷达', platform: 'netease', type: 'song-list' },
  { id: 'netease_playlists', name: '推荐歌单', platform: 'netease', type: 'playlist-grid' },
  { id: 'qq_guess_you_like', name: '猜你喜欢', platform: 'qq', type: 'song-list' },
  { id: 'qq_daily_30', name: '每日三十首', platform: 'qq', type: 'song-list' },
  { id: 'qq_playlists', name: '歌单推荐', platform: 'qq', type: 'playlist-grid' },
]

export default function HomeCustomizeModal({ show, onClose, playerTheme = 'dark' }: HomeCustomizeModalProps) {
  const textPrimary = playerTheme === 'dark' ? 'text-white' : 'text-black'
  const textSecondary = playerTheme === 'dark' ? 'text-white/60' : 'text-black/60'
  const textTertiary = playerTheme === 'dark' ? 'text-white/40' : 'text-black/40'
  const bgCard = playerTheme === 'dark' ? 'bg-white/5' : 'bg-black/5'
  const borderColor = playerTheme === 'dark' ? 'border-white/10' : 'border-black/10'
  
  const [accentColor, setAccentColor] = useState(() => {
    const saved = localStorage.getItem('accentColor')
    return saved || '#3B82F6'
  })
  
  // 分平台的模块选择
  const [neteaseModules, setNeteaseModules] = useState<HomeModuleType[]>(() => {
    const saved = localStorage.getItem('homeModules_netease')
    return saved ? JSON.parse(saved) : ['netease_new_songs', 'netease_hot_songs', 'netease_rising_songs']
  })
  
  const [qqModules, setQQModules] = useState<HomeModuleType[]>(() => {
    const saved = localStorage.getItem('homeModules_qq')
    return saved ? JSON.parse(saved) : []
  })
  
  // 监听模块变化，自动保存
  useEffect(() => {
    localStorage.setItem('homeModules_netease', JSON.stringify(neteaseModules))
    window.dispatchEvent(new Event('homeModulesChanged'))
  }, [neteaseModules])
  
  useEffect(() => {
    localStorage.setItem('homeModules_qq', JSON.stringify(qqModules))
    window.dispatchEvent(new Event('homeModulesChanged'))
  }, [qqModules])
  
  const [draggedModule, setDraggedModule] = useState<{ moduleId: HomeModuleType, platform: 'netease' | 'qq', fromSelected: boolean } | null>(null)
  const [isDraggingOverAvailable, setIsDraggingOverAvailable] = useState(false)
  
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
  
  const handleDragStart = (moduleId: HomeModuleType, platform: 'netease' | 'qq', fromSelected: boolean) => {
    setDraggedModule({ moduleId, platform, fromSelected })
  }
  
  const handleDragOverAvailable = (e: React.DragEvent, platform: 'netease' | 'qq') => {
    e.preventDefault()
    if (!draggedModule || draggedModule.platform !== platform) return
    
    // 只有从已选区拖拽的模块才能拖回可选区
    if (draggedModule.fromSelected) {
      setIsDraggingOverAvailable(true)
    }
  }
  
  const handleDragLeaveAvailable = () => {
    setIsDraggingOverAvailable(false)
  }
  
  const handleDropOnAvailable = (e: React.DragEvent, platform: 'netease' | 'qq') => {
    e.preventDefault()
    setIsDraggingOverAvailable(false)
    
    if (!draggedModule || draggedModule.platform !== platform) return
    
    // 如果是从已选区拖回可选区，执行移除操作
    if (draggedModule.fromSelected) {
      handleRemoveModule(draggedModule.moduleId, platform)
    }
  }
  
  const handleDragOverSelected = (e: React.DragEvent, targetModuleId: HomeModuleType | null, platform: 'netease' | 'qq') => {
    e.preventDefault()
    if (!draggedModule || draggedModule.platform !== platform) return
    
    const modules = platform === 'netease' ? neteaseModules : qqModules
    const setModules = platform === 'netease' ? setNeteaseModules : setQQModules
    
    // 如果是从可选区拖入已选区
    if (!draggedModule.fromSelected) {
      // 检查是否已达到上限
      if (modules.length >= 3 && !modules.includes(draggedModule.moduleId)) {
        return
      }
      
      // 如果还没有添加，添加到末尾
      if (!modules.includes(draggedModule.moduleId)) {
        const newModules = [...modules, draggedModule.moduleId]
        setModules(newModules)
      }
      return
    }
    
    // 如果是在已选区内排序
    if (targetModuleId && draggedModule.moduleId !== targetModuleId) {
      const draggedIndex = modules.indexOf(draggedModule.moduleId)
      const targetIndex = modules.indexOf(targetModuleId)
      
      if (draggedIndex === -1 || targetIndex === -1) return
      
      const newModules = [...modules]
      newModules.splice(draggedIndex, 1)
      newModules.splice(targetIndex, 0, draggedModule.moduleId)
      
      setModules(newModules)
    }
  }
  
  const handleDragEnd = () => {
    if (draggedModule) {
      const platform = draggedModule.platform
      const modules = platform === 'netease' ? neteaseModules : qqModules
      localStorage.setItem(`homeModules_${platform}`, JSON.stringify(modules))
      window.dispatchEvent(new Event('homeModulesChanged'))
      setDraggedModule(null)
    }
  }
  
  const handleRemoveModule = (moduleId: HomeModuleType, platform: 'netease' | 'qq') => {
    const modules = platform === 'netease' ? neteaseModules : qqModules
    const setModules = platform === 'netease' ? setNeteaseModules : setQQModules
    
    const newModules = modules.filter(id => id !== moduleId)
    setModules(newModules)
  }
  
  const handleAddModule = (moduleId: HomeModuleType, platform: 'netease' | 'qq') => {
    const modules = platform === 'netease' ? neteaseModules : qqModules
    const setModules = platform === 'netease' ? setNeteaseModules : setQQModules
    
    // 检查是否已达到上限
    if (modules.length >= 3) return
    
    // 检查是否已添加
    if (modules.includes(moduleId)) return
    
    const newModules = [...modules, moduleId]
    setModules(newModules)
  }
  
  const neteaseAvailableModules = availableModules.filter(m => m.platform === 'netease')
  const qqAvailableModules = availableModules.filter(m => m.platform === 'qq')
  
  // 对可选模块排序：未添加的在前，已添加的在后
  const getSortedAvailableModules = (modules: HomeModule[], selectedModules: HomeModuleType[]) => {
    return [...modules].sort((a, b) => {
      const aSelected = selectedModules.includes(a.id)
      const bSelected = selectedModules.includes(b.id)
      if (aSelected === bSelected) return 0
      return aSelected ? 1 : -1 // 未选中的排在前面
    })
  }
  
  const sortedNeteaseAvailable = getSortedAvailableModules(neteaseAvailableModules, neteaseModules)
  const sortedQQAvailable = getSortedAvailableModules(qqAvailableModules, qqModules)
  
  return (
    <AnimatePresence>
      {show && (
        <>
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
            className="fixed right-0 top-0 h-full w-full max-w-lg z-[70] shadow-2xl overflow-hidden flex flex-col"
            style={{
              background: playerTheme === 'dark' 
                ? 'linear-gradient(135deg, rgba(30, 30, 40, 0.98) 0%, rgba(20, 20, 30, 0.98) 100%)'
                : 'linear-gradient(135deg, rgba(250, 250, 250, 0.98) 0%, rgba(240, 240, 240, 0.98) 100%)',
              backdropFilter: 'blur(20px)',
              WebkitBackdropFilter: 'blur(20px)',
            }}
          >
            {/* 头部 */}
            <div className={`flex-shrink-0 p-6 border-b ${borderColor} flex items-center justify-between`}>
              <h2 className={`text-2xl font-bold ${textPrimary}`}>首页自定义</h2>
              <button
                onClick={onClose}
                className={`p-2 rounded-full transition-colors ${bgCard} hover:bg-white/10`}
              >
                <X className={`w-5 h-5 ${textPrimary}`} />
              </button>
            </div>
            
            {/* 内容区 */}
            <div className="flex-1 overflow-y-auto p-6" style={{ scrollbarWidth: 'thin' }}>
              <p className={`${textSecondary} text-sm mb-6`}>
                分别为网易云音乐和QQ音乐选择最多3个模块，支持拖拽排序
              </p>
              
              {/* 网易云音乐部分 */}
              <div className="mb-8">
                <div className={`flex items-center gap-3 mb-4 p-4 rounded-xl ${bgCard} border ${borderColor}`}>
                  <div 
                    className="w-10 h-10 rounded-lg flex items-center justify-center"
                    style={{ backgroundColor: '#EC4141' }}
                  >
                    <span className="text-white font-bold text-sm">网</span>
                  </div>
                  <h3 className={`text-lg font-bold ${textPrimary} flex-1`}>网易云音乐</h3>
                  <span className={`text-xs px-3 py-1 rounded-full ${bgCard}`} style={{ color: accentColor }}>
                    {neteaseModules.length}/3 已选
                  </span>
                </div>
                
                {/* 已选择的模块 */}
                <div 
                  className="mb-4"
                  onDragOver={(e) => handleDragOverSelected(e, null, 'netease')}
                >
                  <div className={`${textSecondary} text-xs mb-3 font-medium`}>已选择（拖拽排序）</div>
                  {neteaseModules.length > 0 ? (
                    <Reorder.Group
                      axis="y"
                      values={neteaseModules}
                      onReorder={setNeteaseModules}
                      layoutScroll
                      style={{ listStyle: 'none' }}
                    >
                      <AnimatePresence initial={false}>
                        {neteaseModules.map((moduleId) => {
                          const module = availableModules.find(m => m.id === moduleId)
                          if (!module) return null
                          return (
                            <Reorder.Item
                              key={moduleId}
                              value={moduleId}
                              style={{
                                listStyle: 'none',
                                backgroundColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.03)',
                                borderRadius: '0.75rem',
                                border: `1px solid ${playerTheme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)'}`,
                                padding: '1rem',
                                marginBottom: '0.5rem'
                              }}
                              className="flex items-center gap-3 cursor-grab active:cursor-grabbing"
                              drag="y"
                            >
                              <GripVertical className="w-5 h-5 flex-shrink-0" style={{ color: accentColor }} />
                              <div className="flex-1 min-w-0">
                                <span className={`${textPrimary} text-sm font-medium block truncate`}>{module.name}</span>
                                {module.type === 'playlist-grid' && (
                                  <span className={`${textTertiary} text-xs`}>(歌单)</span>
                                )}
                              </div>
                              <motion.button
                                onClick={() => handleRemoveModule(moduleId, 'netease')}
                                whileHover={{ scale: 1.05 }}
                                whileTap={{ scale: 0.95 }}
                                className={`px-3 py-1.5 text-xs rounded-lg ${textSecondary} hover:brightness-110 transition-all flex-shrink-0`}
                                style={{ backgroundColor: `${accentColor}20`, color: accentColor }}
                              >
                                移除
                              </motion.button>
                            </Reorder.Item>
                          )
                        })}
                      </AnimatePresence>
                    </Reorder.Group>
                  ) : (
                    <motion.div 
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className={`p-8 rounded-xl border-2 border-dashed ${borderColor} text-center`}
                      style={{
                        backgroundColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.02)',
                      }}
                    >
                      <p className={`${textTertiary} text-sm`}>点击下方模块添加，或拖拽到这里</p>
                    </motion.div>
                  )}
                </div>
                
                {/* 可选模块 */}
                <div
                  onDragOver={(e) => handleDragOverAvailable(e, 'netease')}
                  onDragLeave={handleDragLeaveAvailable}
                  onDrop={(e) => handleDropOnAvailable(e, 'netease')}
                  className={`transition-all ${isDraggingOverAvailable && draggedModule?.platform === 'netease' ? 'ring-2 ring-offset-2' : ''}`}
                  style={{
                    ringColor: isDraggingOverAvailable ? accentColor : 'transparent'
                  }}
                >
                  <div className={`${textSecondary} text-xs mb-3 font-medium flex items-center justify-between`}>
                    <span>可选模块（点击或拖拽添加）</span>
                    {isDraggingOverAvailable && draggedModule?.platform === 'netease' && (
                      <motion.span
                        initial={{ opacity: 0, x: -10 }}
                        animate={{ opacity: 1, x: 0 }}
                        className="text-xs"
                        style={{ color: accentColor }}
                      >
                        松开移除
                      </motion.span>
                    )}
                  </div>
                  <div className="space-y-2">
                    <AnimatePresence mode="popLayout">
                      {sortedNeteaseAvailable.map(module => {
                        const isSelected = neteaseModules.includes(module.id)
                        const isDisabled = !isSelected && neteaseModules.length >= 3
                        
                        return (
                          <motion.div
                            key={module.id}
                            layout
                            initial={{ opacity: 0, x: -20 }}
                            animate={{ opacity: 1, x: 0 }}
                            exit={{ opacity: 0, x: 20 }}
                            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
                            draggable={!isSelected && !isDisabled}
                            onDragStart={() => !isSelected && !isDisabled && handleDragStart(module.id, 'netease', false)}
                            onDragEnd={handleDragEnd}
                            onClick={() => !isSelected && !isDisabled && handleAddModule(module.id, 'netease')}
                            className={`flex items-center gap-3 p-4 rounded-xl transition-all border ${borderColor} ${
                              isSelected 
                                ? 'opacity-40' 
                                : isDisabled 
                                  ? 'opacity-30 cursor-not-allowed'
                                  : 'cursor-pointer hover:brightness-110 active:scale-95'
                            } ${draggedModule?.moduleId === module.id && !draggedModule.fromSelected ? 'opacity-50' : ''}`}
                            style={{
                              backgroundColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.03)',
                            }}
                          >
                            {!isSelected && !isDisabled ? (
                              <motion.div
                                whileHover={{ rotate: 90 }}
                                transition={{ type: 'spring', stiffness: 300 }}
                              >
                                <Plus className="w-5 h-5" style={{ color: accentColor }} />
                              </motion.div>
                            ) : (
                              <GripVertical 
                                className="w-5 h-5" 
                                style={{ color: isSelected || isDisabled ? textTertiary : accentColor }} 
                              />
                            )}
                            <div className="flex-1">
                              <span className={`${isSelected || isDisabled ? textTertiary : textPrimary} text-sm font-medium`}>
                                {module.name}
                              </span>
                              {module.type === 'playlist-grid' && (
                                <span className={`${textTertiary} text-xs ml-2`}>(歌单)</span>
                              )}
                            </div>
                            {isSelected && (
                              <motion.span 
                                initial={{ scale: 0 }}
                                animate={{ scale: 1 }}
                                className={`text-xs flex items-center gap-1`}
                                style={{ color: accentColor }}
                              >
                                <Check className="w-3 h-3" />
                                已添加
                              </motion.span>
                            )}
                            {isDisabled && (
                              <span className={`text-xs ${textTertiary}`}>已满</span>
                            )}
                          </motion.div>
                        )
                      })}
                    </AnimatePresence>
                  </div>
                </div>
              </div>
              
              {/* QQ音乐部分 */}
              <div>
                <div className={`flex items-center gap-3 mb-4 p-4 rounded-xl ${bgCard} border ${borderColor}`}>
                  <div 
                    className="w-10 h-10 rounded-lg flex items-center justify-center"
                    style={{ backgroundColor: '#31C27C' }}
                  >
                    <span className="text-white font-bold text-sm">Q</span>
                  </div>
                  <h3 className={`text-lg font-bold ${textPrimary} flex-1`}>QQ音乐</h3>
                  <span className={`text-xs px-3 py-1 rounded-full ${bgCard}`} style={{ color: accentColor }}>
                    {qqModules.length}/3 已选
                  </span>
                </div>
                
                {/* 已选择的模块 */}
                <div 
                  className="mb-4"
                  onDragOver={(e) => handleDragOverSelected(e, null, 'qq')}
                >
                  <div className={`${textSecondary} text-xs mb-3 font-medium`}>已选择（拖拽排序）</div>
                  {qqModules.length > 0 ? (
                    <Reorder.Group
                      axis="y"
                      values={qqModules}
                      onReorder={setQQModules}
                      layoutScroll
                      style={{ listStyle: 'none' }}
                    >
                      <AnimatePresence initial={false}>
                        {qqModules.map((moduleId) => {
                          const module = availableModules.find(m => m.id === moduleId)
                          if (!module) return null
                          return (
                            <Reorder.Item
                              key={moduleId}
                              value={moduleId}
                              style={{
                                listStyle: 'none',
                                backgroundColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.03)',
                                borderRadius: '0.75rem',
                                border: `1px solid ${playerTheme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)'}`,
                                padding: '1rem',
                                marginBottom: '0.5rem'
                              }}
                              className="flex items-center gap-3 cursor-grab active:cursor-grabbing"
                              drag="y"
                            >
                              <GripVertical className="w-5 h-5 flex-shrink-0" style={{ color: accentColor }} />
                              <div className="flex-1 min-w-0">
                                <span className={`${textPrimary} text-sm font-medium block truncate`}>{module.name}</span>
                                {module.type === 'playlist-grid' && (
                                  <span className={`${textTertiary} text-xs`}>(歌单)</span>
                                )}
                              </div>
                              <motion.button
                                onClick={() => handleRemoveModule(moduleId, 'qq')}
                                whileHover={{ scale: 1.05 }}
                                whileTap={{ scale: 0.95 }}
                                className={`px-3 py-1.5 text-xs rounded-lg ${textSecondary} hover:brightness-110 transition-all flex-shrink-0`}
                                style={{ backgroundColor: `${accentColor}20`, color: accentColor }}
                              >
                                移除
                              </motion.button>
                            </Reorder.Item>
                          )
                        })}
                      </AnimatePresence>
                    </Reorder.Group>
                  ) : (
                    <motion.div 
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      className={`p-8 rounded-xl border-2 border-dashed ${borderColor} text-center`}
                      style={{
                        backgroundColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.02)',
                      }}
                    >
                      <p className={`${textTertiary} text-sm`}>点击下方模块添加，或拖拽到这里</p>
                    </motion.div>
                  )}
                </div>
                
                {/* 可选模块 */}
                <div
                  onDragOver={(e) => handleDragOverAvailable(e, 'qq')}
                  onDragLeave={handleDragLeaveAvailable}
                  onDrop={(e) => handleDropOnAvailable(e, 'qq')}
                  className={`transition-all ${isDraggingOverAvailable && draggedModule?.platform === 'qq' ? 'ring-2 ring-offset-2' : ''}`}
                  style={{
                    ringColor: isDraggingOverAvailable ? accentColor : 'transparent'
                  }}
                >
                  <div className={`${textSecondary} text-xs mb-3 font-medium flex items-center justify-between`}>
                    <span>可选模块（点击或拖拽添加）</span>
                    {isDraggingOverAvailable && draggedModule?.platform === 'qq' && (
                      <motion.span
                        initial={{ opacity: 0, x: -10 }}
                        animate={{ opacity: 1, x: 0 }}
                        className="text-xs"
                        style={{ color: accentColor }}
                      >
                        松开移除
                      </motion.span>
                    )}
                  </div>
                  <div className="space-y-2">
                    <AnimatePresence mode="popLayout">
                      {sortedQQAvailable.map(module => {
                        const isSelected = qqModules.includes(module.id)
                        const isDisabled = !isSelected && qqModules.length >= 3
                        
                        return (
                          <motion.div
                            key={module.id}
                            layout
                            initial={{ opacity: 0, x: -20 }}
                            animate={{ opacity: 1, x: 0 }}
                            exit={{ opacity: 0, x: 20 }}
                            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
                            draggable={!isSelected && !isDisabled}
                            onDragStart={() => !isSelected && !isDisabled && handleDragStart(module.id, 'qq', false)}
                            onDragEnd={handleDragEnd}
                            onClick={() => !isSelected && !isDisabled && handleAddModule(module.id, 'qq')}
                            className={`flex items-center gap-3 p-4 rounded-xl transition-all border ${borderColor} ${
                              isSelected 
                                ? 'opacity-40' 
                                : isDisabled 
                                  ? 'opacity-30 cursor-not-allowed'
                                  : 'cursor-pointer hover:brightness-110 active:scale-95'
                            } ${draggedModule?.moduleId === module.id && !draggedModule.fromSelected ? 'opacity-50' : ''}`}
                            style={{
                              backgroundColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.03)',
                            }}
                          >
                            {!isSelected && !isDisabled ? (
                              <motion.div
                                whileHover={{ rotate: 90 }}
                                transition={{ type: 'spring', stiffness: 300 }}
                              >
                                <Plus className="w-5 h-5" style={{ color: accentColor }} />
                              </motion.div>
                            ) : (
                              <GripVertical 
                                className="w-5 h-5" 
                                style={{ color: isSelected || isDisabled ? textTertiary : accentColor }} 
                              />
                            )}
                            <div className="flex-1">
                              <span className={`${isSelected || isDisabled ? textTertiary : textPrimary} text-sm font-medium`}>
                                {module.name}
                              </span>
                              {module.type === 'playlist-grid' && (
                                <span className={`${textTertiary} text-xs ml-2`}>(歌单)</span>
                              )}
                            </div>
                            {isSelected && (
                              <motion.span 
                                initial={{ scale: 0 }}
                                animate={{ scale: 1 }}
                                className={`text-xs flex items-center gap-1`}
                                style={{ color: accentColor }}
                              >
                                <Check className="w-3 h-3" />
                                已添加
                              </motion.span>
                            )}
                            {isDisabled && (
                              <span className={`text-xs ${textTertiary}`}>已满</span>
                            )}
                          </motion.div>
                        )
                      })}
                    </AnimatePresence>
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
