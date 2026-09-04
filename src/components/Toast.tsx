import { motion, AnimatePresence } from 'framer-motion'
import { Check, X, Info, AlertCircle } from 'lucide-react'
import { useEffect } from 'react'

export type ToastType = 'success' | 'error' | 'info' | 'warning'

interface ToastProps {
  show: boolean
  message: string
  type?: ToastType
  duration?: number
  onClose?: () => void
  style?: React.CSSProperties
  accentColor?: string // 添加自定义主题色
}

// 确保样式只注入一次
if (typeof document !== 'undefined' && !document.getElementById('toast-animations')) {
  const style = document.createElement('style')
  style.id = 'toast-animations'
  style.textContent = `
    @keyframes liquidFlow {
      0%, 100% { 
        transform: translate(-50%, -50%) scale(1);
      }
      25% { 
        transform: translate(-45%, -48%) scale(1.1);
      }
      50% { 
        transform: translate(-55%, -52%) scale(0.9);
      }
      75% { 
        transform: translate(-50%, -49%) scale(1.05);
      }
    }

    @keyframes liquidPulse {
      0%, 100% { 
        opacity: 0.15;
        transform: translate(-50%, -50%) scale(1);
      }
      50% { 
        opacity: 0.25;
        transform: translate(-50%, -50%) scale(1.15);
      }
    }

    @keyframes shimmer {
      0% { transform: translateX(-100%) rotate(45deg); }
      100% { transform: translateX(200%) rotate(45deg); }
    }

    .liquid-blob {
      animation: liquidFlow 4s ease-in-out infinite;
    }

    .liquid-pulse {
      animation: liquidPulse 3s ease-in-out infinite;
    }

    .shimmer-effect {
      animation: shimmer 3s linear infinite;
    }
  `
  document.head.appendChild(style)
}

export default function Toast({ 
  show, 
  message, 
  type = 'success',
  duration = 4000,
  onClose,
  style,
  accentColor
}: ToastProps) {
  
  // 将十六进制颜色转换为RGB
  const hexToRgb = (hex: string): { r: number; g: number; b: number } | null => {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
    return result ? {
      r: parseInt(result[1], 16),
      g: parseInt(result[2], 16),
      b: parseInt(result[3], 16)
    } : null
  }
  
  // 获取颜色配置
  const getColorStyle = () => {
    // 如果有自定义主题色，使用主题色
    if (accentColor && type === 'info') {
      const rgb = hexToRgb(accentColor)
      if (rgb) {
        return {
          background: `linear-gradient(135deg, rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.45) 0%, rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.35) 50%, rgba(255, 255, 255, 0.15) 100%)`,
          blob: `radial-gradient(circle, rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.5) 0%, rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.3) 35%, transparent 65%)`,
          pulse: `radial-gradient(ellipse 70% 90% at 65% 45%, rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.45) 0%, transparent 55%)`
        }
      }
    }
    
    // 默认颜色
    if (type === 'success') {
      return {
        background: 'linear-gradient(135deg, rgba(34, 197, 94, 0.45) 0%, rgba(22, 163, 74, 0.35) 50%, rgba(255, 255, 255, 0.15) 100%)',
        blob: 'radial-gradient(circle, rgba(34, 197, 94, 0.5) 0%, rgba(74, 222, 128, 0.3) 35%, transparent 65%)',
        pulse: 'radial-gradient(ellipse 70% 90% at 65% 45%, rgba(74, 222, 128, 0.45) 0%, transparent 55%)'
      }
    } else if (type === 'error') {
      return {
        background: 'linear-gradient(135deg, rgba(239, 68, 68, 0.45) 0%, rgba(220, 38, 38, 0.35) 50%, rgba(255, 255, 255, 0.15) 100%)',
        blob: 'radial-gradient(circle, rgba(239, 68, 68, 0.5) 0%, rgba(248, 113, 113, 0.3) 35%, transparent 65%)',
        pulse: 'radial-gradient(ellipse 70% 90% at 65% 45%, rgba(248, 113, 113, 0.45) 0%, transparent 55%)'
      }
    } else if (type === 'warning') {
      return {
        background: 'linear-gradient(135deg, rgba(234, 179, 8, 0.45) 0%, rgba(202, 138, 4, 0.35) 50%, rgba(255, 255, 255, 0.15) 100%)',
        blob: 'radial-gradient(circle, rgba(234, 179, 8, 0.5) 0%, rgba(250, 204, 21, 0.3) 35%, transparent 65%)',
        pulse: 'radial-gradient(ellipse 70% 90% at 65% 45%, rgba(250, 204, 21, 0.45) 0%, transparent 55%)'
      }
    } else {
      // info 默认使用红色
      return {
        background: 'linear-gradient(135deg, rgba(239, 68, 68, 0.45) 0%, rgba(220, 38, 38, 0.35) 50%, rgba(255, 255, 255, 0.15) 100%)',
        blob: 'radial-gradient(circle, rgba(239, 68, 68, 0.5) 0%, rgba(248, 113, 113, 0.3) 35%, transparent 65%)',
        pulse: 'radial-gradient(ellipse 70% 90% at 65% 45%, rgba(248, 113, 113, 0.45) 0%, transparent 55%)'
      }
    }
  }
  
  const colorStyle = getColorStyle()
  
  const getIcon = () => {
    switch (type) {
      case 'success':
        return <Check className="w-5 h-5 text-white" />
      case 'error':
        return <X className="w-5 h-5 text-white" />
      case 'warning':
        return <AlertCircle className="w-5 h-5 text-white" />
      case 'info':
        return <Check className="w-5 h-5 text-white" />  // info类型也显示✓
    }
  }

  return (
    <AnimatePresence mode="wait">
      {show && (
        <motion.div
          key="toast"
          initial={{ opacity: 0, y: -20, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -20, scale: 0.95 }}
          transition={{ 
            type: "spring",
            stiffness: 500,
            damping: 30
          }}
          style={{
            ...style,
            pointerEvents: 'auto'
          }}
        >
          {/* 液态玻璃药丸 */}
          <div className="
            relative overflow-hidden
            backdrop-blur-3xl backdrop-saturate-200
            border border-white/25
            rounded-full
            shadow-2xl
            px-6 py-3.5
            flex items-center gap-3
          "
          style={{
            background: colorStyle.background
          }}
          >
            {/* 液态颜色层1 - 主光晕，模糊融入玻璃 */}
            <div 
              className="absolute liquid-blob pointer-events-none"
              style={{
                width: '180%',
                height: '180%',
                left: '50%',
                top: '50%',
                filter: 'blur(35px)',
                opacity: 0.6,
                background: colorStyle.blob
              }}
            />

            {/* 液态颜色层2 - 副光晕，偏移位置 */}
            <div 
              className="absolute liquid-pulse pointer-events-none"
              style={{
                width: '120%',
                height: '140%',
                left: '50%',
                top: '50%',
                filter: 'blur(28px)',
                opacity: 0.4,
                background: colorStyle.pulse
              }}
            />

            {/* 玻璃高光层 - 多层叠加 */}
            <div className="absolute inset-0 bg-gradient-to-br from-white/40 via-white/5 to-transparent pointer-events-none" />
            <div className="absolute inset-0 bg-gradient-to-tl from-white/30 via-transparent to-white/10 pointer-events-none" />
            
            {/* 顶部边缘高光 */}
            <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/70 to-transparent" />
            
            {/* 流光效果 */}
            <div className="absolute inset-0 overflow-hidden pointer-events-none">
              <div 
                className="absolute w-24 h-full shimmer-effect"
                style={{
                  background: 'linear-gradient(90deg, transparent 0%, rgba(255, 255, 255, 0.5) 50%, transparent 100%)',
                  left: '-25%',
                  opacity: 0.4,
                }}
              />
            </div>
            
            {/* 内容 */}
            <div className="relative flex items-center gap-3 z-10">
              <div className="flex-shrink-0 drop-shadow-lg">
                {getIcon()}
              </div>
              <span className="font-semibold text-sm text-white whitespace-nowrap drop-shadow-lg tracking-wide">
                {message}
              </span>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
