import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Music, ExternalLink, Copy, Check, QrCode, Loader2 } from 'lucide-react'
import { useTvBack } from '../tv/tvCore'

interface KugouLoginPanelProps {
  onClose: () => void
  onLoginSuccess: (cookie: string, username?: string) => void
}

/**
 * 酷狗音乐登录（QQ 音乐同款编号步骤样式）：
 * - 桌面端：Electron 弹窗打开酷狗官网 → 用户扫码/登录 → 自动抓 KuGoo/kg_token Cookie
 * - 手动兜底：粘贴 cookie
 */
export default function KugouLoginPanel({ onClose, onLoginSuccess }: KugouLoginPanelProps) {
  useTvBack(() => {
    onClose()
    return true
  })
  const [cookie, setCookie] = useState('')
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const copiedTimerRef = useRef<number | null>(null)
  const mountedRef = useRef(false)

  const hasNativeLogin = Boolean((window as any).electron?.openKugouLoginWindow)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current)
      copiedTimerRef.current = null
    }
  }, [])

  const handleAutoLogin = async () => {
    if (loading) return
    setLoading(true)
    setError('')
    try {
      const result = await (window as any).electron.openKugouLoginWindow()
      if (!mountedRef.current) return
      if (result?.success && result.cookie) {
        onLoginSuccess(result.cookie, result.username)
      } else {
        setError(result?.error || '登录失败，请重试')
      }
    } catch (e) {
      if (mountedRef.current) setError('登录窗口打开失败')
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }

  const handleOpenKugou = () => {
    window.open('https://www.kugou.com', '_blank')
  }

  const copyInstructions = async () => {
    const instructions = `1. 打开 www.kugou.com 并登录
2. 按F12打开开发者工具
3. Console 输入 document.cookie 回车
4. 复制输出内容`
    try {
      await navigator.clipboard.writeText(instructions)
      if (!mountedRef.current) return
      setCopied(true)
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current)
      copiedTimerRef.current = window.setTimeout(() => {
        copiedTimerRef.current = null
        if (mountedRef.current) setCopied(false)
      }, 2000)
    } catch {
      /* 忽略 */
    }
  }

  const handleManualLogin = () => {
    const trimmedCookie = cookie.trim()
    if (!trimmedCookie) {
      setError('请输入 Cookie')
      return
    }
    if (!trimmedCookie.includes('kg_token') && !trimmedCookie.includes('KuGoo=') && !trimmedCookie.includes('KugooID=')) {
      setError('Cookie 格式不正确，请从 www.kugou.com 登录后获取完整 Cookie（需包含 KuGoo 或 kg_token）')
      return
    }
    onLoginSuccess(trimmedCookie)
  }

  const accent = '#FF7A00'
  const accentText = 'text-orange-400'

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex items-center justify-center p-8"
        data-tv-scope
        onClick={onClose}
      >
        <motion.div
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.9, opacity: 0 }}
          onClick={(e) => e.stopPropagation()}
          className="bg-black/90 backdrop-blur-xl rounded-3xl shadow-2xl w-full max-w-2xl p-8 border border-white/10"
        >
          {/* 头部 */}
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg" style={{ backgroundColor: accent }}>
                <Music className="w-6 h-6 text-white" />
              </div>
              <h2 className="text-2xl font-bold text-white">酷狗音乐登录</h2>
            </div>
            <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-full transition-colors">
              <X className="w-6 h-6 text-white/60" />
            </button>
          </div>

          {/* 说明 */}
          <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4 mb-6">
            <p className="text-yellow-200 text-sm">在弹出窗口完成酷狗登录，登录后自动回到应用；也可以手动粘贴 Cookie</p>
          </div>

          {/* 步骤 1：弹窗扫码登录 */}
          <div className="space-y-4 mb-6">
            <div className="flex items-start gap-4">
              <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 text-white font-bold" style={{ backgroundColor: accent }}>
                1
              </div>
              <div className="flex-1">
                <h3 className="text-white font-medium mb-2">弹出窗口扫码登录（推荐）</h3>
                {hasNativeLogin ? (
                  <button
                    onClick={() => void handleAutoLogin()}
                    disabled={loading}
                    className="flex items-center gap-2 px-4 py-2 text-white rounded-lg transition-colors disabled:opacity-60"
                    style={{ backgroundColor: accent }}
                  >
                    {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <QrCode className="w-4 h-4" />}
                    {loading ? '正在打开登录窗口…' : '在弹出窗口登录酷狗'}
                  </button>
                ) : (
                  <button
                    onClick={handleOpenKugou}
                    className="flex items-center gap-2 px-4 py-2 text-white rounded-lg transition-colors"
                    style={{ backgroundColor: accent }}
                  >
                    <ExternalLink className="w-4 h-4" />
                    打开 www.kugou.com
                  </button>
                )}
              </div>
            </div>

            {/* 步骤 2：手动 Cookie（备用） */}
            <div className="flex items-start gap-4">
              <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 text-white font-bold" style={{ backgroundColor: accent }}>
                2
              </div>
              <div className="flex-1">
                <h3 className="text-white font-medium mb-2">手动粘贴 Cookie（备用）</h3>
                <div className="bg-white/5 rounded-lg p-4 space-y-2 text-white/80 text-sm">
                  <p>1. 打开 <button onClick={handleOpenKugou} className={`${accentText} hover:underline`}>www.kugou.com</button> 并登录</p>
                  <p>2. 按 <kbd className="px-2 py-1 bg-white/10 rounded">F12</kbd> 打开开发者工具</p>
                  <p>3. 在 <strong>Console</strong> 输入 <span className={`${accentText} font-mono`}>document.cookie</span> 回车</p>
                  <p>4. 复制输出的内容（需包含 KuGoo 或 kg_token）</p>
                </div>
                <button
                  onClick={copyInstructions}
                  className="mt-2 flex items-center gap-2 px-3 py-1 text-white/60 hover:text-white text-sm transition-colors"
                >
                  {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  {copied ? '已复制说明' : '复制操作说明'}
                </button>
                <textarea
                  value={cookie}
                  onChange={(e) => {
                    setCookie(e.target.value)
                    setError('')
                  }}
                  placeholder="粘贴从浏览器复制的 Cookie..."
                  className="mt-2 w-full h-28 bg-white/5 border border-white/10 rounded-lg p-3 text-white placeholder-white/40 focus:outline-none resize-none"
                  style={{ borderColor: 'rgba(255,255,255,0.1)' }}
                />
                {error && <p className="mt-2 text-red-400 text-sm">{error}</p>}
              </div>
            </div>
          </div>

          {/* 按钮 */}
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="flex-1 px-6 py-3 bg-white/10 hover:bg-white/20 text-white rounded-xl font-medium transition-colors"
            >
              取消
            </button>
            <button
              onClick={handleManualLogin}
              className="flex-1 px-6 py-3 text-white rounded-xl font-medium transition-colors"
              style={{ backgroundColor: accent }}
            >
              登录
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}
