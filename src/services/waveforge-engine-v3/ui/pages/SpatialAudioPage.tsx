import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Headphones, RotateCcw, Settings2, Check, Move3D, Speaker, DoorOpen, ArrowUpRight, Volume2 } from 'lucide-react'
import { ActionBtn, GlassCard, InfoLine, Segmented, Slider, Toggle } from '../components/Primitives'
import { SpatialSceneEditor, type SpatialScenePoint } from '../components/SpatialSceneEditor'
import { SpatialModeVisual } from '../components/SpatialModeVisual'
import { SpeakerCalibrationPanel } from '../components/SpeakerCalibrationPanel'
import { useStateFeedback } from '../feedback'
import StagePanel from '../components/StagePanel'
import { importSofaFile } from '../sofaImport'
import { readActiveHrtf, saveActiveHrtf } from '../hrtfStore'
import { HeadPoseFilter, type HeadPose } from '../../src/spatial/HeadPose'
import { HeadTrackingInput } from '../headTrackingInput'
import { HeadTrackingBridgeControls } from '../components/HeadTrackingBridgeControls'
import { HEAD_LOCKED_LAYOUTS, SPATIAL_ROOM_OPTIONS } from '../components/spatialConstants'
import { createLayoutSpeakers, headLockedSpeakers } from '../../src/spatial/layouts'
import { createDefaultSpatialSettings, type SpatialSettings } from '../../src/types'
import { computeRelativeDirection } from '../../src/spatial/controller'
import { resolveMusicSourceRoute } from '../../src/spatial/worldRouting'
import type { AudioObject, SpatialMode, VirtualSpeakerCfg } from '../../src/spatial/types'
import { deepMerge, type DeepPartial, type V3ParamsController } from '../hooks'
import type { V3UiBridge } from '../bridge'
import type { HSETheme } from '../hse-theme'
import './spatial-workbench.css'
import type { PlaybackTimeStore } from '../../../../audio/playbackTimeStore'

const WorldPreview = lazy(() => import('../components/SpatialWorldView').then(module => ({ default: module.SpatialWorldView })))
const HOME_LISTENER = { position: { x: 0, y: 1.6, z: 0 }, yaw: 0, pitch: 0, roll: 0 }
const ROUTES = [{ value: 'l', label: '左声道 L' }, { value: 'r', label: '右声道 R' }, { value: 'both', label: '中央 M' }, { value: 'side', label: '差分 S' }] as const
const ROUTE_LABELS = { l: '左声道', r: '右声道', both: '中央信号', side: '侧向差分' } as const
const MODES = [
  { value: 'instant', label: '快速空间化', hint: '让立体声在身前展开', icon: Headphones },
  { value: 'headLocked', label: '扬声器布局', hint: '在耳机方向上固定音箱布局', icon: Speaker },
  { value: 'world', label: '自由声场', hint: '自由摆放声源与听者位置', icon: Move3D },
  { value: 'stage', label: '房间预设', hint: '从现成的空间开始试听', icon: DoorOpen },
] as const

function NumberField({ label, value, onChange, min, max, step = 0.1, theme }: {
  label: string; value: number; onChange: (value: number) => void; min: number; max: number; step?: number; theme: HSETheme
}) {
  const [draft, setDraft] = useState(String(Math.round(value * 100) / 100))
  useEffect(() => setDraft(String(Math.round(value * 100) / 100)), [value])
  return <label className={`block text-xs ${theme.textSecondary}`}>{label}
    <input type="number" aria-label={label} min={min} max={max} step={step} value={draft}
      className={`mt-1.5 min-h-10 w-full rounded-xl border px-3 hse-mono ${theme.textPrimary}`} style={{ background: theme.inputBg, borderColor: theme.cardBorder }}
      onChange={event => {
        setDraft(event.target.value)
        const next = Number(event.target.value)
        if (event.target.value !== '' && Number.isFinite(next) && next >= min && next <= max) onChange(next)
      }} onBlur={() => {
        const next = Number(draft)
        if (draft !== '' && Number.isFinite(next)) onChange(Math.max(min, Math.min(max, next)))
        else setDraft(String(value))
      }} />
  </label>
}

export default function SpatialAudioPage({ bridge, controller, theme, playbackTimeStore, initialView = '3d' }: {
  bridge: V3UiBridge; controller: V3ParamsController; theme: HSETheme
  onOpenEffect?: (key: string) => void; playbackTimeStore?: PlaybackTimeStore
  initialView?: 'top' | 'side' | '3d'
}) {
  const spatial = controller.params.spatial ?? createDefaultSpatialSettings()
  const active = spatial.mode !== 'off'
  const lastMode = useRef<Exclude<SpatialMode, 'off'>>('instant')
  if (active) lastMode.current = spatial.mode as Exclude<SpatialMode, 'off'>
  const mode = active ? spatial.mode : lastMode.current
  const [advanced, setAdvanced] = useState(false)
  const [view, setView] = useState<'top' | 'side' | '3d'>(initialView)
  const [selected, setSelected] = useState<string | null>(null)
  const [followTrack, setFollowTrack] = useState(false)
  const [latency, setLatency] = useState(0)
  const [channels, setChannels] = useState<number | null>(null)
  const [formatValid, setFormatValid] = useState(true)
  const [hrtfName, setHrtfName] = useState(() => bridge.getSpatialHrtfSource?.() ?? 'MIT KEMAR compact')
  const [importing, setImporting] = useState(false)
  const [hrtfMessage, setHrtfMessage] = useState('')
  const hrtfInput = useRef<HTMLInputElement>(null)
  const [tracking, setTracking] = useState(false)
  const [trackingStatus, setTrackingStatus] = useState('未连接姿态输入')
  const poseFilter = useRef(new HeadPoseFilter())
  const trackingInput = useRef<HeadTrackingInput | null>(null)
  const [trackingUrl, setTrackingUrl] = useState('ws://127.0.0.1:8989/pose')
  const [bluetoothService, setBluetoothService] = useState('')
  const [bluetoothCharacteristic, setBluetoothCharacteristic] = useState('')
  const soloBefore = useRef<boolean[] | null>(null)
  const compareRef = useRef<HTMLDivElement>(null)
  useStateFeedback(active, compareRef)
  const hrtfFeedbackRef = useRef<HTMLDivElement>(null)
  useStateFeedback(hrtfName, hrtfFeedbackRef)

  const patch = (partial: DeepPartial<SpatialSettings>) => controller.patch({ spatial: deepMerge(current(), partial) })
  // 事件内从桥读取最新值，连续的移动/转头/数值操作不会互相写回旧快照。
  const current = () => bridge.getParams().spatial ?? createDefaultSpatialSettings()
  useEffect(() => {
    let cancelled = false
    void readActiveHrtf().then(grid => {
      if (grid && !cancelled && bridge.setSpatialHrtf) {
        if (bridge.getSpatialHrtfSource?.() !== grid.source) bridge.setSpatialHrtf(grid)
        setHrtfName(grid.source ?? '用户 HRTF')
      }
    }).catch(() => { if (!cancelled) setHrtfMessage('本地 HRTF 未能恢复，当前使用内置数据。') })
    return () => { cancelled = true }
  }, [bridge])
  useEffect(() => {
    if (!tracking || !bridge.setSpatialHeadPose) return
    let lastAt = 0
    let alive = true
    const forwardPose = (input: HeadPose | null, timestamp: number) => {
      if (!alive) return
      if (!input) { bridge.setSpatialHeadPose?.(null); lastAt = 0; return }
      const pose = poseFilter.current.update(input, timestamp)
      if (pose) { lastAt = performance.now(); bridge.setSpatialHeadPose?.(pose); setTrackingStatus(`已接收 · 朝向 ${pose.yaw.toFixed(0)}°`) }
    }
    trackingInput.current = new HeadTrackingInput({ onPose: forwardPose, onStatus: (status, message) => {
      if (!alive) return
      if (status === 'connected' && lastAt) return
      const labels = { connecting: '正在连接姿态设备', connected: '设备已连接，等待姿态', reconnecting: '连接中断，正在重连',
        stalled: '姿态输入超时', disconnected: '姿态设备已断开', error: '姿态设备连接失败' }
      setTrackingStatus(message ?? labels[status])
    } })
    const receive = (event: Event) => {
      const detail = (event as CustomEvent<HeadPose & { timestamp?: number }>).detail
      if (!detail || typeof detail !== 'object') return
      forwardPose(detail, detail.timestamp ?? performance.now())
    }
    window.addEventListener('hse:head-pose', receive)
    const timer = window.setInterval(() => { if (!lastAt || performance.now() - lastAt > 1500) setTrackingStatus(lastAt ? '姿态输入已中断' : '等待姿态输入') }, 500)
    return () => { alive = false; window.removeEventListener('hse:head-pose', receive); window.clearInterval(timer)
      void trackingInput.current?.disconnect(); trackingInput.current = null; bridge.setSpatialHeadPose?.(null) }
  }, [tracking, bridge])
  useEffect(() => {
    const tick = () => {
      const stats = bridge.getStats()
      setLatency(stats.engineLatencySamples / bridge.getSampleRate() * 1000)
      const observed = (stats as typeof stats & { inputChannels?: number }).inputChannels
      setChannels(observed && observed > 0 ? observed : null)
      setFormatValid(stats.spatialInputFormatValid !== false)
    }
    tick(); const timer = window.setInterval(tick, 300)
    return () => window.clearInterval(timer)
  }, [bridge])
  useEffect(() => {
    if (!followTrack || !playbackTimeStore || !active || mode !== 'world' || !spatial.world.trajectories.length) return
    const timer = window.setInterval(() => {
      const next = playbackTimeStore.getSnapshot().currentTime
      if (Math.abs(current().world.playhead - next) >= 0.04) patch({ world: { playhead: next } })
    }, 50)
    return () => window.clearInterval(timer)
  }, [followTrack, playbackTimeStore, active, mode, spatial.world.trajectories.length])

  const listener = mode === 'world' ? spatial.world.listener : HOME_LISTENER
  const speakers = headLockedSpeakers(spatial.headLocked)
  const headPoints: SpatialScenePoint[] = speakers.map((speaker, index) => {
    const az = speaker.azimuthDeg * Math.PI / 180, el = speaker.elevationDeg * Math.PI / 180
    return { id: `speaker-${index}`, label: `#${index + 1}`, muted: speaker.muted,
      position: { x: Math.sin(az) * Math.cos(el) * speaker.distance, y: 1.6 + Math.sin(el) * speaker.distance,
        z: Math.cos(az) * Math.cos(el) * speaker.distance } }
  })
  const worldSources = spatial.world.sources
  const points: SpatialScenePoint[] = mode === 'world' ? worldSources.map((source, index) => ({
    id: source.id, label: `${ROUTE_LABELS[resolveMusicSourceRoute(source)]} ${index + 1}`, position: source.position, muted: source.gain === 0,
  })) : headPoints
  const selectedPoint = points.find(point => point.id === selected)
  const selectedIndex = points.findIndex(point => point.id === selected)
  const selectedSpeaker = mode === 'headLocked' && selectedIndex >= 0 ? speakers[selectedIndex] : undefined
  const selectedSource = mode === 'world' ? worldSources.find(source => source.id === selected) : undefined
  const setSpeaker = (index: number, update: Partial<VirtualSpeakerCfg>) => {
    const head = current().headLocked
    const list = headLockedSpeakers(head).map((speaker, i) => ({ ...speaker,
      route: speaker.route ?? (Math.abs(speaker.azimuthDeg) < 0.001 ? 'both' as const : speaker.azimuthDeg < 0 ? 'l' as const : 'r' as const),
      ...(i === index ? update : {}) }))
    patch({ headLocked: { layout: 'custom', speakers: list, routes: [] } })
  }
  const setSource = (id: string, update: Partial<AudioObject>) => {
    patch({ world: { sources: current().world.sources.map(source => source.id === id
      ? { ...source, route: resolveMusicSourceRoute(source), ...update } : source) } })
  }
  const movePoint = (id: string, position: SpatialScenePoint['position']) => {
    if (mode === 'world') setSource(id, { position })
    else {
      const index = Number(id.slice(8))
      const relative = computeRelativeDirection(HOME_LISTENER, position)
      setSpeaker(index, { ...relative, distance: Math.max(0.1, relative.distance) })
    }
  }
  const reset = () => { patch(createDefaultSpatialSettings()); setSelected(null); soloBefore.current = null }
  const roomAmount = mode === 'stage' ? spatial.stage.reverbAmount : spatial.instant.roomAmount

  return <div className="hse-spatial-workbench @container">
    <header className="hse-spatial-page-header">
      <div><div className="hse-spatial-eyebrow">HSE / 空间工作台</div>
        <h1 className={theme.textPrimary}>空间音频</h1>
        <p className={theme.textSecondary}>在耳机中试听方向、距离与房间感。</p></div>
      <div className="hse-spatial-master"><span>{active ? '空间音频已启用' : '正在对比原声'}</span>
        <Toggle label="空间音频" checked={active} onChange={enabled => patch({ mode: enabled ? lastMode.current : 'off' })} theme={theme} /></div>
    </header>
    <div className="hse-spatial-mode-grid" role="group" aria-label="空间模式">
      {MODES.map(({ value, label, hint, icon: Icon }) => <button key={value} type="button" aria-pressed={mode === value}
        onClick={() => { lastMode.current = value; patch({ mode: value }); setSelected(null) }} className="hse-spatial-mode hse-glass-choice">
        <Icon size={21} aria-hidden="true" /><span><strong>{label}</strong><small>{hint}</small></span>
        {mode === value && <Check className="hse-spatial-mode-check" size={16} aria-hidden="true" />}
      </button>)}
    </div>
    <div className="hse-spatial-session-strip">
      <span className="hse-spatial-signal-path"><span>{channels ? `${channels} 声道输入` : '等待音频输入'}</span><ArrowUpRight size={14} /><span>{active ? '空间处理' : '原声旁路'}</span><ArrowUpRight size={14} /><span>耳机双声道</span></span>
      <span className="hse-mono">{bridge.getSampleRate() / 1000} kHz · {Number.isFinite(latency) ? latency.toFixed(1) : '—'} ms</span>
      <div ref={compareRef} className="hse-spatial-compare" role="group" aria-label="原声与空间对比">
        <button type="button" aria-pressed={!active} onClick={() => patch({ mode: 'off' })}>A · 原声</button>
        <button type="button" aria-pressed={active} onClick={() => patch({ mode: lastMode.current })}>B · 空间</button>
      </div>
    </div>
    {!formatValid && <p role="alert" className="hse-spatial-alert">音源格式与实际声道数不匹配，当前按普通声道下混。请检查下方的音源设置。</p>}
    <section className={`hse-spatial-main-controls ${mode === 'headLocked' || mode === 'world' ? 'is-editor-mode' : ''}`} aria-label="空间听感">
      <Slider label="空间强度" value={Math.round(spatial.instant.amount * 100)} min={0} max={100} step={1}
        onChange={value => patch({ instant: { amount: value / 100 } })} display={`${Math.round(spatial.instant.amount * 100)}%`} theme={theme} />
      {mode === 'instant' && <Slider label="展开角度" value={spatial.instant.spreadDeg} min={20} max={120} step={1} disabled={spatial.instant.multichannelAuto}
        onChange={value => patch({ instant: { spreadDeg: value } })} display={`${spatial.instant.spreadDeg}°`} theme={theme} />}
      <div><p className={`mb-2 text-xs ${theme.textSecondary}`}>声音风格</p><Segmented label="空间听感" options={[{ value: 'natural', label: '自然外化' }, { value: 'focused', label: '清晰定位' }]}
        value={spatial.renderStyle ?? 'natural'} onChange={renderStyle => patch({ renderStyle })} theme={theme} small /></div>
    </section>
    {mode === 'instant' && <section className="hse-spatial-quick-view" aria-label="立体声空间预览">
      <div><h2>立体声展开</h2><p>拖动 L、R 调整展开角度；也可以选中后用方向键微调。</p></div>
      <SpatialModeVisual spreadDeg={spatial.instant.spreadDeg} amount={spatial.instant.amount} active={active}
        theme={theme} onSpreadChange={spatial.instant.multichannelAuto ? undefined : value => patch({ instant: { spreadDeg: value } })} />
      <p className="hse-spatial-quick-note">{spatial.renderStyle === 'focused' ? '清晰定位侧重方向感。' : '自然外化混合原始声音与空间声音。'}边试听边调整强度。</p>
    </section>}
    <details className="hse-spatial-input-settings"><summary><Volume2 size={16} />音源与声道格式<span>普通音频保持默认即可</span></summary>
      <div className="mt-3 flex items-center justify-between gap-3"><span className={`text-sm ${theme.textPrimary}`}>按多声道布局空间化</span>
        <Toggle theme={theme} label="多声道输入空间化" checked={spatial.instant.multichannelAuto}
          onChange={value => patch({ instant: { multichannelAuto: value, multichannelLayout: 'auto' } })} /></div>
      {spatial.instant.multichannelAuto && <div className="mt-3"><Segmented label="输入声道布局" theme={theme} small
        options={[{ value: 'auto', label: '自动布局' }, { value: 'quad', label: 'Quad' }, { value: '51', label: '5.1' }, { value: '71', label: '7.1' }, { value: '714', label: '7.1.4' }]}
        value={spatial.instant.multichannelLayout} onChange={value => patch({ instant: { multichannelLayout: value } })} /></div>}
      <div className="mt-4"><label className={`block text-xs ${theme.textSecondary}`}>音源格式
        <select aria-label="音源格式" className={`hse-glass-input mt-2 min-h-10 w-full rounded-lg px-3 ${theme.textPrimary}`}
          value={spatial.inputFormat === 'ambix1' ? 'ambix' : spatial.inputFormat ?? 'channels'}
          onChange={event => patch({ inputFormat: event.currentTarget.value as NonNullable<SpatialSettings['inputFormat']> })}>
          <option value="channels">普通音频 · 单声道 / 立体声 / 多声道</option>
          <optgroup label="Ambisonics 文件"><option value="ambix">一阶 AmbiX · 4 声道</option><option value="ambix2">二阶 AmbiX · 9 声道</option><option value="ambix3">三阶 AmbiX · 16 声道</option><option value="fuma">一阶 FuMa · 4 声道</option></optgroup>
          <optgroup label="立体声上混"><option value="stereo51">立体声 → 虚拟 5.1</option><option value="stereo71">立体声 → 虚拟 7.1</option></optgroup>
        </select></label>
        <InfoLine theme={theme}>{spatial.inputFormat?.startsWith('ambix') ? 'AmbiX 文件使用 ACN/SN3D；一、二、三阶分别需要 4、9、16 个声道。'
          : spatial.inputFormat === 'fuma' ? '四声道 FuMa 文件使用 W、X、Y、Z 顺序。'
            : spatial.inputFormat === 'stereo51' || spatial.inputFormat === 'stereo71'
              ? '从立体声派生环绕信号后，在耳机中试听。原文件仍为立体声。'
              : '普通音频使用此项。多声道文件可在上方指定布局。'}</InfoLine>
      </div>
    </details>
    {mode === 'stage' && <GlassCard theme={theme}><StagePanel params={spatial.stage} theme={theme} onChange={stage => patch({ stage })} /></GlassCard>}

    {(mode === 'headLocked' || mode === 'world') && <section className="hse-spatial-editor hse-glass-card" aria-label="声场编辑工作区">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h3 className={`text-sm font-semibold ${theme.textPrimary}`}>{mode === 'world' ? '虚拟声源' : '虚拟扬声器'}</h3>
        <Segmented label="声场观察方式" options={[{ value: 'top', label: '俯视' }, { value: 'side', label: '侧视' }, { value: '3d', label: '3D 预览' }]}
          value={view} onChange={setView} theme={theme} small />
      </div>
      {mode === 'headLocked' && <div className="mb-4"><Segmented label="扬声器布局" options={HEAD_LOCKED_LAYOUTS} value={spatial.headLocked.layout}
        onChange={layout => { soloBefore.current = null; patch({ headLocked: { layout, speakers: layout === 'custom' ? headLockedSpeakers(current().headLocked) : createLayoutSpeakers(layout), routes: [] } }); setSelected(null) }} theme={theme} small />
        {(spatial.headLocked.layout === '514' || spatial.headLocked.layout === '714') && <div className="mt-3 flex items-center gap-3"><span className={`text-xs ${theme.textSecondary}`}>顶置声源</span><Toggle label="启用顶置声源" theme={theme} checked={spatial.headLocked.heightLayer} onChange={heightLayer => { setSelected(null); patch({ headLocked: { heightLayer } }) }} /></div>}
      </div>}
      <p className={`mb-4 text-xs leading-relaxed ${theme.textSecondary}`}>{mode === 'world' ? '声源固定在场景中；改变听者的位置或朝向，会改变听到的方向。' : '音箱布局随头部朝向移动；头部追踪不会旋转这组布局。'}</p>
      <div className="hse-spatial-editor-grid">
        <div className="min-w-0">
          {view === '3d' ? <div className="min-w-0"><Suspense fallback={<p className={theme.textSecondary}>正在准备三维预览…</p>}>
            <WorldPreview sources={points.map((point, index) => ({ id: point.id, position: point.position, gain: mode === 'world' ? worldSources[index].gain : point.muted ? 0 : speakers[index].gain, size: mode === 'world' ? worldSources[index].size : speakers[index].size }))}
              sourceLabels={Object.fromEntries(points.map(point => [point.id, point.label]))}
              sourceRoutes={Object.fromEntries(points.map((point, index) => [point.id, ({ l: 'L', r: 'R', both: 'M', side: 'S' } as const)[mode === 'world' ? resolveMusicSourceRoute(spatial.world.sources[index]) : speakers[index].route ?? (Math.abs(speakers[index].azimuthDeg) < 0.001 ? 'both' : speakers[index].azimuthDeg > 0 ? 'r' : 'l')]]))}
              trajectories={mode === 'world' ? spatial.world.trajectories : undefined} playhead={spatial.world.playhead}
              listener={listener} theme={theme} selectedId={selected} onSelectSource={setSelected}
              onMove={() => {}} onRotate={() => {}} onMoveSource={movePoint} />
          </Suspense></div> : <SpatialSceneEditor points={points} listener={listener} selected={selected} onSelect={setSelected} onMove={movePoint} view={view} theme={theme} />}
          {view === '3d' && <InfoLine theme={theme}>拖动音箱调整位置，拖动空白处旋转视角。数值编辑在声源属性中。</InfoLine>}
          {view === '3d' && <div className="hse-spatial-source-list mt-3 flex flex-wrap gap-2" aria-label="声源列表">{points.map(point => <button type="button" key={point.id} aria-pressed={selected === point.id}
            onClick={() => setSelected(point.id)} className={`hse-glass-button min-h-10 rounded-xl border px-3 text-xs ${theme.textPrimary}`}
            style={{ borderColor: selected === point.id ? theme.accentColor : theme.cardBorder, background: selected === point.id ? theme.accentDim : theme.inputBg }}>
            {selected === point.id && <Check size={12} aria-hidden="true" />}{point.label}{point.muted ? ' · 静音' : ''}</button>)}</div>}
          <div className="mt-3"><ActionBtn theme={theme} ghost disabled={points.length >= 16} onClick={() => {
            if (mode === 'world') {
              const id = `声源-${Date.now().toString(36)}`
              patch({ world: { sources: [...current().world.sources, { id, position: { x: 2, y: 1.6, z: 3 }, gain: 1, size: 0, route: 'r' }] } }); setSelected(id)
            } else {
              const list = headLockedSpeakers(current().headLocked)
              patch({ headLocked: { layout: 'custom', speakers: [...list, { azimuthDeg: 60, elevationDeg: 0, distance: 2, gain: 1, size: 0, route: 'r' }], routes: [] } }); setSelected(`speaker-${list.length}`)
            }
          }}>添加{mode === 'world' ? '声源' : '扬声器'}</ActionBtn></div>
        </div>
        <aside className="hse-spatial-inspector hse-glass-card" aria-label="选中声源属性">
          <h4 className={`text-sm font-semibold ${theme.textPrimary}`}>{selectedPoint ? `${selectedPoint.label} · 属性` : '选择一个声源'}</h4>
          {!selectedPoint && <p className={`mt-3 text-xs leading-relaxed ${theme.textSecondary}`}>选择场景中的音箱或下方声源。这里可以调整位置、音量与输入声道。</p>}
          {selectedPoint && <div className="mt-4 space-y-4">
            <p className={`hse-mono text-xs ${theme.textSecondary}`}>距听者 {Math.hypot(selectedPoint.position.x - listener.position.x, selectedPoint.position.y - listener.position.y, selectedPoint.position.z - listener.position.z).toFixed(2)} m</p>
            {selectedSpeaker && <div className="grid grid-cols-2 gap-3">
              <NumberField label="方位角 °" value={selectedSpeaker.azimuthDeg} min={-180} max={180} theme={theme} onChange={azimuthDeg => setSpeaker(selectedIndex, { azimuthDeg })} />
              <NumberField label="仰角 °" value={selectedSpeaker.elevationDeg} min={-90} max={90} theme={theme} onChange={elevationDeg => setSpeaker(selectedIndex, { elevationDeg })} />
              <NumberField label="距离 m" value={selectedSpeaker.distance} min={0.1} max={100} theme={theme} onChange={distance => setSpeaker(selectedIndex, { distance })} />
            </div>}
            {selectedSource && <div className="grid grid-cols-3 gap-2">{(['x', 'y', 'z'] as const).map(axis => <NumberField key={axis} label={`${({ x: '左右 X', y: '高度 Y', z: '前后 Z' })[axis]} m`} value={selectedSource.position[axis]} min={-100} max={100} theme={theme}
              onChange={value => setSource(selectedSource.id, { position: { ...current().world.sources.find(source => source.id === selectedSource.id)!.position, [axis]: value } })} />)}</div>}
            <Slider label="声源音量" value={selectedSpeaker?.gain ?? selectedSource?.gain ?? 1} min={0} max={2} step={0.01} theme={theme}
              display={`${(selectedSpeaker?.gain ?? selectedSource?.gain ?? 1).toFixed(2)} ×`} onChange={gain => selectedSpeaker ? setSpeaker(selectedIndex, { gain }) : setSource(selected!, { gain })} />
            <div><span className={`text-xs ${theme.textSecondary}`}>使用哪个声道</span><div className="mt-2"><Segmented label="声源输入绑定" options={[...ROUTES]}
              value={selectedSpeaker?.route ?? (selectedSource ? resolveMusicSourceRoute(selectedSource) : selectedSpeaker && Math.abs(selectedSpeaker.azimuthDeg) < 0.001 ? 'both' : selectedSpeaker && selectedSpeaker.azimuthDeg > 0 ? 'r' : 'l')}
              onChange={route => selectedSpeaker ? setSpeaker(selectedIndex, { route }) : setSource(selected!, { route })} theme={theme} small /></div></div>
            {selectedSpeaker && <div className="flex flex-wrap gap-2">
              <ActionBtn theme={theme} ghost onClick={() => setSpeaker(selectedIndex, { muted: !selectedSpeaker.muted })}>{selectedSpeaker.muted ? '取消静音' : '静音'}</ActionBtn>
              <ActionBtn theme={theme} ghost onClick={() => {
                const list = headLockedSpeakers(current().headLocked)
                if (soloBefore.current) { const muted = soloBefore.current; patch({ headLocked: { layout: 'custom', speakers: list.map((speaker, index) => ({ ...speaker, muted: muted[index] ?? false })), routes: [] } }); soloBefore.current = null }
                else { soloBefore.current = list.map(speaker => speaker.muted ?? false); patch({ headLocked: { layout: 'custom', speakers: list.map((speaker, index) => ({ ...speaker, muted: index !== selectedIndex })), routes: [] } }) }
              }}>{soloBefore.current ? '退出独奏' : '独奏'}</ActionBtn>
            </div>}
            <Slider label="声源扩散" value={Math.round((selectedSpeaker?.size ?? selectedSource?.size ?? 0) * 100)} min={0} max={100} step={1} theme={theme}
              display={`${Math.round((selectedSpeaker?.size ?? selectedSource?.size ?? 0) * 100)}%`} onChange={value => selectedSpeaker ? setSpeaker(selectedIndex, { size: value / 100 }) : setSource(selected!, { size: value / 100 })} />
            <div className="flex flex-wrap gap-2"><ActionBtn theme={theme} ghost disabled={points.length >= 16} onClick={() => {
              if (selectedSource) {
                const id = `声源-${Date.now().toString(36)}`
                patch({ world: { sources: [...current().world.sources, { ...selectedSource, id, position: { ...selectedSource.position, x: selectedSource.position.x + 0.5 } }] } }); setSelected(id)
              } else if (selectedSpeaker) {
                const list = headLockedSpeakers(current().headLocked)
                patch({ headLocked: { layout: 'custom', speakers: [...list, { ...selectedSpeaker, azimuthDeg: selectedSpeaker.azimuthDeg + 10 }], routes: [] } }); setSelected(`speaker-${list.length}`)
              }
            }}>复制</ActionBtn><ActionBtn theme={theme} ghost disabled={points.length <= 1} onClick={() => {
              if (mode === 'world') patch({ world: { sources: current().world.sources.filter(source => source.id !== selected), trajectories: current().world.trajectories.filter(item => item.sourceId !== selected) } })
              else patch({ headLocked: { layout: 'custom', speakers: headLockedSpeakers(current().headLocked).filter((_, index) => index !== selectedIndex), routes: [] } })
              setSelected(null); soloBefore.current = null
            }}>删除</ActionBtn></div>
          </div>}
        </aside>
      </div>
      <InfoLine theme={theme}>L、R 分别取左、右声道；M 取左右声道的平均，S 取左右声道的差分。这些声源使用同一首音乐，并非分离出的人声或乐器。</InfoLine>
      {mode === 'world' && <details className="hse-spatial-listener-settings mt-5 border-t pt-4" style={{ borderColor: theme.cardBorder }}>
        <summary className={`mb-3 cursor-pointer text-sm font-semibold ${theme.textPrimary}`}>听者位置、朝向与声源轨迹</summary>
        <div className="grid grid-cols-2 gap-3 @min-[40rem]:grid-cols-4">{(['x', 'y', 'z'] as const).map(axis => <NumberField key={axis} label={`听者 ${axis.toUpperCase()} m`} value={listener.position[axis]} min={-100} max={100} theme={theme}
          onChange={value => patch({ world: { listener: { position: { ...current().world.listener.position, [axis]: value } } } })} />)}
          <NumberField label="听者朝向 °" value={listener.yaw} min={-180} max={180} step={1} theme={theme} onChange={yaw => patch({ world: { listener: { yaw } } })} />
        </div>
        <div className="mt-3 flex flex-wrap gap-2"><ActionBtn theme={theme} ghost onClick={() => patch({ world: { listener: HOME_LISTENER } })}>重置听者</ActionBtn>
          {(['pitch', 'roll'] as const).map(axis => <NumberField key={axis} label={axis === 'pitch' ? '抬头角 °' : '侧倾角 °'} value={listener[axis]} min={-90} max={90} theme={theme} onChange={value => patch({ world: { listener: { [axis]: value } } })} />)}</div>
        <details className="mt-4"><summary className={`cursor-pointer text-xs ${theme.textSecondary}`}>声源轨迹</summary>
          <div className="mt-3"><Slider label="轨迹时刻" value={spatial.world.playhead} min={0} max={Math.max(30, spatial.world.playhead)} step={0.1} theme={theme} display={`${spatial.world.playhead.toFixed(1)} s`} onChange={playhead => patch({ world: { playhead } })} />
            {selectedSource && <div className="flex flex-wrap gap-2"><ActionBtn theme={theme} ghost onClick={() => {
              const now = current().world, existing = now.trajectories.find(item => item.sourceId === selected)
              const keyframes = [...(existing?.keyframes ?? []).filter(frame => frame.t !== now.playhead), { t: now.playhead, position: { ...now.sources.find(source => source.id === selected)!.position } }].sort((a, b) => a.t - b.t)
              patch({ world: { trajectories: [...now.trajectories.filter(item => item.sourceId !== selected), { sourceId: selected!, keyframes }] } })
            }}>记录当前位置</ActionBtn><ActionBtn theme={theme} ghost onClick={() => patch({ world: { trajectories: current().world.trajectories.filter(item => item.sourceId !== selected) } })}>清除该轨迹</ActionBtn></div>}
            {playbackTimeStore && <div className="mt-3 flex items-center gap-3"><span className={`text-xs ${theme.textSecondary}`}>随曲目播放轨迹</span><Toggle label="随曲目播放轨迹" checked={followTrack} onChange={setFollowTrack} theme={theme} /></div>}
          </div>
        </details>
      </details>}
    </section>}

    <GlassCard theme={theme}>
      <h3 className={`mb-4 text-sm font-semibold ${theme.textPrimary}`}>房间与氛围</h3>
      {mode !== 'stage' && <Segmented label="房间预设" options={SPATIAL_ROOM_OPTIONS} value={spatial.instant.room}
        onChange={room => patch({ instant: { room } })} theme={theme} small />}
      <div className="mt-4 grid gap-x-8 @min-[40rem]:grid-cols-2">
        <Slider label="房间混响" value={Math.round(roomAmount * 100)} min={0} max={100} step={1} display={`${Math.round(roomAmount * 100)}%`} theme={theme}
          onChange={value => mode === 'stage' ? patch({ stage: { reverbAmount: value / 100 } }) : patch({ instant: { roomAmount: value / 100 } })} />
        <Slider label="环境扩散" value={spatial.ambience.enabled ? Math.round(spatial.ambience.amount * 100) : 0} min={0} max={100} step={1} theme={theme}
          onChange={value => patch({ ambience: { enabled: value > 0, amount: value / 100 } })} display={`${spatial.ambience.enabled ? Math.round(spatial.ambience.amount * 100) : 0}%`} />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2"><ActionBtn theme={theme} ghost onClick={reset}><RotateCcw size={14} />重置空间设置</ActionBtn>
      <button type="button" aria-controls="hse-spatial-advanced" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)} className={`hse-glass-button flex min-h-10 items-center gap-2 rounded-xl px-3 text-xs ${theme.textSecondary}`}><Settings2 size={14} />{advanced ? '收起设备与高级设置' : '设备与高级设置'}</button></div>
      {advanced && <div id="hse-spatial-advanced" className="hse-spatial-advanced mt-5 space-y-4">
        {(spatial.inputFormat?.startsWith('ambix') || spatial.inputFormat === 'fuma') && <div className="rounded-2xl border p-4" style={{ borderColor: theme.cardBorder }}>
          <h4 className={`mb-3 text-sm font-medium ${theme.textPrimary}`}>Ambisonics 声场旋转与缩放</h4>
          <div className="grid grid-cols-3 gap-3">{(['yawDeg', 'pitchDeg', 'rollDeg'] as const).map((key, index) =>
            <NumberField key={key} label={['声场右转 °', '声场抬头 °', '声场右倾 °'][index]}
              value={spatial.ambisonicTransform?.[key] ?? 0} min={-180} max={180} step={1} theme={theme}
              onChange={value => patch({ ambisonicTransform: { [key]: value } })} />)}</div>
          <div className="grid gap-x-6 @min-[40rem]:grid-cols-2">{Array.from({ length: spatial.inputFormat === 'ambix3' ? 4 : spatial.inputFormat === 'ambix2' ? 3 : 2 }, (_, order) =>
            <Slider key={order} label={`${order} 阶增益`} value={spatial.ambisonicTransform?.orderGains[order] ?? 1}
              min={0} max={2} step={0.05} display={`${(spatial.ambisonicTransform?.orderGains[order] ?? 1).toFixed(2)}×`} theme={theme}
              onChange={value => { const gains = [...(current().ambisonicTransform?.orderGains ?? [1, 1, 1, 1])]; gains[order] = value; patch({ ambisonicTransform: { orderGains: gains } }) }} />)}</div>
          <InfoLine theme={theme}>旋转整个声场，分阶增益改变方向性；0 阶保留全向分量，高阶不从普通声道数推断。</InfoLine>
        </div>}
        <div className="rounded-2xl border p-4" style={{ borderColor: theme.cardBorder }}>
          <div className="flex items-center justify-between gap-3"><h4 className={`text-sm font-medium ${theme.textPrimary}`}>头部追踪</h4>
            <Toggle label="启用头部追踪输入" theme={theme} checked={tracking} disabled={!bridge.setSpatialHeadPose} onChange={setTracking} /></div>
          <div role="status" className={`mt-2 text-xs ${theme.textSecondary}`}>{tracking ? trackingStatus : '未启用姿态输入'}</div>
          <div className="mt-3"><ActionBtn theme={theme} ghost disabled={!tracking || !trackingStatus.startsWith('已接收')} onClick={() => bridge.setSpatialHeadPose?.(poseFilter.current.recenter())}>以当前方向校准朝前</ActionBtn></div>
          <HeadTrackingBridgeControls theme={theme} onBridgeUrl={setTrackingUrl} />
          {tracking && <div className="mt-3 space-y-3"><div className="flex flex-wrap gap-2">
            <ActionBtn theme={theme} ghost onClick={() => void trackingInput.current?.connectSerial().catch(error => setTrackingStatus(String(error)))}>连接串口头追</ActionBtn>
            <ActionBtn theme={theme} ghost onClick={() => void trackingInput.current?.connectDeviceOrientation().catch(error => setTrackingStatus(String(error)))}>连接设备方向传感器</ActionBtn>
            <ActionBtn theme={theme} ghost onClick={() => void trackingInput.current?.disconnect()}>断开姿态设备</ActionBtn></div>
            <label className={`block text-xs ${theme.textSecondary}`}>本机姿态桥地址<input aria-label="本机姿态桥地址" value={trackingUrl} onChange={event => setTrackingUrl(event.currentTarget.value)}
              className={`mt-1.5 min-h-10 w-full rounded-xl border px-3 ${theme.textPrimary}`} style={{ background: theme.inputBg, borderColor: theme.cardBorder }} /></label>
            <ActionBtn theme={theme} ghost onClick={() => void trackingInput.current?.connectWebSocket(trackingUrl).catch(error => setTrackingStatus(String(error)))}>连接 OSC / 蓝牙姿态桥</ActionBtn>
            <div className="grid grid-cols-1 gap-3 @min-[40rem]:grid-cols-2">
              <label className={`text-xs ${theme.textSecondary}`}>蓝牙服务 UUID<input aria-label="蓝牙服务 UUID" value={bluetoothService} onChange={event => setBluetoothService(event.currentTarget.value)}
                className={`mt-1.5 min-h-10 w-full rounded-xl border px-3 ${theme.textPrimary}`} style={{ background: theme.inputBg, borderColor: theme.cardBorder }} /></label>
              <label className={`text-xs ${theme.textSecondary}`}>蓝牙通知特征 UUID<input aria-label="蓝牙通知特征 UUID" value={bluetoothCharacteristic} onChange={event => setBluetoothCharacteristic(event.currentTarget.value)}
                className={`mt-1.5 min-h-10 w-full rounded-xl border px-3 ${theme.textPrimary}`} style={{ background: theme.inputBg, borderColor: theme.cardBorder }} /></label>
            </div>
            <ActionBtn theme={theme} ghost disabled={!bluetoothService.trim() || !bluetoothCharacteristic.trim()}
              onClick={() => void trackingInput.current?.connectBluetooth({ serviceUuid: bluetoothService.trim(), characteristicUuid: bluetoothCharacteristic.trim() }).catch(error => setTrackingStatus(String(error)))}>连接蓝牙头追</ActionBtn>
          </div>}
          <InfoLine theme={theme}>串口支持逐行 JSON 或 yaw,pitch,roll。OSC 与蓝牙可由本机姿态桥转入；方向传感器按屏幕朝上、设备顶边朝前安装。头锁定模式不随追踪旋转。</InfoLine>
        </div>
        {mode === 'world' && <div><div className="mt-4 flex items-center gap-3"><Toggle label="物理传播延迟" checked={spatial.world.propagation ?? false} onChange={propagation => patch({ world: { propagation } })} theme={theme} /><span className={`text-xs ${theme.textSecondary}`}>按距离模拟传播时间</span></div>
        <InfoLine theme={theme}>传播按 343 m/s 计算，移动时延迟连续变化；自然外化混合直达声，清晰定位可使用完整湿声。</InfoLine>
        <Slider label="全局遮挡衰减" value={Math.round(spatial.world.occlusion * 100)} min={0} max={100} step={1} theme={theme} display={`${Math.round(spatial.world.occlusion * 100)}%`} onChange={value => patch({ world: { occlusion: value / 100 } })} /></div>}
        <div className="rounded-2xl border p-4" style={{ borderColor: theme.cardBorder }}>
          <div className="flex items-center justify-between gap-3"><h4 className={`text-sm font-medium ${theme.textPrimary}`}>双音箱串扰消除</h4>
            <Toggle label="启用双音箱串扰消除" theme={theme} checked={spatial.speakerCancellation?.enabled ?? false}
              onChange={enabled => patch({ speakerCancellation: { enabled } })} /></div>
          <InfoLine theme={theme}>用于两只音箱的立体声回放；佩戴耳机时关闭。它与耳机 Crossfeed 分开处理。</InfoLine>
          {spatial.speakerCancellation?.enabled && <div className="mt-4">
            <Slider label="串扰消除强度" value={Math.round(spatial.speakerCancellation.amount * 100)} min={0} max={100} step={1} theme={theme} display={`${Math.round(spatial.speakerCancellation.amount * 100)}%`} onChange={value => patch({ speakerCancellation: { amount: value / 100 } })} />
            <div className="grid grid-cols-2 gap-3"><NumberField label="声学路径时差 ms" value={spatial.speakerCancellation.delayMs} min={0.02} max={1.5} step={0.01} theme={theme} onChange={delayMs => patch({ speakerCancellation: { delayMs } })} />
              <NumberField label="有效频率上限 Hz" value={spatial.speakerCancellation.cutoffHz} min={200} max={5000} step={100} theme={theme} onChange={cutoffHz => patch({ speakerCancellation: { cutoffHz } })} /></div>
          </div>}
          <details className="mt-4"><summary className={`cursor-pointer text-xs ${theme.textSecondary}`}>摆位估算与测量文件</summary><SpeakerCalibrationPanel theme={theme} sampleRate={bridge.getSampleRate()} onApply={speakerCancellation => patch({ speakerCancellation })} /></details>
        </div>
        <div className="rounded-2xl border p-4" style={{ borderColor: theme.cardBorder }}>
          <div ref={hrtfFeedbackRef} className={`text-sm font-medium ${theme.textPrimary}`}>耳机方向模型 · HRTF</div>
          <p className={`mt-1 break-all text-xs ${theme.textSecondary}`}>{hrtfName}</p>
          <input ref={hrtfInput} type="file" accept=".sofa" className="hidden" aria-label="导入 SOFA HRTF" disabled={importing} onChange={async event => {
            const file = event.target.files?.[0]; event.target.value = ''
            if (!file || !bridge.setSpatialHrtf) return
            setImporting(true); setHrtfMessage('正在解析本地 SOFA…')
            try {
              const grid = await importSofaFile(file, bridge.getSampleRate())
              bridge.setSpatialHrtf(grid); setHrtfName(grid.source ?? file.name)
              try { await saveActiveHrtf(grid); setHrtfMessage('已应用并保存在本机。') }
              catch { setHrtfMessage('本次会话已应用；本地保存失败。') }
            } catch (error) { setHrtfMessage(error instanceof Error ? error.message : 'SOFA 导入失败') }
            finally { setImporting(false) }
          }} />
          <div className="mt-3 flex flex-wrap gap-2"><ActionBtn theme={theme} ghost disabled={importing || !bridge.setSpatialHrtf} onClick={() => hrtfInput.current?.click()}>{importing ? '正在导入…' : '导入 SOFA'}</ActionBtn>
            <ActionBtn theme={theme} ghost disabled={importing || !bridge.setSpatialHrtf} onClick={async () => {
              bridge.setSpatialHrtf?.(null); setHrtfName('MIT KEMAR compact')
              try { await saveActiveHrtf(null); setHrtfMessage('已恢复内置 KEMAR。') } catch { setHrtfMessage('已恢复内置数据；本地记录清理失败。') }
            }}>恢复内置 HRTF</ActionBtn></div>
          <p role="status" className={`mt-2 text-xs ${theme.textSecondary}`}>{hrtfMessage}</p>
          <InfoLine theme={theme}>支持双耳 SimpleFreeFieldHRIR，最大 32 MiB；仅在本机解析，数据不进入分享串。</InfoLine>
        </div>
        <section className="hse-spatial-render-settings"><h4 className={`mb-4 text-sm font-medium ${theme.textPrimary}`}>渲染与距离</h4>
        <div className="grid gap-x-8 @min-[40rem]:grid-cols-2">
          <Slider label="早期反射" value={Math.round((spatial.earlyAmount ?? 1) * 100)} min={0} max={100} step={1} theme={theme} display={`${Math.round((spatial.earlyAmount ?? 1) * 100)}%`} onChange={value => patch({ earlyAmount: value / 100 })} />
          <Slider label="晚期混响" value={Math.round((spatial.lateAmount ?? 1) * 100)} min={0} max={100} step={1} theme={theme} display={`${Math.round((spatial.lateAmount ?? 1) * 100)}%`} onChange={value => patch({ lateAmount: value / 100 })} />
        </div>
        <Segmented label="HRTF 插值" options={[{ value: 'spherical', label: '连续方向' }, { value: 'nearest', label: '测量点' }]} value={spatial.hrtfInterp} onChange={hrtfInterp => patch({ hrtfInterp })} theme={theme} small />
        <Segmented label="反射计算预算" options={[{ value: 'quality', label: '完整反射' }, { value: 'auto', label: '自动预算' }, { value: 'lowLatency', label: '仅晚混响' }]} value={spatial.budgetMode ?? 'quality'} onChange={budgetMode => patch({ budgetMode })} theme={theme} small />
        <Segmented label="早反射双耳模型" options={[{ value: 'cues', label: '轻量线索' }, { value: 'spectral', label: '完整 HRTF 频谱' }]} value={spatial.earlyReflectionModel ?? 'cues'} onChange={earlyReflectionModel => patch({ earlyReflectionModel })} theme={theme} small />
        <Segmented label="环境声提取" options={[{ value: 'pca', label: '非相干环境估计' }, { value: 'difference', label: 'L-R 残差' }]} value={spatial.ambience.extraction ?? 'pca'} onChange={extraction => patch({ ambience: { extraction } })} theme={theme} small />
        <Segmented label="空间卷积方式" options={[{ value: 'partitioned', label: 'FFT 分区卷积' }, { value: 'time', label: '直接卷积' }]} value={spatial.convolution} onChange={convolution => patch({ convolution })} theme={theme} small />
        <Segmented label="距离衰减模型" options={[{ value: 'inverse', label: '反距离' }, { value: 'linear', label: '线性' }, { value: 'exponential', label: '指数' }]} value={spatial.distanceModel} onChange={distanceModel => patch({ distanceModel })} theme={theme} small />
        <div className="grid grid-cols-2 gap-3"><NumberField label="参考距离 m" value={spatial.refDistance} min={0.1} max={100} theme={theme} onChange={refDistance => patch({ refDistance })} />
          <NumberField label="最大距离 m" value={spatial.maxDistance} min={spatial.refDistance + 0.1} max={200} theme={theme} onChange={maxDistance => patch({ maxDistance })} /></div>
        <Slider label="空间输出电平" value={spatial.masterGain} min={0.5} max={1} step={0.01} theme={theme} display={`${(20 * Math.log10(spatial.masterGain)).toFixed(1)} dB`} onChange={masterGain => patch({ masterGain })} />
        <p className={`text-xs leading-relaxed ${theme.textSecondary}`}>当前数据集：{hrtfName} · 耳机双声道输出</p>
        </section>
      </div>}
    </GlassCard>
  </div>
}
