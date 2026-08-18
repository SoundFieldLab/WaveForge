import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Music, Loader2, QrCode, ExternalLink } from 'lucide-react'
import { useTvBack } from '../tv/tvCore'

interface SodaLoginPanelProps {
  onClose: () => void
  onLoginSuccess: (token: string, username?: string) => void
}

/**
 * 汽水音乐登录（QQ 音乐同款编号步骤样式）：抖音扫码。
 * 桌面端调 window.electron.openSodaLogin()（主进程开抖音 passport 扫码窗口，抓会话 Cookie）。
 */
export default function SodaLoginPanel({ onClose, onLoginSuccess }: SodaLoginPanelProps) {
  useTvBack(() => {
    onClose()
    return true
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const mountedRef = useRef(false)

  const hasNativeLogin = Boolean((window as any).electron?.openSodaLogin)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const handleLogin = async () => {
    if (loading) return
    setLoading(true)
    setError('')
    try {
      const result = await (window as any).electron.openSodaLogin()
      if (!mountedRef.current) return
      if (result?.success && (result.cookie || result.token)) {
        onLoginSuccess(result.cookie || result.token, result.username)
      } else {
        setError(result?.error || '登录失败，请重试')
      }
    } catch (e) {
      if (mountedRef.current) setError('登录窗口打开失败')
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }

  const accent = '#38BDF8'

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
              <h2 className="text-2xl font-bold text-white">汽水音乐登录</h2>
            </div>
            <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-full transition-colors">
              <X className="w-6 h-6 text-white/60" />
            </button>
          </div>

          {/* 说明 */}
          <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4 mb-6">
            <p className="text-yellow-200 text-sm">
              汽水音乐使用抖音账号体系，打开抖音登录页扫码即可，登录后自动完成
            </p>
          </div>

          {/* 步骤 1：抖音扫码 */}
          <div className="space-y-4 mb-6">
            <div className="flex items-start gap-4">
              <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 text-white font-bold" style={{ backgroundColor: accent }}>
                1
              </div>
              <div className="flex-1">
                <h3 className="text-white font-medium mb-2">打开抖音登录页并扫码</h3>
                {hasNativeLogin ? (
                  <button
                    onClick={() => void handleLogin()}
                    disabled={loading}
                    className="flex items-center gap-2 px-4 py-2 text-white rounded-lg transition-colors disabled:opacity-60"
                    style={{ backgroundColor: accent }}
                  >
                    {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <QrCode className="w-4 h-4" />}
                    {loading ? '正在打开登录窗口…' : '在弹出窗口扫码登录（抖音 App）'}
                  </button>
                ) : (
                  <button
                    onClick={() => window.open('https://sso.douyin.com/', '_blank')}
                    className="flex items-center gap-2 px-4 py-2 text-white rounded-lg transition-colors"
                    style={{ backgroundColor: accent }}
                  >
                    <ExternalLink className="w-4 h-4" />
                    打开抖音登录页
                  </button>
                )}
              </div>
            </div>

            {/* 步骤 2：说明 */}
            <div className="flex items-start gap-4">
              <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 text-white font-bold" style={{ backgroundColor: accent }}>
                2
              </div>
              <div className="flex-1">
                <h3 className="text-white font-medium mb-2">完成登录</h3>
                <div className="bg-white/5 rounded-lg p-4 space-y-2 text-white/80 text-sm">
                  <p>1. 使用 <strong>抖音 App</strong> 扫描二维码</p>
                  <p>2. 在手机上确认登录</p>
                  <p>3. 登录窗口自动关闭并完成登录</p>
                </div>
              </div>
            </div>
          </div>

          {error && <p className="mt-2 mb-4 text-red-400 text-sm">{error}</p>}

          {/* 按钮 */}
          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="flex-1 px-6 py-3 bg-white/10 hover:bg-white/20 text-white rounded-xl font-medium transition-colors"
            >
              取消
            </button>
            <button
              onClick={() => void handleLogin()}
              disabled={loading}
              className="flex-1 px-6 py-3 text-white rounded-xl font-medium transition-colors disabled:opacity-60"
              style={{ backgroundColor: accent }}
            >
              {loading ? '正在打开…' : '扫码登录'}
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}
