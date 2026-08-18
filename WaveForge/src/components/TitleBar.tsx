import { memo, useState, useEffect, useRef } from 'react'
import { Minus, Square, X, Minimize2, Maximize2 } from 'lucide-react'
import { useTvMode } from '../tv/tvCore'

// 无 props 的常驻组件：memo 后父级（App 1Hz 重渲染）不再连带重渲染它，
// 其状态仅由窗口 IPC/鼠标事件驱动
export default memo(function TitleBar() {
  const tvMode = useTvMode()
  const [isMaximized, setIsMaximized] = useState(false)
  const [isHovered, setIsHovered] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [isKiosk, setIsKiosk] = useState(false)
  const hideTimeoutRef = useRef<number | null>(null)

  // TV 遥控器模式没有窗口化概念，整个标题栏无意义，直接隐藏。
  if (tvMode) return null

  useEffect(() => {
    const unsubscribers: Array<() => void> = []
    if (window.electron?.system?.isMaximized) {
      window.electron.system.isMaximized().then(setIsMaximized)
    }

    if (window.electron?.system?.onMaximizedChange) {
      unsubscribers.push(window.electron.system.onMaximizedChange((maximized: boolean) => {
        setIsMaximized(maximized)
      }))
    }

    // 检查全屏状态
    const checkFullscreen = async () => {
      if (window.electron?.system?.isFullscreen) {
        const status = await window.electron.system.isFullscreen()
        setIsFullscreen(status.fullscreen || status.kiosk || status.maximized)
        setIsKiosk(status.kiosk)
      }
    }
    checkFullscreen()

    // 监听全屏状态变化
    if (window.electron?.system?.onFullscreenChange) {
      unsubscribers.push(window.electron.system.onFullscreenChange((fullscreen: boolean) => {
        setIsFullscreen(fullscreen)
        // 当全屏状态变化时，重新检查是否是 kiosk 模式
        checkFullscreen()
      }))
    }

    return () => unsubscribers.forEach(unsubscribe => unsubscribe())
  }, [])

  const handleMinimize = () => {
    window.electron?.system?.minimize()
  }

  const handleMaximize = async () => {
    // 如果是全屏状态（kiosk 或 fullscreen），退出全屏并还原窗口
    if (isFullscreen) {
      if (window.electron?.system?.setFullscreen) {
        await window.electron.system.setFullscreen(false, false)
        setIsFullscreen(false)
        setIsKiosk(false)
      }
      return
    }
    
    // 普通最大化/取消最大化切换
    if (window.electron?.system?.maximize) {
      await window.electron.system.maximize()
      // 更新状态
      if (window.electron?.system?.isMaximized) {
        const maximized = await window.electron.system.isMaximized()
        setIsMaximized(maximized)
      }
    }
  }

  const handleClose = () => {
    window.electron?.system?.close()
  }

  const handleMouseEnter = () => {
    if (hideTimeoutRef.current) {
      clearTimeout(hideTimeoutRef.current)
      hideTimeoutRef.current = null
    }
    setIsHovered(true)
  }

  const handleMouseLeave = () => {
    hideTimeoutRef.current = window.setTimeout(() => {
      setIsHovered(false)
    }, 2000)
  }

  useEffect(() => {
    return () => {
      if (hideTimeoutRef.current) {
        clearTimeout(hideTimeoutRef.current)
      }
    }
  }, [])

  return (
    <>
      {/* 左侧标题栏区域 - 用于拖拽窗口 */}
      <div 
        className="fixed top-0 left-0 h-8 z-[9999]"
        style={{ 
          WebkitAppRegion: 'drag',
          borderRadius: '12px 0 0 0',
          background: 'transparent',
          width: 'calc(50% - 100px)' // 左侧占一半减去中间下箭头区域
        } as any}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      />

      {/* 右侧标题栏区域 - 用于拖拽窗口和显示控制按钮 */}
      <div 
        className="fixed top-0 right-0 h-8 z-[9999] flex items-center justify-end"
        style={{ 
          WebkitAppRegion: 'drag',
          borderRadius: '0 12px 0 0',
          background: 'transparent',
          width: 'calc(50% - 100px)' // 右侧占一半减去中间下箭头区域
        } as any}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        {/* 窗口控制按钮 */}
        <div 
          className="flex items-center"
          style={{ 
            WebkitAppRegion: 'no-drag',
            opacity: isHovered ? 1 : 0,
            transition: 'opacity 0.3s ease-in-out',
            height: '32px'
          } as any}
        >
          <button
            onClick={handleMinimize}
            className="w-12 flex items-center justify-center text-white/60 hover:bg-white/10 hover:text-white transition-all rounded-bl"
            style={{ height: '32px' }}
          >
            <Minus className="w-4 h-4" />
          </button>
          
          <button
            onClick={handleMaximize}
            className="w-12 flex items-center justify-center text-white/60 hover:bg-white/10 hover:text-white transition-all"
            style={{ height: '32px' }}
            title={isFullscreen ? (isKiosk ? '退出全屏' : '退出全屏无边框') : (isMaximized ? '还原' : '最大化')}
          >
            {isFullscreen ? (
              // 全屏状态显示还原图标
              <Maximize2 className="w-3.5 h-3.5" />
            ) : isMaximized ? (
              // 最大化状态显示缩小图标
              <Minimize2 className="w-3.5 h-3.5" />
            ) : (
              // 正常状态显示最大化图标
              <Square className="w-3.5 h-3.5" />
            )}
          </button>
          
          <button
            onClick={handleClose}
            className="flex items-center justify-center text-white/60 hover:text-white transition-all relative overflow-hidden group"
            style={{ 
              width: '49px',
              height: '33px',
              borderTopRightRadius: '12px',
              marginTop: '-1px',
              marginRight: '-1px'
            }}
          >
            <div 
              className="absolute inset-0 bg-transparent group-hover:bg-red-500 transition-colors"
              style={{
                borderTopRightRadius: '12px'
              }}
            />
            <X className="w-4 h-4 relative z-10" style={{ pointerEvents: 'none' }} />
          </button>
        </div>
      </div>
    </>
  )
})
