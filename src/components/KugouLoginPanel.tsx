import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Music, Copy, Check, QrCode, Loader2, RefreshCw, Globe } from 'lucide-react'
import { useTvBack } from '../tv/tvCore'
import LoginBackdrop from './LoginBackdrop'
import { getApiBase } from '../services/apiConfig'
import { saveKugouConceptCredential } from '../services/kugouService'

interface KugouLoginPanelProps {
  onClose: () => void
  onLoginSuccess: (cookie: string, username?: string) => void
}

type LoginMode = 'qr' | 'web'

interface QrSession {
  key: string
  image: string
  device: Record<string, string>
}

/**
 * 酷狗音乐登录：
 * - 扫码登录（推荐，概念版通道）：应用内直接出示二维码，用酷狗 App 扫码；扫码得到的凭据走概念版接口
 *   （Folia 同款通道，支持歌单/喜欢/播放直链——概念版还有每日领取 VIP 的官方活动）
 * - 网页登录（兜底，不方便扫码的用户）：Electron 弹窗打开酷狗官网抓 KuGoo cookie
 * - 手动粘贴 Cookie（最终兜底）
 */
export default function KugouLoginPanel({ onClose, onLoginSuccess }: KugouLoginPanelProps) {
  useTvBack(() => {
    onClose()
    return true
  })
  const [mode, setMode] = useState<LoginMode>('qr')
  const [qr, setQr] = useState<QrSession | null>(null)
  const [qrStatus, setQrStatus] = useState<0 | 1 | 2 | 4>(1)
  const [qrError, setQrError] = useState('')
  const [qrLoading, setQrLoading] = useState(false)
  const [cookie, setCookie] = useState('')
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const copiedTimerRef = useRef<number | null>(null)
  const mountedRef = useRef(false)
  const qrRef = useRef<QrSession | null>(null)
  const pollTimerRef = useRef<number | null>(null)

  const hasNativeLogin = Boolean((window as any).electron?.openKugouLoginWindow)
  const API_BASE = getApiBase()

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current)
      copiedTimerRef.current = null
      if (pollTimerRef.current !== null) window.clearTimeout(pollTimerRef.current)
      pollTimerRef.current = null
    }
  }, [])

  const stopPolling = () => {
    if (pollTimerRef.current !== null) {
      window.clearTimeout(pollTimerRef.current)
      pollTimerRef.current = null
    }
  }

  const startQrLogin = async () => {
    if (qrLoading) return
    stopPolling()
    setQrLoading(true)
    setQrError('')
    setQrStatus(1)
    try {
      const resp = await fetch(`${API_BASE}/kugou/qr/create`, { method: 'POST' })
      const json = await resp.json()
      if (!mountedRef.current) return
      if (!json?.success || !json.key || !json.image) {
        setQrError(json?.error || '二维码生成失败，请重试')
        return
      }
      const session: QrSession = { key: String(json.key), image: String(json.image), device: json.device || {} }
      qrRef.current = session
      setQr(session)
      schedulePoll()
    } catch (e) {
      if (mountedRef.current) setQrError('二维码生成失败，请检查本地服务后重试')
    } finally {
      if (mountedRef.current) setQrLoading(false)
    }
  }

  const schedulePoll = () => {
    stopPolling()
    pollTimerRef.current = window.setTimeout(() => { void pollQr() }, 2000)
  }

  const pollQr = async () => {
    const session = qrRef.current
    if (!session || !mountedRef.current) return
    try {
      const resp = await fetch(`${API_BASE}/kugou/qr/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: session.key, device: session.device }),
      })
      const json = await resp.json()
      if (!mountedRef.current) return
      if (!json?.success) { setQrError(json?.error || '扫码状态查询失败'); return }
      const status = Number(json.status)
      if (status === 4 && json.token && json.userid) {
        // 概念版凭据落盘：{ token, userid, 设备身份... }
        const credential = {
          token: String(json.token),
          userid: String(json.userid),
          dfid: String(json.dfid || session.device?.dfid || ''),
          mid: String(session.device?.mid || ''),
          guid: String(session.device?.guid || ''),
          dev: String(session.device?.dev || ''),
          mac: String(session.device?.mac || ''),
          webgl: String(session.device?.webgl || ''),
          nickname: json.nickname ? String(json.nickname) : '',
          avatar: json.avatar ? String(json.avatar) : '',
        }
        saveKugouConceptCredential(credential)
        // 合成等价 cookie：既有登录态判定 / 用户 id 解析（KuGoo）与网页兜底通道都能识别
        const enc = (s: string) => encodeURIComponent(s).replace(/%/g, '%25').replace(/%25u/g, '%u')
        const cookieString = [
          `kg_mid=${credential.mid}`,
          `kg_dfid=${credential.dfid}`,
          `KuGoo=KugooID=${credential.userid}&NickName=${enc(credential.nickname || '')}&t=${credential.token}`,
        ].join('; ')
        // 用户资料直接落盘：概念版通道没有网页 getinfo（www 域对服务端请求有 WAF）
        try {
          localStorage.setItem('kugou_user_id', credential.userid)
          if (credential.nickname) localStorage.setItem('kugou_username', credential.nickname)
          if (credential.avatar) localStorage.setItem('kugou_avatar', credential.avatar)
        } catch { /* 忽略存储失败 */ }
        stopPolling()
        onLoginSuccess(cookieString, credential.nickname || undefined)
        return
      }
      if (status === 0) {
        setQrStatus(0)
        return // 等待用户点击刷新，不再轮询
      }
      setQrStatus(status === 2 ? 2 : 1)
      schedulePoll()
    } catch {
      if (mountedRef.current) schedulePoll()
    }
  }

  useEffect(() => {
    if (mode === 'qr' && !qr && !qrLoading) void startQrLogin()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

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

  const copyInstructions = async () => {
    const instructions = `1. 打开 www.kugou.com 并登录
2. 按F12打开开发者工具
3. Console 输入 document.cookie 回车
4. 复制输出内容`
    try {
      await navigator.clipboard.writeText(instructions)
      if (!mountedRef.current) return
      setCopied(true)
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
        className="fixed inset-0 w-full h-full overflow-hidden z-50"
        data-tv-scope
        onClick={onClose}
      >
        {/* 与网易云/QQ 登录弹窗共用同一套动态背景，避免「有的有背景、有的是纯黑底」 */}
        <LoginBackdrop />
        <div className="relative z-10 w-full h-full flex items-center justify-center p-6">
        <motion.div
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.9, opacity: 0 }}
          onClick={(e) => e.stopPropagation()}
          className="relative w-full max-w-md"
          style={{
            background: 'rgba(0, 0, 0, 0.4)',
            backdropFilter: 'blur(40px) saturate(180%)',
            WebkitBackdropFilter: 'blur(40px) saturate(180%)',
            borderRadius: '24px',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            boxShadow: '0 8px 32px 0 rgba(0, 0, 0, 0.37)',
          }}
        >
          {/* 头部 */}
          <div className="flex items-center justify-between p-6 border-b border-white/10">
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

          <div className="p-8">
          {/* 登录方式切换（分段控件） */}
          <div className="flex bg-white/5 rounded-full p-1 mb-6">
            <button
              onClick={() => setMode('qr')}
              className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-full text-sm transition-all ${mode === 'qr' ? 'text-white shadow' : 'text-white/50 hover:text-white/80'}`}
              style={mode === 'qr' ? { backgroundColor: accent } : undefined}
            >
              <QrCode className="w-4 h-4" />
              扫码登录
            </button>
            <button
              onClick={() => {
                setMode('web')
                stopPolling()
              }}
              className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-full text-sm transition-all ${mode === 'web' ? 'text-white shadow' : 'text-white/50 hover:text-white/80'}`}
              style={mode === 'web' ? { backgroundColor: accent } : undefined}
            >
              <Globe className="w-4 h-4" />
              网页登录
            </button>
          </div>

          {mode === 'qr' ? (
            <div className="flex flex-col items-center">
              <h3 className="text-xl font-medium text-white">手机酷狗扫码登录</h3>
              <p className="text-white/50 text-sm mt-1.5">打开酷狗音乐 App，扫一扫下方二维码</p>

              <div className="mt-6 relative w-64 h-64 p-4 bg-white rounded-2xl">
                {qr?.image ? (
                  <img src={qr.image} alt="酷狗登录二维码" className="w-full h-full object-contain rounded-lg" />
                ) : qrError ? (
                  <div className="w-full h-full flex flex-col items-center justify-center gap-2 rounded-lg bg-black/5 text-black/60">
                    <QrCode className="w-8 h-8" />
                    <span className="text-xs">二维码不可用</span>
                  </div>
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <Loader2 className="w-8 h-8 animate-spin text-black/30" />
                  </div>
                )}
                {qrStatus === 0 && (
                  <button
                    onClick={() => void startQrLogin()}
                    className="absolute inset-3 rounded-lg bg-black/75 backdrop-blur-sm flex flex-col items-center justify-center gap-2 text-white text-sm"
                  >
                    <RefreshCw className="w-6 h-6" />
                    已过期，点击刷新
                  </button>
                )}
              </div>

              <div className="mt-5 flex items-center justify-center gap-2 text-sm min-h-5">
                {qrError ? (
                  <span className="text-red-400">{qrError}</span>
                ) : qrStatus === 0 ? (
                  <span className="text-white/50">二维码已过期</span>
                ) : (
                  <>
                    <span className={`w-1.5 h-1.5 rounded-full ${qrStatus === 2 ? 'bg-blue-400' : 'bg-orange-400'} animate-pulse`} />
                    <span className={qrStatus === 2 ? 'text-blue-400' : 'text-white/60'}>
                      {qrStatus === 2 ? '已扫码，请在手机上确认' : '等待扫码…'}
                    </span>
                  </>
                )}
              </div>
            </div>
          ) : (
            <div className="space-y-4 mb-2">
              <div className="flex items-start gap-4">
                <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 text-white font-bold" style={{ backgroundColor: accent }}>
                  1
                </div>
                <div className="flex-1">
                  <h3 className="text-white font-medium mb-2">弹出窗口登录</h3>
                  {hasNativeLogin ? (
                    <button
                      onClick={() => void handleAutoLogin()}
                      disabled={loading}
                      className="flex items-center gap-2 px-4 py-2 text-white rounded-lg transition-colors disabled:opacity-60"
                      style={{ backgroundColor: accent }}
                    >
                      {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Globe className="w-4 h-4" />}
                      {loading ? '正在打开登录窗口…' : '在弹出窗口登录酷狗'}
                    </button>
                  ) : (
                    <p className="text-white/50 text-sm">当前环境无法打开网页窗口，请手动粘贴 Cookie 或改用扫码登录</p>
                  )}
                </div>
              </div>

              <div className="flex items-start gap-4">
                <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 text-white font-bold" style={{ backgroundColor: accent }}>
                  2
                </div>
                <div className="flex-1">
                  <h3 className="text-white font-medium mb-2">手动粘贴 Cookie</h3>
                  <div className="bg-white/5 rounded-lg p-4 space-y-2 text-white/80 text-sm">
                    <p>1. 在手机/电脑浏览器打开 <strong className={accentText}>www.kugou.com</strong> 并登录</p>
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
          )}

          {/* 按钮 */}
          <div className="flex gap-3 mt-6">
            <button
              onClick={onClose}
              className="flex-1 px-6 py-3 bg-white/10 hover:bg-white/20 text-white rounded-xl font-medium transition-colors"
            >
              取消
            </button>
            {mode === 'web' && (
              <button
                onClick={handleManualLogin}
                className="flex-1 px-6 py-3 text-white rounded-xl font-medium transition-colors"
                style={{ backgroundColor: accent }}
              >
                登录
              </button>
            )}
            {mode === 'qr' && (
              <button
                onClick={() => void startQrLogin()}
                disabled={qrLoading}
                className="flex-1 px-6 py-3 text-white rounded-xl font-medium transition-colors inline-flex items-center justify-center gap-2 disabled:opacity-60"
                style={{ backgroundColor: accent }}
              >
                <RefreshCw className="w-4 h-4" />
                {qrLoading ? '刷新中…' : '刷新二维码'}
              </button>
            )}
          </div>
          </div>
        </motion.div>
        </div>
      </motion.div>
    </AnimatePresence>
  )
}
