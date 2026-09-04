import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Loader2 } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { useTvBack } from '../tv/tvCore'
import {
  generateBilibiliQr,
  checkBilibiliQr,
  getBilibiliUser,
  saveBilibiliCookie,
  saveBilibiliUser,
  setBilibiliServerCookie,
  recordBilibiliLogin,
} from '../services/bilibiliApi'

interface BilibiliLoginPanelProps {
  onClose: () => void
  onLoginSuccess: (cookie: string) => void
}

const BILI_PINK = '#FB7299'

export default function BilibiliLoginPanel({ onClose, onLoginSuccess }: BilibiliLoginPanelProps) {
  useTvBack(() => {
    onClose()
    return true
  })

  const [qrUrl, setQrUrl] = useState('')
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState<'pending' | 'scanned' | 'success' | 'expired'>('pending')
  const pollTimerRef = useRef<number | null>(null)
  const pollControllerRef = useRef<AbortController | null>(null)
  const generationRef = useRef(0)
  const mountedRef = useRef(false)

  const clearPolling = () => {
    if (pollTimerRef.current !== null) window.clearTimeout(pollTimerRef.current)
    pollTimerRef.current = null
    pollControllerRef.current?.abort()
    pollControllerRef.current = null
  }

  const isCurrent = (generation: number) => mountedRef.current && generationRef.current === generation

  const startPolling = (key: string, generation: number) => {
    clearPolling()
    const poll = async () => {
      if (!isCurrent(generation)) return
      const controller = new AbortController()
      pollControllerRef.current = controller
      let finished = false
      try {
        const data = await checkBilibiliQr(key)
        if (!isCurrent(generation)) return
        if (data.status === 'ok' && data.cookie) {
          setStatus('success')
          finished = true
          // 登录态落库：localStorage + 后端全局 + 有效期
          saveBilibiliCookie(data.cookie)
          await setBilibiliServerCookie(data.cookie).catch(() => undefined)
          recordBilibiliLogin()
          const user = await getBilibiliUser().catch(() => null)
          if (user && user.isLogin) saveBilibiliUser(user)
          window.dispatchEvent(new CustomEvent('bilibili-auth-changed', { detail: { loggedIn: true } }))
          onLoginSuccess(data.cookie)
        } else if (data.status === 'expired') {
          setStatus('expired')
          finished = true
        } else if (data.status === 'scanned') {
          setStatus('scanned')
        } else {
          setStatus('pending')
        }
      } catch (error) {
        if (!controller.signal.aborted) console.error('[Bilibili] 登录轮询失败:', error)
      } finally {
        if (pollControllerRef.current === controller) pollControllerRef.current = null
        if (!finished && isCurrent(generation)) {
          pollTimerRef.current = window.setTimeout(() => void poll(), 2000)
        }
      }
    }
    pollTimerRef.current = window.setTimeout(() => void poll(), 1500)
  }

  const fetchQRCode = async () => {
    const generation = ++generationRef.current
    clearPolling()
    setLoading(true)
    setStatus('pending')
    try {
      const data = await generateBilibiliQr()
      if (!isCurrent(generation)) return
      if (data.code !== 0 || !data.url) throw new Error('生成二维码失败')
      setQrUrl(data.url)
      setLoading(false)
      startPolling(data.qrcodeKey, generation)
    } catch (error) {
      if (!isCurrent(generation)) return
      console.error('[Bilibili] 加载登录二维码失败:', error)
      setLoading(false)
      setStatus('expired')
    }
  }

  useEffect(() => {
    mountedRef.current = true
    void fetchQRCode()
    return () => {
      mountedRef.current = false
      generationRef.current += 1
      clearPolling()
    }
  }, [])

  const getStatusText = () => {
    switch (status) {
      case 'pending':
        return '请使用哔哩哔哩 APP 扫描二维码'
      case 'scanned':
        return '扫描成功，请在手机上确认登录'
      case 'success':
        return '登录成功！'
      case 'expired':
        return '二维码已过期，请刷新'
      default:
        return ''
    }
  }

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-8"
        data-tv-scope
        onClick={onClose}
      >
        <motion.div
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.9, opacity: 0 }}
          onClick={(e) => e.stopPropagation()}
          className="bg-black/90 backdrop-blur-xl rounded-3xl shadow-2xl w-full max-w-md p-8 border border-white/10"
        >
          {/* 头部 */}
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg" style={{ backgroundColor: BILI_PINK }}>
                <svg className="w-6 h-6 text-white" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M17.813 4.653h.854c1.51.054 2.769.578 3.773 1.574 1.004.995 1.524 2.249 1.56 3.76v7.36c-.036 1.51-.556 2.765-1.56 3.761-1.004.996-2.263 1.52-3.773 1.574h-.854c-1.51-.054-2.769-.578-3.773-1.574-.996-.996-1.51-2.251-1.542-3.76v-1.804h-4.996v1.804c-.032 1.509-.546 2.764-1.542 3.76-1.004.996-2.263 1.52-3.773 1.574h-.854C1.75 20.554.491 20.03-.513 19.034c-1.004-.996-1.524-2.251-1.56-3.76v-7.36c.036-1.511.556-2.765 1.56-3.761C.49 2.157 1.75 1.633 3.26 1.58h.854c1.51.054 2.769.578 3.773 1.574.996.996 1.51 2.251 1.542 3.76v1.804h4.996V6.914c.032-1.509.546-2.764 1.542-3.76 1.004-.996 2.263-1.52 3.773-1.574z" />
                </svg>
              </div>
              <h2 className="text-2xl font-bold text-white">哔哩哔哩登录</h2>
            </div>
            <button
              onClick={onClose}
              className="p-2 hover:bg-white/10 rounded-full transition-colors"
            >
              <X className="w-6 h-6 text-white/60" />
            </button>
          </div>

          {/* 二维码区域 */}
          <div className="flex flex-col items-center gap-6">
            {loading ? (
              <div className="w-64 h-64 bg-white/5 rounded-2xl flex items-center justify-center">
                <Loader2 className="w-12 h-12 text-white/40 animate-spin" />
              </div>
            ) : status === 'expired' ? (
              <div className="w-64 h-64 bg-white/5 rounded-2xl flex flex-col items-center justify-center gap-4">
                <div className="text-white/60 text-center">二维码已过期</div>
                <button
                  onClick={fetchQRCode}
                  className="px-6 py-2 bg-white text-black rounded-xl font-medium hover:bg-white/90 transition-colors"
                >
                  刷新二维码
                </button>
              </div>
            ) : status === 'success' ? (
              <div className="w-64 h-64 rounded-2xl flex flex-col items-center justify-center gap-4" style={{ backgroundColor: 'rgba(251,114,153,0.15)' }}>
                <svg className="w-16 h-16 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7"></path>
                </svg>
                <div className="text-white text-center">登录成功！</div>
              </div>
            ) : (
              <div className="w-64 h-64 bg-white p-4 rounded-2xl flex items-center justify-center">
                {qrUrl ? (
                  <QRCodeSVG value={qrUrl} size={224} level="M" includeMargin={false} />
                ) : (
                  <Loader2 className="w-10 h-10 text-black/30 animate-spin" />
                )}
              </div>
            )}

            {/* 状态提示 */}
            <div className="text-center">
              <p className="text-white/80 mb-2">{getStatusText()}</p>
              {status === 'pending' && (
                <p className="text-white/40 text-sm">
                  打开哔哩哔哩手机 APP，扫描二维码登录（登录后解锁 1080P 高画质）
                </p>
              )}
              {status === 'success' && (
                <p className="text-white/40 text-sm">登录成功，正在为你寻找 MV…</p>
              )}
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}
