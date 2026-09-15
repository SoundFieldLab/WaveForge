import { useEffect, useRef, useState } from 'react'
import { ExternalLink, Loader2, RotateCw, X } from 'lucide-react'

// src/features/neteaseExplore/NeteaseWebPanel.tsx
// 站内网页面板：网易云的 H5 / 专辑商城 / 编辑部专题等页面在应用内打开，
// 不再跳系统浏览器。Electron 下用 <webview>（不受 X-Frame-Options 限制），
// 纯浏览器调试环境退回 iframe，并保留「在浏览器打开」兜底。

export interface NeteaseWebTarget {
  url: string
  title: string
}

interface NeteaseWebPanelProps {
  target: NeteaseWebTarget
  onClose: () => void
}

// Electron 的 <webview> 不在 React 内置类型里，用宽松元素类型承载其专有事件
const ElectronWebview = 'webview' as unknown as React.ComponentType<Record<string, unknown>>

interface ElectronBridge {
  openExternal?: (url: string) => Promise<void> | void
}

function externalOpen(url: string) {
  const bridge = (window as unknown as { electron?: ElectronBridge }).electron
  if (bridge?.openExternal) void bridge.openExternal(url)
  else window.open(url, '_blank', 'noopener,noreferrer')
}

export default function NeteaseWebPanel({ target, onClose }: NeteaseWebPanelProps) {
  const [loading, setLoading] = useState(true)
  const [frameFailed, setFrameFailed] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const webviewRef = useRef<any>(null)
  // Electron 下用 <webview>（不受 X-Frame-Options 限制）；浏览器调试环境退回 iframe
  const supportsWebview = useRef(typeof window !== 'undefined' && (/Electron/i.test(navigator.userAgent) || 'WebviewTag' in window))

  useEffect(() => {
    setLoading(true)
    setFrameFailed(false)
  }, [target.url, reloadKey])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const handleReload = () => {
    const view = webviewRef.current
    if (view?.reload) view.reload()
    else setReloadKey(key => key + 1)
  }

  return (
    <div className="fixed inset-0 z-[200] flex flex-col bg-[#0b0e14]/97 backdrop-blur-xl" role="dialog" aria-label={target.title || '站内网页'}>
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-white/[0.08] px-4">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-white/80">{target.title || target.url}</span>
        <button type="button" onClick={handleReload} aria-label="刷新页面" className="flex h-8 w-8 items-center justify-center rounded-full text-white/55 transition hover:bg-white/[0.08] hover:text-white/90">
          <RotateCw className="h-4 w-4" />
        </button>
        <button type="button" onClick={() => externalOpen(target.url)} aria-label="在浏览器打开" className="flex h-8 items-center gap-1.5 rounded-full px-3 text-xs text-white/55 transition hover:bg-white/[0.08] hover:text-white/90">
          <ExternalLink className="h-3.5 w-3.5" />在浏览器打开
        </button>
        <button type="button" onClick={onClose} aria-label="关闭网页" className="flex h-8 w-8 items-center justify-center rounded-full text-white/55 transition hover:bg-white/[0.08] hover:text-white/90">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="relative min-h-0 flex-1 bg-white">
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#0b0e14]">
            <Loader2 className="h-6 w-6 animate-spin text-white/50" />
          </div>
        )}
        {supportsWebview.current ? (
          <ElectronWebview
            key={`${target.url}-${reloadKey}`}
            ref={webviewRef}
            src={target.url}
            className="h-full w-full"
            onDidStopLoading={() => setLoading(false)}
            onDidFailLoad={() => { setLoading(false); setFrameFailed(true) }}
          />
        ) : (
          <iframe
            key={`${target.url}-${reloadKey}`}
            src={target.url}
            title={target.title}
            className="h-full w-full border-0"
            onLoad={() => setLoading(false)}
            onError={() => { setLoading(false); setFrameFailed(true) }}
          />
        )}
        {frameFailed && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#0b0e14] text-sm text-white/60">
            <p>该页面不允许被内嵌显示。</p>
            <button type="button" onClick={() => externalOpen(target.url)} className="flex h-9 items-center gap-2 rounded-full bg-white px-4 text-black">
              <ExternalLink className="h-4 w-4" />在浏览器打开
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
