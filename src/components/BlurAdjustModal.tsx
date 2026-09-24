import { useState, useEffect, useRef, useCallback } from 'react'
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
  
  // 拖动滑块时每步都做「同步 localStorage 写 + 全局事件」代价很高：
  // 事件监听方（HomeView / DesktopView）会 setState，而 cardBlurAmount 又驱动
  // backdrop-filter: blur() —— 首页最多上百张卡片会跟着重算样式。输入设备一帧可派发
  // 多个 change，这里用 rAF 合并成每帧最多一次提交（与 PlaylistDetailPanel 的滚动
  // 处理同款做法）；localStorage 只在松手/保存时落盘（其他组件仅在挂载时读取它）。
  const pendingBlurRef = useRef<number | null>(null)
  const blurFrameRef = useRef<number | null>(null)

  const commitBlur = useCallback((value: number) => {
    localStorage.setItem('cardBlurAmount', value.toString())
    window.dispatchEvent(new CustomEvent('cardBlurAmountChanged', { detail: value }))
  }, [])

  const handleBlurChange = useCallback((value: number) => {
    setBlurAmount(value)
    pendingBlurRef.current = value
    if (blurFrameRef.current !== null) return
    blurFrameRef.current = window.requestAnimationFrame(() => {
      blurFrameRef.current = null
      const pending = pendingBlurRef.current
      if (pending === null) return
      pendingBlurRef.current = null
      // 每帧最多一次同步落盘 + 事件派发（原来每个 change 事件都做一遍）；
      // 落盘与派发必须成对，否则「拖动后直接关闭」会丢掉 localStorage 值。
      commitBlur(pending)
    })
  }, [commitBlur])

  // 以指定值立即提交（丢弃尚未执行的帧）：用于保存/取消这类「必须立刻确定最终值」的路径。
  // 必须先取消帧并清空 pending，否则同一帧稍后还会再派发一次拖动的中间值覆盖它。
  const commitBlurNow = useCallback((value: number) => {
    if (blurFrameRef.current !== null) {
      window.cancelAnimationFrame(blurFrameRef.current)
      blurFrameRef.current = null
    }
    pendingBlurRef.current = null
    commitBlur(value)
  }, [commitBlur])

  // 卸载时提交最后一次待处理值（落盘 + 派发，保持与拖动路径一致）：否则 rAF 被取消，
  // localStorage 与监听方会停在上一个已派发的中间值上。
  useEffect(() => () => {
    if (blurFrameRef.current !== null) {
      window.cancelAnimationFrame(blurFrameRef.current)
      blurFrameRef.current = null
    }
    const pending = pendingBlurRef.current
    pendingBlurRef.current = null
    if (pending !== null) {
      localStorage.setItem('cardBlurAmount', pending.toString())
      window.dispatchEvent(new CustomEvent('cardBlurAmountChanged', { detail: pending }))
    }
  }, [])
  
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
    // 以当前滑块值立即落盘（同步派发事件，在 onClose 之前生效）
    commitBlurNow(blurAmount)
    onClose()
    // 保存后重新打开设置面板
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('reopenSettings'))
    }, 100)
  }
  
  const handleCancel = () => {
    // 恢复到初始值：必须同步提交，否则紧接着的 onClose 卸载会让 rAF 丢失
    commitBlurNow(initialBlurAmount)
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
