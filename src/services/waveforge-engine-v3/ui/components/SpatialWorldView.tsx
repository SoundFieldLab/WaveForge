/**
 * SpatialWorldView —— 模式 C 世界漫游 3D 世界视图（Three.js / R3F）
 *
 * 渲染（<Canvas>）：半透明房间边界（20×6×20m，中心原点）+ 地面网格 + 发光声源球
 * （accentFrom/accentTo 交替，选中放大 + 地面光晕环 + 名字标签）+ 听者头部标记
 * （圆柱 + 朝向锥体，锥体指向 yaw 方向）+ 选中声源↔听者距离虚线。
 *
 * 视角：OrbitControls 默认（左键拖拽旋转 = 转头语义，仅改变相机视角，
 * 不改听者朝向；听者 yaw 由 WorldPanel 键盘事件经父面板接线驱动）。
 * F 键第一人称跟随（follow prop）：OrbitControls 目标每帧 lerp 到听者位置。
 *
 * 小地图：右上角叠加 2D canvas（不占 3D 场景），俯视 x/z 平面图——房间边界、
 * 声源点、听者点 + 朝向扇形（yaw）、画布上方 = 世界 +Z（前方，与
 * SpatialRingEditor 前方朝上约定一致）。独立 raf 循环 + dpr 缩放。
 *
 * 轨迹（本波新增）：选中声源有轨迹时画关键帧折线（drei Line，accentTo 半透明
 * 1.5px）+ 关键帧小点；提供 playhead prop 时在轨迹上按时间插值画亮点
 * （世界系位置随 keyframes 线性插值）。数据契约 world.trajectories
 * （TrajectoryKeyframes 列表）已落地（src/spatial/types.ts）；缺省不画。
 *
 * 本组件只发事件（onSelectSource/onMoveSource）、不做引擎状态写入；onMove/onRotate
 * 为统一事件接口（键盘逻辑在 WorldPanel，父面板统一接线到 patchSpatialParams）。
 *
 * 交互补充（本波新增）：
 *  - 声源拖拽（onMoveSource 可选 prop，缺省不启用拖拽，向后兼容）：用 drei
 *    DragControls 包裹声源球体——拖拽期间 drei 直接改写包裹 group 的矩阵
 *    （autoTransform，视觉即时跟随、无 React 中间态），onDragEnd 读矩阵位置
 *    分量（= 自拖拽开始累计位移）+ 源位置，一次性提交 onMoveSource；
 *  - Tab 循环选源（window keydown，preventDefault 防焦点跳转）：按 sources
 *    数组顺序循环选中，无选中从第一个开始，仅 1 个时不变（逻辑在
 *    worldControl.nextSourceIndex 纯函数，可单测）；
 *  - 视角预设（视图内小按钮组，本地 state viewMode）：透视3D（现状自由
 *    OrbitControls）/ 俯视（相机 (0,14,0.01) 看向原点，近平面前倾 0.01 防
 *    z-fight）/ 侧视（相机 (14,1.6,0) 看向原点）/ 第一人称（follow 语义本地
 *    镜像：复用 FollowRig，与 F 键同链路；切换后 OrbitControls 仍可自由拖，
 *    预设只是快捷位）。
 *
 * 第一人称 HUD（规划书 §5.4「FPS 式方向指示器」）：viewMode==='first'（或父面板
 * follow）时，把每个声源世界坐标投影到相机屏幕空间（vector.project(camera) →
 * NDC → 屏幕像素，100ms 节流）：屏幕内声源沿用 3D Html 名字标签并追加
 * 距离/方位角读数（dist=|Δp|、az=atan2(Δx,Δz)·180/π−yaw）；屏幕外声源在
 * 覆盖层（绝对定位全屏 pointer-events-none，createPortal 挂视图容器）画边缘
 * 方向箭头（距边缘 16px、指向该方向、标签=声源名，**全部声源**——FPS 敌人
 * 标记语义）；视角非 first 时覆盖层不渲染。
 *
 * 视角重置操作组（规划书模式 C 操作表 [重置视角] [回到中心] [俯瞰全局]）：
 * 重置视角/回到中心 = 相机回默认位 (6,8,10) 看原点 + viewMode 回 'persp' +
 * OrbitControls target 归零（ResetRig 按 token 触发，回到中心与重置视角语义
 * 合并为同一动作）；俯瞰全局 = 俯视预设（ViewPresetRig 既有 'top' 路径）。
 * 按钮恒可用（简化：不判断 disabled 态）。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import * as THREE from 'three'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { DragControls, Html, Line, OrbitControls } from '@react-three/drei'
import type { HSETheme } from '../hse-theme'
import type { AudioObject, ListenerState, TrajectoryKeyframes } from '../../src/spatial/types'
import { nextSourceIndex, sourceName } from './worldControl'

/** 房间尺寸（米）：x × y × z，中心在原点 */
const ROOM = { x: 20, y: 6, z: 20 }

/** 屏幕边缘内边距（px）：屏幕外声源方向箭头距视图边缘的距离（FPS 标记语义） */
const EDGE_MARGIN = 16

/** 视角预设（视图内小按钮组，本地 state；persp 为现状自由 OrbitControls） */
type ViewMode = 'persp' | 'top' | 'side' | 'first'

const VIEW_PRESETS: { mode: ViewMode; label: string }[] = [
  { mode: 'persp', label: '透视3D' },
  { mode: 'top', label: '俯视' },
  { mode: 'side', label: '侧视' },
  { mode: 'first', label: '第一人称' },
]

/** 模块级临时对象（拖拽矩阵分解用，避免每次拖拽结束新建） */
const TMP_POS = new THREE.Vector3()
const TMP_QUAT = new THREE.Quaternion()
const TMP_SCALE = new THREE.Vector3()

interface SpatialWorldViewProps {
  /** 世界漫游声源列表 */
  sources: AudioObject[]
  /** 听者实时状态（位置 + 欧拉朝向；仅用 position/yaw） */
  listener: ListenerState
  theme: HSETheme
  /** 位移增量事件（米，世界系）——父面板接线到 patchSpatialParams */
  onMove: (d: { x: number; y: number; z: number }) => void
  /** 偏航角增量事件（度，右正） */
  onRotate: (dYawDeg: number) => void
  /** 点击声源选中 / 取消（传 null） */
  onSelectSource: (id: string | null) => void
  /** 拖拽声源改位置（世界系，提交最终位置；缺省不启用拖拽，向后兼容）——
   *  父面板接线到 patchSpatialParams（sources 数组整段替换） */
  onMoveSource?: (id: string, position: { x: number; y: number; z: number }) => void
  /** 当前选中声源 id */
  selectedId: string | null
  /** 第一人称跟随：true 时 OrbitControls 目标每帧跟随听者（F 键由父面板切换） */
  follow?: boolean
  /** 轨迹数据（world.trajectories，已落地；缺省不画）——按 sourceId 匹配选中声源 */
  trajectories?: TrajectoryKeyframes[]
  /** 轨迹时间预览（秒，world.playhead）；提供时画轨迹上的插值亮点 */
  playhead?: number
}

/* ───────── 场景内子组件（仅在本文件使用，随 Canvas 挂载） ───────── */

/** 房间边界：半透明立方体线框（仅边，无对角线） */
function RoomBounds({ theme }: { theme: HSETheme }) {
  const edges = useMemo(
    () => new THREE.EdgesGeometry(new THREE.BoxGeometry(ROOM.x, ROOM.y, ROOM.z)),
    [],
  )
  return (
    <lineSegments geometry={edges}>
      <lineBasicMaterial color="#ffffff" transparent opacity={0.3} />
    </lineSegments>
  )
}

/** 地面：实体平面 + 网格线（网格色走中性灰，中心线用主题紫） */
function Ground({ theme }: { theme: HSETheme }) {
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} position={[0, -ROOM.y / 2, 0]}>
        <planeGeometry args={[ROOM.x, ROOM.z]} />
        <meshStandardMaterial color="#12121a" roughness={0.95} metalness={0} />
      </mesh>
      <gridHelper
        args={[ROOM.x, 20, theme.accentTo, '#2a2a36']}
        position={[0, -ROOM.y / 2 + 0.02, 0]}
      />
    </group>
  )
}

/** 声源：发光球体（accentFrom/accentTo 交替）；选中放大 + 地面光晕环 + 名字标签。
 *  提供 onMoveSource 时启用 drei DragControls 拖拽改位置（缺省不启用，向后兼容）：
 *  拖拽期间 drei 直接改写包裹 group 的矩阵（autoTransform，视觉即时跟随、无
 *  React 中间态），onDragEnd 读矩阵位置分量（= 自拖拽开始累计位移，世界系）+
 *  源位置一次性提交 onMoveSource；提交后父面板更新 sources prop，渲染位置与
 *  拖拽终点一致、无跳变（包裹矩阵保留累计位移，下次拖拽起点自动衔接）。 */
function SourceMarker({
  source,
  color,
  selected,
  onSelect,
  onMoveSource,
  onDragStateChange,
  listener,
  showReadout,
}: {
  source: AudioObject
  color: string
  selected: boolean
  onSelect: (id: string | null) => void
  onMoveSource?: (id: string, position: { x: number; y: number; z: number }) => void
  /**
   * 拖拽生命周期通知（O3 审计 P2：拖拽期间禁用 OrbitControls 避免争抢指针）。
   * dragStart→true、dragEnd→false；缺省（无 onMoveSource 时本组件不启用拖拽，
   * 此回调亦不触发）。
   */
  onDragStateChange?: (dragging: boolean) => void
  /** 听者状态（距离/方位角读数用；仅取 position/yaw） */
  listener: ListenerState
  /** 显示距离/方位角读数（第一人称 HUD 语义，规划书 §5.4 底部数值） */
  showReadout: boolean
}) {
  const radius = 0.3 + Math.max(0, Math.min(1, source.size)) * 0.22
  // DragControls 包裹 group 的 ref（onDragEnd 读其矩阵位置 = 累计拖拽位移）
  const dragGroupRef = useRef<THREE.Group>(null)
  /** 听者相对读数：距离 dist = |Δp|（米）；方位角 az = atan2(Δx,Δz)·180/π − yaw
   *  （与 fusion computeRelativeDirection 同约定，右正，归一到 [-180,180)） */
  const readout = useMemo(() => {
    const dx = source.position.x - listener.position.x
    const dy = source.position.y - listener.position.y
    const dz = source.position.z - listener.position.z
    const dist = Math.hypot(dx, dy, dz)
    const azDeg = ((Math.atan2(dx, dz) * 180) / Math.PI - listener.yaw + 540) % 360 - 180
    return `${dist.toFixed(1)}m · ${Math.round(azDeg)}°`
  }, [source.position, listener.position, listener.yaw])
  const marker = (
    <>
      <mesh
        scale={selected ? 1.35 : 1}
        onPointerDown={(e) => {
          // 拖拽启用时放行事件冒泡给 DragControls（gesture 需要收到 pointerdown）；
          // 缺省时截停，避免点击选源事件穿透到场景其它元素
          if (!onMoveSource) e.stopPropagation()
          onSelect(source.id)
        }}
      >
        <sphereGeometry args={[radius, 24, 24]} />
        <meshStandardMaterial
          color="#0a0a12"
          emissive={color}
          emissiveIntensity={selected ? 2.6 : 1.4}
          roughness={0.35}
          metalness={0.1}
        />
      </mesh>
      {selected && (
        <>
          {/* 地面光晕环（世界 y≈0 平面，随声源 x/z） */}
          <mesh rotation-x={-Math.PI / 2} position={[0, -source.position.y + 0.02, 0]}>
            <ringGeometry args={[radius * 1.7, radius * 2.2, 32]} />
            <meshBasicMaterial color={color} transparent opacity={0.5} side={THREE.DoubleSide} />
          </mesh>
          {/* 名字标签（HTML 叠加，不挡 3D 交互） */}
          <Html position={[0, radius + 1.1, 0]} center zIndexRange={[10, 0]} style={{ pointerEvents: 'none', userSelect: 'none' }}>
            <div
              className="px-2 py-0.5 rounded-md text-[11px] whitespace-nowrap flex flex-col items-center"
              style={{
                background: 'rgba(10,10,16,0.78)',
                border: `1px solid ${color}66`,
                color: '#fff',
                fontFamily: '"PingFang SC", "Microsoft YaHei", sans-serif',
              }}
            >
              <div>
                {sourceName(source.id)}
                <span style={{ opacity: 0.55 }}>
                  {' '}({source.position.x.toFixed(1)}, {source.position.y.toFixed(1)}, {source.position.z.toFixed(1)})
                </span>
              </div>
              {/* 第一人称读数：距离/方位角（规划书 §5.4 底部数值；仅 first/follow 时显示） */}
              {showReadout && <div style={{ opacity: 0.55 }}>{readout}</div>}
            </div>
          </Html>
        </>
      )}
    </>
  )
  // 缺省（无 onMoveSource）：普通静态 group，不启用拖拽交互（向后兼容）
  if (!onMoveSource) {
    return (
      <group position={[source.position.x, source.position.y, source.position.z]}>
        {marker}
      </group>
    )
  }
  return (
    <DragControls
      ref={dragGroupRef}
      onDragStart={() => onDragStateChange?.(true)}
      onDragEnd={() => {
        const g = dragGroupRef.current
        if (g) {
          // 包裹矩阵位置分量 = 自拖拽开始的累计位移（世界系）
          g.matrix.decompose(TMP_POS, TMP_QUAT, TMP_SCALE)
          onMoveSource(source.id, {
            x: source.position.x + TMP_POS.x,
            y: source.position.y + TMP_POS.y,
            z: source.position.z + TMP_POS.z,
          })
          // 提交后必须清零包裹矩阵：DragControls(autoTransform) 的累计位移残留在
          // matrix 里（matrixAutoUpdate=false 且从不清零）——提交后内层 group 已
          // 移到新位置，若包裹矩阵不清零，渲染位置 = 残留位移 + 新位置 = 旧位置
          // +2×位移（声球松手后朝拖拽方向再跳出一倍距离，且下次拖拽起点被污染）
          g.matrix.identity()
        }
        // 始终清除拖拽态（即便 g 缺失也不卡住 OrbitControls 禁用），恢复相机旋转
        onDragStateChange?.(false)
      }}
    >
      <group position={[source.position.x, source.position.y, source.position.z]}>
        {marker}
      </group>
    </DragControls>
  )
}

/** 听者：头部圆柱 + 朝向锥体（锥体绕 Y 旋转指向 yaw 方向） */
function ListenerMarker({ listener, theme }: { listener: ListenerState; theme: HSETheme }) {
  // forward = (sin yaw, 0, cos yaw)（与 worldControl/引擎 controller 同约定）
  const quat = useMemo(() => {
    const yaw = (listener.yaw * Math.PI) / 180
    const forward = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw))
    return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), forward)
  }, [listener.yaw])
  return (
    <group position={[listener.position.x, listener.position.y, listener.position.z]}>
      {/* 头部 */}
      <mesh position={[0, 0.4, 0]}>
        <cylinderGeometry args={[0.26, 0.34, 0.55, 20]} />
        <meshStandardMaterial
          color="#e8e8f0"
          emissive={theme.accentFrom}
          emissiveIntensity={0.35}
          roughness={0.5}
        />
      </mesh>
      {/* 朝向锥体 */}
      <mesh position={[0, 0.95, 0]} quaternion={quat}>
        <coneGeometry args={[0.2, 0.55, 16]} />
        <meshStandardMaterial
          color={theme.accentFrom}
          emissive={theme.accentFrom}
          emissiveIntensity={1.1}
          roughness={0.4}
        />
      </mesh>
    </group>
  )
}

/** 选中声源 ↔ 听者 距离虚线（drei Line，Line2 dashed） */
function DistanceLine({
  from,
  to,
  color,
}: {
  from: [number, number, number]
  to: [number, number, number]
  color: string
}) {
  return (
    <Line
      points={[from, to]}
      color={color}
      lineWidth={1}
      dashed
      dashSize={0.3}
      gapSize={0.2}
      transparent
      opacity={0.8}
    />
  )
}

/** 第一人称跟随：follow=true 时每帧把 OrbitControls 目标 lerp 到听者位置 */
function FollowRig({ follow, target, snapCamera }: { follow: boolean; target: THREE.Vector3; snapCamera?: boolean }) {
  const controls = useThree((s) => s.controls) as unknown as
    | { target: THREE.Vector3; update: () => void }
    | null
  const camera = useThree((s) => s.camera)
  const tmp = useRef(new THREE.Vector3())
  const tmp2 = useRef(new THREE.Vector3())
  useFrame(() => {
    if (!follow || !controls) return
    tmp.current.copy(target)
    controls.target.lerp(tmp.current, 0.12)
    // 第一人称（snapCamera）：相机同步贴到听者耳位后上方——原实现只移目标点，
    // 相机可仍停在 40m 外（maxDistance=40），屏幕投影/边缘箭头/距离读数全部基于
    // 远离头部的视点，「第一人称」名不副实。普通跟随（F 键）保持相机位置自由。
    if (snapCamera) {
      tmp2.current.copy(tmp.current).add(FIRST_PERSON_CAM_OFFSET)
      camera.position.lerp(tmp2.current, 0.12)
    }
    controls.update()
  })
  return null
}

/** 第一人称相机偏移（听者耳位后上方一点——贴头但不穿听者圆柱模型，保留
 *  OrbitControls 环视/推拉可用性；真 FPS 锁定相机后续按需再加） */
const FIRST_PERSON_CAM_OFFSET = new THREE.Vector3(0.6, 0.5, 1.8)

/**
 * 视角预设应用器：切到非 persp 模式时把相机摆到预设位（OrbitControls 目标回
 * 原点）；persp/第一人称不动作（第一人称走 FollowRig 本地镜像）。切换后
 * OrbitControls 仍可自由拖拽——预设只是快捷位，不是锁定模式。
 */
function ViewPresetRig({ viewMode }: { viewMode: ViewMode }) {
  const controls = useThree((s) => s.controls) as unknown as
    | { target: THREE.Vector3; update: () => void }
    | null
  const camera = useThree((s) => s.camera)
  useEffect(() => {
    if (viewMode === 'persp' || viewMode === 'first') return
    if (viewMode === 'top') {
      // 俯视：正上方向下看（近平面前倾 0.01 防与地面 z-fight）
      camera.position.set(0, 14, 0.01)
    } else {
      // 侧视：听者耳高（1.6m）正侧方向原点看
      camera.position.set(14, 1.6, 0)
    }
    if (controls) {
      controls.target.set(0, 0, 0)
      controls.update()
    }
  }, [viewMode, camera, controls])
  return null
}

/** 屏幕外声源的方向指示标记（FPS 敌人标记语义：边缘箭头 + 名称小字） */
interface EdgeMark {
  id: string
  name: string
  /** 箭头锚点（px，相对视图容器左上角；中心→投影点射线与内缩矩形交点） */
  x: number
  y: number
  /** 指向角（度）：屏幕坐标 atan2（y 向下 → 即 CSS rotate 顺时针角） */
  angleDeg: number
  color: string
}

/**
 * 第一人称方向指示器（规划书 §5.4：声源显示为 FPS 式方向箭头，屏幕边缘指示）。
 *
 * 每帧（100ms 节流）把每个声源世界坐标投影到相机屏幕空间：
 *   v.project(camera) → NDC（视锥内 z∈[-1,1]）；
 *   屏幕像素 x = (v.x+1)/2·w、y = (1−v.y)/2·h（注释公式：NDC 左下角为 (-1,-1)）。
 * 相机后方点（NDC.z>1）投影会镜像到屏幕另一侧——经屏幕中心反射恢复正确方向角。
 * 屏幕内（距边缘 EDGE_MARGIN 内）不画箭头（该声源可见，走 3D Html 标签）；
 * 屏幕外按「中心→投影点」射线与内缩矩形（EDGE_MARGIN 内边距）的交点画边缘
 * 箭头（rotate 指向 + 名称小字，**全部声源**——FPS 标记语义）。
 * 渲染经 createPortal 挂到视图容器：绝对定位全屏 pointer-events-none 覆盖层
 * （zIndex 10，低于小地图/按钮 20）。视角非 first（followActive=false）时由
 * 调用方条件挂载（不渲染覆盖层）。
 */
function FirstPersonMarkers({
  sources,
  theme,
  containerRef,
}: {
  sources: AudioObject[]
  theme: HSETheme
  /** 视图容器 ref（createPortal 挂载目标；覆盖层的定位上下文） */
  containerRef: { current: HTMLDivElement | null }
}) {
  const camera = useThree((s) => s.camera)
  const size = useThree((s) => s.size)
  const [marks, setMarks] = useState<EdgeMark[]>([])
  // useFrame 节流累积（100ms 节流，避免每帧 setState 高频重渲染）
  const accumRef = useRef(0)
  const tmpV = useRef(new THREE.Vector3())

  useFrame((_, delta) => {
    accumRef.current += delta
    if (accumRef.current < 0.1) return // 100ms 节流
    accumRef.current = 0
    const w = size.width
    const h = size.height
    if (w < 1 || h < 1) return // 视图尺寸未就绪
    const cx = w / 2
    const cy = h / 2
    const innerW = w / 2 - EDGE_MARGIN
    const innerH = h / 2 - EDGE_MARGIN
    const next: EdgeMark[] = []
    for (let i = 0; i < sources.length; i++) {
      const s = sources[i]
      // 世界坐标 → NDC（project 到相机裁剪空间）
      tmpV.current.set(s.position.x, s.position.y, s.position.z).project(camera)
      // NDC → 屏幕像素：x = (v.x+1)/2·w（左 0 右 w）；y = (1−v.y)/2·h（上 0 下 h，屏幕 y 向下）
      let sx = ((tmpV.current.x + 1) / 2) * w
      let sy = ((1 - tmpV.current.y) / 2) * h
      if (tmpV.current.z > 1) {
        // 相机后方的点投影镜像到屏幕另一侧：经屏幕中心反射恢复正确方向角（FPS 常规处理）
        sx = 2 * cx - sx
        sy = 2 * cy - sy
      }
      // 屏幕内（含边缘内边距）：不画箭头（该声源可见，走 3D Html 标签）
      if (sx >= EDGE_MARGIN && sx <= w - EDGE_MARGIN && sy >= EDGE_MARGIN && sy <= h - EDGE_MARGIN) continue
      // 中心 → 投影点方向（屏幕坐标，y 向下）
      const dx = sx - cx
      const dy = sy - cy
      if (dx === 0 && dy === 0) continue // 退化解（投影恰在屏幕中心且相机后方）：无方向可指
      // 射线与内缩矩形（距边缘 EDGE_MARGIN）的交点参数 t = min(两轴缩放)
      const t = Math.min(
        dx !== 0 ? innerW / Math.abs(dx) : Infinity,
        dy !== 0 ? innerH / Math.abs(dy) : Infinity,
      )
      // 箭头锚点 = 屏幕中心沿方向走 t 倍（距边缘恰好 EDGE_MARGIN）
      const ax = cx + dx * t
      const ay = cy + dy * t
      // 指向角：屏幕坐标 atan2（y 向下 → 正角即 CSS rotate 顺时针，箭头默认朝右）
      const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI
      next.push({
        id: s.id,
        name: sourceName(s.id),
        x: ax,
        y: ay,
        angleDeg,
        color: i % 2 === 0 ? theme.accentFrom : theme.accentTo,
      })
    }
    setMarks(next)
  })

  const container = containerRef.current
  if (!container) return null
  // 覆盖层挂到视图容器（绝对定位全屏，pointer-events-none 不挡 3D 交互）
  return createPortal(
    <div className="absolute inset-0 pointer-events-none select-none" style={{ zIndex: 10 }}>
      {marks.map((m) => (
        <div
          key={m.id}
          className="absolute flex flex-col items-center"
          style={{ left: m.x, top: m.y, transform: 'translate(-50%, -50%)' }}
        >
          {/* 方向箭头（三角，默认朝右；rotate 顺时针指向声源方向） */}
          <svg width={12} height={12} style={{ transform: `rotate(${m.angleDeg}deg)` }} aria-hidden="true">
            <path d="M1 1 L11 6 L1 11 Z" fill={m.color} />
          </svg>
          {/* 名称小字（FPS 标记语义：全部声源） */}
          <span
            className="text-[10px] whitespace-nowrap px-1 rounded"
            style={{
              background: 'rgba(8,8,14,0.72)',
              border: `1px solid ${m.color}55`,
              color: '#fff',
              fontFamily: '"PingFang SC", "Microsoft YaHei", sans-serif',
            }}
          >
            {m.name}
          </span>
        </div>
      ))}
    </div>,
    container,
  )
}

/**
 * 视角重置器（规划书模式 C 操作表 [重置视角] [回到中心]）：token 变化时把相机
 * 摆回默认位 (6,8,10) 看原点 + OrbitControls target 归零（回到中心语义与重置
 * 视角合并为同一动作——详见调用方 handleResetView）。俯瞰全局 = 俯视预设
 * （ViewPresetRig 既有 'top' 路径）。token=0 为初始值，挂载时不动作。
 */
function ResetRig({ token }: { token: number }) {
  const controls = useThree((s) => s.controls) as unknown as
    | { target: THREE.Vector3; update: () => void }
    | null
  const camera = useThree((s) => s.camera)
  useEffect(() => {
    if (token === 0) return // 初始挂载不动作（仅按钮触发）
    // 默认视角（与 Canvas camera prop position 一致）；OrbitControls.update 重算朝向
    camera.position.set(6, 8, 10)
    if (controls) {
      controls.target.set(0, 0, 0)
      controls.update()
    }
  }, [token, camera, controls])
  return null
}

/**
 * 拖拽期间禁用 OrbitControls（O3 审计 P2：DragControls 与 OrbitControls 争抢
 * 指针——拖拽声源时禁用相机旋转，结束恢复）。参照 SpatialSphereEditor
 * DragUpdater 的 `controls.enabled = dragIndex === null` 模式：controls 由
 * OrbitControls makeDefault 注册，挂载后 useThree 解析；effect 在 controls
 * 可用或 dragging 变化时重跑（controls 在 deps 内，makeDefault 完成后触发）。
 */
function OrbitControlsGate({ dragging }: { dragging: boolean }) {
  const controls = useThree((s) => s.controls) as unknown as { enabled: boolean } | null
  useEffect(() => {
    if (controls) controls.enabled = !dragging
  }, [controls, dragging])
  return null
}

/**
 * 轨迹关键帧 → 按时间 t（秒）线性插值的位置（世界系）。
 * keyframes 须按 t 升序（WorldPanel 添加关键帧时已排序）；t 越界取两端端点。
 * 返回 null 仅当关键帧为空。
 */
function interpolateTrajectory(
  keyframes: TrajectoryKeyframes['keyframes'],
  t: number,
): { x: number; y: number; z: number } | null {
  if (keyframes.length === 0) return null
  if (keyframes.length === 1) return keyframes[0].position
  const first = keyframes[0]
  const last = keyframes[keyframes.length - 1]
  if (t <= first.t) return first.position
  if (t >= last.t) return last.position
  for (let i = 0; i < keyframes.length - 1; i++) {
    const a = keyframes[i]
    const b = keyframes[i + 1]
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t
      const f = span > 0 ? (t - a.t) / span : 0
      return {
        x: a.position.x + (b.position.x - a.position.x) * f,
        y: a.position.y + (b.position.y - a.position.y) * f,
        z: a.position.z + (b.position.z - a.position.z) * f,
      }
    }
  }
  return last.position
}

/** 选中声源的 3D 轨迹：关键帧折线（accentTo 半透明）+ 关键帧小点 + playhead 插值亮点 */
function TrajectoryCurve({
  keyframes,
  color,
  playhead,
}: {
  keyframes: TrajectoryKeyframes['keyframes']
  color: string
  playhead?: number
}) {
  const points = useMemo(
    () => keyframes.map((k) => [k.position.x, k.position.y, k.position.z] as [number, number, number]),
    [keyframes],
  )
  const head = useMemo(
    () => (playhead === undefined ? null : interpolateTrajectory(keyframes, playhead)),
    [keyframes, playhead],
  )
  return (
    <group>
      {/* 关键帧折线（≥2 点才画线；点对点直线连接，可视化轨迹路径） */}
      {points.length >= 2 && (
        <Line
          points={points}
          color={color}
          lineWidth={1.5}
          transparent
          opacity={0.55}
        />
      )}
      {/* 关键帧小点 */}
      {keyframes.map((k, i) => (
        <mesh key={i} position={[k.position.x, k.position.y, k.position.z]}>
          <sphereGeometry args={[0.09, 12, 12]} />
          <meshBasicMaterial color={color} transparent opacity={0.9} />
        </mesh>
      ))}
      {/* playhead 插值亮点（白心 + 光晕） */}
      {head && (
        <group position={[head.x, head.y, head.z]}>
          <mesh>
            <sphereGeometry args={[0.16, 16, 16]} />
            <meshBasicMaterial color="#ffffff" />
          </mesh>
          <mesh>
            <sphereGeometry args={[0.3, 16, 16]} />
            <meshBasicMaterial color={color} transparent opacity={0.28} />
          </mesh>
        </group>
      )}
    </group>
  )
}

/* ───────── 小地图（右上角 2D 叠加，独立 raf 循环） ───────── */

function MinimapOverlay({
  sources,
  listener,
  theme,
  selectedId,
}: {
  sources: AudioObject[]
  listener: ListenerState
  theme: HSETheme
  selectedId: string | null
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // 最新 props 走 ref + 脏标记（数据/主题变化才重绘一次——原实现 60fps 常驻重绘，
  // 世界视图挂载即空烧；渲染循环只挂一次，由脏标记驱动）
  const propsRef = useRef({ sources, listener, theme, selectedId })
  propsRef.current = { sources, listener, theme, selectedId }
  const dirtyRef = useRef(true)
  dirtyRef.current = true

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    let width = 0
    let height = 0
    let raf = 0

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      width = Math.max(1, rect.width)
      height = Math.max(1, rect.height)
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      dirtyRef.current = true
    }
    resize()
    window.addEventListener('resize', resize)

    const draw = () => {
      // 脏标记驱动：数据/主题/尺寸未变时跳过绘制（rAF 空转一次函数调用的成本，
      // 远低于 60fps 全量重绘；数据变化在下帧生效 ≤16ms 延迟不可感）
      if (!dirtyRef.current) {
        raf = requestAnimationFrame(draw)
        return
      }
      dirtyRef.current = false
      const { sources: srcs, listener: lst, theme: th, selectedId: selId } = propsRef.current
      ctx.clearRect(0, 0, width, height)
      const pad = 12
      const half = ROOM.x / 2
      const scale = Math.min((width - pad * 2) / ROOM.x, (height - pad * 2) / ROOM.z)
      const cx = width / 2
      const cy = height / 2
      // 世界 (x, z) → 地图 (x, y)：画布上方 = 世界 +Z（前方，与环形编辑器同约定）
      const toMap = (x: number, z: number) => ({ x: cx + x * scale, y: cy - z * scale })

      // 房间边界 + 十字轴线
      ctx.strokeStyle = 'rgba(255,255,255,0.4)'
      ctx.lineWidth = 1
      ctx.strokeRect(cx - half * scale, cy - half * scale, ROOM.x * scale, ROOM.z * scale)
      ctx.strokeStyle = 'rgba(255,255,255,0.12)'
      ctx.setLineDash([3, 4])
      ctx.beginPath()
      ctx.moveTo(cx - half * scale, cy)
      ctx.lineTo(cx + half * scale, cy)
      ctx.moveTo(cx, cy - half * scale)
      ctx.lineTo(cx, cy + half * scale)
      ctx.stroke()
      ctx.setLineDash([])

      // 听者朝向扇形（yaw → 地图角：世界 forward (sin,cos) → 地图向量 (sin,−cos)）
      const l = toMap(lst.position.x, lst.position.z)
      const yawRad = (lst.yaw * Math.PI) / 180
      const baseAng = Math.atan2(-Math.cos(yawRad), Math.sin(yawRad))
      const fanR = Math.min(width, height) * 0.15
      const halfFan = 0.42 // ±24°
      ctx.beginPath()
      ctx.moveTo(l.x, l.y)
      ctx.arc(l.x, l.y, fanR, baseAng - halfFan, baseAng + halfFan)
      ctx.closePath()
      ctx.fillStyle = `${th.accentFrom}44`
      ctx.fill()
      ctx.strokeStyle = th.accentFrom
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(l.x, l.y)
      ctx.lineTo(l.x + Math.cos(baseAng) * fanR * 0.9, l.y + Math.sin(baseAng) * fanR * 0.9)
      ctx.stroke()

      // 声源点（accentFrom/accentTo 交替，选中放大 + 高亮环）
      srcs.forEach((s, i) => {
        const p = toMap(s.position.x, s.position.z)
        const color = i % 2 === 0 ? th.accentFrom : th.accentTo
        const sel = s.id === selId
        ctx.fillStyle = color
        ctx.beginPath()
        ctx.arc(p.x, p.y, sel ? 4.5 : 3.5, 0, Math.PI * 2)
        ctx.fill()
        if (sel) {
          ctx.strokeStyle = color
          ctx.lineWidth = 1.5
          ctx.beginPath()
          ctx.arc(p.x, p.y, 7, 0, Math.PI * 2)
          ctx.stroke()
        }
      })

      // 听者点 + 光环
      ctx.fillStyle = '#ffffff'
      ctx.beginPath()
      ctx.arc(l.x, l.y, 3, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = `${th.accentFrom}88`
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.arc(l.x, l.y, 5.5, 0, Math.PI * 2)
      ctx.stroke()

      raf = requestAnimationFrame(draw)
    }
    draw()
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
    }
  }, [])

  return (
    <div
      className="absolute top-2 right-2 rounded-lg overflow-hidden pointer-events-none select-none"
      style={{
        width: 148,
        height: 148,
        zIndex: 20,
        border: `1px solid ${theme.cardBorder}`,
        background: 'rgba(8,8,14,0.62)',
        backdropFilter: 'blur(6px)',
      }}
    >
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
      <div className="absolute top-1 left-1.5 text-[9px]" style={{ color: 'rgba(255,255,255,0.45)' }}>
        俯视 · 上=前方
      </div>
    </div>
  )
}

/* ───────── 主组件 ───────── */

export function SpatialWorldView({
  sources,
  listener,
  theme,
  onMove,
  onRotate,
  onSelectSource,
  onMoveSource,
  selectedId,
  follow = false,
  trajectories,
  playhead,
}: SpatialWorldViewProps) {
  const selected = useMemo(
    () => sources.find((s) => s.id === selectedId) ?? null,
    [sources, selectedId],
  )
  // 选中声源的轨迹（按 sourceId 匹配；缺省不画）
  const selectedTrajectory = useMemo(
    () => trajectories?.find((tr) => tr.sourceId === selectedId) ?? null,
    [trajectories, selectedId],
  )
  const listenerPos: [number, number, number] = [
    listener.position.x,
    listener.position.y,
    listener.position.z,
  ]
  const targetVec = useMemo(
    () => new THREE.Vector3(listener.position.x, listener.position.y, listener.position.z),
    [listener.position.x, listener.position.y, listener.position.z],
  )
  /** 视图容器 ref（FPS 方向指示器覆盖层 createPortal 的挂载目标） */
  const containerRef = useRef<HTMLDivElement>(null)

  /* ── 视角预设（本地 state；persp = 现状自由 OrbitControls） ── */
  const [viewMode, setViewMode] = useState<ViewMode>('persp')
  // 第一人称 = follow 语义本地镜像：复用 FollowRig（与 F 键同链路），仅当
  // 视角切到「第一人称」或父面板 follow（F 键）时激活
  const followActive = follow || viewMode === 'first'

  /* ── 视角重置操作组（[重置视角] [回到中心] [俯瞰全局]，规划书模式 C 操作表） ── */
  const [resetToken, setResetToken] = useState(0)

  /* ── 拖拽声源期间禁用 OrbitControls（O3 审计 P2：DragControls/OrbitControls
       争抢指针——dragStart→禁用相机旋转、dragEnd→恢复；OrbitControlsGate 消费） ── */
  const [dragging, setDragging] = useState(false)
  /** 重置视角/回到中心：相机回默认位 (6,8,10) 看原点 + viewMode 回 'persp' +
   *  OrbitControls target 归零（ResetRig 按 token 触发；回到中心语义与重置视角
   *  合并为同一动作）。俯瞰全局 = 俯视预设（setViewMode('top')，ViewPresetRig 摆相机） */
  const handleResetView = (): void => {
    setViewMode('persp')
    setResetToken((t) => t + 1)
  }

  /* ── Tab 循环选源：window keydown（最新 props 走 ref 防闭包陈旧，参照
       WorldPanel 键盘范式；卸载清理） ── */
  const sourcesRef = useRef(sources)
  sourcesRef.current = sources
  const selectedIdRef = useRef(selectedId)
  selectedIdRef.current = selectedId
  const onSelectSourceRef = useRef(onSelectSource)
  onSelectSourceRef.current = onSelectSource
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      // 组合键（Ctrl/Cmd/Alt）与表单聚焦时不劫持 Tab（保留焦点跳转语义）
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      e.preventDefault()
      const srcs = sourcesRef.current
      const next = nextSourceIndex(srcs, selectedIdRef.current)
      if (next < 0 || srcs[next].id === selectedIdRef.current) return // 空列表 / 仅 1 个时不变
      onSelectSourceRef.current(srcs[next].id)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div
      ref={containerRef}
      className="relative w-full overflow-hidden rounded-xl"
      style={{
        height: '100%',
        minHeight: 340,
        border: `1px solid ${theme.cardBorder}`,
        background: 'radial-gradient(120% 120% at 50% 0%, #14141c 0%, #0b0b11 62%)',
      }}
    >
      <Canvas
        camera={{ position: [6, 8, 10], fov: 45, near: 0.1, far: 100 }}
        dpr={[1, 2]}
        gl={{ antialias: true }}
      >
        <color attach="background" args={['#0b0b11']} />

        {/* 灯光：环境 + 主方向光 + 中央青色氛围点光 */}
        <ambientLight intensity={0.6} />
        <directionalLight position={[8, 12, 6]} intensity={1.1} />
        <pointLight position={[0, 4, 0]} intensity={8} distance={14} color={theme.accentFrom} />

        <Ground theme={theme} />
        <RoomBounds theme={theme} />

        {/* 声源（accentFrom/accentTo 交替发光；传 onMoveSource 时启用拖拽改位置） */}
        {sources.map((s, i) => (
          <SourceMarker
            key={s.id}
            source={s}
            color={i % 2 === 0 ? theme.accentFrom : theme.accentTo}
            selected={s.id === selectedId}
            onSelect={onSelectSource}
            onMoveSource={onMoveSource}
            onDragStateChange={setDragging}
            listener={listener}
            showReadout={followActive}
          />
        ))}

        {/* 听者头部标记 */}
        <ListenerMarker listener={listener} theme={theme} />

        {/* 选中声源 ↔ 听者 距离虚线 */}
        {selected && (
          <DistanceLine
            from={listenerPos}
            to={[selected.position.x, selected.position.y, selected.position.z]}
            color={theme.accentColor}
          />
        )}

        {/* 选中声源的 3D 轨迹曲线（关键帧折线 + 关键帧点 + playhead 插值亮点） */}
        {selectedTrajectory && selectedTrajectory.keyframes.length > 0 && (
          <TrajectoryCurve
            keyframes={selectedTrajectory.keyframes}
            color={theme.accentTo}
            playhead={playhead}
          />
        )}

        {/* 视角：左键拖拽旋转 = 转头语义（仅相机，不改听者 yaw）；F 键由父面板
            切换 follow，使目标跟随听者（第一人称简化实现）；视图内按钮组切
            预设（ViewPresetRig 摆相机，切换后仍可自由拖） */}
        <OrbitControls
          enablePan={false}
          target={[0, 0, 0]}
          minDistance={2}
          maxDistance={40}
          makeDefault
        />
        {/* 拖拽声源期间禁用 OrbitControls（O3 P2：DragControls 与相机旋转争抢指针） */}
        <OrbitControlsGate dragging={dragging} />
        <FollowRig follow={followActive} target={targetVec} snapCamera={viewMode === 'first'} />
        <ViewPresetRig viewMode={viewMode} />
        {/* 视角重置（token 触发相机回默认位 + target 归零；俯瞰全局走 'top' 预设） */}
        <ResetRig token={resetToken} />
        {/* 第一人称方向指示器（仅 first/follow 时挂载；非 first 视角不渲染覆盖层） */}
        {followActive && (
          <FirstPersonMarkers sources={sources} theme={theme} containerRef={containerRef} />
        )}
      </Canvas>

      {/* 右上角小地图（2D 叠加，不占 3D 场景） */}
      <MinimapOverlay sources={sources} listener={listener} theme={theme} selectedId={selectedId} />

      {/* 视角预设按钮组（小地图下方叠加，theme 风格小字按钮；点击只切相机快捷位） */}
      <div
        className="absolute right-2 flex gap-1"
        style={{ top: 162, zIndex: 20 }}
      >
        {VIEW_PRESETS.map((p) => {
          const active = viewMode === p.mode
          return (
            <button
              key={p.mode}
              type="button"
              onClick={() => setViewMode(p.mode)}
              title={p.label}
              className="px-2 py-1 rounded-md text-[10px] transition-all cursor-pointer"
              style={active
                ? { background: theme.accentGradient, color: '#fff' }
                : {
                    background: 'rgba(8,8,14,0.62)',
                    border: `1px solid ${theme.cardBorder}`,
                    color: theme.textSecondary,
                    backdropFilter: 'blur(6px)',
                  }}
            >
              {p.label}
            </button>
          )
        })}
      </div>

      {/* 重置视角操作组（规划书模式 C 操作表 [重置视角] [回到中心] [俯瞰全局]）：
          重置视角/回到中心语义合并（相机回默认位看原点 + 回 persp + target 归零，
          handleResetView）；俯瞰全局 = 俯视预设（ViewPresetRig 'top' 路径）。
          按钮恒可用（简化：不判断 disabled 态） */}
      <div
        className="absolute right-2 flex gap-1"
        style={{ top: 194, zIndex: 20 }}
      >
        <button
          type="button"
          onClick={handleResetView}
          title="重置视角：相机回默认位 (6,8,10) 看原点"
          className="px-2 py-1 rounded-md text-[10px] transition-all cursor-pointer"
          style={{
            background: 'rgba(8,8,14,0.62)',
            border: `1px solid ${theme.cardBorder}`,
            color: theme.textSecondary,
            backdropFilter: 'blur(6px)',
          }}
        >
          重置视角
        </button>
        <button
          type="button"
          onClick={handleResetView}
          title="回到中心：与重置视角同语义（相机回默认位、目标归零）"
          className="px-2 py-1 rounded-md text-[10px] transition-all cursor-pointer"
          style={{
            background: 'rgba(8,8,14,0.62)',
            border: `1px solid ${theme.cardBorder}`,
            color: theme.textSecondary,
            backdropFilter: 'blur(6px)',
          }}
        >
          回到中心
        </button>
        <button
          type="button"
          onClick={() => setViewMode('top')}
          title="俯瞰全局：俯视预设（相机 (0,14,0.01) 看原点）"
          className="px-2 py-1 rounded-md text-[10px] transition-all cursor-pointer"
          style={{
            background: 'rgba(8,8,14,0.62)',
            border: `1px solid ${theme.cardBorder}`,
            color: theme.textSecondary,
            backdropFilter: 'blur(6px)',
          }}
        >
          俯瞰全局
        </button>
      </div>
    </div>
  )
}
