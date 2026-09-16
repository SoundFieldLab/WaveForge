/**
 * DG-LAB 最小化调试平台主界面。
 *
 * 布局上的一个关键事实：真实控制台（DGLabConsoleModal）是
 * `fixed inset-0 z-[95]` 的全屏模态——它就是主程序里点开的那个弹窗，
 * 内联嵌进某个格子没有意义（fixed 会脱离文档流盖住整页）。
 *
 * 所以这里采用：
 *   · 真实控制台按原样全屏弹出（UI 与主程序 100% 一致，可原样验收）
 *   · 调试信息放进一个更高层级（z-[200]）的浮动 HUD，可拖动 / 折叠 / 换页
 * → 既能看真实 UI，又能同时盯住「设备到底收到了什么」。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity, ChevronDown, GripVertical, Loader2, Music, Pause, Play, Radio,
  RotateCw, Terminal, Usb, Zap,
} from 'lucide-react'

// ── 主仓库真实组件与数据层（同一份代码，不是副本）──
// 挂载的是主程序的 PluginOverlay 本体，而不是逐个组件「摆」进来：
// 插件启用 → 生命周期回调（dglabClient.activate）→ 连接中继 → 启动映射引擎，
// 这条链路由 PluginOverlay 的 useRuntimeBridge 驱动。单独渲染 DGLabConsoleModal
// 只会画出 UI，插件永远不会激活（引擎不跑、没有波形下发）。
import PluginOverlay from '@/components/PluginOverlay'
import { openDGLabConsole, usePluginHostState } from '@/services/pluginStore'
import { loadDGLabSettings } from '@/plugins/clients/DGLabClient'
import { useDebugAudioEngine } from './useDebugAudioEngine'
import DeviceMonitor from './DeviceMonitor'
import RelayActivity from './RelayActivity'

const API = 'http://127.0.0.1:3101'

export interface Track {
  id: string
  name: string
  file: string
  ext: string
  size: number
  dir: string
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

type HudTab = 'music' | 'device' | 'relay'

export default function Harness() {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const engine = useDebugAudioEngine(audioRef)
  const host = usePluginHostState()

  const [tracks, setTracks] = useState<Track[]>([])
  const [trackId, setTrackId] = useState<string | null>(null)
  const [musicError, setMusicError] = useState<string | null>(null)
  const [volume, setVolume] = useState(0.8)
  const [pluginReady, setPluginReady] = useState(false)
  const [bootError, setBootError] = useState<string | null>(null)
  const [deviceBusy, setDeviceBusy] = useState(false)

  /* ------------------------------ HUD 状态 ------------------------------ */

  const [tab, setTab] = useState<HudTab>('music')
  const [collapsed, setCollapsed] = useState(false)
  const [pos, setPos] = useState({ x: 16, y: 72 })
  const dragRef = useRef<{ dx: number; dy: number } | null>(null)

  const onDragStart = (e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onDragMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return
    setPos({
      x: Math.max(0, Math.min(e.clientX - dragRef.current.dx, window.innerWidth - 120)),
      y: Math.max(0, Math.min(e.clientY - dragRef.current.dy, window.innerHeight - 60)),
    })
  }
  const onDragEnd = () => { dragRef.current = null }

  /* ------------------------------ 插件启用 ------------------------------ */

  // 注意：插件启用状态与须知门控在 main.tsx 里、React 挂载**之前**就已写入
  // （见那里的注释：在 effect 里启用会被 StrictMode 双挂载的启停竞态抵消）。
  // 这里只负责打开控制台并记录就绪状态。
  useEffect(() => {
    try {
      openDGLabConsole()
      setPluginReady(true)
    } catch (error) {
      setBootError(`控制台初始化失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }, [])

  /* ------------------------------ 曲目 ------------------------------ */

  const loadTracks = useCallback(async () => {
    setMusicError(null)
    try {
      const res = await fetch(`${API}/api/debug/music`, { signal: AbortSignal.timeout(4000) })
      const json = await res.json()
      const list: Track[] = Array.isArray(json?.tracks) ? json.tracks : []
      setTracks(list)
      if (!list.length) setMusicError('音乐目录下没找到音频文件（可用 DGLAB_DEBUG_MUSIC_DIR 指定）')
      setTrackId(prev => (prev && list.some(t => t.id === prev) ? prev : list[0]?.id ?? null))
    } catch (error) {
      setMusicError(`读取曲目失败（调试后端是否已启动？）：${error instanceof Error ? error.message : String(error)}`)
    }
  }, [])

  useEffect(() => { void loadTracks() }, [loadTracks])

  const current = useMemo(() => tracks.find(t => t.id === trackId) ?? null, [tracks, trackId])
  const trackUrl = current ? `${API}/api/debug/music/${encodeURIComponent(current.id)}` : undefined

  // 切歌：换 src；原本在播就继续播，保持调试节奏
  useEffect(() => {
    const el = audioRef.current
    if (!el || !trackUrl) return
    const wasPlaying = !el.paused
    el.src = trackUrl
    el.load()
    if (wasPlaying) void engine.play()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackUrl])

  useEffect(() => { engine.setVolume(volume) }, [volume, engine])

  /* ------------------------------ 中继控制 ------------------------------ */

  // 重启中继：真机连接会被掐断，需要在手机 App 上重新扫码。
  const restartRelay = useCallback(async () => {
    setDeviceBusy(true)
    try {
      const settings = loadDGLabSettings()
      await fetch(`${API}/api/dglab/control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'restart', settings: { ...settings, port: 31082 } }),
      })
    } finally { setDeviceBusy(false) }
  }, [])

  /* ------------------------------ 渲染 ------------------------------ */

  if (bootError) {
    return (
      <div className="fixed inset-0 flex items-center justify-center p-8">
        <div className="max-w-lg rounded-xl border border-red-500/40 bg-red-500/10 p-5 text-sm text-red-200">
          <div className="font-bold mb-2">调试平台启动失败</div>
          <p>{bootError}</p>
        </div>
      </div>
    )
  }

  return (
    <>
      {/* 背景页：控制台关闭时可见的操作台 */}
      <div className="min-h-screen p-6">
        <div className="max-w-3xl mx-auto pt-10 space-y-4">
          <div className="flex items-center gap-2">
            <Zap className="w-5 h-5 text-amber-300" />
            <h1 className="text-lg font-black text-amber-200">DG-LAB 最小化调试平台</h1>
          </div>
          <p className="text-[12px] text-white/50 leading-relaxed">
            端口与主程序错开（前端 3100 · API 3101 · 中继 31082），可与 WaveForge 同时运行。
            控制台、悬浮小组件、整机监听浮标都是主仓库 <code className="text-amber-200/80">src/</code> 里的真实组件，
            在这里改动会直接同步到主程序。
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              onClick={() => openDGLabConsole()}
              className="px-3 py-1.5 rounded-lg bg-amber-300 text-black text-xs font-bold hover:bg-amber-200 transition-colors"
            >
              打开 DG-LAB 控制台
            </button>
            <span className={`flex items-center gap-1.5 text-[11px] px-2.5 py-1.5 rounded-lg border ${pluginReady
              ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300'
              : 'border-white/15 text-white/50'}`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${pluginReady ? 'bg-emerald-400' : 'bg-white/40'}`} />
              {pluginReady ? '插件已启用' : '初始化中'}
            </span>
            <span className="text-[11px] px-2.5 py-1.5 rounded-lg border border-white/12 text-white/45">
              控制台状态：{host.dglabConsoleOpen ? '已打开' : '已关闭'}
            </span>
          </div>
        </div>
      </div>

      {/* 浮动调试 HUD：z-[200] 高于控制台的 z-[95]，控制台全屏时依然可见 */}
      <div
        className="fixed z-[200] rounded-xl border shadow-2xl overflow-hidden"
        style={{
          left: pos.x,
          top: pos.y,
          width: collapsed ? 260 : 380,
          background: 'linear-gradient(160deg, rgba(10,10,13,0.97), rgba(20,17,8,0.97))',
          borderColor: 'rgba(245,200,76,0.28)',
          backdropFilter: 'blur(16px)',
        }}
      >
        {/* 标题栏（可拖动） */}
        <div
          className="flex items-center gap-1.5 px-2 py-1.5 cursor-grab active:cursor-grabbing select-none border-b border-white/[0.07]"
          style={{ touchAction: 'none' }}
          onPointerDown={onDragStart}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
        >
          <GripVertical className="w-3 h-3 text-white/30" />
          <Activity className="w-3.5 h-3.5 text-amber-300" />
          <span className="text-[11px] font-bold text-amber-100">调试 HUD</span>
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => openDGLabConsole()}
              className="px-1.5 py-0.5 rounded text-[10px] text-amber-200/80 hover:bg-white/10 transition-colors"
              title="打开真实控制台"
            >
              控制台
            </button>
            <button
              type="button"
              onClick={() => setCollapsed(c => !c)}
              className="p-0.5 rounded text-white/50 hover:bg-white/10 hover:text-white transition-colors"
              title={collapsed ? '展开' : '折叠'}
            >
              <ChevronDown className={`w-3.5 h-3.5 transition-transform ${collapsed ? '-rotate-90' : ''}`} />
            </button>
          </div>
        </div>

        {!collapsed && (
          <>
            {/* 分页 */}
            <div className="flex items-center gap-1 px-2 pt-1.5">
              {([
                { id: 'music' as const, label: '音乐', icon: Music },
                { id: 'device' as const, label: '设备', icon: Usb },
                { id: 'relay' as const, label: '中继', icon: Terminal },
              ]).map(item => {
                const Icon = item.icon
                const active = tab === item.id
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setTab(item.id)}
                    className={`flex items-center gap-1 px-2 py-1 rounded-md text-[11px] border transition-colors ${active
                      ? 'border-amber-300/40 bg-amber-300/10 text-amber-200'
                      : 'border-transparent text-white/55 hover:bg-white/[0.07]'}`}
                  >
                    <Icon className="w-3 h-3" />{item.label}
                  </button>
                )
              })}
            </div>

            <div className="p-2 max-h-[72vh] overflow-y-auto plugin-center-scroll">
              {tab === 'music' && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-white/40 flex-1 truncate" title={current?.file}>
                      {current ? current.name : '未找到曲目'}
                    </span>
                    <button
                      type="button"
                      onClick={() => void loadTracks()}
                      className="p-1 rounded hover:bg-white/10 text-white/45 hover:text-white/80 transition-colors"
                      title="重新扫描音乐目录"
                    >
                      <RotateCw className="w-3 h-3" />
                    </button>
                  </div>

                  {musicError && <p className="text-[10px] text-amber-300/80 leading-relaxed">{musicError}</p>}

                  <div className="space-y-1 max-h-40 overflow-y-auto plugin-center-scroll">
                    {tracks.map(track => {
                      const active = track.id === trackId
                      return (
                        <button
                          key={track.id}
                          type="button"
                          onClick={() => setTrackId(track.id)}
                          className={`w-full text-left px-2 py-1.5 rounded-lg border transition-colors ${active
                            ? 'border-amber-300/40 bg-amber-300/10'
                            : 'border-transparent hover:bg-white/[0.06]'}`}
                        >
                          <div className={`text-[11px] font-medium truncate ${active ? 'text-amber-200' : 'text-white/80'}`} title={track.file}>
                            {track.name}
                          </div>
                          <div className="text-[10px] text-white/35">
                            {track.ext.replace('.', '').toUpperCase()} · {(track.size / 1024 / 1024).toFixed(1)}MB
                          </div>
                        </button>
                      )
                    })}
                  </div>

                  <div className="flex items-center gap-2 pt-1 border-t border-white/[0.07]">
                    <button
                      type="button"
                      onClick={() => (engine.state.playing ? engine.pause() : void engine.play())}
                      disabled={!current}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-300 text-black text-[11px] font-bold hover:bg-amber-200 disabled:opacity-40 transition-colors"
                    >
                      {engine.state.playing ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
                      {engine.state.playing ? '暂停' : '播放'}
                    </button>
                    <span className="text-[10px] text-white/50 tabular-nums">
                      {formatTime(engine.state.currentTime)} / {formatTime(engine.state.duration)}
                    </span>
                    <span className={`ml-auto text-[10px] ${engine.analyzerEnabled ? 'text-emerald-300' : 'text-white/35'}`}>
                      {engine.state.ready ? (engine.analyzerEnabled ? '分析流运行中' : '分析流已停') : '音频图未建立'}
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    <button type="button" onClick={() => engine.seek(engine.state.currentTime - 10)}
                      className="px-2 py-1 rounded border border-white/15 text-[10px] text-white/70 hover:bg-white/10 transition-colors">−10s</button>
                    <button type="button" onClick={() => engine.seek(engine.state.currentTime + 10)}
                      className="px-2 py-1 rounded border border-white/15 text-[10px] text-white/70 hover:bg-white/10 transition-colors">+10s</button>
                    <input
                      type="range" min={0} max={100} value={Math.round(volume * 100)}
                      onChange={e => setVolume(Number(e.target.value) / 100)}
                      className="flex-1 accent-amber-300"
                      title="音量（分析点在音量之前，不影响送给插件的信号）"
                    />
                  </div>

                  {engine.state.error && <p className="text-[10px] text-red-300/90">{engine.state.error}</p>}
                  {!engine.nodes && (
                    <p className="text-[10px] text-white/35 leading-relaxed">
                      首次点「播放」建立音频图（需用户手势解锁 AudioContext）。
                    </p>
                  )}

                  <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-white/[0.07]">
                    <button type="button" onClick={() => void restartRelay()} disabled={deviceBusy}
                      className="px-2.5 py-1 rounded-md border border-white/15 text-[10px] text-white/70 hover:bg-white/10 disabled:opacity-40 transition-colors"
                      title="重启中继（端口 31082）。真机连接会被断开，需要重新扫码。">
                      <span className="inline-flex items-center gap-1">
                        {deviceBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Radio className="w-3 h-3" />}重启中继
                      </span>
                    </button>
                    <span className="text-[10px] text-white/35 leading-relaxed">
                      真机连接：在「控制台」里用手机 App 扫二维码
                    </span>
                  </div>
                </div>
              )}

              {tab === 'device' && <DeviceMonitor api={API} />}
              {tab === 'relay' && <RelayActivity api={API} />}
            </div>
          </>
        )}
      </div>

      {/* 主程序真实插件宿主：控制台 / 悬浮小组件 / 整机监听浮标 +
          启用状态 → 生命周期桥接（这条桥才会真正 activate 插件） */}
      <PluginOverlay />

      {/* 调试平台自有音源 */}
      <audio ref={audioRef} crossOrigin="anonymous" preload="metadata" className="hidden" />
    </>
  )
}
