/**
 * 播放设备控制弹窗：音频输出设备 + AirPlay 投送（简约模式底栏入口）。
 * 风格与设置弹窗统一：暗色毛玻璃 + motion 动效。
 */
import { useState, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, RefreshCw, Speaker, Loader2 } from 'lucide-react'
import type { AirplayStatus } from '../electron'
import { airplayController } from '../services/airplayController'
import {
  listAudioOutputDevices,
  refreshAudioOutputDevices as refreshDevicesService,
  applyOutputDevice,
  getStoredOutputDevice,
  getActiveAudioContext,
  getCachedAudioOutputDevices,
  type AudioOutputDevice,
  type StoredOutputDevice,
} from '../services/audioOutput'

interface PlaybackDeviceModalProps {
  show: boolean
  onClose: () => void
  playerTheme?: 'light' | 'dark'
}

export default function PlaybackDeviceModal({ show, onClose, playerTheme = 'dark' }: PlaybackDeviceModalProps) {
  const dark = playerTheme !== 'light'
  const textPrimary = dark ? 'text-white' : 'text-black/85'
  const textSecondary = dark ? 'text-white/55' : 'text-black/55'
  const textTertiary = dark ? 'text-white/35' : 'text-black/40'
  const bgCard = dark ? 'bg-white/[0.06]' : 'bg-black/[0.05]'
  const borderColor = dark ? 'border-white/10' : 'border-black/10'
  const accentColor = '#8B5CF6'

  // ── AirPlay 状态 ──
  const [airplayStatus, setAirplayStatus] = useState<AirplayStatus | null>(null)
  const [airplayEnabled, setAirplayEnabledState] = useState(() => airplayController.getEnabled())
  const [airplayMode, setAirplayModeState] = useState<'auto' | 'raop' | 'airplay2'>(() => airplayController.getMode())
  const [airplayVolume, setAirplayVolumeState] = useState(() => airplayController.getVolume())
  const [airplaySyncVolume, setAirplaySyncVolume] = useState(() => airplayController.getSyncVolume())
  const [airplayRestoreVolume, setAirplayRestoreVolume] = useState(() => airplayController.getRestoreVolume())
  const [airplayConnectSound, setAirplayConnectSound] = useState(() => airplayController.getConnectSound())
  // 正在连接的设备（用于按钮转圈动画）
  const [connectingDeviceId, setConnectingDeviceId] = useState<string | null>(null)

  useEffect(() => {
    if (!show) return
    airplayController.init()
    return airplayController.subscribe((status) => {
      setAirplayStatus(status)
      // 连接结果确定后清除转圈
      if (status.phase === 'connected' || status.phase === 'streaming' || status.phase === 'error') {
        setConnectingDeviceId(null)
      }
    })
  }, [show])

  const handleAirplayEnabledToggle = async (enabled: boolean) => {
    setAirplayEnabledState(enabled)
    await airplayController.setEnabled(enabled)
  }

  const handleAirplayConnect = async (deviceId: string) => {
    setConnectingDeviceId(deviceId)
    const result = await airplayController.connect(deviceId, airplayMode)
    if (!result?.success) {
      setConnectingDeviceId(null)
      window.dispatchEvent(new CustomEvent('showToast', {
        detail: { message: result?.error === 'device_unavailable' ? 'AirPlay 设备当前不可用' : `AirPlay 连接失败：${result?.error || '未知错误'}`, type: 'error' },
      }))
    }
  }

  const handleAirplayDisconnect = async () => {
    await airplayController.disconnect()
  }

  const handleAirplayModeChange = (mode: 'auto' | 'raop' | 'airplay2') => {
    setAirplayModeState(mode)
    try { localStorage.setItem('airplayMode', JSON.stringify(mode)) } catch { /* 忽略 */ }
  }

  // ── 音频输出设备状态 ──
  // 启动时已后台预载一次，这里直接显示缓存（不闪不重新入场）
  const [audioOutputDevices, setAudioOutputDevices] = useState<AudioOutputDevice[]>(() => getCachedAudioOutputDevices())
  const [audioOutputSupported, setAudioOutputSupported] = useState(false)
  const [audioOutputBusy, setAudioOutputBusy] = useState(false)
  const [audioOutputStored, setAudioOutputStored] = useState<StoredOutputDevice | null>(() => getStoredOutputDevice())

  // AirPlay 也视为一种音频输出：连接成功后自动加入上方输出列表（位于跟随系统默认之下）
  // 并自动选中，切换统一从输出列表进行；但切换本机设备不会自动断开 AirPlay，
  // 断开只发生在用户按「断开」或关闭软件时。
  const airplayActive = !!airplayStatus
    && (airplayStatus.phase === 'connected' || airplayStatus.phase === 'streaming')
    && !!airplayStatus.connectedDeviceId
  const airplayEntry: AudioOutputDevice | null = airplayActive && airplayStatus?.connectedDeviceId
    ? {
        deviceId: `airplay:${airplayStatus.connectedDeviceId}`,
        label: airplayStatus.devices.find(d => d.id === airplayStatus.connectedDeviceId)?.name || 'AirPlay 设备',
        groupId: '',
        isDefault: false,
      }
    : null
  // AirPlay 条目紧跟「跟随系统默认」按钮，避免排到末尾用户看不见
  const displayDevices = airplayEntry ? [airplayEntry, ...audioOutputDevices] : audioOutputDevices

  const refreshAudioOutputDevices = useCallback(async () => {
    setAudioOutputBusy(true)
    try {
      const next = await refreshDevicesService()
      setAudioOutputSupported(true)
      // 合并：保持已有顺序，按 deviceId 刷新已存在项的数据（默认标记跟随刷新），
      // 新增设备追加（触发进入动画），已消失的移除；完全无变化时保持原列表
      setAudioOutputDevices(prev => {
        const prevList = prev || []
        const nextIds = new Set(next.map(d => d.deviceId))
        const prevIds = new Set(prevList.map(d => d.deviceId))
        const added = next.some(d => !prevIds.has(d.deviceId))
        const removed = prevList.some(d => !nextIds.has(d.deviceId))
        if (!added && !removed) return prevList
        const merged = prevList
          .map(old => next.find(d => d.deviceId === old.deviceId) || null)
          .filter((d): d is AudioOutputDevice => d !== null)
        for (const device of next) {
          if (!prevIds.has(device.deviceId)) merged.push(device)
        }
        return merged
      })
    } catch {
      // 扫描失败：保留当前显示列表
    } finally {
      setAudioOutputBusy(false)
    }
  }, [])

  useEffect(() => {
    if (!show) return
    let active = true
    // 打开弹窗：直接显示缓存；后台扫一次——有新增自动加入（带动画），无变化保持
    void listAudioOutputDevices().then(devices => { if (active) setAudioOutputDevices(devices) }).catch(() => undefined)
    void refreshAudioOutputDevices()
    return () => { active = false }
  }, [show, refreshAudioOutputDevices])

  const handleAudioOutputSelect = async (device: AudioOutputDevice) => {
    // AirPlay 条目：仅连接期间存在，作为当前输出展示；已选中无需再操作
    if (device.deviceId.startsWith('airplay:')) return
    // 切换本机输出设备不会自动断开 AirPlay（断开只由「断开」按钮/关闭软件触发）；
    // 投送期间的选择先记住，断开 AirPlay 后生效。
    const context = getActiveAudioContext()
    const result = await applyOutputDevice(context, { deviceId: device.deviceId, label: device.label })
    setAudioOutputStored(getStoredOutputDevice())
    if (result.success) {
      const message = airplayActive
        ? `已选择「${device.label}」，断开 AirPlay 后生效`
        : (result as { pending?: boolean }).pending
          ? `已选择「${device.label}」，播放时自动应用`
          : `音频输出已切换到：${device.label}`
      window.dispatchEvent(new CustomEvent('showToast', {
        detail: { message, type: 'success' },
      }))
    } else {
      window.dispatchEvent(new CustomEvent('showToast', {
        detail: { message: result.error === 'setSinkId-unsupported' ? '当前环境不支持切换输出设备' : `切换输出设备失败：${result.error || '未知错误'}`, type: 'error' },
      }))
    }
  }

  const handleAudioOutputDefault = async () => {
    // 同上：不自动断开 AirPlay，选择先记住，断开后生效
    const context = getActiveAudioContext()
    const result = await applyOutputDevice(context, null)
    setAudioOutputStored(getStoredOutputDevice())
    if (result.success) {
      window.dispatchEvent(new CustomEvent('showToast', {
        detail: { message: airplayActive ? '已恢复跟随系统默认，断开 AirPlay 后生效' : '已恢复跟随系统默认输出', type: 'success' },
      }))
    }
  }

  const toggle = (checked: boolean, onChange: (v: boolean) => void) => (
    <label className="relative inline-flex items-center cursor-pointer shrink-0">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="sr-only peer" />
      <div className={`w-11 h-6 ${dark ? 'bg-white/20' : 'bg-black/20'} rounded-full peer peer-checked:after:translate-x-full after:bg-white after:shadow-[0_1px_3px_rgba(0,0,0,0.35)] after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:rounded-full after:h-5 after:w-5 after:transition-all`} style={{ backgroundColor: checked ? accentColor : '' }} />
    </label>
  )

  const followingDefault = !audioOutputStored

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center p-6"
          onClick={onClose}
        >
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
          <motion.div
            initial={{ scale: 0.92, opacity: 0, y: 12 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.92, opacity: 0, y: 12 }}
            transition={{ type: 'spring', stiffness: 300, damping: 28 }}
            onClick={(e) => e.stopPropagation()}
            className={`relative w-full max-w-lg rounded-3xl shadow-2xl border ${dark ? 'bg-[#14161d]/95 border-white/10' : 'bg-white/95 border-black/10'}`}
            style={{ backdropFilter: 'blur(24px)', WebkitBackdropFilter: 'blur(24px)' }}
          >
            {/* 头部 */}
            <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b" style={{ borderColor: dark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.08)' }}>
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-xl" style={{ backgroundColor: `${accentColor}22` }}>
                  <Speaker className="w-5 h-5" style={{ color: accentColor }} />
                </div>
                <div>
                  <h2 className={`text-lg font-bold ${textPrimary}`}>播放设备控制</h2>
                  <p className={`text-xs ${textTertiary}`}>音频输出设备 · AirPlay 投送</p>
                </div>
              </div>
              <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-full transition-colors">
                <X className="w-5 h-5" style={{ color: dark ? 'rgba(255,255,255,.6)' : 'rgba(0,0,0,.6)' }} />
              </button>
            </div>

            <div className="px-6 py-5 space-y-6 max-h-[70vh] overflow-y-auto">
              {/* ── 音频输出设备 ── */}
              <section>
                <div className="flex items-center justify-between mb-3">
                  <h3 className={`text-sm font-semibold ${textPrimary}`}>音频输出设备</h3>
                  <button type="button" onClick={() => void refreshAudioOutputDevices()} className={`text-xs ${textSecondary} hover:opacity-80 flex items-center gap-1.5`} title="刷新设备列表">
                    <RefreshCw className={`w-3 h-3 ${audioOutputBusy ? 'animate-spin' : ''}`} />
                    刷新
                  </button>
                </div>

                {!audioOutputSupported ? (
                  <p className={`text-xs leading-5 ${textTertiary}`}>当前环境不支持枚举输出设备（仅桌面端支持），音频将跟随系统默认输出。</p>
                ) : displayDevices.length === 0 ? (
                  <p className={`text-xs leading-5 ${textTertiary}`}>未检测到音频输出设备，音频将跟随系统默认输出。</p>
                ) : (
                  <div className="space-y-1.5 pr-1">
                    <button
                      type="button"
                      onClick={() => void handleAudioOutputDefault()}
                      className="w-full flex items-center justify-between gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors"
                      style={{
                        borderColor: !airplayActive && followingDefault ? `${accentColor}99` : borderColor === 'border-white/10' ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.1)',
                        background: !airplayActive && followingDefault ? `${accentColor}12` : 'transparent',
                      }}
                    >
                      <div className="min-w-0">
                        <div className={`${textPrimary} text-sm font-medium`}>跟随系统默认</div>
                        <div className={`${textTertiary} text-xs mt-0.5`}>勾选仅显示当前系统默认设备，刷新后自动跟随</div>
                      </div>
                    </button>
                    <AnimatePresence initial={false}>
                      {displayDevices.map((device) => {
                        const isAirplay = device.deviceId.startsWith('airplay:')
                        // 跟随默认：默认设备行只显示右侧「使用中」勾（不高亮整行）；
                        // 选中具体设备：该行高亮 + 勾；AirPlay 投送中：AirPlay 行高亮 + 勾
                        const isStoredDevice = !isAirplay && audioOutputStored?.deviceId === device.deviceId
                        const isDefaultDisplay = !isAirplay && followingDefault && device.isDefault
                        const highlight = isAirplay ? airplayActive : isStoredDevice && !airplayActive
                        const showCheck = isAirplay ? airplayActive : (isStoredDevice || isDefaultDisplay) && !airplayActive
                        return (
                          <motion.button
                            key={device.deviceId}
                            layout
                            initial={{ opacity: 0, y: -8 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: -8 }}
                            transition={{ type: 'spring', stiffness: 320, damping: 28 }}
                            type="button"
                            onClick={() => void handleAudioOutputSelect(device)}
                            className="w-full flex items-center justify-between gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors"
                            style={{
                              borderColor: highlight ? `${accentColor}99` : borderColor === 'border-white/10' ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.1)',
                              background: highlight ? `${accentColor}12` : 'transparent',
                            }}
                          >
                            <div className="min-w-0">
                              <div className={`${textPrimary} text-sm font-medium break-words leading-snug`}>{device.label}</div>
                              <div className={`${textTertiary} text-xs mt-0.5`}>
                                {isAirplay
                                  ? 'AirPlay 投送'
                                  : device.isDefault
                                    ? '系统默认设备'
                                    : '外接设备'}
                              </div>
                            </div>
                            {isAirplay && (
                              <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium" style={{ backgroundColor: `${accentColor}22`, color: accentColor }}>AirPlay</span>
                            )}
                            {showCheck && <span className="shrink-0 text-xs" style={{ color: accentColor }}>使用中</span>}
                          </motion.button>
                        )
                      })}
                    </AnimatePresence>
                  </div>
                )}
              </section>

              {/* ── AirPlay 投送 ── */}
              <section>
                <div className="flex items-center justify-between gap-6 mb-3">
                  <div>
                    <h3 className={`text-sm font-semibold ${textPrimary}`}>AirPlay 投送</h3>
                    <p className={`text-xs ${textSecondary} mt-0.5`}>将当前播放的音频投送到局域网 AirPlay 音箱 / 电视</p>
                  </div>
                  {toggle(airplayEnabled, (v) => void handleAirplayEnabledToggle(v))}
                </div>

                <div className="mb-4">
                  <div className={`${textPrimary} text-xs font-medium mb-2`}>连接协议</div>
                  <div className="grid grid-cols-3 gap-3">
                    {([
                      ['auto', '自动', 'RAOP 优先，兼容 AirPlay2'],
                      ['raop', 'RAOP', 'AirPlay 1（兼容性最好）'],
                      ['airplay2', 'AirPlay2', 'Apple TV / HomePod'],
                    ] as const).map(([value, label, hint]) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => handleAirplayModeChange(value)}
                        className="rounded-xl border px-2 py-2 text-xs transition-colors"
                        style={{
                          color: airplayMode === value ? accentColor : dark ? 'rgba(255,255,255,.45)' : 'rgba(0,0,0,.45)',
                          borderColor: airplayMode === value ? `${accentColor}99` : dark ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.1)',
                          background: airplayMode === value ? `${accentColor}18` : 'transparent',
                        }}
                        title={hint}
                      >{label}</button>
                    ))}
                  </div>
                </div>

                {airplayEnabled && (
                  <div className={`rounded-xl border ${borderColor} ${bgCard} p-3`}>
                    <div className="flex items-center justify-between mb-2">
                      <span className={`${textPrimary} text-xs font-medium`}>
                        可用设备
                        <span className={`${textTertiary} text-[11px] ml-1.5`}>
                          {airplayStatus?.phase === 'browsing' ? '正在发现…' : airplayStatus?.devices.length ? `${airplayStatus.devices.length} 台` : '未发现设备'}
                        </span>
                      </span>
                      {(airplayStatus?.connectedMode === 'airplay2' || airplayStatus?.connectedMode === 'raop') && (
                        <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium" style={{ backgroundColor: `${accentColor}22`, color: accentColor }}>
                          {airplayStatus.connectedMode === 'airplay2' ? 'AirPlay 2' : 'RAOP'}
                        </span>
                      )}
                    </div>
                    {airplayStatus?.phase === 'error' && (
                      <p className={`text-[11px] mb-2 ${dark ? 'text-red-400' : 'text-red-600'}`}>{airplayStatus.message || '连接出错'}</p>
                    )}
                    {(!airplayStatus?.devices || airplayStatus.devices.length === 0) ? (
                      <p className={`${textTertiary} text-[11px] leading-4 mb-2`}>未发现 AirPlay 设备，请确认音箱与电脑同一局域网并已开启接收。</p>
                    ) : (
                      <div className="space-y-1.5 pr-1">
                        {airplayStatus.devices.map((device) => {
                          const isConnected = airplayStatus.connectedDeviceId === device.id
                          const isConnecting = connectingDeviceId === device.id
                          return (
                            <div key={device.id} className="flex items-center justify-between gap-2 rounded-lg border px-2.5 py-2"
                              style={{
                                borderColor: isConnected ? `${accentColor}99` : dark ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.1)',
                                background: isConnected ? `${accentColor}12` : 'transparent',
                              }}
                            >
                              <div className="min-w-0">
                                <div className={`${textPrimary} text-xs font-medium truncate`}>{device.name}</div>
                                <div className={`${textTertiary} text-[10px] flex items-center gap-1.5 mt-0.5`}>
                                  <span className="truncate">{device.host}</span>
                                  {device.hasRaop && <span className="shrink-0 rounded px-1 text-[9px]" style={{ backgroundColor: `${accentColor}22`, color: accentColor }}>RAOP</span>}
                                  {device.hasAirplay2 && <span className="shrink-0 rounded px-1 text-[9px]" style={{ backgroundColor: `${accentColor}22`, color: accentColor }}>AirPlay2</span>}
                                </div>
                              </div>
                              {isConnected ? (
                                <button
                                  type="button"
                                  onClick={() => void handleAirplayDisconnect()}
                                  className="shrink-0 rounded-lg px-2.5 py-1 text-[11px] transition-colors"
                                  style={{
                                    color: dark ? 'rgba(255,255,255,.8)' : 'rgba(0,0,0,.8)',
                                    border: `1px solid ${dark ? 'rgba(255,255,255,.25)' : 'rgba(0,0,0,.2)'}`,
                                    background: `${accentColor}22`,
                                  }}
                                >断开</button>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => void handleAirplayConnect(device.id)}
                                  disabled={isConnecting}
                                  className="shrink-0 rounded-lg px-2.5 py-1 text-[11px] transition-colors disabled:opacity-70 flex items-center gap-1"
                                  style={{
                                    color: accentColor,
                                    border: `1px solid ${`${accentColor}99`}`,
                                    background: 'transparent',
                                  }}
                                >
                                  {isConnecting && <Loader2 className="w-3 h-3 animate-spin" />}
                                  {isConnecting ? '连接中' : '连接'}
                                </button>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}

                    <div className="mt-3 pt-3 border-t" style={{ borderColor: dark ? 'rgba(255,255,255,.1)' : 'rgba(0,0,0,.1)' }}>
                      <div className="flex items-center justify-between mb-1.5">
                        <span className={`${textPrimary} text-xs font-medium`}>投送音量</span>
                        <span className={`${textTertiary} text-[11px] tabular-nums`}>{airplayVolume}%</span>
                      </div>
                      <input
                        type="range" min="0" max="100" step="1" value={airplayVolume}
                        onChange={(e) => {
                          const next = Number(e.target.value)
                          setAirplayVolumeState(next)
                          void airplayController.setVolume(next)
                        }}
                        className="w-full" style={{ accentColor }}
                      />
                      <div className="flex items-center justify-between mt-2.5">
                        <span className={`${textPrimary} text-xs font-medium`}>跟随播放器音量</span>
                        {toggle(airplaySyncVolume, (v) => { setAirplaySyncVolume(v); airplayController.setSyncVolume(v) })}
                      </div>
                      <div className="flex items-center justify-between mt-2.5">
                        <span className={`${textPrimary} text-xs font-medium`}>连接提示音</span>
                        {toggle(airplayConnectSound, (v) => { setAirplayConnectSound(v); airplayController.setConnectSound(v) })}
                      </div>
                      <div className="mt-3 pt-3 border-t" style={{ borderColor: dark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.08)' }}>
                        <div className="flex items-center justify-between mb-1.5">
                          <span className={`${textPrimary} text-xs font-medium`}>断开后设备音量</span>
                          <span className={`${textTertiary} text-[11px] tabular-nums`}>{airplayRestoreVolume}%</span>
                        </div>
                        <input
                          type="range" min="0" max="100" step="1" value={airplayRestoreVolume}
                          onChange={(e) => {
                            const next = Number(e.target.value)
                            setAirplayRestoreVolume(next)
                            void airplayController.setRestoreVolume(next)
                          }}
                          className="w-full" style={{ accentColor }}
                        />
                        <p className={`${textTertiary} text-[10px] mt-1 leading-4`}>断开连接 / 退出软件后，音箱音量自动恢复到此值</p>
                      </div>
                    </div>
                  </div>
                )}
              </section>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
