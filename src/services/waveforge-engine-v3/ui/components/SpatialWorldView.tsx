/** 空间工作台：清晰的场景、独立的相机工具和有约束的声源移动。 */
import { useMemo, useState, type CSSProperties } from 'react'
import { Canvas } from '@react-three/fiber'
import { Box, Scan, Eye, MoveHorizontal, MoveVertical, Focus, RotateCcw, Maximize2, Minimize2, Plus, Minus, Compass, Layers3 } from 'lucide-react'
import type { HSETheme } from '../hse-theme'
import type { AudioObject, ListenerState, TrajectoryKeyframes } from '../../src/spatial/types'
import { sourceName } from './worldControl'
import { frameSpatialScene, sourceReadout } from './spatialViewModel'
import { SCENE_COLORS, SpatialWorldScene, type WorldViewMode, type CameraCommand, type SpatialDragMode } from './SpatialWorldScene'
import './spatial-world-view.css'

interface SpatialWorldViewProps {
  sources: AudioObject[]
  sourceLabels?: Record<string, string>
  sourceRoutes?: Record<string, string>
  listener: ListenerState
  theme: HSETheme
  onMove: (delta: { x: number; y: number; z: number }) => void
  onRotate: (yaw: number) => void
  onSelectSource: (id: string | null) => void
  onMoveSource?: (id: string, position: AudioObject['position']) => void
  selectedId: string | null
  follow?: boolean
  trajectories?: TrajectoryKeyframes[]
  playhead?: number
}

const VIEWS = [
  { mode: 'persp', label: '全景', icon: Box },
  { mode: 'top', label: '俯视', icon: Scan },
  { mode: 'side', label: '侧视', icon: Layers3 },
  { mode: 'first', label: '第一人称', icon: Eye },
] as const

export function SpatialWorldView({ sources, sourceLabels, sourceRoutes, listener, theme, onSelectSource, onMoveSource, selectedId,
  follow, trajectories, playhead }: SpatialWorldViewProps) {
  const [view, setView] = useState<WorldViewMode>('persp')
  const [command, setCommand] = useState<CameraCommand>({ type: 'fit', serial: 0 })
  const [dragMode, setDragMode] = useState<SpatialDragMode>('horizontal')
  const [dragging, setDragging] = useState(false), [expanded, setExpanded] = useState(false), [guides, setGuides] = useState(true)
  const frame = useMemo(() => frameSpatialScene(sources, listener), [sources, listener])
  const selected = sources.find(source => source.id === selectedId)
  const info = selected ? sourceReadout(selected.position, listener) : null
  const colors = SCENE_COLORS
  const names = sourceLabels ?? Object.fromEntries(sources.map(source => [source.id, sourceName(source.id)]))
  const send = (type: CameraCommand['type']) => setCommand(previous => ({ type, serial: previous.serial + 1 }))
  const setCamera = (mode: WorldViewMode) => { setView(mode); send('fit') }
  const surface = {
    '--sv-ink': '#153a37', '--sv-secondary': '#536b66',
    '--sv-surface': '#fbfdfc', '--sv-border': '#d7e2de',
    '--sv-soft': '#fbfdfc', '--sv-accent': theme.accentColor,
    '--sv-selected': theme.accentDim, '--sv-label': '#ffffff',
  } as CSSProperties
  return <section className={`hse-spatial-view ${expanded ? 'is-expanded' : ''}`} style={surface} aria-label="三维声场预览">
    <div className="hse-spatial-view-toolbar">
      <div className="hse-spatial-view-heading"><Compass size={18} aria-hidden="true" /><span>空间视图<small>{sources.length} 个声源</small></span></div>
      <div className="hse-spatial-camera-switch" role="group" aria-label="三维相机视角">
        {VIEWS.map(({ mode, label, icon: Icon }) => <button key={mode} type="button" aria-pressed={view === mode} title={label}
          onClick={() => setCamera(mode)}><Icon size={15} aria-hidden="true" /><span>{label}</span></button>)}
      </div>
      <button type="button" className="hse-spatial-icon-button" title={expanded ? '收起画布' : '放大画布'} aria-label={expanded ? '收起画布' : '放大画布'}
        aria-pressed={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? <Minimize2 size={17} /> : <Maximize2 size={17} />}</button>
    </div>
    <div className="hse-spatial-view-canvas" data-spatial-viewport>
      <Canvas shadows camera={{ position: [12, 12, 16], fov: 42, near: 0.05, far: 1500 }} dpr={[1, 1.75]} gl={{ antialias: true, alpha: false }}
        fallback={<div className="hse-spatial-webgl-fallback">当前环境无法显示三维场景，请使用上方的俯视或侧视编辑。</div>}>
        <SpatialWorldScene sources={sources} sourceLabels={names} sourceRoutes={sourceRoutes} listener={listener} selectedId={selectedId}
          onSelectSource={onSelectSource} onMoveSource={onMoveSource} frame={frame} view={view} command={command} dragMode={dragMode}
          onDragState={setDragging} dragging={dragging} colors={colors} follow={follow} trajectories={trajectories} playhead={playhead} showGuides={guides} />
      </Canvas>
      <div className="hse-spatial-scene-caption" aria-hidden="true"><span className="hse-spatial-caption-dot" />空间示意<span>网格 {frame.gridStep} m</span></div>
      <div className="hse-spatial-camera-actions" role="group" aria-label="相机操作">
        <button type="button" aria-label="拉近视角" title="拉近视角" disabled={view === 'first'} onClick={() => send('in')}><Plus size={17} /></button>
        <button type="button" aria-label="拉远视角" title="拉远视角" disabled={view === 'first'} onClick={() => send('out')}><Minus size={17} /></button>
      </div>
      <div className={`hse-spatial-view-selection ${selected ? '' : 'is-empty'}`} role="status">
        <span className="hse-spatial-selection-overline">{selected ? '当前声源' : '选择一个声源'}</span>
        <strong>{selected ? names[selected.id] : '从场景中的音箱开始'}</strong>
        <span>{info ? `${info.direction} · ${info.distance.toFixed(2)} m` : '选中后可移动位置或调整高度'}</span>
      </div>
    </div>
    <div className="hse-spatial-view-tools">
      <div className="hse-spatial-drag-switch" role="group" aria-label="三维声源移动方式">
        <button type="button" aria-pressed={dragMode === 'horizontal'} disabled={view === 'first'} onClick={() => setDragMode('horizontal')}><MoveHorizontal size={15} />水平移动</button>
        <button type="button" aria-pressed={dragMode === 'height'} disabled={view === 'first'} onClick={() => setDragMode('height')}><MoveVertical size={15} />调整高度</button>
      </div>
      <div className="hse-spatial-view-tools-end">
        <button type="button" disabled={!selected} onClick={() => { setView('persp'); send('focus') }}><Focus size={15} />聚焦声源</button>
        <button type="button" aria-pressed={guides} onClick={() => setGuides(!guides)}><Layers3 size={15} />辅助线</button>
        <button type="button" onClick={() => setCamera('persp')}><RotateCcw size={15} />重置视角</button>
      </div>
    </div>
    <div className="hse-spatial-view-hint"><span>{view === 'first' ? '第一人称沿听者朝向观察；方向请在听者属性中调整。'
      : dragging ? dragMode === 'horizontal' ? '正在移动声源 · 高度保持不变' : '正在调整高度 · 水平位置保持不变'
      : dragMode === 'horizontal' ? '拖动音箱或标签移动位置；拖动空白处旋转视角，滚轮缩放。' : '上下拖动音箱或标签调整高度；水平位置保持不变。'}</span>
      <span>相机操作不改变声音方向</span></div>
  </section>
}
