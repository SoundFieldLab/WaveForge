import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { QRCodeSVG } from 'qrcode.react'
import { X, Link2, Unplug, Loader2, MonitorSmartphone, ChevronDown, Check, Wifi, Copy, Plus, Smartphone } from 'lucide-react'
import type { RemoteSettings, RemoteStatus } from '../electron'
import { isAndroid } from '../platform'

interface RemoteControlModalProps {
  onClose: () => void
  playerTheme: 'dark' | 'light'
}

export default function RemoteControlModal({ onClose, playerTheme }: RemoteControlModalProps) {
  const dark = playerTheme === 'dark'
  const [status, setStatus] = useState<RemoteStatus>({ running: false, port: 25567, token: '', clientCount: 0, maxClients: 5, clients: [], ips: [] })
  const [settings, setSettings] = useState<RemoteSettings>({ theme: 'dark', topRightAction: 'song', gestures: { doubleTap: true, swipe: true, twoFinger: true, twoFingerTap: true } })
  const [starting, setStarting] = useState(true)
  const [error, setError] = useState('')
  const [selectedIp, setSelectedIp] = useState('')
  const [ipOpen, setIpOpen] = useState(false)
  const [showConnect, setShowConnect] = useState(true)
  const ipDropdownRef = useRef<HTMLDivElement>(null)
  const prevClientCountRef = useRef(0)

  const [accentColor, setAccentColor] = useState(() => localStorage.getItem('accentColor') || '#3B82F6')

  useEffect(() => {
    const handleAccent = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail) setAccentColor(detail)
    }
    window.addEventListener('accentColorChanged', handleAccent)
    return () => window.removeEventListener('accentColorChanged', handleAccent)
  }, [])

  const connectUrl = useMemo(() => {
    if (!status.running || !status.token) return ''
    const ip = selectedIp || status.ips[0]?.address || '127.0.0.1'
    return `http://${ip}:${status.port}/?t=${status.token}`
  }, [status, selectedIp])

  const selectedIpLabel = useMemo(() => {
    const info = status.ips.find(ip => ip.address === selectedIp)
    return info ? `${info.name} · ${info.address}` : (selectedIp || '')
  }, [status.ips, selectedIp])

  const connected = status.clientCount > 0
  const canConnectMore = status.clientCount < status.maxClients

  const start = useCallback(async () => {
    setStarting(true)
    setError('')
    try {
      const bridge = window.electron?.remote
      if (bridge) {
        // 桌面：Electron 遥控服务
        const [st, stg] = await Promise.all([bridge.start(25566), bridge.getSettings()])
        setStatus(st || { running: false, port: 25567, token: '', clientCount: 0, maxClients: 5, clients: [], ips: [] })
        setSettings(stg)
        if (st && !st.running && st.error) setError(st.error)
      } else {
        // TV / 浏览器调试：设备内置 Node 已自动启动遥控服务（复用 PC 端同一套 remote-server），
        // 读取状态（含 token / 端口 / 网卡 IP），用于生成手机连接二维码
        const res = await fetch('http://localhost:3001/api/tv/remote-status', { cache: 'no-store' })
        if (res.ok) {
          const st = await res.json()
          setStatus(st || { running: false, port: 25567, token: '', clientCount: 0, maxClients: 5, clients: [], ips: [] })
          if (st && !st.running) setError('遥控器服务未就绪')
        } else {
          setError('遥控器服务未就绪（当前环境未启动）')
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '启动失败')
    } finally {
      setStarting(false)
    }
  }, [])

  const stop = useCallback(async () => {
    if (isAndroid()) {
      // TV：遥控服务随应用常驻（token 配对防护），无需手动停止
      setError('TV 端遥控服务随应用常驻运行，无需停止')
      return
    }
    const bridge = window.electron?.remote
    if (!bridge) return
    const st = await bridge.stop()
    setStatus(st || { running: false, port: 25567, token: '', clientCount: 0, maxClients: 5, clients: [], ips: [] })
    setShowConnect(true)
  }, [])

  useEffect(() => {
    void start()
    const bridge = window.electron?.remote
    if (!bridge) {
      // TV/浏览器调试：无 Electron 事件，轮询状态（客户端增减 / 端口 / IP 变化）
      const timer = window.setInterval(() => {
        void fetch('http://localhost:3001/api/tv/remote-status', { cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : null))
          .then((st) => {
            if (st) {
              setStatus((prev) => ({ ...prev, ...st }))
              // 有设备新连入时自动收起「连接新设备」区块（与 Electron 路径行为一致）
              if ((st.clientCount || 0) > prevClientCountRef.current) setShowConnect(false)
              prevClientCountRef.current = st.clientCount || 0
            }
          })
          .catch(() => {})
      }, 3000)
      return () => window.clearInterval(timer)
    }
    // 关闭弹窗不停服务：遥控持续到软件关闭或手动断开
    const offClients = bridge?.onClientsChange((st) => {
      setStatus(prev => ({ ...prev, ...st }))
      // 有设备新连入时自动收起「连接新设备」区块，露出设备列表与「连接多台」按钮
      if (st && (st.clientCount || 0) > prevClientCountRef.current) setShowConnect(false)
      prevClientCountRef.current = st ? st.clientCount || 0 : 0
    })
    return () => { offClients?.() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 多网卡：默认选第一个局域网 IPv4
  useEffect(() => {
    if (!selectedIp && status.ips.length > 0) setSelectedIp(status.ips[0].address)
  }, [status.ips, selectedIp])

  // 点击下拉框外部时关闭
  useEffect(() => {
    if (!ipOpen) return
    const onDown = (e: MouseEvent) => {
      if (ipDropdownRef.current && !ipDropdownRef.current.contains(e.target as Node)) setIpOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [ipOpen])

  const copyUrl = async () => {
    if (!connectUrl) return
    try {
      await navigator.clipboard.writeText(connectUrl)
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '连接地址已复制到剪贴板', type: 'info' } }))
    } catch {
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: connectUrl, type: 'info' } }))
    }
  }

  const textPrimary = dark ? 'text-white' : 'text-black'
  const textSecondary = dark ? 'text-white/60' : 'text-black/60'
  const panelBg = dark ? 'rgba(14,17,24,0.84)' : 'rgba(255,255,255,0.88)'

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      data-tv-scope
      className="fixed inset-0 z-[80] flex items-center justify-center p-4"
      style={{ backgroundColor: dark ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.25)', backdropFilter: 'blur(8px)' }}
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.9, opacity: 0, y: 12 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.9, opacity: 0, y: 12 }}
        transition={{ type: 'spring', damping: 26, stiffness: 320 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm max-h-[88vh] overflow-y-auto rounded-3xl shadow-2xl"
        style={{ background: panelBg, border: `1px solid ${dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)'}`, backdropFilter: 'blur(30px)' }}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between px-5 py-4" style={{ borderBottom: `1px solid ${dark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)'}` }}>
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ backgroundColor: `${accentColor}26`, color: accentColor }}>
              <MonitorSmartphone className="w-4.5 h-4.5" />
            </div>
            <div>
              <h2 className={`text-base font-semibold ${textPrimary}`}>远程遥控器</h2>
              <div className={`${textSecondary} text-[11px] -mt-0.5`}>已连接 {status.clientCount}/{status.maxClients} 台</div>
            </div>
          </div>
          <button type="button" onClick={onClose} className={`p-2 rounded-full transition-colors ${dark ? 'hover:bg-white/15' : 'hover:bg-black/10'}`}>
            <X className={`w-5 h-5 ${textSecondary}`} />
          </button>
        </div>

        <div className="p-6 flex flex-col items-center">
          {starting ? (
            <div className="py-16 flex flex-col items-center gap-3">
              <Loader2 className="w-6 h-6 animate-spin" style={{ color: accentColor }} />
              <span className={`${textSecondary} text-sm`}>正在启动遥控器服务…</span>
            </div>
          ) : error ? (
            <div className="py-12 text-center">
              <p className="text-red-400 text-sm mb-4">{error}</p>
              <button type="button" onClick={() => void start()} className="px-4 py-2 rounded-xl text-sm text-white" style={{ backgroundColor: accentColor }}>
                重试
              </button>
            </div>
          ) : (
            <div className="w-full flex flex-col gap-4">
              {/* 已连接设备列表 */}
              {connected && (
                <div className="w-full">
                  <div className={`${textSecondary} text-[11px] mb-2`}>已连接设备</div>
                  <div className="space-y-1.5">
                    {status.clients.map((c, i) => (
                      <div
                        key={i}
                        className="flex items-center gap-2.5 rounded-xl px-3 py-2.5"
                        style={{ background: dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)', border: `1px solid ${dark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)'}` }}
                      >
                        <Smartphone className="w-4 h-4 shrink-0" style={{ color: accentColor }} />
                        <span className={`flex-1 min-w-0 text-sm ${textPrimary} truncate`}>{c.name}</span>
                        <span className={`text-xs ${textSecondary} tabular-nums`}>{c.ip}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 连接新设备：二维码 + 复制链接 */}
              {canConnectMore && showConnect && (
                <div className="w-full flex flex-col items-center gap-4 pt-1">
                  <div className="rounded-2xl p-3" style={{ background: '#fff' }}>
                    {connectUrl && <QRCodeSVG value={connectUrl} size={180} bgColor="#ffffff" fgColor="#0b0d12" level="M" />}
                  </div>

                  {/* 多网卡 IP 选择（自定义美化下拉） */}
                  {status.ips.length > 0 && (
                    <div className="relative w-full" ref={ipDropdownRef}>
                      <label className={`${textSecondary} text-[11px] mb-1 block`}>本机局域网地址（多网卡可切换）</label>
                      <button
                        type="button"
                        onClick={() => setIpOpen(v => !v)}
                        className={`w-full flex items-center justify-between gap-2 rounded-xl px-3 py-2.5 text-sm text-left outline-none transition-all ${textPrimary}`}
                        style={{
                          background: dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
                          border: `1px solid ${ipOpen ? accentColor : dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.1)'}`,
                          boxShadow: ipOpen ? `0 0 0 3px ${accentColor}26` : undefined,
                        }}
                      >
                        <span className="flex items-center gap-2 min-w-0">
                          <Wifi className="w-4 h-4 shrink-0" style={{ color: accentColor }} />
                          <span className="truncate">{selectedIpLabel}</span>
                        </span>
                        <ChevronDown className={`w-4 h-4 shrink-0 transition-transform ${textSecondary} ${ipOpen ? 'rotate-180' : ''}`} />
                      </button>

                      <AnimatePresence>
                        {ipOpen && (
                          <motion.div
                            initial={{ opacity: 0, y: -6, scale: 0.98 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            exit={{ opacity: 0, y: -6, scale: 0.98 }}
                            transition={{ duration: 0.14 }}
                            className="absolute left-0 right-0 z-20 mt-1.5 rounded-xl overflow-hidden shadow-2xl"
                            style={{ background: dark ? 'rgba(24,28,38,0.98)' : 'rgba(255,255,255,0.98)', border: `1px solid ${dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.1)'}` }}
                          >
                            {status.ips.map((ip) => {
                              const active = ip.address === selectedIp
                              return (
                                <button
                                  key={ip.address}
                                  type="button"
                                  onClick={() => { setSelectedIp(ip.address); setIpOpen(false) }}
                                  className="w-full flex items-center justify-between gap-2 px-3 py-2.5 text-sm text-left transition-colors"
                                  style={{ background: active ? `${accentColor}1f` : 'transparent' }}
                                  onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)' }}
                                  onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent' }}
                                >
                                  <span className="min-w-0">
                                    <span className={`block truncate ${active ? 'font-medium' : textPrimary}`} style={active ? { color: accentColor } : undefined}>{ip.address}</span>
                                    <span className={`block text-[11px] truncate ${textSecondary}`}>{ip.name}</span>
                                  </span>
                                  {active && <Check className="w-4 h-4 shrink-0" style={{ color: accentColor }} />}
                                </button>
                              )
                            })}
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  )}

                  {/* 浏览器连接地址（点击复制） */}
                  <div className="w-full">
                    <div className={`${textSecondary} text-[11px] mb-1`}>通过浏览器连接（点击复制）</div>
                    <button
                      type="button"
                      onClick={() => void copyUrl()}
                      className="w-full flex items-center gap-2 rounded-xl px-3 py-2.5 text-sm break-all select-all text-left transition-colors"
                      style={{ background: dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)', border: `1px solid ${dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.1)'}`, color: accentColor }}
                    >
                      <span className="flex-1 min-w-0">{connectUrl || '准备中…'}</span>
                      <Copy className="w-4 h-4 shrink-0" style={{ color: accentColor }} />
                    </button>
                  </div>

                  <p className={`${textSecondary} text-xs text-center leading-relaxed`}>
                    手机需与电脑连接同一 Wi‑Fi / 局域网；首次运行 Windows 可能弹出防火墙授权，请允许。
                  </p>
                </div>
              )}

              {/* 底部操作 */}
              {connected && (
                <div className="flex flex-col gap-2">
                  {canConnectMore && !showConnect && (
                    <button
                      type="button"
                      onClick={() => setShowConnect(true)}
                      className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium text-white transition-all active:scale-[0.98]"
                      style={{ backgroundColor: accentColor, boxShadow: `0 0 14px ${accentColor}44` }}
                    >
                      <Plus className="w-4 h-4" /> 连接多台（{status.clientCount}/{status.maxClients}）
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void stop()}
                    className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium text-white transition-all active:scale-[0.98]"
                    style={{ backgroundColor: '#ef4444' }}
                  >
                    <Unplug className="w-4 h-4" /> 断开全部连接
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>
  )
}
