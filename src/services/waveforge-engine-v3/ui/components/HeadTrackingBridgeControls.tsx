import { useEffect, useState } from 'react'
import type { HSETheme } from '../hse-theme'
import { ActionBtn } from './Primitives'

export function HeadTrackingBridgeControls({ theme, onBridgeUrl }: { theme: HSETheme; onBridgeUrl: (url: string) => void }) {
  const api = window.electron?.hseHeadTracking
  const [running, setRunning] = useState(false)
  const [pending, setPending] = useState(true)
  const [message, setMessage] = useState('正在读取本机 OSC 桥状态…')
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!api) return
    let alive = true
    void api.getBridgeState().then(state => {
      if (!alive) return
      setRunning(state.running)
      setFailed(Boolean(state.error))
      setMessage(state.error || (state.running ? `OSC 桥运行中 · UDP ${state.udpPort} → ${state.wsUrl}` : '本机 OSC 桥未启动'))
    }).catch(() => { if (alive) { setFailed(true); setMessage('无法读取 OSC 桥状态，请重试。') } })
      .finally(() => { if (alive) setPending(false) })
    return () => { alive = false }
  }, [api])

  if (!api) return null

  const changeRunning = async () => {
    if (pending) return
    setPending(true)
    try {
      const state = await (running ? api.stopBridge() : api.startBridge())
      setRunning(state.running)
      setFailed(Boolean(state.error))
      setMessage(state.error || (state.running ? `OSC 桥运行中 · UDP ${state.udpPort} → ${state.wsUrl}` : '本机 OSC 桥已停止'))
      if (state.running && !state.error) onBridgeUrl(state.wsUrl)
    } catch (error) {
      setFailed(true)
      setMessage(error instanceof Error ? error.message : 'OSC 桥操作失败，请重试。')
    } finally { setPending(false) }
  }

  return <section aria-label="本机 OSC 桥" className="mt-3 rounded-xl border p-3" style={{ borderColor: theme.cardBorder, background: theme.inputBg }}>
    <p className={`mb-2 text-xs font-medium ${theme.textPrimary}`}>本机 OSC 姿态桥</p>
    <ActionBtn theme={theme} ghost disabled={pending} onClick={() => void changeRunning()}>{pending ? '正在处理 OSC 桥…' : running ? '停止本机 OSC 桥' : '启动本机 OSC 桥'}</ActionBtn>
    <p role="status" className={`mt-2 break-words text-xs ${theme.textSecondary}`} style={failed ? { color: '#a6362a' } : undefined}>{message}</p>
    <p className={`mt-2 text-xs leading-relaxed ${theme.textSecondary}`}>启动后启用头部追踪，再点击连接姿态桥接入。仅监听本机，停止姿态输入后可在此关闭 OSC 桥。</p>
  </section>
}
