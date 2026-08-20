/**
 * SpatialSphereEditor —— 模式 B 头锁定环绕 3D 球形网格编辑器（Three.js / R3F）
 *
 * 规划书 §5.3 模式 B「3D 球形网格编辑器」：
 *  - 中央 3D 球形线框网格（半径 1 单位，经/纬线 wireframe）代表声场球面；
 *  - 听者头部图标（圆柱 + 朝向锥，参照 SpatialWorldView ListenerMarker 风格，
 *    比例缩小适配单位球）位于球心；
 *  - 每只扬声器是球面上的一个发光点（按方位角/仰角投影，公式见 sphereMath.ts：
 *    x = cos(el)·sin(az)、y = sin(el)、z = cos(el)·cos(az)）；
 *  - 拖拽发光点沿球面移动（pointer 拖拽 → 射线与球面交点反解方位角/仰角：
 *    az = atan2(x, z)、el = asin(y)，实时 onChangeSpeaker patch，帧级节流）；
 *  - 滚轮在点上调整该声源的距离（±0.5m/格，钳制 0.5..10m）；
 *  - 双击点弹出精确数值输入浮层（方位角 -180..180 / 仰角 -90..90 / 距离
 *    0.5..10，确定整值写回）；
 *  - OrbitControls 环绕查看（旋转仅改变相机视角，不改扬声器参数）。
 *
 * 与 SpatialRingEditor（2D 环形）共用 speakers/onChangeSpeaker 链路；视图切换
 * 由 SpatialPage 模式 B 区块的「视图」Segmented 决定（2D 环形保留为默认）。
 *
 * 交互（仅 editable=true；预设布局只读灰调展示）：
 *  - pointerdown 点：选中 + 开始拖拽（拖拽期间禁用 OrbitControls 旋转，避免
 *    互抢指针；指针捕获到 canvas，拖出球面仍持续收到移动）；
 *  - pointermove：帧级射线-单位球求交 → positionToAzEl 反解 → 0.1° 取整 patch；
 *  - 滚轮：adjustDistance 调距（OrbitControls 关闭缩放——滚轮语义让位给调距，
 *    避免「点上滚轮同时缩放相机」的双重响应）；
 *  - 双击：精确输入浮层（Enter 确认 / Escape 取消）；
 *  - 选中后显示「删除」按钮（至少保留 1 只；调用方 handleDeleteSpeaker 保证）；
 *  - 右键菜单不做重复实现（2D 环形已有完整菜单：复制/删除/静音/Solo）。
 *
 * 选中状态：onSelect/selectedIndex 提供时为受控；缺省组件内部状态（向后兼容）。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react'
import * as THREE from 'three'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import type { ThreeEvent } from '@react-three/fiber'
import { Html, OrbitControls, useCursor } from '@react-three/drei'
import type { HSETheme } from '../hse-theme'
import type { VirtualSpeakerCfg } from '../../src/spatial/types'
import {
  DISTANCE_STEP,
  MAX_DISTANCE,
  MIN_DISTANCE,
  adjustDistance,
  azElToPosition,
  positionToAzEl,
} from './sphereMath'
import { InfoLine } from './Primitives'

interface SpatialSphereEditorProps {
  /** 扬声器配置列表（模式 B headLocked.speakers，与 2D 环形同源） */
  speakers: VirtualSpeakerCfg[]
  /** 可编辑（layout==='custom'）；false 时只读灰调展示 */
  editable: boolean
  theme: HSETheme
  /** 修改第 index 只扬声器（局部字段；拖拽/滚轮/双击浮层共用链路） */
  onChangeSpeaker?: (index: number, patch: Partial<VirtualSpeakerCfg>) => void
  /** 删除第 index 只扬声器（调用方保证至少保留 1 只；选中时显示删除按钮） */
  onDeleteSpeaker?: (index: number) => void
  /** 添加扬声器（调用方保证不超过上限；缺省不渲染添加按钮） */
  onAddSpeaker?: () => void
  /** 受控选中（缺省 = 组件内部状态，向后兼容） */
  selectedIndex?: number | null
  /** 选中变化事件（缺省 = 内部状态） */
  onSelect?: (index: number | null) => void
}

/** 自定义布局扬声器上限（与 2D 环形一致） */
const MAX_SPEAKERS = 16
/** 无操作回调（onChangeSpeaker 缺省时占位，DragUpdater 恒为空跑） */
const NOOP = (): void => {}

/* ───────── 场景内子组件（仅在本文件使用，随 Canvas 挂载） ───────── */

/** 经纬线线框球（半径 1 单位，球心原点）：经线每 30° 一条（纬向分段 5°）、
 *  纬线每 30° 一条（经向分段 15°）；半透明白线（theme.textSecondary 灰调语义），
 *  不遮挡发光点。 */
function SphereGrid() {
  const geo = useMemo(() => {
    const pts: number[] = []
    // 经线（meridians）：az ∈ {0, 30, …, 330}，从南极到北极
    for (let a = 0; a < 360; a += 30) {
      for (let lat = -90; lat < 90; lat += 5) {
        const p1 = azElToPosition(a, lat)
        const p2 = azElToPosition(a, lat + 5)
        pts.push(p1.x, p1.y, p1.z, p2.x, p2.y, p2.z)
      }
    }
    // 纬线（parallels）：el ∈ {-60, -30, 0, 30, 60}，绕一整圈
    for (const lat of [-60, -30, 0, 30, 60]) {
      for (let a = 0; a < 360; a += 15) {
        const p1 = azElToPosition(a, lat)
        const p2 = azElToPosition(a + 15, lat)
        pts.push(p1.x, p1.y, p1.z, p2.x, p2.y, p2.z)
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
    return g
  }, [])
  return (
    <lineSegments geometry={geo}>
      <lineBasicMaterial color="#ffffff" transparent opacity={0.14} />
    </lineSegments>
  )
}

/** 听者头部（球心）：小圆柱 + 朝向锥（cone 默认 +Y，绕 X 转 +90° 指向 +Z 正前，
 *  与 SpatialWorldView ListenerMarker 同风格） */
function ListenerHead({ theme }: { theme: HSETheme }) {
  return (
    <group>
      <mesh position={[0, 0.16, 0]}>
        <cylinderGeometry args={[0.08, 0.11, 0.26, 16]} />
        <meshStandardMaterial
          color="#e8e8f0"
          emissive={theme.accentFrom}
          emissiveIntensity={0.4}
          roughness={0.5}
        />
      </mesh>
      <mesh position={[0, 0.3, 0]} rotation-x={Math.PI / 2}>
        <coneGeometry args={[0.065, 0.2, 12]} />
        <meshStandardMaterial
          color={theme.accentFrom}
          emissive={theme.accentFrom}
          emissiveIntensity={1.2}
          roughness={0.4}
        />
      </mesh>
    </group>
  )
}

/** 扬声器发光点：位置 = azElToPosition(方位角, 仰角) 球面投影；
 *  颜色 az<0 电光青 accentFrom / az>0 深邃紫 accentTo（与 2D 环形同语义）；
 *  选中放大 + 外圈光环 + Html 标签（序号/距离）；仰角≠0 略大（顶/底层辨识）；
 *  距离近大远小（滚轮调距有视觉反馈）；非 editable 灰调只读。 */
function SpeakerMarker({
  speaker,
  index,
  color,
  selected,
  editable,
  onPointerDown,
  onWheel,
  onDoubleClick,
}: {
  speaker: VirtualSpeakerCfg
  index: number
  color: string
  selected: boolean
  editable: boolean
  onPointerDown: (index: number, e: ThreeEvent<PointerEvent>) => void
  onWheel: (index: number, e: ThreeEvent<WheelEvent>) => void
  onDoubleClick: (index: number, e: ThreeEvent<MouseEvent>) => void
}) {
  const pos = useMemo(
    () => azElToPosition(speaker.azimuthDeg, speaker.elevationDeg),
    [speaker.azimuthDeg, speaker.elevationDeg],
  )
  const [hovered, setHovered] = useState(false)
  useCursor(hovered, 'pointer', 'default')
  // 半径合成：基础 0.085 × 仰角≠0 1.35 × 距离近大远小（0.5m≈满、10m≈75%）× 选中 1.35
  const distNorm = (Math.min(MAX_DISTANCE, Math.max(MIN_DISTANCE, speaker.distance)) - MIN_DISTANCE) / (MAX_DISTANCE - MIN_DISTANCE)
  const radius =
    0.085 *
    (speaker.elevationDeg !== 0 ? 1.35 : 1) *
    (0.75 + 0.25 * (1 - distNorm)) *
    (selected ? 1.35 : 1)
  return (
    <group position={[pos.x, pos.y, pos.z]}>
      <mesh
        onPointerOver={(e) => { e.stopPropagation(); setHovered(true) }}
        onPointerOut={() => setHovered(false)}
        onPointerDown={(e) => { if (editable) onPointerDown(index, e) }}
        onWheel={(e) => { if (editable) onWheel(index, e) }}
        onDoubleClick={(e) => { if (editable) onDoubleClick(index, e) }}
      >
        <sphereGeometry args={[radius, 20, 20]} />
        <meshStandardMaterial
          color="#0a0a12"
          emissive={color}
          emissiveIntensity={selected ? 2.6 : editable ? 1.4 : 0.6}
          roughness={0.35}
          metalness={0.1}
        />
      </mesh>
      {/* 选中光环（外圈发光壳） */}
      {selected && editable && (
        <mesh>
          <sphereGeometry args={[radius * 1.9, 16, 16]} />
          <meshBasicMaterial color={color} transparent opacity={0.22} />
        </mesh>
      )}
      {/* 选中标签：序号 + 距离（Html 叠加，不挡 3D 交互） */}
      {selected && editable && (
        <Html position={[0, radius + 0.24, 0]} center zIndexRange={[10, 0]} style={{ pointerEvents: 'none', userSelect: 'none' }}>
          <div
            className="px-2 py-0.5 rounded-md text-[10px] whitespace-nowrap hse-mono"
            style={{
              background: 'rgba(10,10,16,0.78)',
              border: `1px solid ${color}66`,
              color: '#fff',
              fontFamily: '"PingFang SC", "Microsoft YaHei", sans-serif',
            }}
          >
            #{index + 1} · {speaker.distance.toFixed(1)}m
          </div>
        </Html>
      )}
    </group>
  )
}

/**
 * 拖拽更新器：拖拽期间每帧把当前指针射线与单位球（球心原点、半径 1）求交，
 * 反解方位角/仰角实时 patch（帧级节流，规划书「事件本身是帧级，可接受」）；
 * 拖拽期间禁用 OrbitControls（避免旋转抢指针），结束恢复。
 * 射线-球面求交：t² + 2(ro·rd)t + (|ro|² − 1) = 0，取最近正交点
 * （相机位于球内时近根为负，回退远根）。
 */
function DragUpdater({
  dragIndex,
  onChange,
}: {
  dragIndex: number | null
  onChange: (index: number, patch: Partial<VirtualSpeakerCfg>) => void
}) {
  const { camera, raycaster, pointer } = useThree()
  const controls = useThree((s) => s.controls) as unknown as { enabled: boolean } | null
  const hit = useRef(new THREE.Vector3())
  useEffect(() => {
    if (controls) controls.enabled = dragIndex === null
  }, [controls, dragIndex])
  useFrame(() => {
    if (dragIndex === null) return
    raycaster.setFromCamera(pointer, camera)
    const ro = raycaster.ray.origin
    const rd = raycaster.ray.direction
    const b = ro.dot(rd)
    const disc = b * b - ro.lengthSq() + 1
    if (disc < 0) return
    const t1 = -b - Math.sqrt(disc)
    const t2 = -b + Math.sqrt(disc)
    const t = t1 > 0 ? t1 : t2
    if (t <= 0) return
    hit.current.copy(rd).multiplyScalar(t).add(ro)
    const { azDeg, elDeg } = positionToAzEl(hit.current.x, hit.current.y, hit.current.z)
    // 取整到 0.1°（避免浮点长尾污染持久化参数）
    onChange(dragIndex, {
      azimuthDeg: Math.round(azDeg * 10) / 10,
      elevationDeg: Math.round(elDeg * 10) / 10,
    })
  })
  return null
}

/* ───────── 精确输入浮层（双击弹出，HTML 叠加在 Canvas 之上） ───────── */

/** number 输入框统一样式（theme 风格） */
const numberInputStyle: CSSProperties = {
  backgroundColor: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(255,255,255,0.12)',
}

/** 输入行（标签 + number 输入） */
function NumberField({ label, value, onChange, step, min, max }: {
  label: string
  value: string
  onChange: (v: string) => void
  step: number
  min: number
  max: number
}) {
  return (
    <label className="block mb-2">
      <span className="text-white/70 text-xs mb-1 block">{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-2 py-1 rounded-lg text-xs hse-mono outline-none"
        style={numberInputStyle}
      />
    </label>
  )
}

/**
 * 精确输入浮层（双击点弹出）：方位角（wrap 归一）/仰角（钳制 ±90）/距离
 * （钳制 0.5..10，0.1 取整）三个 number 输入 + 确定/取消；Enter 确认 /
 * Escape 取消；点浮层外背景取消。
 */
function NumericPopup({ index, speaker, theme, onConfirm, onCancel }: {
  index: number
  speaker: VirtualSpeakerCfg
  theme: HSETheme
  onConfirm: (index: number, patch: Partial<VirtualSpeakerCfg>) => void
  onCancel: () => void
}) {
  const [az, setAz] = useState(String(Math.round(speaker.azimuthDeg)))
  const [el, setEl] = useState(String(Math.round(speaker.elevationDeg)))
  const [dist, setDist] = useState(speaker.distance.toFixed(1))

  const submit = (): void => {
    const azV = Number.parseFloat(az)
    const elV = Number.parseFloat(el)
    const distV = Number.parseFloat(dist)
    if (Number.isNaN(azV) || Number.isNaN(elV) || Number.isNaN(distV)) return
    onConfirm(index, {
      azimuthDeg: azV,
      elevationDeg: elV,
      distance: distV,
    })
  }

  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Enter') submit()
    else if (e.key === 'Escape') onCancel()
  }

  return (
    <div
      className="absolute inset-0 z-20 flex items-center justify-center"
      style={{ background: 'rgba(5,5,10,0.45)' }}
      onPointerDown={(e) => { if (e.target === e.currentTarget) onCancel() }}
    >
      <div
        className="w-56 rounded-xl p-4 shadow-2xl"
        style={{
          background: theme.panelBg,
          border: `1px solid ${theme.cardBorder}`,
          backdropFilter: theme.glassBlur,
          WebkitBackdropFilter: theme.glassBlur,
        }}
        onKeyDown={onKey}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="text-white/85 text-xs font-medium mb-2">扬声器 #{index + 1} 精确位置</div>
        <NumberField label="方位角（°）" value={az} onChange={setAz} step={1} min={-180} max={180} />
        <NumberField label="仰角（°）" value={el} onChange={setEl} step={1} min={-90} max={90} />
        <NumberField label="距离（m）" value={dist} onChange={setDist} step={0.1} min={MIN_DISTANCE} max={MAX_DISTANCE} />
        <div className="flex gap-2 mt-1">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 py-1.5 rounded-lg text-xs transition-all hover:brightness-110"
            style={{ backgroundColor: 'rgba(255,255,255,0.06)', border: `1px solid ${theme.cardBorder}`, color: theme.textSecondary }}
          >
            取消
          </button>
          <button
            type="button"
            onClick={submit}
            className="flex-1 py-1.5 rounded-lg text-xs text-white font-medium transition-all hover:brightness-110"
            style={{ background: theme.accentGradient, boxShadow: `0 4px 14px ${theme.accentColor}44` }}
          >
            确定
          </button>
        </div>
      </div>
    </div>
  )
}

/* ───────── 主组件 ───────── */

export function SpatialSphereEditor({
  speakers,
  editable,
  theme,
  onChangeSpeaker,
  onDeleteSpeaker,
  onAddSpeaker,
  selectedIndex,
  onSelect,
}: SpatialSphereEditorProps) {
  /** 选中：受控（onSelect 提供时用 selectedIndex）或内部状态（缺省，向后兼容） */
  const [localSel, setLocalSel] = useState<number | null>(null)
  const selected = onSelect ? (selectedIndex ?? null) : localSel
  const select = (i: number | null): void => {
    if (onSelect) onSelect(i)
    else setLocalSel(i)
  }

  /** 拖拽中的扬声器索引（null = 未拖拽） */
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  /** 精确输入浮层（双击打开；null = 关闭） */
  const [popup, setPopup] = useState<{ index: number } | null>(null)

  // 只读（预设布局）时清理选中与浮层
  useEffect(() => {
    if (!editable) {
      select(null)
      setPopup(null)
    }
  }, [editable])
  // 列表缩短（删除/布局切换）时清理越界选中
  useEffect(() => {
    if (selected !== null && selected >= speakers.length) select(null)
  }, [speakers.length, selected])

  /** 点上 pointerdown：选中 + 开始拖拽；双击序列（detail≥2）不启动拖拽，
   *  避免双击前点被拖走；指针捕获到 canvas（拖出球面仍持续收到移动） */
  const handlePointerDown = (index: number, e: ThreeEvent<PointerEvent>): void => {
    if (e.nativeEvent.detail >= 2) return
    e.stopPropagation()
    select(index)
    setDragIndex(index)
    const canvas = e.nativeEvent.target as HTMLCanvasElement | null
    try {
      canvas?.setPointerCapture(e.nativeEvent.pointerId)
    } catch {
      /* 捕获失败：悬停期间仍可拖（指针离开球面后移动停止） */
    }
  }

  /** 结束拖拽：指针释放/取消（wrapper 冒泡监听，覆盖捕获后的任意释放位置） */
  const endDrag = (): void => setDragIndex(null)

  /** 点上滚轮：±DISTANCE_STEP 调整距离（deltaY<0 上滚推远 +0.5、deltaY>0 下滚
   *  拉近 −0.5，钳制 0.5..10m；OrbitControls 已关缩放，滚轮语义完整让位） */
  const handleWheel = (index: number, e: ThreeEvent<WheelEvent>): void => {
    e.stopPropagation()
    if (!onChangeSpeaker) return
    const s = speakers[index]
    if (!s) return
    const delta = e.deltaY > 0 ? -DISTANCE_STEP : DISTANCE_STEP
    onChangeSpeaker(index, { distance: adjustDistance(s.distance, delta) })
  }

  /** 双击：选中 + 弹出精确输入浮层 */
  const handleDoubleClick = (index: number, e: ThreeEvent<MouseEvent>): void => {
    e.stopPropagation()
    select(index)
    setPopup({ index })
  }

  /** 浮层确认：整值写入（方位角 wrap、仰角/距离钳制在浮层提交时归一） */
  const confirmPopup = (index: number, patch: Partial<VirtualSpeakerCfg>): void => {
    onChangeSpeaker?.(index, patch)
    setPopup(null)
  }

  /** 删除按钮：选中扬声器删除（至少保留 1 只时可用） */
  const handleDelete = (index: number): void => {
    onDeleteSpeaker?.(index)
    select(null)
  }

  const popupSpeaker = popup !== null && popup.index < speakers.length ? speakers[popup.index] : null

  return (
    <div>
      <div
        className="relative w-full overflow-hidden rounded-xl"
        style={{
          height: 340,
          border: `1px solid ${theme.cardBorder}`,
          background: 'radial-gradient(120% 120% at 50% 0%, #14141c 0%, #0b0b11 62%)',
        }}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <Canvas
          camera={{ position: [3.4, 2.2, 3.4], fov: 45, near: 0.1, far: 50 }}
          dpr={[1, 2]}
          gl={{ antialias: true }}
        >
          <color attach="background" args={['#0b0b11']} />

          {/* 灯光：环境 + 主方向光 + 球心青色氛围点光 */}
          <ambientLight intensity={0.6} />
          <directionalLight position={[4, 6, 4]} intensity={1.1} />
          <pointLight position={[0, 0, 0]} intensity={2} distance={8} color={theme.accentFrom} />

          <SphereGrid />
          <ListenerHead theme={theme} />

          {/* 扬声器发光点（az<0 电光青 / az>0 深邃紫；选中放大 + 光环 + 标签）。
              key={i}（数组索引）：VirtualSpeakerCfg 无稳定 id 字段，删除中间扬声器
              时后续项位移——hover state 可能瞬时错位，但 selected 由父受控
              （selectedIndex/onSelect，见下方清理越界 effect）不受影响，行为安全。
              改稳定 key 需先给 VirtualSpeakerCfg 加 id 字段（侵入类型契约，后续 wave）。 */}
          {speakers.map((s, i) => (
            <SpeakerMarker
              key={i}
              speaker={s}
              index={i}
              color={s.azimuthDeg < 0 ? theme.accentFrom : theme.accentTo}
              selected={editable && selected === i}
              editable={editable}
              onPointerDown={handlePointerDown}
              onWheel={handleWheel}
              onDoubleClick={handleDoubleClick}
            />
          ))}

          {/* 拖拽更新器（射线-球面反解 az/el；非 editable 恒空跑） */}
          <DragUpdater dragIndex={editable ? dragIndex : null} onChange={onChangeSpeaker ?? NOOP} />

          {/* 视角：左键拖拽旋转 = 环绕查看（仅相机，不改扬声器参数）；关缩放——
              滚轮在扬声器点上语义让位给距离调整（避免双重响应） */}
          <OrbitControls
            makeDefault
            enablePan={false}
            enableZoom={false}
            enableDamping
            dampingFactor={0.08}
            minDistance={1.6}
            maxDistance={8}
          />
        </Canvas>

        {/* 双击精确输入浮层（覆盖在 Canvas 之上；点背景取消） */}
        {editable && popup && popupSpeaker && (
          <NumericPopup
            index={popup.index}
            speaker={popupSpeaker}
            theme={theme}
            onConfirm={confirmPopup}
            onCancel={() => setPopup(null)}
          />
        )}
      </div>

      {/* 添加/删除行 + 计数（与 2D 环形同区） */}
      <div className="mt-3 flex items-center justify-between gap-2">
        {editable && onAddSpeaker && (
          <button
            type="button"
            disabled={speakers.length >= MAX_SPEAKERS}
            onClick={onAddSpeaker}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs transition-all hover:brightness-110 disabled:opacity-40"
            style={{
              backgroundColor: theme.inputBg,
              border: `1px solid ${theme.cardBorder}`,
              color: theme.textSecondary,
            }}
          >
            + 添加扬声器
          </button>
        )}
        <div className="flex items-center gap-2 ml-auto">
          {editable && onDeleteSpeaker && selected !== null && selected < speakers.length && (
            <button
              type="button"
              disabled={speakers.length <= 1}
              onClick={() => handleDelete(selected)}
              className="px-3 py-1.5 rounded-lg text-xs transition-all hover:brightness-110 disabled:opacity-40"
              style={{
                backgroundColor: 'rgba(239,68,68,0.12)',
                border: '1px solid rgba(239,68,68,0.35)',
                color: '#f87171',
              }}
            >
              删除 #{selected + 1}
            </button>
          )}
          <span className={`hse-mono ${theme.textTertiary} text-[11px]`}>
            {speakers.length}/{MAX_SPEAKERS}
          </span>
        </div>
      </div>

      {editable && (
        <InfoLine theme={theme}>
          拖拽发光点沿球面调整方位角/仰角；滚轮在点上调整距离（0.5–10m）；双击精确输入。
          {onDeleteSpeaker && ' 选中后显示删除按钮（至少保留 1 只）。'}
          右键菜单（复制/静音/Solo）见 2D 环形视图。
        </InfoLine>
      )}
    </div>
  )
}
