import React, { useState, useEffect, useRef, Suspense, lazy } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Music, RefreshCw, Copy, Check, ExternalLink } from 'lucide-react'
import type { MusicPlatform } from '../services/platforms'
import GlobalToast from './GlobalToast'

// 新平台登录面板（组件外声明，避免条件内 lazy 造成重挂载）
const KugouLoginPanel = lazy(() => import('./KugouLoginPanel').then(m => ({ default: m.default })))
const SpotifyLoginPanel = lazy(() => import('./SpotifyLoginPanel').then(m => ({ default: m.default })))
const SodaLoginPanel = lazy(() => import('./SodaLoginPanel').then(m => ({ default: m.default })))

interface LoginViewProps {
  platform: MusicPlatform
  onCancel: () => void
  onLoginSuccess: (cookie: string, username?: string) => void
}

export default function LoginView({ platform, onCancel, onLoginSuccess }: LoginViewProps) {
  const [qrCode, setQrCode] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState<'pending' | 'scanned' | 'success' | 'expired'>('pending')
  // 🔧 修复内存泄漏：改用 ref 而非 state
  const pollTimerRef = useRef<number | null>(null)
  const requestControllerRef = useRef<AbortController | null>(null)
  const pollControllerRef = useRef<AbortController | null>(null)
  const websiteTimerRef = useRef<number | null>(null)
  const toastTimerRef = useRef<number | null>(null)
  const generationRef = useRef(0)
  const mountedRef = useRef(false)
  
  // QQ 登录相关状态
  const [qqCookie, setQQCookie] = useState('')
  const [qqError, setQQError] = useState('')
  const [showCopiedToast, setShowCopiedToast] = useState(false)
  const [qqManualMode, setQQManualMode] = useState(false) // QQ 手动模式
  // 应用内扫码登录（TV）回调的最新引用，供事件监听使用（在函数定义后赋值）
  const handleQQLoginWithCookieRef = useRef<(cookie: string) => Promise<void>>(async () => {})

  const clearPolling = () => {
    if (pollTimerRef.current !== null) window.clearTimeout(pollTimerRef.current)
    pollTimerRef.current = null
    pollControllerRef.current?.abort()
    pollControllerRef.current = null
  }

  const clearWebsiteTimers = () => {
    if (websiteTimerRef.current !== null) window.clearTimeout(websiteTimerRef.current)
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current)
    websiteTimerRef.current = null
    toastTimerRef.current = null
  }

  const isCurrent = (generation: number) => mountedRef.current && generationRef.current === generation

  const handleQQAutoLogin = async () => {
    try {
      setLoading(true)
      setQQError('')
      const electron = window.electron
      const native = (window as any).WaveForgeNative
      if (!electron?.openQQLoginWindow && !native?.openQQLogin) {
        // 纯浏览器（含 ?tv=1 模拟）：跨域限制下无法自动抓取 qq.com 的 cookie——
        // 打开 y.qq.com 让用户登录，然后走"手动登录"粘贴 Cookie 流程。
        setQQError('')
        setQQManualMode(true)
        setLoading(false)
        window.open('https://y.qq.com', '_blank')
        return
      }

      if (electron?.openQQLoginWindow) {
        // 桌面：Electron 登录窗口（登录成功自动抓取 cookie）
        const result = await electron.openQQLoginWindow()
        if (!mountedRef.current) return
        if (result.success && result.cookie) {
          await handleQQLoginWithCookie(result.cookie)
        } else if (result.error) {
          setQQError(result.error)
          setLoading(false)
        } else {
          setQQError('未获取到登录信息')
          setLoading(false)
        }
        return
      }

      // TV/安卓：应用内扫码登录——原生侧弹出 QQ 登录页（手机扫码），
      // 抓到 cookie 后通过 qqLoginCookieCaptured 事件回传
      setQQError('')
      setQQManualMode(false)
      native.openQQLogin()
    } catch (err) {
      if (!mountedRef.current) return
      console.error('QQ 自动登录失败:', err)
      setQQError('QQ 自动登录失败')
      setLoading(false)
    }
  }

  const handleQQOpenWebsite = async () => {
    try {
      await navigator.clipboard.writeText('document.cookie')
      if (!mountedRef.current) return
      clearWebsiteTimers()
      setShowCopiedToast(true)
      websiteTimerRef.current = window.setTimeout(() => {
        websiteTimerRef.current = null
        window.open('https://y.qq.com', '_blank')
        toastTimerRef.current = window.setTimeout(() => {
          toastTimerRef.current = null
          if (mountedRef.current) setShowCopiedToast(false)
        }, 500)
      }, 3500)
    } catch (err) {
      console.error('打开网页失败:', err)
    }
  }

  const startPolling = (key: string, generation: number) => {
    clearPolling()
    const poll = async () => {
      if (!isCurrent(generation)) return
      const controller = new AbortController()
      pollControllerRef.current = controller
      let finished = false
      try {
        const res = await fetch(`http://localhost:3001/api/netease/login/qr/check?key=${key}`, { signal: controller.signal })
        const data = await res.json()
        if (!isCurrent(generation)) return

        if (data.code === 800) {
          setStatus('expired')
          finished = true
        } else if (data.code === 801) {
          setStatus('pending')
        } else if (data.code === 802) {
          setStatus('scanned')
        } else if (data.code === 803) {
          setStatus('success')
          finished = true
          if (data.cookie) onLoginSuccess(data.cookie)
          else console.error('login succeeded without cookie')
        }
      } catch (error) {
        if (!controller.signal.aborted) console.error('login polling failed:', error)
      } finally {
        if (pollControllerRef.current === controller) pollControllerRef.current = null
        if (!finished && isCurrent(generation)) {
          pollTimerRef.current = window.setTimeout(() => void poll(), 2000)
        }
      }
    }
    pollTimerRef.current = window.setTimeout(() => void poll(), 2000)
  }

  const generateQRCode = async () => {
    const generation = ++generationRef.current
    clearPolling()
    requestControllerRef.current?.abort()
    const controller = new AbortController()
    requestControllerRef.current = controller
    setLoading(true)
    setStatus('pending')
    try {
      const keyRes = await fetch('http://localhost:3001/api/netease/login/qr/key', { signal: controller.signal })
      const keyData = await keyRes.json()
      if (!keyData.data?.unikey) throw new Error('failed to get QR key')

      const key = keyData.data.unikey
      const qrRes = await fetch(`http://localhost:3001/api/netease/login/qr/create?key=${key}&qrimg=true`, { signal: controller.signal })
      const qrData = await qrRes.json()
      if (!isCurrent(generation)) return
      if (!qrData.data?.qrimg) throw new Error('failed to generate QR code')

      setQrCode(qrData.data.qrimg)
      setLoading(false)
      startPolling(key, generation)
    } catch (error) {
      if (controller.signal.aborted || !isCurrent(generation)) return
      console.error('网易云扫码失败:', error)
      setLoading(false)
      setStatus('expired')
    } finally {
      if (requestControllerRef.current === controller) requestControllerRef.current = null
    }
  }

  useEffect(() => {
    mountedRef.current = true
    if (platform === 'netease') void generateQRCode()
    else setLoading(false)
    return () => {
      mountedRef.current = false
      generationRef.current += 1
      clearPolling()
      clearWebsiteTimers()
      requestControllerRef.current?.abort()
      requestControllerRef.current = null
    }
  }, [platform])

  // TV 应用内扫码登录：原生侧抓到 QQ cookie 后回传
  useEffect(() => {
    const onCookieCaptured = (e: Event) => {
      const detail = (e as CustomEvent<{ cookie?: string }>).detail
      if (!detail?.cookie) return
      setLoading(false)
      void handleQQLoginWithCookieRef.current(detail.cookie)
    }
    const onLoginClosed = () => {
      setLoading(false)
      setQQError('未获取到登录信息，请重试')
    }
    window.addEventListener('qqLoginCookieCaptured', onCookieCaptured)
    window.addEventListener('qqLoginClosed', onLoginClosed)
    return () => {
      window.removeEventListener('qqLoginCookieCaptured', onCookieCaptured)
      window.removeEventListener('qqLoginClosed', onLoginClosed)
    }
  }, [])

  const handleRefresh = () => {
    void generateQRCode()
  }

  const handleQQLoginWithCookie = async (cookie: string) => {
    setQQError('')
    
    if (!cookie.trim()) {
      setQQError('请输入 Cookie')
      setLoading(false)
      return
    }

    // 验证 Cookie 格式 - 检查是否包含任何可能的用户标识字段
    const hasUserIdentifier = cookie.includes('uin') || 
                              cookie.includes('wxuin') || 
                              cookie.includes('ts_uid') ||
                              cookie.includes('psrf_qqopenid')
    
    if (!hasUserIdentifier) {
      setQQError('Cookie 格式不正确，请确保从 y.qq.com 登录后获取完整的 Cookie')
      setLoading(false)
      return
    }

    onLoginSuccess(cookie)
  }
  handleQQLoginWithCookieRef.current = handleQQLoginWithCookie

  const handleQQLogin = () => {
    handleQQLoginWithCookie(qqCookie.trim())
  }

  const getStatusText = () => {
    switch (status) {
      case 'pending':
        return '请使用网易云音乐 App 扫码登录'
      case 'scanned':
        return '扫码成功，请在手机上确认登录'
      case 'success':
        return '登录成功！'
      case 'expired':
        return '二维码已过期，请点击刷新'
    }
  }

  const getStatusColor = () => {
    switch (status) {
      case 'pending':
        return 'text-white/60'
      case 'scanned':
        return 'text-blue-400'
      case 'success':
        return 'text-green-400'
      case 'expired':
        return 'text-red-400'
    }
  }

  // 新三平台（Spotify/酷狗/汽水）：复用各自登录面板（简化登录）
  if (platform === 'kugou' || platform === 'spotify' || platform === 'soda') {
    if (platform === 'kugou') {
      return (
        <Suspense fallback={null}>
          <KugouLoginPanel onClose={onCancel} onLoginSuccess={(cookie: string) => onLoginSuccess(cookie)} />
        </Suspense>
      )
    }
    if (platform === 'spotify') {
      return (
        <Suspense fallback={null}>
          <SpotifyLoginPanel onClose={onCancel} onLoginSuccess={(username?: string) => onLoginSuccess('spotify-logged', username)} />
        </Suspense>
      )
    }
    return (
      <Suspense fallback={null}>
        <SodaLoginPanel onClose={onCancel} onLoginSuccess={(token: string) => onLoginSuccess(token)} />
      </Suspense>
    )
  }

  return (
    <>
      <div className="fixed inset-0 w-full h-full overflow-hidden z-50" data-tv-scope>
        {/* 动态背景 */}
      <motion.div 
        className="absolute inset-0"
        animate={{
          background: [
            'linear-gradient(135deg, #2d1b3d 0%, #1a0f2e 50%, #0a0a0a 100%)',
            'linear-gradient(135deg, #3d1b2d 0%, #2e0f1a 50%, #0a0a0a 100%)',
            'linear-gradient(135deg, #2d1b3d 0%, #1a0f2e 50%, #0a0a0a 100%)',
          ]
        }}
        transition={{
          duration: 10,
          repeat: Infinity,
          ease: "easeInOut"
        }}
      />
      
      {/* 动态光晕 */}
      <motion.div
        className="absolute w-[40vw] h-[40vw] max-w-[500px] max-h-[500px] rounded-full"
        style={{
          background: 'radial-gradient(circle, rgba(255, 105, 180, 0.5) 0%, transparent 70%)',
          filter: 'blur(80px)',
          top: '20%',
          left: '15%',
        }}
        animate={{
          scale: [1, 1.3, 1],
          x: [0, 60, 0],
          y: [0, 40, 0],
        }}
        transition={{
          duration: 12,
          repeat: Infinity,
          ease: "easeInOut"
        }}
      />
      
      {/* 遮罩 */}
      <div className="absolute inset-0 bg-black/20" />

      {/* 内容区 */}
      <div className="relative z-10 w-full h-full flex items-center justify-center p-6">
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.9 }}
          className="relative w-full max-w-md"
          style={{
            background: 'rgba(0, 0, 0, 0.4)',
            backdropFilter: 'blur(40px) saturate(180%)',
            WebkitBackdropFilter: 'blur(40px) saturate(180%)',
            borderRadius: '24px',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            boxShadow: '0 8px 32px 0 rgba(0, 0, 0, 0.37)'
          }}
        >
          {/* 头部 */}
          <div className="flex items-center justify-between p-6 border-b border-white/10">
            <div className="flex items-center gap-3">
              <Music className="w-6 h-6 text-white" />
              <h2 className="text-2xl font-bold text-white">
                {platform === 'netease' ? '网易云音乐登录' : 'QQ音乐登录'}
              </h2>
            </div>
            <motion.button
              whileHover={{ scale: 1.1, rotate: 90 }}
              whileTap={{ scale: 0.9 }}
              onClick={onCancel}
              className="p-2 hover:bg-white/10 rounded-full transition-colors"
            >
              <X className="w-6 h-6 text-white/60" />
            </motion.button>
          </div>

          {/* 二维码区域 */}
          <div className="p-8 flex flex-col items-center">
            {platform === 'netease' ? (
              <>
                {/* 二维码 */}
                <div className="relative mb-6">
                  <AnimatePresence mode="wait">
                    {loading ? (
                      <motion.div
                        key="loading"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="w-64 h-64 bg-white/10 rounded-2xl flex items-center justify-center"
                      >
                        <div className="text-white/60">加载中...</div>
                      </motion.div>
                    ) : (
                      <motion.div
                        key="qrcode"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="relative"
                      >
                        <img 
                          src={qrCode} 
                          alt="登录二维码" 
                          className="w-64 h-64 rounded-2xl bg-white p-4"
                        />
                        {status === 'expired' && (
                          <div className="absolute inset-0 bg-black/60 rounded-2xl flex items-center justify-center">
                            <motion.button
                              whileHover={{ scale: 1.1 }}
                              whileTap={{ scale: 0.9 }}
                              onClick={handleRefresh}
                              className="px-6 py-3 bg-white/20 hover:bg-white/30 text-white rounded-full font-medium transition-all flex items-center gap-2"
                            >
                              <RefreshCw className="w-5 h-5" />
                              刷新二维码
                            </motion.button>
                          </div>
                        )}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                {/* 状态提示 */}
                <motion.p 
                  key={status}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={`text-center text-lg ${getStatusColor()}`}
                >
                  {getStatusText()}
                </motion.p>

                {status === 'pending' && (
                  <p className="text-center text-white/40 text-sm mt-2">
                    打开网易云音乐 App，扫描上方二维码
                  </p>
                )}
              </>
            ) : (
              // QQ音乐登录
              <div className="space-y-6 w-full">
                {loading ? (
                  <div className="flex flex-col items-center justify-center py-8">
                    <div className="w-16 h-16 border-4 border-green-500/30 border-t-green-500 rounded-full animate-spin mb-4"></div>
                    <p className="text-white/60 text-sm">正在等待登录...</p>
                  </div>
                ) : !qqManualMode ? (
                  // 自动登录模式
                  <>
                    <div className="text-center space-y-4">
                      <Music className="w-16 h-16 text-green-500 mx-auto" />
                      <div>
                        <h3 className="text-xl font-medium text-white mb-2">QQ音乐登录</h3>
                        <p className="text-white/60 text-sm">
                          {(window as any).WaveForgeNative?.openQQLogin
                            ? '请在电视屏幕上使用手机 QQ 扫码登录，登录成功后自动返回'
                            : '弹出窗口后请选择立即登录，登录成功后本窗口将自动关闭'}
                        </p>
                      </div>
                    </div>

                    {qqError && (
                      <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4">
                        <p className="text-red-400 text-sm">{qqError}</p>
                      </div>
                    )}

                    {/* 手动登录提示链接 */}
                    <div className="text-center -mt-2">
                      <button
                        onClick={() => {
                          setQQManualMode(true)
                          setQQError('')
                        }}
                        className="text-white/50 hover:text-white/80 text-sm transition-colors"
                      >
                        遇到问题？可尝试<span className="underline">手动登录</span>
                      </button>
                    </div>

                    <div className="flex gap-3 pt-2">
                      <button
                        onClick={handleQQAutoLogin}
                        className="flex-1 px-6 py-3 bg-green-600 hover:bg-green-700 text-white rounded-full font-medium transition-colors inline-flex items-center justify-center gap-2"
                      >
                        <ExternalLink className="w-4 h-4" />
                        {(window as any).WaveForgeNative?.openQQLogin ? '手机扫码登录' : '打开登录窗口'}
                      </button>
                      <button
                        onClick={onCancel}
                        className="flex-1 px-6 py-3 bg-white/10 hover:bg-white/20 text-white rounded-full font-medium transition-colors"
                      >
                        取消
                      </button>
                    </div>
                  </>
                ) : (
                  // 手动登录模式
                  <>
                    <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4 mb-2">
                      <p className="text-yellow-200 text-sm">
                        由于QQ音乐API限制，需要手动获取Cookie进行登录
                      </p>
                    </div>

                    <div className="space-y-4">
                      {/* 步骤1 */}
                      <div className="flex items-start gap-4">
                        <div className="w-8 h-8 bg-green-600 rounded-full flex items-center justify-center flex-shrink-0 text-white font-bold">
                          1
                        </div>
                        <div className="flex-1">
                          <h3 className="text-white font-medium mb-2">打开QQ音乐官网并登录</h3>
                          <button
                            onClick={handleQQOpenWebsite}
                            className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg transition-colors"
                          >
                            <ExternalLink className="w-4 h-4" />
                            前往 y.qq.com
                          </button>
                        </div>
                      </div>

                      {/* 步骤2 */}
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
                        </div>
                      </div>

                      {/* 步骤3 */}
                      <div className="flex items-start gap-4">
                        <div className="w-8 h-8 bg-green-600 rounded-full flex items-center justify-center flex-shrink-0 text-white font-bold">
                          3
                        </div>
                        <div className="flex-1">
                          <h3 className="text-white font-medium mb-2">粘贴Cookie</h3>
                          <textarea
                            value={qqCookie}
                            onChange={(e) => {
                              setQQCookie(e.target.value)
                              setQQError('')
                            }}
                            placeholder="粘贴从浏览器复制的 Cookie..."
                            className="w-full h-32 bg-white/5 border border-white/10 rounded-lg p-3 text-white placeholder-white/40 focus:outline-none focus:border-green-500 resize-none"
                          />
                        </div>
                      </div>
                    </div>

                    {qqError && (
                      <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4">
                        <p className="text-red-400 text-sm">{qqError}</p>
                      </div>
                    )}

                    <div className="flex gap-3 pt-2">
                      <button
                        onClick={() => {
                          setQQManualMode(false)
                          setQQError('')
                          setQQCookie('')
                        }}
                        className="flex-1 px-6 py-3 bg-white/10 hover:bg-white/20 text-white rounded-full font-medium transition-colors"
                      >
                        返回自动登录
                      </button>
                      <button
                        onClick={handleQQLogin}
                        className="flex-1 px-6 py-3 bg-green-600 hover:bg-green-700 text-white rounded-full font-medium transition-colors"
                      >
                        登录
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </motion.div>
      </div>
      
      {/* 全局 Toast 通知 */}
      <GlobalToast 
        show={showCopiedToast}
        message="已复制指令！请前往 y.qq.com 按 F12 打开控制台粘贴"
        type="info"
        onClose={() => setShowCopiedToast(false)}
      />
    </div>
    </>
  )
}

