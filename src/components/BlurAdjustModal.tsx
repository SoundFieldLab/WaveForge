import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Check, X } from 'lucide-react'
import { useTvBack } from '../tv/tvCore'

interface BlurAdjustModalProps {
  show: boolean
  onClose: () => void
  playerTheme?: 'light' | 'dark'
  onBackToCustomize?: () => void
  onBackToSettings?: () => void
}

export default function BlurAdjustModal({ show, onClose, playerTheme = 'dark', onBackToCustomize, onBackToSettings }: BlurAdjustModalProps) {
  // TV 遥控器 BACK：关闭毛玻璃调节弹窗
  useTvBack(() => {
    if (show) {
      onClose()
      return true
    }
    return false
  }, [show, onClose])
  const [blurAmount, setBlurAmount] = useState(() => {
    const saved = localStorage.getItem('cardBlurAmount')
    return saved ? parseInt(saved) : 10
  })
  
  const [initialBlurAmount] = useState(() => {
    const saved = localStorage.getItem('cardBlurAmount')
    return saved ? parseInt(saved) : 10
  })
  
  const [accentColor, setAccentColor] = useState(() => {
    const saved = localStorage.getItem('accentColor')
    return saved || '#3B82F6'
  })
  
  // 鼠标位置和tooltip显示状态
  const [showTooltip, setShowTooltip] = useState(false)
  const [tooltipX, setTooltipX] = useState(0)
  const [isDragging, setIsDragging] = useState(false)
  
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
  
  const handleBlurChange = (value: number) => {
    console.log('[BlurAdjustModal] 模糊度改变:', value)
    setBlurAmount(value)
    // 实时更新
    localStorage.setItem('cardBlurAmount', value.toString())
    const event = new CustomEvent('cardBlurAmountChanged', { detail: value })
    console.log('[BlurAdjustModal] 触发事件:', event)
    window.dispatchEvent(event)
  }
  
  const handleSliderMouseMove = (e: React.MouseEvent<HTMLInputElement>) => {
    if (isDragging) {
      const rect = e.currentTarget.getBoundingClientRect()
      setTooltipX(e.clientX - rect.left)
      setShowTooltip(true)
    }
  }
  
  const handleSliderMouseDown = () => {
    setIsDragging(true)
    setShowTooltip(true)
  }
  
  const handleSliderMouseUp = () => {
    setIsDragging(false)
    setShowTooltip(false)
  }
  
  const handleSliderMouseLeave = () => {
    setShowTooltip(false)
  }
  
  const handleSave = () => {
    localStorage.setItem('cardBlurAmount', blurAmount.toString())
    window.dispatchEvent(new CustomEvent('cardBlurAmountChanged', { detail: blurAmount }))
    onClose()
    // 保存后重新打开设置面板
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('reopenSettings'))
    }, 100)
  }
  
  const handleCancel = () => {
    // 恢复到初始值
    handleBlurChange(initialBlurAmount)
    onClose()
    // 取消后也重新打开设置面板
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('reopenSettings'))
    }, 100)
  }
  
  return (
    <AnimatePresence>
      {show && (
        <>
          {/* 无遮罩背景 - 让用户直接看到首页预览效果 */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[70] pointer-events-none"
          />
          
          {/* 底部控制条 */}
          <motion.div
            data-tv-scope
            initial={{ y: '100%', opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: '100%', opacity: 0 }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            className="fixed bottom-8 left-1/2 transform -translate-x-1/2 z-[80] pointer-events-auto"
          >
            <div 
              className="rounded-2xl shadow-2xl p-6 border"
              style={{
                background: playerTheme === 'dark' 
                  ? 'rgba(0, 0, 0, 0.3)'
                  : 'rgba(255, 255, 255, 0.3)',
                backdropFilter: 'blur(20px) saturate(180%)',
                WebkitBackdropFilter: 'blur(20px) saturate(180%)',
                borderColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)',
                minWidth: '500px',
              }}
            >
              <div className="flex items-start gap-6">
                {/* 滑块区域 */}
                <div className="flex-1">
                  <div 
                    className="text-sm font-medium mb-3 text-center"
                    style={{ color: playerTheme === 'dark' ? 'white' : 'black' }}
                  >
                    卡片模糊度
                  </div>
                  
                  <div className="relative">
                    {/* Tooltip显示当前值 */}
                    {showTooltip && (
                      <div
                        className="absolute -top-10 px-2 py-1 rounded-md text-xs font-medium text-white pointer-events-none"
                        style={{
                          left: `${tooltipX}px`,
                          transform: 'translateX(-50%)',
                          backgroundColor: accentColor,
                          boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
                        }}
                      >
                        {blurAmount}px
                      </div>
                    )}
                    
                    <input
                      type="range"
                      min="0"
                      max="30"
                      step="1"
                      value={blurAmount}
                      onChange={(e) => handleBlurChange(parseInt(e.target.value))}
                      onMouseMove={handleSliderMouseMove}
                      onMouseDown={handleSliderMouseDown}
                      onMouseUp={handleSliderMouseUp}
                      onMouseLeave={handleSliderMouseLeave}
                      onMouseEnter={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect()
                        const percent = blurAmount / 30
                        setTooltipX(rect.width * percent)
                      }}
                      className="w-full h-2 rounded-full appearance-none cursor-pointer"
                      style={{
                        background: `linear-gradient(to right, ${accentColor} 0%, ${accentColor} ${(blurAmount / 30) * 100}%, ${playerTheme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)'} ${(blurAmount / 30) * 100}%, ${playerTheme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)'} 100%)`,
                      }}
                    />
                    <style>
                      {`
                        input[type="range"]::-webkit-slider-thumb {
                          appearance: none;
                          width: 20px;
                          height: 20px;
                          border-radius: 50%;
                          background: rgba(255, 255, 255, 0.9);
                          cursor: pointer;
                          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2), inset 0 1px 2px rgba(255, 255, 255, 0.5);
                          backdrop-filter: blur(10px);
                          border: 2px solid rgba(255, 255, 255, 0.3);
                          transition: transform 0.2s ease, box-shadow 0.2s ease;
                        }
                        input[type="range"]::-webkit-slider-thumb:hover {
                          transform: scale(1.15);
                          box-shadow: 0 6px 16px rgba(0, 0, 0, 0.3), inset 0 2px 4px rgba(255, 255, 255, 0.6);
                        }
                        input[type="range"]::-webkit-slider-thumb:active {
                          transform: scale(1.05);
                          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25), inset 0 1px 2px rgba(255, 255, 255, 0.5);
                        }
                        input[type="range"]::-moz-range-thumb {
                          width: 20px;
                          height: 20px;
                          border-radius: 50%;
                          background: rgba(255, 255, 255, 0.9);
                          cursor: pointer;
                          border: 2px solid rgba(255, 255, 255, 0.3);
                          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2), inset 0 1px 2px rgba(255, 255, 255, 0.5);
                          transition: transform 0.2s ease, box-shadow 0.2s ease;
                        }
                        input[type="range"]::-moz-range-thumb:hover {
                          transform: scale(1.15);
                          box-shadow: 0 6px 16px rgba(0, 0, 0, 0.3), inset 0 2px 4px rgba(255, 255, 255, 0.6);
                        }
                        input[type="range"]::-moz-range-thumb:active {
                          transform: scale(1.05);
                          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25), inset 0 1px 2px rgba(255, 255, 255, 0.5);
                        }
                      `}
                    </style>
                  </div>
                  
                  {/* 预设值 - 在滑块下方 */}
                  <div className="flex items-center gap-2 mt-4">
                    <div 
                      className="text-xs"
                      style={{ 
                        color: playerTheme === 'dark' ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.4)',
                        lineHeight: '32px'
                      }}
                    >
                      预设：
                    </div>
                    {[0, 5].map(preset => (
                      <button
                        key={preset}
                        onClick={() => handleBlurChange(preset)}
                        className={`px-3 py-1.5 rounded-lg text-xs transition-all ${
                          blurAmount === preset ? 'font-medium' : ''
                        }`}
                        style={{
                          backgroundColor: blurAmount === preset 
                            ? `${accentColor}30` 
                            : playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)',
                          color: blurAmount === preset 
                            ? accentColor 
                            : playerTheme === 'dark' ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.6)',
                          border: blurAmount === preset ? `1px solid ${accentColor}` : '1px solid transparent',
                        }}
                      >
                        {preset}px
                      </button>
                    ))}
                    {/* 10px默认 - 放在15px左侧 */}
                    <button
                      onClick={() => handleBlurChange(10)}
                      className={`px-3 py-1.5 rounded-lg text-xs transition-all ${
                        blurAmount === 10 ? 'font-medium' : ''
                      }`}
                      style={{
                        backgroundColor: blurAmount === 10 
                          ? `${accentColor}30` 
                          : playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)',
                        color: blurAmount === 10 
                          ? accentColor 
                          : playerTheme === 'dark' ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.6)',
                        border: blurAmount === 10 ? `1px solid ${accentColor}` : '1px solid transparent',
                      }}
                    >
                      默认
                    </button>
                    {[15, 20].map(preset => (
                      <button
                        key={preset}
                        onClick={() => handleBlurChange(preset)}
                        className={`px-3 py-1.5 rounded-lg text-xs transition-all ${
                          blurAmount === preset ? 'font-medium' : ''
                        }`}
                        style={{
                          backgroundColor: blurAmount === preset 
                            ? `${accentColor}30` 
                            : playerTheme === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)',
                          color: blurAmount === preset 
                            ? accentColor 
                            : playerTheme === 'dark' ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.6)',
                          border: blurAmount === preset ? `1px solid ${accentColor}` : '1px solid transparent',
                        }}
                      >
                        {preset}px
                      </button>
                    ))}
                  </div>
                </div>
                
                {/* 右侧按钮组 - 保存和取消垂直排列 */}
                <div className="flex flex-col gap-2 pt-6">
                  <button
                    onClick={handleSave}
                    className="px-6 py-2.5 rounded-xl font-medium transition-all flex items-center justify-center gap-2 hover:brightness-110 active:scale-95"
                    style={{
                      backgroundColor: accentColor,
                      color: 'white',
                      minWidth: '100px',
                    }}
                  >
                    <Check className="w-4 h-4" />
                    保存
                  </button>
                  
                  <button
                    onClick={handleCancel}
                    className="px-6 py-2.5 rounded-xl font-medium transition-all flex items-center justify-center gap-2 hover:brightness-110 active:scale-95"
                    style={{
                      backgroundColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)',
                      color: playerTheme === 'dark' ? 'white' : 'black',
                      minWidth: '100px',
                    }}
                  >
                    <X className="w-4 h-4" />
                    取消
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
