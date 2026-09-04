import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Music, ExternalLink, Copy, Check, QrCode } from 'lucide-react'
import { useTvBack } from '../tv/tvCore'

interface QQLoginPanelProps {
  onClose: () => void
  onLoginSuccess: (cookie: string) => void
}

export default function QQLoginPanel({ onClose, onLoginSuccess }: QQLoginPanelProps) {
  // TV 遥控器 BACK 关闭登录面板
  useTvBack(() => {
    onClose()
    return true
  })
  const [cookie, setCookie] = useState('')
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  const copiedTimerRef = useRef<number | null>(null)
  const loginControllerRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current)
      copiedTimerRef.current = null
      loginControllerRef.current?.abort()
      loginControllerRef.current = null
    }
  }, [])

  // TV：原生应用内扫码登录，抓到 cookie 后自动完成登录
  const nativeBridge = (window as any).WaveForgeNative
  const canNativeLogin = Boolean(nativeBridge?.openQQLogin)

  useEffect(() => {
    const onCookieCaptured = (e: Event) => {
      const detail = (e as CustomEvent<{ cookie?: string }>).detail
      if (!detail?.cookie) return
      if (mountedRef.current) onLoginSuccess(detail.cookie)
    }
    window.addEventListener('qqLoginCookieCaptured', onCookieCaptured)
    return () => window.removeEventListener('qqLoginCookieCaptured', onCookieCaptured)
  }, [onLoginSuccess])

  const handleOpenQQMusic = () => {
    // TV：没有浏览器可调起，直接走应用内扫码登录
    if (nativeBridge?.openQQLogin) {
      nativeBridge.openQQLogin()
      return
    }
    window.open('https://y.qq.com', '_blank')
  }

  const copyInstructions = async () => {
    const instructions = `1. 按F12打开开发者工具
2. 切换到Console标签
3. 输入以下代码并回车：
document.cookie

4. 复制输出的内容`
    
    try {
      await navigator.clipboard.writeText(instructions)
      if (!mountedRef.current) return
      setCopied(true)
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current)
      copiedTimerRef.current = window.setTimeout(() => {
        copiedTimerRef.current = null
        if (mountedRef.current) setCopied(false)
      }, 2000)
    } catch (err) {
      console.error('复制失败:', err)
    }
  }

  const handleLogin = async () => {
    const trimmedCookie = cookie.trim()
    if (!trimmedCookie) {
      setError('请输入 Cookie')
      return
    }

    if (!trimmedCookie.includes('uin') && !trimmedCookie.includes('qm_keyst') && !trimmedCookie.includes('qqmusic_key')) {
      setError('Cookie 格式不正确，请从 y.qq.com 登录后获取完整的 Cookie')
      return
    }

    loginControllerRef.current?.abort()
    const controller = new AbortController()
    loginControllerRef.current = controller
    try {
      const res = await fetch('http://localhost:3001/api/qq/user/setCookie', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ data: trimmedCookie }),
        signal: controller.signal,
      })
      const result = await res.json()
      if (!mountedRef.current || loginControllerRef.current !== controller) return

      if (result.result === 100) {
        onLoginSuccess(trimmedCookie)
      } else {
        setError('Cookie 无效，请检查后重试')
      }
    } catch (err) {
      if (controller.signal.aborted) return
      if (!mountedRef.current) return
      console.error('QQ 登录失败:', err)
      setError('登录失败，请重试')
    } finally {
      if (loginControllerRef.current === controller) loginControllerRef.current = null
    }
  }

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
              <div className="bg-green-600 p-2 rounded-lg">
                <Music className="w-6 h-6 text-white" />
              </div>
              <h2 className="text-2xl font-bold text-white">QQ音乐登录</h2>
            </div>
            <button
              onClick={onClose}
              className="p-2 hover:bg-white/10 rounded-full transition-colors"
            >
              <X className="w-6 h-6 text-white/60" />
            </button>
          </div>

          {/* 说明 */}
          <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4 mb-6">
            <p className="text-yellow-200 text-sm">
              由于QQ音乐API限制，需要手动获取Cookie进行登录
            </p>
          </div>

          {/* 步骤 */}
          <div className="space-y-4 mb-6">
            <div className="flex items-start gap-4">
              <div className="w-8 h-8 bg-green-600 rounded-full flex items-center justify-center flex-shrink-0 text-white font-bold">
                1
              </div>
              <div className="flex-1">
                <h3 className="text-white font-medium mb-2">打开QQ音乐官网并登录</h3>
                {canNativeLogin ? (
                  // TV：应用内扫码登录（无浏览器可调起）
                  <button
                    onClick={() => nativeBridge.openQQLogin()}
                    className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg transition-colors"
                  >
                    <QrCode className="w-4 h-4" />
                    手机扫码登录（电视）
                  </button>
                ) : (
                  <button
                    onClick={handleOpenQQMusic}
                    className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg transition-colors"
                  >
                    <ExternalLink className="w-4 h-4" />
                    打开 y.qq.com
                  </button>
                )}
              </div>
            </div>

            <div className="flex items-start gap-4">
              <div className="w-8 h-8 bg-green-600 rounded-full flex items-center justify-center flex-shrink-0 text-white font-bold">
                2
              </div>
              <div className="flex-1">
                <h3 className="text-white font-medium mb-2">获取Cookie</h3>
                <div className="bg-white/5 rounded-lg p-4 space-y-2 text-white/80 text-sm">
                  <p>1. 按 <kbd className="px-2 py-1 bg-white/10 rounded">F12</kbd> 打开开发者工具</p>
                  <p>2. 切换到 <strong>Console</strong> 标签</p>
                  <p>3. 输入以下代码并回车：</p>
                  <div className="bg-black/50 p-2 rounded font-mono text-green-400">
                    document.cookie
                  </div>
                  <p>4. 复制输出的内容（通常很长）</p>
                </div>
                <button
                  onClick={copyInstructions}
                  className="mt-2 flex items-center gap-2 px-3 py-1 text-white/60 hover:text-white text-sm transition-colors"
                >
                  {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  {copied ? '已复制说明' : '复制操作说明'}
                </button>
              </div>
            </div>

            <div className="flex items-start gap-4">
              <div className="w-8 h-8 bg-green-600 rounded-full flex items-center justify-center flex-shrink-0 text-white font-bold">
                3
              </div>
              <div className="flex-1">
                <h3 className="text-white font-medium mb-2">粘贴Cookie</h3>
                <textarea
                  value={cookie}
                  onChange={(e) => {
                    setCookie(e.target.value)
                    setError('')
                  }}
                  placeholder="粘贴从浏览器复制的Cookie..."
                  className="w-full h-32 bg-white/5 border border-white/10 rounded-lg p-3 text-white placeholder-white/40 focus:outline-none focus:border-green-500 resize-none"
                />
                {error && (
                  <p className="mt-2 text-red-400 text-sm">{error}</p>
                )}
              </div>
            </div>
          </div>

          {/* 登录按钮 */}
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="flex-1 px-6 py-3 bg-white/10 hover:bg-white/20 text-white rounded-xl font-medium transition-colors"
            >
              取消
            </button>
            <button
              onClick={handleLogin}
              className="flex-1 px-6 py-3 bg-green-600 hover:bg-green-700 text-white rounded-xl font-medium transition-colors"
            >
              登录
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}
