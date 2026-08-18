import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Image as ImageIcon, ChevronRight, Blend, Grid3x3 } from 'lucide-react'
import WallpaperCustomizeModal from './WallpaperCustomizeModal'
import ModuleCustomizeModal from './ModuleCustomizeModal'
import BlurAdjustModal from './BlurAdjustModal'
import { useTvBack } from '../tv/tvCore'

interface HomeCustomizeModalProps {
  show: boolean
  onClose: () => void
  playerTheme?: 'light' | 'dark'
  onBlurAdjustOpen?: () => void
  onReopenRequest?: () => void
}

export default function HomeCustomizeModal({ show, onClose, playerTheme = 'dark', onBlurAdjustOpen, onReopenRequest }: HomeCustomizeModalProps) {
  const textPrimary = playerTheme === 'dark' ? 'text-white' : 'text-black'
  const textSecondary = playerTheme === 'dark' ? 'text-white/60' : 'text-black/60'
  const textTertiary = playerTheme === 'dark' ? 'text-white/40' : 'text-black/40'
  const bgCard = playerTheme === 'dark' ? 'bg-white/5' : 'bg-black/5'
  const borderColor = playerTheme === 'dark' ? 'border-white/10' : 'border-black/10'
  
  // TV 遥控器 BACK 关闭弹窗
  useTvBack(() => {
    onClose()
    return true
  })
  const [accentColor, setAccentColor] = useState(() => {
    const saved = localStorage.getItem('accentColor')
    return saved || '#3B82F6'
  })
  
  const [showWallpaperModal, setShowWallpaperModal] = useState(false)
  const [showModuleModal, setShowModuleModal] = useState(false)
  const [showBlurModal, setShowBlurModal] = useState(false)
  const [shouldShowBlurModal, setShouldShowBlurModal] = useState(false)
  
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
  
  // 当主面板关闭后，如果需要显示模糊度面板，则延迟显示
  useEffect(() => {
    if (!show && shouldShowBlurModal) {
      setTimeout(() => {
        setShowBlurModal(true)
        setShouldShowBlurModal(false)
      }, 100)
    }
  }, [show, shouldShowBlurModal])
  
  return (
    <>
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
              data-tv-scope
              style={{
                background: playerTheme === 'dark' 
                  ? 'rgba(0, 0, 0, 0.3)'
                  : 'rgba(255, 255, 255, 0.3)',
                backdropFilter: 'blur(20px) saturate(180%)',
                WebkitBackdropFilter: 'blur(20px) saturate(180%)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                boxShadow: '0 8px 32px 0 rgba(0, 0, 0, 0.37)'
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
                自定义首页外观和显示内容
              </p>
              
              {/* 调整卡片模糊度按钮 */}
              <div className="mb-4">
                <button
                  onClick={() => {
                    setShouldShowBlurModal(true)
                    onClose() // 先关闭当前面板
                    if (onBlurAdjustOpen) {
                      onBlurAdjustOpen() // 触发回调，关闭设置面板
                    }
                  }}
                  className={`w-full ${bgCard} rounded-xl p-4 border ${borderColor} hover:bg-white/10 transition-all flex items-center justify-between group`}
                >
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accentColor}20` }}>
                      <Blend className="w-5 h-5" style={{ color: accentColor }} />
                    </div>
                    <div className="text-left">
                      <div className={`${textPrimary} font-medium`}>调整卡片模糊度</div>
                      <div className={`${textSecondary} text-sm`}>
                        设置首页卡片的背景模糊效果
                      </div>
                    </div>
                  </div>
                  <ChevronRight className={`w-5 h-5 ${textTertiary} group-hover:translate-x-1 transition-transform`} />
                </button>
              </div>
              
              {/* 壁纸自定义按钮 */}
              <div className="mb-4">
                <button
                  onClick={() => setShowWallpaperModal(true)}
                  className={`w-full ${bgCard} rounded-xl p-4 border ${borderColor} hover:bg-white/10 transition-all flex items-center justify-between group`}
                >
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accentColor}20` }}>
                      <ImageIcon className="w-5 h-5" style={{ color: accentColor }} />
                    </div>
                    <div className="text-left">
                      <div className={`${textPrimary} font-medium`}>自定义主页壁纸</div>
                      <div className={`${textSecondary} text-sm`}>
                        上传图片或视频作为首页背景
                      </div>
                    </div>
                  </div>
                  <ChevronRight className={`w-5 h-5 ${textTertiary} group-hover:translate-x-1 transition-transform`} />
                </button>
              </div>
              
              {/* 自定义模块卡片按钮 */}
              <div className="mb-6">
                <button
                  onClick={() => setShowModuleModal(true)}
                  className={`w-full ${bgCard} rounded-xl p-4 border ${borderColor} hover:bg-white/10 transition-all flex items-center justify-between group`}
                >
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accentColor}20` }}>
                      <Grid3x3 className="w-5 h-5" style={{ color: accentColor }} />
                    </div>
                    <div className="text-left">
                      <div className={`${textPrimary} font-medium`}>自定义模块卡片</div>
                      <div className={`${textSecondary} text-sm`}>
                        选择和排序网易云、QQ音乐模块
                      </div>
                    </div>
                  </div>
                  <ChevronRight className={`w-5 h-5 ${textTertiary} group-hover:translate-x-1 transition-transform`} />
                </button>
              </div>
            </div>
          </motion.div>
          
          {/* 壁纸自定义弹窗 */}
          <WallpaperCustomizeModal
            show={showWallpaperModal}
            onClose={() => setShowWallpaperModal(false)}
            playerTheme={playerTheme}
          />
          
          {/* 模块自定义弹窗 */}
          <ModuleCustomizeModal
            show={showModuleModal}
            onClose={() => setShowModuleModal(false)}
            playerTheme={playerTheme}
          />
        </>
      )}
    </AnimatePresence>
    
    {/* 模糊度调整弹窗 - 独立于主面板 */}
    <BlurAdjustModal
      show={showBlurModal}
      onClose={() => setShowBlurModal(false)}
      playerTheme={playerTheme}
      onBackToCustomize={() => {
        setShowBlurModal(false)
        // 延迟重新打开首页自定义面板
        setTimeout(() => {
          if (onReopenRequest) {
            onReopenRequest()
          }
        }, 100)
      }}
    />
  </>
  )
}
