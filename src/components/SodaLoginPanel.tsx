/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 */
import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Music, Loader2, QrCode, ExternalLink, ChevronDown, ChevronUp } from 'lucide-react'
import { useTvBack } from '../tv/tvCore'

interface SodaLoginPanelProps {
  onClose: () => void
  onLoginSuccess: (token: string, username?: string, extra?: { avatar?: string; userId?: string }) => void
}

/**
 * 汽水音乐登录（QQ 音乐同款编号步骤样式）：抖音扫码。
 * 桌面端调 window.electron.openSodaLogin()（主进程开抖音 passport 扫码窗口，抓会话 Cookie）。
 * TV/非 Electron 无扫码窗口：折叠的手动粘贴 Cookie 区为次级通道——粘贴网页版 Cookie
 * 经 /api/soda/status 验证后落盘四键并走 App 层 handleSodaLogin 广播登录态。
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
  // 桌面端以扫码为主入口，手动输入默认折叠；TV/非 Electron 扫码不可用，默认展开唯一可用通道
  const [showManual, setShowManual] = useState(() => !hasNativeLogin)
  const [manualCookie, setManualCookie] = useState('')
  const [verifying, setVerifying] = useState(false)

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
        // 转发完整结果：主进程已抓取昵称/头像/ID，App 层据此落盘显示
        onLoginSuccess(result.cookie || result.token, result.username, { avatar: result.avatar, userId: result.userId })
      } else {
        setError(result?.error || '登录失败，请重试')
      }
    } catch (e) {
      if (mountedRef.current) setError('登录窗口打开失败')
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }

  // 手动粘贴 Cookie 登录：用粘贴内容调 /api/soda/status 验证（不先动 localStorage），
  // 通过后资料用 status 返回的 profile 直接落键；持久化与事件广播交给 App 层
  // handleSodaLogin（与扫码登录同一条链路，避免双份状态同步逻辑）。
  const handleManualLogin = async () => {
    const cookie = manualCookie.trim()
    if (verifying) return
    if (!cookie) {
      setError('请先粘贴汽水音乐网页版 Cookie')
      return
    }
    setVerifying(true)
    setError('')
    try {
      const { getSodaStatus } = await import('../services/sodaService')
      const status = await getSodaStatus(cookie)
      if (!mountedRef.current) return
      if (!status?.loggedIn) {
        setError('验证未通过：Cookie 无效/已过期，或本地服务未就绪，请重试')
        return
      }
      const p = status.profile
      // 落键与 App.handleSodaLogin 同一组四键（此后回调会再次写入同值，幂等）
      localStorage.setItem('soda_token', cookie)
      if (p?.nickname) localStorage.setItem('soda_username', p.nickname)
      if (p?.avatarUrl) localStorage.setItem('soda_avatar', p.avatarUrl)
      if (p?.userId) localStorage.setItem('soda_user_id', String(p.userId))
      onLoginSuccess(cookie, p?.nickname, { avatar: p?.avatarUrl, userId: p?.userId })
      setManualCookie('')
    } catch (e) {
      if (mountedRef.current) setError('Cookie 验证失败，请检查网络后重试')
    } finally {
      if (mountedRef.current) setVerifying(false)
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
              弹出窗口展示汽水官方二维码，使用「汽水音乐」App 扫码确认后自动完成登录
            </p>
          </div>

          {/* 步骤 1：抖音扫码 */}
          <div className="space-y-4 mb-6">
            <div className="flex items-start gap-4">
              <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 text-white font-bold" style={{ backgroundColor: accent }}>
                1
              </div>
              <div className="flex-1">
                <h3 className="text-white font-medium mb-2">弹出窗口扫码（汽水音乐 App）</h3>
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
                    onClick={() => window.open('https://www.qishui.com/', '_blank')}
                    className="flex items-center gap-2 px-4 py-2 text-white rounded-lg transition-colors"
                    style={{ backgroundColor: accent }}
                  >
                    <ExternalLink className="w-4 h-4" />
                    打开汽水音乐网页版
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

            {/* 手动粘贴 Cookie（TV/无扫码窗口时的次级通道）：桌面端折叠，TV 默认展开 */}
            <div className="border-t border-white/10 pt-4">
              <button
                onClick={() => setShowManual(prev => !prev)}
                className="w-full flex items-center justify-between bg-white/5 hover:bg-white/10 rounded-lg px-4 py-3 transition-colors"
              >
                <span className="text-white/80 text-sm font-medium">无法扫码？手动粘贴 Cookie 登录</span>
                {showManual ? <ChevronUp className="w-4 h-4 text-white/60" /> : <ChevronDown className="w-4 h-4 text-white/60" />}
              </button>
              {showManual && (
                <div className="mt-3 space-y-3">
                  <div className="bg-white/5 rounded-lg p-3 text-white/60 text-xs leading-relaxed">
                    在浏览器打开汽水音乐网页版（www.qishui.com）并登录，按 F12 打开开发者工具，
                    在「应用 / Application → Cookies」中复制全部 Cookie（需含 sessionid 字段），粘贴到下方。
                  </div>
                  <textarea
                    value={manualCookie}
                    onChange={(e) => setManualCookie(e.target.value)}
                    disabled={verifying}
                    rows={4}
                    placeholder="粘贴完整 Cookie（key=value; key=value …）"
                    className="w-full h-24 resize-none bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-xs font-mono placeholder-white/30 focus:outline-none focus:border-sky-400 disabled:opacity-60"
                  />
                  <button
                    onClick={() => void handleManualLogin()}
                    disabled={verifying || !manualCookie.trim()}
                    className="flex items-center gap-2 px-4 py-2 text-white rounded-lg text-sm transition-colors disabled:opacity-60"
                    style={{ backgroundColor: accent }}
                  >
                    {verifying ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                    {verifying ? '正在验证…' : '验证并登录'}
                  </button>
                </div>
              )}
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
            {hasNativeLogin && (
              <button
                onClick={() => void handleLogin()}
                disabled={loading}
                className="flex-1 px-6 py-3 text-white rounded-xl font-medium transition-colors disabled:opacity-60"
                style={{ backgroundColor: accent }}
              >
                {loading ? '正在打开…' : '扫码登录'}
              </button>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}
