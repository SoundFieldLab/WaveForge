import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Music, Loader2, Check, ExternalLink } from 'lucide-react'
import { useTvBack } from '../tv/tvCore'

interface SpotifyLoginPanelProps {
  onClose: () => void
  onLoginSuccess: (username?: string) => void
}

/**
 * Spotify 登录（QQ 音乐同款编号步骤样式）：OAuth 授权弹窗。
 * 桌面端调 window.electron.openSpotifyLogin()（主进程开授权窗口，自动换 token 并回调）。
 */
export default function SpotifyLoginPanel({ onClose, onLoginSuccess }: SpotifyLoginPanelProps) {
  useTvBack(() => {
    onClose()
    return true
  })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const mountedRef = useRef(false)

  const hasNativeLogin = Boolean((window as any).electron?.openSpotifyLogin)

  useEffect(() => {
    mountedRef.current = true
    const onAuth = (e: Event) => {
      const detail = (e as CustomEvent<{ username?: string }>).detail
      if (mountedRef.current && detail?.username !== undefined) {
        onLoginSuccess(detail.username)
        onClose()
      }
    }
    window.addEventListener('spotifyAuthCompleted', onAuth)
    return () => {
      mountedRef.current = false
      window.removeEventListener('spotifyAuthCompleted', onAuth)
    }
  }, [onLoginSuccess, onClose])

  const handleAuth = async () => {
    if (loading) return
    setLoading(true)
    setError('')
    try {
      const customId = clientId.trim()
      if (customId) localStorage.setItem('spotify_client_id', customId)
      const result = await (window as any).electron.openSpotifyLogin(customId || undefined)
      if (!mountedRef.current) return
      if (result?.success && result.username !== undefined) {
        onLoginSuccess(result.username)
        onClose()
      } else if (result?.success && result.username === undefined) {
        onLoginSuccess()
        onClose()
      } else {
        setError(result?.error || '授权失败，请重试')
      }
    } catch (e) {
      if (mountedRef.current) setError('授权窗口打开失败')
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }

  const accent = '#1DB954'
  // 自定义 Client ID（Spotify 共享 Client ID 可能被风控报 server_error；用户可在
  // developer.spotify.com 免费注册自己的应用，Redirect URI 填 http://127.0.0.1:8000/login）
  const [clientId, setClientId] = useState(() => {
    try { return localStorage.getItem('spotify_client_id') || '' } catch { return '' }
  })
  const [showClientId, setShowClientId] = useState(false)

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
              <div className="p-2 rounded-full" style={{ backgroundColor: accent }}>
                <Music className="w-6 h-6 text-white" />
              </div>
              <h2 className="text-2xl font-bold text-white">Spotify 登录</h2>
            </div>
            <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-full transition-colors">
              <X className="w-6 h-6 text-white/60" />
            </button>
          </div>

          {/* 说明 */}
          <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4 mb-6">
            <p className="text-yellow-200 text-sm">将打开 Spotify 官方授权页面，登录并同意授权后自动完成</p>
          </div>

          {/* 自定义 Client ID（共享 Client ID 被风控时使用） */}
          <div className="mb-5">
            <button
              type="button"
              onClick={() => setShowClientId(v => !v)}
              className="text-xs text-white/50 hover:text-white/80 transition-colors"
            >
              {showClientId ? '▾ 收起' : '▸ 授权报错（server_error）？配置自己的 Spotify Client ID'}
            </button>
            {showClientId && (
              <div className="mt-2 rounded-xl border border-white/10 bg-white/[0.04] p-3 space-y-2">
                <p className="text-xs leading-relaxed text-white/55">
                  共享的公开 Client ID 可能被 Spotify 风控导致授权返回 server_error。可前往
                  <span className="text-white/80"> developer.spotify.com/dashboard </span>
                  免费创建应用，把 Redirect URI 设为
                  <code className="mx-1 rounded bg-white/10 px-1 py-0.5 text-white/80">http://127.0.0.1:8000/login</code>
                  ，然后把应用的 Client ID 粘贴到下面：
                </p>
                <input
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value.trim())}
                  placeholder="32 位十六进制 Client ID"
                  className="w-full rounded-lg border border-white/15 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-[#1DB954]"
                />
              </div>
            )}
          </div>

          {/* 步骤 1：OAuth 授权 */}
          <div className="space-y-4 mb-6">
            <div className="flex items-start gap-4">
              <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 text-white font-bold" style={{ backgroundColor: accent }}>
                1
              </div>
              <div className="flex-1">
                <h3 className="text-white font-medium mb-2">打开 Spotify 授权页面</h3>
                {hasNativeLogin ? (
                  <button
                    onClick={() => void handleAuth()}
                    disabled={loading}
                    className="flex items-center gap-2 px-4 py-2 text-white rounded-lg transition-colors disabled:opacity-60"
                    style={{ backgroundColor: accent }}
                  >
                    {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                    {loading ? '正在打开授权窗口…' : '使用 Spotify 账号授权登录'}
                  </button>
                ) : (
                  <button
                    onClick={() => window.open('https://accounts.spotify.com/authorize', '_blank')}
                    className="flex items-center gap-2 px-4 py-2 text-white rounded-lg transition-colors"
                    style={{ backgroundColor: accent }}
                  >
                    <ExternalLink className="w-4 h-4" />
                    打开 Spotify 授权页
                  </button>
                )}
              </div>
            </div>

            {/* 步骤 2：完成授权 */}
            <div className="flex items-start gap-4">
              <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 text-white font-bold" style={{ backgroundColor: accent }}>
                2
              </div>
              <div className="flex-1">
                <h3 className="text-white font-medium mb-2">完成授权</h3>
                <div className="bg-white/5 rounded-lg p-4 space-y-2 text-white/80 text-sm">
                  <p>1. 在弹出窗口中登录 <strong>Spotify 账号</strong></p>
                  <p>2. 点击 <strong>同意授权</strong></p>
                  <p>3. 窗口自动关闭并完成登录</p>
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
              onClick={() => void handleAuth()}
              disabled={loading}
              className="flex-1 px-6 py-3 text-white rounded-xl font-medium transition-colors disabled:opacity-60"
              style={{ backgroundColor: accent }}
            >
              {loading ? '正在打开…' : '授权登录'}
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}
