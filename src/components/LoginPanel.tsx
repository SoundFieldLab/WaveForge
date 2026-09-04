import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Music, Loader2 } from 'lucide-react'
import { useTvBack } from '../tv/tvCore'

interface LoginPanelProps {
  platform: 'netease' | 'qq'
  onClose: () => void
  onLoginSuccess: (cookie: string) => void
}

export default function LoginPanel({ platform, onClose, onLoginSuccess }: LoginPanelProps) {
  // TV 遥控器 BACK 关闭登录面板
  useTvBack(() => {
    onClose()
    return true
  })
  const [qrCode, setQrCode] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState<'pending' | 'scanned' | 'success' | 'expired'>('pending')
  // 🔧 修复内存泄漏：改用 ref 而非 state
  const pollTimerRef = useRef<number | null>(null)
  const requestControllerRef = useRef<AbortController | null>(null)
  const pollControllerRef = useRef<AbortController | null>(null)
  const generationRef = useRef(0)
  const mountedRef = useRef(false)

  const platformName = platform === 'netease' ? '?????' : 'QQ??'
  const platformColor = platform === 'netease' ? 'bg-red-600' : 'bg-green-600'

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
        const endpoint = platform === 'netease'
          ? `/api/netease/login/qr/check?key=${key}`
          : `/api/qq/login/qr/check?key=${key}`
        const res = await fetch(`http://localhost:3001${endpoint}`, { signal: controller.signal })
        const data = await res.json()
        if (!isCurrent(generation)) return

        if (platform === 'netease') {
          if (data.code === 800) {
            setStatus('expired')
            finished = true
          } else if (data.code === 802) {
            setStatus('scanned')
          } else if (data.code === 803) {
            setStatus('success')
            finished = true
            if (data.cookie) onLoginSuccess(data.cookie)
            else console.error('login succeeded without cookie')
          }
        } else if (data.code === 0) {
          setStatus('success')
          finished = true
          onLoginSuccess(data.cookie)
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

  const fetchQRCode = async () => {
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
      const qrRes = await fetch(`http://localhost:3001/api/netease/login/qr/create?key=${key}`, { signal: controller.signal })
      const qrData = await qrRes.json()
      if (!isCurrent(generation)) return

      if (!qrData.data?.qrimg) throw new Error('invalid QR response')
      setQrCode(qrData.data.qrimg)
      setLoading(false)
      startPolling(key, generation)
    } catch (error) {
      if (controller.signal.aborted || !isCurrent(generation)) return
      console.error('failed to load login QR code:', error)
      setLoading(false)
      setStatus('expired')
    } finally {
      if (requestControllerRef.current === controller) requestControllerRef.current = null
    }
  }

  useEffect(() => {
    mountedRef.current = true
    if (platform === 'netease') void fetchQRCode()
    else setLoading(false)
    return () => {
      mountedRef.current = false
      generationRef.current += 1
      clearPolling()
      requestControllerRef.current?.abort()
      requestControllerRef.current = null
    }
  }, [platform])

  const getStatusText = () => {
    switch (status) {
      case 'pending':
        return '请使用手机APP扫描二维码'
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
              <div className={`${platformColor} p-2 rounded-lg`}>
                <Music className="w-6 h-6 text-white" />
              </div>
              <h2 className="text-2xl font-bold text-white">{platformName}登录</h2>
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
              <div className="w-64 h-64 bg-green-600/20 rounded-2xl flex flex-col items-center justify-center gap-4">
                <svg className="w-16 h-16 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7"></path>
                </svg>
                <div className="text-white text-center">登录成功！</div>
              </div>
            ) : (
              <div className="w-64 h-64 bg-white p-4 rounded-2xl">
                <img src={qrCode} alt="登录二维码" className="w-full h-full" />
              </div>
            )}

            {/* 状态提示 */}
            <div className="text-center">
              <p className="text-white/80 mb-2">{getStatusText()}</p>
              {status === 'pending' && (
                <p className="text-white/40 text-sm">
                  打开{platformName}手机APP，扫描二维码登录
                </p>
              )}
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}
