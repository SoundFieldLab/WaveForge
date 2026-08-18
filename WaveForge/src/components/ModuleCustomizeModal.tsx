import { useState, useEffect, type CSSProperties } from 'react'
import { motion, AnimatePresence, Reorder } from 'framer-motion'
import { X, GripVertical, Check, Plus } from 'lucide-react'
import type { MusicPlatform } from '../services/platforms'
import {
  getDefaultHomeModules,
  HOME_MODULES,
  MAX_HOME_MODULES,
  sanitizeHomeModules,
  type HomeModuleDefinition,
  type HomeModuleType,
} from '../services/homeModules'
import { useTvBack } from '../tv/tvCore'

interface ModuleCustomizeModalProps {
  show: boolean
  onClose: () => void
  playerTheme?: 'light' | 'dark'
}

export default function ModuleCustomizeModal({ show, onClose, playerTheme = 'dark' }: ModuleCustomizeModalProps) {
  // TV 遥控器 BACK：关闭首页模块自定义弹窗
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
  const tertiaryColor = playerTheme === 'dark' ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.4)'
  const bgCard = playerTheme === 'dark' ? 'bg-white/5' : 'bg-black/5'
  const borderColor = playerTheme === 'dark' ? 'border-white/10' : 'border-black/10'
  
  const [accentColor, setAccentColor] = useState(() => {
    const saved = localStorage.getItem('accentColor')
    return saved || '#3B82F6'
  })
  
  // 分平台的模块选择
  const [neteaseModules, setNeteaseModules] = useState<HomeModuleType[]>(() => {
    const saved = localStorage.getItem('homeModules_netease')
    const loggedIn = Boolean(localStorage.getItem('netease_cookie') || localStorage.getItem('neteaseCookie'))
    return saved ? sanitizeHomeModules(saved, 'netease') : getDefaultHomeModules('netease', loggedIn)
  })
  
  const [qqModules, setQQModules] = useState<HomeModuleType[]>(() => {
    const saved = localStorage.getItem('homeModules_qq')
    const loggedIn = Boolean(localStorage.getItem('qq_cookie') || localStorage.getItem('qqCookie'))
    return saved ? sanitizeHomeModules(saved, 'qq') : getDefaultHomeModules('qq', loggedIn)
  })

  const [appleModules, setAppleModules] = useState<HomeModuleType[]>(() => {
    const saved = localStorage.getItem('homeModules_apple')
    const loggedIn = Boolean(localStorage.getItem('appleAccountName'))
    return saved ? sanitizeHomeModules(saved, 'apple') : getDefaultHomeModules('apple', loggedIn)
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

  useEffect(() => {
    localStorage.setItem('homeModules_apple', JSON.stringify(appleModules))
    window.dispatchEvent(new Event('homeModulesChanged'))
  }, [appleModules])
  
  const [draggedModule, setDraggedModule] = useState<{ moduleId: HomeModuleType, platform: MusicPlatform, fromSelected: boolean } | null>(null)
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
  
  const getModules = (platform: MusicPlatform): HomeModuleType[] => (
    platform === 'netease' ? neteaseModules : platform === 'qq' ? qqModules : appleModules
  )
  const getSetModules = (platform: MusicPlatform) => (
    platform === 'netease' ? setNeteaseModules : platform === 'qq' ? setQQModules : setAppleModules
  )

  const handleDragStart = (moduleId: HomeModuleType, platform: MusicPlatform, fromSelected: boolean) => {
    setDraggedModule({ moduleId, platform, fromSelected })
  }
  
  const handleDragOverAvailable = (e: React.DragEvent, platform: MusicPlatform) => {
    e.preventDefault()
    if (!draggedModule || draggedModule.platform !== platform) return
    
    // 只有从已选区拖拽的模块才能拖回可选区
    if (draggedModule.fromSelected) {
      setIsDraggingOverAvailable(true)
    }
  }
  
  const handleDragOverSelected = (e: React.DragEvent, index: number | null, platform: MusicPlatform) => {
    e.preventDefault()
    if (!draggedModule || draggedModule.platform !== platform) return
    
    const modules = getModules(platform)
    const setModules = getSetModules(platform)
    
    // 从可选区拖拽到已选区：添加模块
    if (!draggedModule.fromSelected && modules.length < MAX_HOME_MODULES && !modules.includes(draggedModule.moduleId)) {
      const newModules = [...modules, draggedModule.moduleId]
      setModules(newModules)
      setDraggedModule({ ...draggedModule, fromSelected: true })
    }
  }
  
  const handleDropOnAvailable = (platform: MusicPlatform) => {
    if (!draggedModule || draggedModule.platform !== platform || !draggedModule.fromSelected) return
    
    const modules = getModules(platform)
    const setModules = getSetModules(platform)
    
    // 从已选区删除
    const newModules = modules.filter(id => id !== draggedModule.moduleId)
    setModules(newModules)
    
    setIsDraggingOverAvailable(false)
    setDraggedModule(null)
  }
  
  const handleDragEnd = () => {
    setIsDraggingOverAvailable(false)
  }
  
  const handleAddModule = (moduleId: HomeModuleType, platform: MusicPlatform) => {
    const modules = getModules(platform)
    const setModules = getSetModules(platform)
    
    if (modules.length >= MAX_HOME_MODULES) return
    if (modules.includes(moduleId)) return
    
    setModules([...modules, moduleId])
  }
  
  const handleRemoveModule = (moduleId: HomeModuleType, platform: MusicPlatform) => {
    const modules = getModules(platform)
    const setModules = getSetModules(platform)
    
    setModules(modules.filter(id => id !== moduleId))
  }
  
  // 可选模块（排除已选的）
  const neteaseAvailableModules = HOME_MODULES.filter(m => m.platform === 'netease')
  const qqAvailableModules = HOME_MODULES.filter(m => m.platform === 'qq')
  const appleAvailableModules = HOME_MODULES.filter(m => m.platform === 'apple')
  
  // 按照是否已选排序（已选的排在后面，灰色显示）
  const getSortedAvailableModules = (modules: HomeModuleDefinition[], selectedIds: HomeModuleType[]) => {
    return [...modules].sort((a, b) => {
      const aSelected = selectedIds.includes(a.id)
      const bSelected = selectedIds.includes(b.id)
      if (aSelected && !bSelected) return 1
      if (!aSelected && bSelected) return -1
      return 0
    })
  }
  
  const sortedNeteaseAvailable = getSortedAvailableModules(neteaseAvailableModules, neteaseModules)
  const sortedQQAvailable = getSortedAvailableModules(qqAvailableModules, qqModules)
  const sortedAppleAvailable = getSortedAvailableModules(appleAvailableModules, appleModules)
  
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
            className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[70]"
          />
          
          {/* 弹窗 */}
          <motion.div
            data-tv-scope
            initial={{ x: '100%', opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: '100%', opacity: 0 }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            className="fixed right-0 top-0 h-full w-full max-w-lg z-[80] shadow-2xl overflow-hidden flex flex-col"
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
              <h2 className={`text-2xl font-bold ${textPrimary}`}>自定义模块卡片</h2>
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
                分别为网易云音乐、QQ 音乐和 Apple Music 选择最多 {MAX_HOME_MODULES} 个模块，支持拖拽排序
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
                    {neteaseModules.length}/{MAX_HOME_MODULES} 已选
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
                        {neteaseModules.map((moduleId, index) => {
                          const module = HOME_MODULES.find(m => m.id === moduleId)
                          if (!module) return null
                          
                          return (
                            <Reorder.Item
                              key={moduleId}
                              value={moduleId}
                              initial={{ opacity: 0, height: 0 }}
                              animate={{ opacity: 1, height: 'auto' }}
                              exit={{ opacity: 0, height: 0 }}
                              transition={{ type: 'spring', damping: 25, stiffness: 300 }}
                              whileHover={{ scale: 1.02 }}
                              whileDrag={{ scale: 1.05, zIndex: 10 }}
                              dragListener={false}
                              className="mb-2 cursor-move"
                            >
                              <div
                                className={`flex items-center gap-3 p-4 rounded-xl border ${borderColor}`}
                                style={{
                                  background: playerTheme === 'dark'
                                    ? `linear-gradient(135deg, rgba(236, 65, 65, 0.1) 0%, rgba(236, 65, 65, 0.05) 100%)`
                                    : `linear-gradient(135deg, rgba(236, 65, 65, 0.15) 0%, rgba(236, 65, 65, 0.08) 100%)`,
                                }}
                                onDragStart={() => handleDragStart(moduleId, 'netease', true)}
                                onDragEnd={handleDragEnd}
                                draggable
                              >
                                <GripVertical className="w-5 h-5 cursor-grab active:cursor-grabbing" style={{ color: accentColor }} />
                                <div className="flex-1">
                                  <span className={`${textPrimary} text-sm font-medium`}>{module.name}</span>
                                  {module.type === 'playlist-grid' && (
                                    <span className={`${textSecondary} text-xs ml-2`}>(歌单)</span>
                                  )}
                                  <p className={`${textTertiary} mt-1 text-xs leading-4`}>{module.description}</p>
                                </div>
                                <button
                                  onClick={() => handleRemoveModule(moduleId, 'netease')}
                                  className="p-1 hover:bg-white/10 rounded transition-colors"
                                >
                                  <X className="w-4 h-4" style={{ color: accentColor }} />
                                </button>
                              </div>
                            </Reorder.Item>
                          )
                        })}
                      </AnimatePresence>
                    </Reorder.Group>
                  ) : (
                    <div className={`${bgCard} rounded-xl p-8 text-center border ${borderColor}`}>
                      <p className={`${textTertiary} text-sm`}>从下方拖拽或点击添加模块</p>
                    </div>
                  )}
                </div>
                
                {/* 可选模块 */}
                <div 
                  className={`transition-all ${isDraggingOverAvailable && draggedModule?.platform === 'netease' ? 'ring-2' : ''}`}
                  style={{ 
                    '--tw-ring-color': isDraggingOverAvailable && draggedModule?.platform === 'netease' ? accentColor : 'transparent' 
                  } as CSSProperties}
                  onDragOver={(e) => handleDragOverAvailable(e, 'netease')}
                  onDrop={() => handleDropOnAvailable('netease')}
                  onDragLeave={() => setIsDraggingOverAvailable(false)}
                >
                  <div className={`${textSecondary} text-xs mb-3 font-medium`}>
                    可选模块 {isDraggingOverAvailable && draggedModule?.platform === 'netease' && '（松开删除）'}
                  </div>
                  <div className="space-y-2">
                    <AnimatePresence mode="popLayout">
                      {sortedNeteaseAvailable.map(module => {
                        const isSelected = neteaseModules.includes(module.id)
                        const isDisabled = !isSelected && neteaseModules.length >= MAX_HOME_MODULES
                        
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
                                style={{ color: isSelected || isDisabled ? tertiaryColor : accentColor }} 
                              />
                            )}
                            <div className="flex-1">
                              <span className={`${isSelected || isDisabled ? textTertiary : textPrimary} text-sm font-medium`}>
                                {module.name}
                              </span>
                              {module.type === 'playlist-grid' && (
                                <span className={`${textTertiary} text-xs ml-2`}>(歌单)</span>
                              )}
                              <p className={`${isSelected || isDisabled ? textTertiary : textSecondary} mt-1 text-xs leading-4`}>
                                {module.description}
                                {module.loginRequired ? ' · 需登录' : ''}
                                {module.officialSkill ? ' · 官方增强' : ''}
                              </p>
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
              <div className="mb-8">
                <div className={`flex items-center gap-3 mb-4 p-4 rounded-xl ${bgCard} border ${borderColor}`}>
                  <div 
                    className="w-10 h-10 rounded-lg flex items-center justify-center"
                    style={{ backgroundColor: '#31C27C' }}
                  >
                    <span className="text-white font-bold text-sm">Q</span>
                  </div>
                  <h3 className={`text-lg font-bold ${textPrimary} flex-1`}>QQ音乐</h3>
                  <span className={`text-xs px-3 py-1 rounded-full ${bgCard}`} style={{ color: accentColor }}>
                    {qqModules.length}/{MAX_HOME_MODULES} 已选
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
                        {qqModules.map((moduleId, index) => {
                          const module = HOME_MODULES.find(m => m.id === moduleId)
                          if (!module) return null
                          
                          return (
                            <Reorder.Item
                              key={moduleId}
                              value={moduleId}
                              initial={{ opacity: 0, height: 0 }}
                              animate={{ opacity: 1, height: 'auto' }}
                              exit={{ opacity: 0, height: 0 }}
                              transition={{ type: 'spring', damping: 25, stiffness: 300 }}
                              whileHover={{ scale: 1.02 }}
                              whileDrag={{ scale: 1.05, zIndex: 10 }}
                              dragListener={false}
                              className="mb-2 cursor-move"
                            >
                              <div
                                className={`flex items-center gap-3 p-4 rounded-xl border ${borderColor}`}
                                style={{
                                  background: playerTheme === 'dark'
                                    ? `linear-gradient(135deg, rgba(49, 194, 124, 0.1) 0%, rgba(49, 194, 124, 0.05) 100%)`
                                    : `linear-gradient(135deg, rgba(49, 194, 124, 0.15) 0%, rgba(49, 194, 124, 0.08) 100%)`,
                                }}
                                onDragStart={() => handleDragStart(moduleId, 'qq', true)}
                                onDragEnd={handleDragEnd}
                                draggable
                              >
                                <GripVertical className="w-5 h-5 cursor-grab active:cursor-grabbing" style={{ color: accentColor }} />
                                <div className="flex-1">
                                  <span className={`${textPrimary} text-sm font-medium`}>{module.name}</span>
                                  {module.type === 'playlist-grid' && (
                                    <span className={`${textSecondary} text-xs ml-2`}>(歌单)</span>
                                  )}
                                  <p className={`${textTertiary} mt-1 text-xs leading-4`}>{module.description}</p>
                                </div>
                                <button
                                  onClick={() => handleRemoveModule(moduleId, 'qq')}
                                  className="p-1 hover:bg-white/10 rounded transition-colors"
                                >
                                  <X className="w-4 h-4" style={{ color: accentColor }} />
                                </button>
                              </div>
                            </Reorder.Item>
                          )
                        })}
                      </AnimatePresence>
                    </Reorder.Group>
                  ) : (
                    <div className={`${bgCard} rounded-xl p-8 text-center border ${borderColor}`}>
                      <p className={`${textTertiary} text-sm`}>从下方拖拽或点击添加模块</p>
                    </div>
                  )}
                </div>
                
                {/* 可选模块 */}
                <div 
                  className={`transition-all ${isDraggingOverAvailable && draggedModule?.platform === 'qq' ? 'ring-2' : ''}`}
                  style={{ 
                    '--tw-ring-color': isDraggingOverAvailable && draggedModule?.platform === 'qq' ? accentColor : 'transparent' 
                  } as CSSProperties}
                  onDragOver={(e) => handleDragOverAvailable(e, 'qq')}
                  onDrop={() => handleDropOnAvailable('qq')}
                  onDragLeave={() => setIsDraggingOverAvailable(false)}
                >
                  <div className={`${textSecondary} text-xs mb-3 font-medium`}>
                    可选模块 {isDraggingOverAvailable && draggedModule?.platform === 'qq' && '（松开删除）'}
                  </div>
                  <div className="space-y-2">
                    <AnimatePresence mode="popLayout">
                      {sortedQQAvailable.map(module => {
                        const isSelected = qqModules.includes(module.id)
                        const isDisabled = !isSelected && qqModules.length >= MAX_HOME_MODULES
                        
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
                                style={{ color: isSelected || isDisabled ? tertiaryColor : accentColor }} 
                              />
                            )}
                            <div className="flex-1">
                              <span className={`${isSelected || isDisabled ? textTertiary : textPrimary} text-sm font-medium`}>
                                {module.name}
                              </span>
                              {module.type === 'playlist-grid' && (
                                <span className={`${textTertiary} text-xs ml-2`}>(歌单)</span>
                              )}
                              <p className={`${isSelected || isDisabled ? textTertiary : textSecondary} mt-1 text-xs leading-4`}>
                                {module.description}
                                {module.loginRequired ? ' · 需登录' : ''}
                                {module.officialSkill ? ' · 官方增强' : ''}
                              </p>
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

              {/* Apple Music 部分 */}
              <div className="mb-8">
                <div className={`flex items-center gap-3 mb-4 p-4 rounded-xl ${bgCard} border ${borderColor}`}>
                  <div 
                    className="w-10 h-10 rounded-lg flex items-center justify-center"
                    style={{ backgroundColor: '#fa2d48' }}
                  >
                    <span className="text-white font-bold text-sm">苹</span>
                  </div>
                  <h3 className={`text-lg font-bold ${textPrimary} flex-1`}>Apple Music</h3>
                  <span className={`text-xs px-3 py-1 rounded-full ${bgCard}`} style={{ color: accentColor }}>
                    {appleModules.length}/{MAX_HOME_MODULES} 已选
                  </span>
                </div>
                
                {/* 已选择的模块 */}
                <div 
                  className="mb-4"
                  onDragOver={(e) => handleDragOverSelected(e, null, 'apple')}
                >
                  <div className={`${textSecondary} text-xs mb-3 font-medium`}>已选择（拖拽排序）</div>
                  {appleModules.length > 0 ? (
                    <Reorder.Group
                      axis="y"
                      values={appleModules}
                      onReorder={setAppleModules}
                      layoutScroll
                      style={{ listStyle: 'none' }}
                    >
                      <AnimatePresence initial={false}>
                        {appleModules.map(moduleId => {
                          const module = HOME_MODULES.find(m => m.id === moduleId)
                          if (!module) return null
                          
                          return (
                            <Reorder.Item
                              key={moduleId}
                              value={moduleId}
                              initial={{ opacity: 0, height: 0 }}
                              animate={{ opacity: 1, height: 'auto' }}
                              exit={{ opacity: 0, height: 0 }}
                              transition={{ type: 'spring', damping: 25, stiffness: 300 }}
                              whileHover={{ scale: 1.02 }}
                              whileDrag={{ scale: 1.05, zIndex: 10 }}
                              dragListener={false}
                              className="mb-2 cursor-move"
                            >
                              <div
                                className={`flex items-center gap-3 p-4 rounded-xl border ${borderColor}`}
                                style={{
                                  background: playerTheme === 'dark'
                                    ? `linear-gradient(135deg, rgba(250, 45, 72, 0.1) 0%, rgba(250, 45, 72, 0.05) 100%)`
                                    : `linear-gradient(135deg, rgba(250, 45, 72, 0.15) 0%, rgba(250, 45, 72, 0.08) 100%)`,
                                }}
                                onDragStart={() => handleDragStart(moduleId, 'apple', true)}
                                onDragEnd={handleDragEnd}
                                draggable
                              >
                                <GripVertical className="w-5 h-5 cursor-grab active:cursor-grabbing" style={{ color: accentColor }} />
                                <div className="flex-1">
                                  <span className={`${textPrimary} text-sm font-medium`}>{module.name}</span>
                                  {module.type === 'playlist-grid' && (
                                    <span className={`${textSecondary} text-xs ml-2`}>(歌单)</span>
                                  )}
                                  <p className={`${textTertiary} mt-1 text-xs leading-4`}>{module.description}</p>
                                </div>
                                <button
                                  onClick={() => handleRemoveModule(moduleId, 'apple')}
                                  className="p-1 hover:bg-white/10 rounded transition-colors"
                                >
                                  <X className="w-4 h-4" style={{ color: accentColor }} />
                                </button>
                              </div>
                            </Reorder.Item>
                          )
                        })}
                      </AnimatePresence>
                    </Reorder.Group>
                  ) : (
                    <div className={`${bgCard} rounded-xl p-8 text-center border ${borderColor}`}>
                      <p className={`${textTertiary} text-sm`}>从下方拖拽或点击添加模块</p>
                    </div>
                  )}
                </div>
                
                {/* 可选模块 */}
                <div 
                  className={`transition-all ${isDraggingOverAvailable && draggedModule?.platform === 'apple' ? 'ring-2' : ''}`}
                  style={{ 
                    '--tw-ring-color': isDraggingOverAvailable && draggedModule?.platform === 'apple' ? accentColor : 'transparent' 
                  } as CSSProperties}
                  onDragOver={(e) => handleDragOverAvailable(e, 'apple')}
                  onDrop={() => handleDropOnAvailable('apple')}
                  onDragLeave={() => setIsDraggingOverAvailable(false)}
                >
                  <div className={`${textSecondary} text-xs mb-3 font-medium`}>
                    可选模块 {isDraggingOverAvailable && draggedModule?.platform === 'apple' && '（松开删除）'}
                  </div>
                  <div className="space-y-2">
                    <AnimatePresence mode="popLayout">
                      {sortedAppleAvailable.map(module => {
                        const isSelected = appleModules.includes(module.id)
                        const isDisabled = !isSelected && appleModules.length >= MAX_HOME_MODULES
                        
                        return (
                          <motion.div
                            key={module.id}
                            layout
                            initial={{ opacity: 0, x: -20 }}
                            animate={{ opacity: 1, x: 0 }}
                            exit={{ opacity: 0, x: 20 }}
                            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
                            draggable={!isSelected && !isDisabled}
                            onDragStart={() => !isSelected && !isDisabled && handleDragStart(module.id, 'apple', false)}
                            onDragEnd={handleDragEnd}
                            onClick={() => !isSelected && !isDisabled && handleAddModule(module.id, 'apple')}
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
                                style={{ color: isSelected || isDisabled ? tertiaryColor : accentColor }} 
                              />
                            )}
                            <div className="flex-1">
                              <span className={`${isSelected || isDisabled ? textTertiary : textPrimary} text-sm font-medium`}>
                                {module.name}
                              </span>
                              {module.type === 'playlist-grid' && (
                                <span className={`${textTertiary} text-xs ml-2`}>(歌单)</span>
                              )}
                              <p className={`${isSelected || isDisabled ? textTertiary : textSecondary} mt-1 text-xs leading-4`}>
                                {module.description}
                                {module.loginRequired ? ' · 需登录' : ''}
                              </p>
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
