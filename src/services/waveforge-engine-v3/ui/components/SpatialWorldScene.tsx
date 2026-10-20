/** 三维场景只消费音频坐标；所有渲染/拖动统一经 toScene/fromScene 转换。 */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { Html, Line, OrbitControls, RoundedBox } from '@react-three/drei'
import * as THREE from 'three'
import type { AudioObject, ListenerState, TrajectoryKeyframes } from '../../src/spatial/types'
import { toScene, fromScene, sourceReadout, fitSceneDistance, layoutSpatialLabels, type SpatialSceneFrame } from './spatialViewModel'
import './spatial-world-view.css'

export type WorldViewMode = 'persp' | 'top' | 'side' | 'first'
export type SpatialDragMode = 'horizontal' | 'height'
export type CameraCommand = { type: 'fit' | 'focus' | 'in' | 'out'; serial: number }
export const SCENE_COLORS = { backdrop: '#edf3ef', horizon: '#e6ede7', floor: '#edf1e9', base: '#cedbd1', wall: '#e0e9df', panel: '#c4d2bf', grid: '#a1b4a7', ink: '#153a37', white: '#fffef8', line: '#547563' }
export type SceneColors = typeof SCENE_COLORS

function FloorGrid({ frame, colors }: { frame: SpatialSceneFrame; colors: SceneColors }) {
  const geometry = useMemo(() => {
    const values: number[] = [], step = frame.gridStep
    for (let x = Math.ceil(frame.minX / step) * step; x <= frame.maxX; x += step) values.push(x, 0.012, frame.minZ, x, 0.012, frame.maxZ)
    for (let z = Math.ceil(frame.minZ / step) * step; z <= frame.maxZ; z += step) values.push(frame.minX, 0.012, z, frame.maxX, 0.012, z)
    return new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(values, 3))
  }, [frame.minX, frame.maxX, frame.minZ, frame.maxZ, frame.gridStep])
  useEffect(() => () => geometry.dispose(), [geometry])
  return <lineSegments geometry={geometry}><lineBasicMaterial color={colors.grid} transparent opacity={0.45} depthWrite={false} /></lineSegments>
}

/** 开放的空间示意台：有材质、地面和背景参照，近侧不设墙，始终能看见听者。 */
function SpatialEnvironment({ frame, colors, first }: { frame: SpatialSceneFrame; colors: SceneColors; first: boolean }) {
  const { camera } = useThree()
  const backMaterial = useRef<THREE.MeshStandardMaterial>(null), sideMaterial = useRef<THREE.MeshStandardMaterial>(null)
  const panels = useRef<THREE.Group>(null)
  const cx = (frame.minX + frame.maxX) / 2, cz = (frame.minZ + frame.maxZ) / 2
  const wallHeight = Math.max(3.2, Math.min(5, frame.maxY + 0.5))
  const panelCount = Math.min(20, Math.max(5, Math.floor(frame.width / 0.85)))
  useFrame(() => {
    const behind = camera.position.z < frame.minZ
    if (backMaterial.current) backMaterial.current.opacity = behind ? 0.12 : 1
    if (sideMaterial.current) sideMaterial.current.opacity = camera.position.x < frame.minX ? 0.12 : first ? 0.5 : 0.78
    if (panels.current) panels.current.visible = !behind
  })
  return <>
    <color attach="background" args={[colors.backdrop]} />
    <fog attach="fog" args={[colors.backdrop, Math.max(30, frame.radius * 3), Math.max(80, frame.radius * 6)]} />
    <hemisphereLight args={['#fffdf5', '#92ad9e', 1.6]} />
    <ambientLight intensity={0.35} />
    <directionalLight castShadow position={[-3, 12, 7]} intensity={2} color="#fff9e9"
      shadow-mapSize={[1024, 1024]} shadow-bias={-0.0003} shadow-normalBias={0.03}
      shadow-camera-left={-frame.radius} shadow-camera-right={frame.radius} shadow-camera-top={frame.radius}
      shadow-camera-bottom={-frame.radius} shadow-camera-far={frame.radius * 5 + 30} />
    <directionalLight position={[6, 5, -8]} intensity={0.8} color="#e7f5ee" />
    <mesh rotation-x={-Math.PI / 2} position={[cx, -0.24, cz]} receiveShadow>
      <planeGeometry args={[Math.max(250, frame.width * 5), Math.max(250, frame.depth * 5)]} />
      <meshStandardMaterial color={colors.horizon} roughness={1} />
    </mesh>
    <RoundedBox args={[frame.width + 0.25, 0.2, frame.depth + 0.25]} radius={0.09} smoothness={3} position={[cx, -0.115, cz]} receiveShadow>
      <meshStandardMaterial color={colors.base} roughness={0.9} />
    </RoundedBox>
    <mesh rotation-x={-Math.PI / 2} position={[cx, 0, cz]} receiveShadow>
      <planeGeometry args={[frame.width, frame.depth]} />
      <meshStandardMaterial color={colors.floor} roughness={0.95} transparent opacity={0.94} />
    </mesh>
    <FloorGrid frame={frame} colors={colors} />
    {/* 背景只做坐标示意；不作为混响求解的物理墙面。 */}
    <RoundedBox args={[frame.width + 0.25, wallHeight, 0.18]} radius={0.07} smoothness={3}
      position={[cx, wallHeight / 2, frame.minZ - 0.12]} receiveShadow>
      <meshStandardMaterial ref={backMaterial} color={colors.wall} roughness={0.9} transparent depthWrite={false} />
    </RoundedBox>
    <RoundedBox args={[0.18, wallHeight * 0.65, frame.depth + 0.25]} radius={0.07} smoothness={3}
      position={[frame.minX - 0.12, wallHeight * 0.325, cz]} receiveShadow>
      <meshStandardMaterial ref={sideMaterial} color={colors.wall} roughness={0.95} transparent opacity={first ? 0.5 : 0.78} depthWrite={false} />
    </RoundedBox>
    <group ref={panels}>{Array.from({ length: panelCount }, (_, index) => <RoundedBox key={index}
      args={[Math.min(0.45, frame.width / panelCount * 0.5), wallHeight * 0.5, 0.08]} radius={0.03} smoothness={2}
      position={[frame.minX + (index + 0.5) * frame.width / panelCount, wallHeight * 0.58, frame.minZ + 0.015]}>
      <meshStandardMaterial color={colors.panel} roughness={0.95} />
    </RoundedBox>)}</group>
    <mesh position={[cx, 0.08, frame.minZ + 0.035]}>
      <boxGeometry args={[frame.width - 0.1, 0.025, 0.035]} /><meshBasicMaterial color="#b8d9c7" />
    </mesh>
    {!first && <>
      <FloorLabel position={[cx, 0.035, frame.minZ + 0.5]}>前方 +Z</FloorLabel>
      <FloorLabel position={[frame.maxX - 0.55, 0.035, cz]} rotation={Math.PI / 2}>右侧 +X</FloorLabel>
    </>}
  </>
}

function FloorLabel({ position, rotation = 0, children }: { position: [number, number, number]; rotation?: number; children: string }) {
  return <Html position={position} transform rotation={[-Math.PI / 2, 0, rotation]} distanceFactor={5} center zIndexRange={[3, 0]} style={{ pointerEvents: 'none' }}>
    <span className="hse-spatial-floor-label">{children}</span>
  </Html>
}

function ListenerFigure({ listener, colors }: { listener: ListenerState; colors: SceneColors }) {
  const heading = -listener.yaw * Math.PI / 180
  return <group position={toScene(listener.position)} rotation-y={heading}>
    {/* 头部与耳机明确区分听者和音箱；耳位就是参数中的 listener.position。 */}
    <group rotation={[listener.pitch * Math.PI / 180, 0, -listener.roll * Math.PI / 180]}>
      <mesh castShadow scale={[0.86, 1, 0.9]}><sphereGeometry args={[0.23, 24, 20]} /><meshStandardMaterial color={colors.white} roughness={0.68} /></mesh>
      <mesh position={[0, -0.015, -0.213]} rotation-x={Math.PI / 2} castShadow><coneGeometry args={[0.055, 0.1, 12]} /><meshStandardMaterial color={colors.white} /></mesh>
      <mesh position={[0, 0.035, 0]}><torusGeometry args={[0.26, 0.027, 8, 32, Math.PI]} /><meshStandardMaterial color="#236b59" roughness={0.6} /></mesh>
      {[-1, 1].map(side => <RoundedBox key={side} args={[0.085, 0.18, 0.15]} radius={0.035} smoothness={3} position={[side * 0.23, -0.015, 0]} castShadow><meshStandardMaterial color="#236b59" roughness={0.65} /></RoundedBox>)}
    </group>
    <mesh position={[0, -0.29, 0]} castShadow><cylinderGeometry args={[0.095, 0.11, 0.18, 16]} /><meshStandardMaterial color={colors.white} /></mesh>
    <mesh position={[0, -0.69, 0.03]} castShadow><capsuleGeometry args={[0.28, 0.36, 6, 16]} /><meshStandardMaterial color="#98b4a0" roughness={0.85} /></mesh>
    {[-1, 1].map(side => <group key={side}>
      <mesh position={[side * 0.14, -1.2, 0.05]} castShadow><capsuleGeometry args={[0.1, 0.4, 4, 12]} /><meshStandardMaterial color="#6a887b" roughness={0.9} /></mesh>
      <RoundedBox args={[0.18, 0.1, 0.32]} radius={0.045} smoothness={3} position={[side * 0.14, -1.52, -0.04]} castShadow><meshStandardMaterial color={colors.white} /></RoundedBox>
    </group>)}
    <Html position={[0, 0.48, 0]} center zIndexRange={[7, 0]} style={{ pointerEvents: 'none' }}><span className="hse-spatial-listener-label">听者<span>{Math.round(listener.yaw)}°</span></span></Html>
  </group>
}

function ListenerReference({ listener, colors }: { listener: ListenerState; colors: SceneColors }) {
  const shape = useMemo(() => new THREE.Shape().moveTo(0, 0).lineTo(-0.75, 1.6).lineTo(0.75, 1.6).closePath(), [])
  return <group position={[listener.position.x, 0.022, -listener.position.z]} rotation-y={-listener.yaw * Math.PI / 180}>
    <mesh rotation-x={-Math.PI / 2}><circleGeometry args={[0.56, 64]} /><meshBasicMaterial color={colors.white} /></mesh>
    <mesh rotation-x={-Math.PI / 2} position={[0, 0.002, 0]}><ringGeometry args={[0.51, 0.55, 64]} /><meshBasicMaterial color="#387d68" transparent opacity={0.6} /></mesh>
    <mesh rotation-x={-Math.PI / 2} position={[0, 0.001, 0]}><shapeGeometry args={[shape]} /><meshBasicMaterial color="#5ea48a" transparent opacity={0.1} depthWrite={false} /></mesh>
    {[1, 2].map(radius => <mesh key={radius} rotation-x={-Math.PI / 2} position={[0, 0.002, 0]}><ringGeometry args={[radius - 0.008, radius + 0.008, 96]} /><meshBasicMaterial color={colors.line} transparent opacity={0.22} depthWrite={false} /></mesh>)}
    <mesh position={[0, 0.02, -1.3]} rotation-x={-Math.PI / 2}><coneGeometry args={[0.085, 0.22, 3]} /><meshBasicMaterial color="#387d68" /></mesh>
  </group>
}

function SourceMarker({ source, label, route, index, listener, selected, first, dragMode, showLabel, onSelect, onMove, onDragState }: {
  source: AudioObject; label: string; route: string; index: number; listener: ListenerState; selected: boolean
  first: boolean; dragMode: SpatialDragMode; showLabel: boolean; onSelect: (id: string | null) => void
  onMove?: (id: string, position: { x: number; y: number; z: number }) => void; onDragState: (value: boolean) => void
}) {
  const { camera, gl, size } = useThree(), [hovered, setHovered] = useState(false)
  const raycaster = useRef(new THREE.Raycaster())
  const drag = useRef<{ plane: THREE.Plane; offset: THREE.Vector3; origin: AudioObject['position']; clientY: number; units: number } | null>(null)
  const muted = source.gain <= 0, color = muted ? '#536b66' : route === 'R' ? '#416986' : route === 'M' ? '#765b35' : route === 'S' ? '#63657d' : '#006a63'
  const readout = sourceReadout(source.position, listener)
  const markerScale = Math.min(1.85, Math.max(0.7, readout.distance * 0.28 + 0.3))
  const compact = !showLabel && !selected && !hovered
  const end = () => { drag.current = null; onDragState(false) }
  useEffect(() => {
    const stop = () => { if (drag.current) { drag.current = null; onDragState(false) } }
    window.addEventListener('blur', stop); window.addEventListener('pointerup', stop, true); window.addEventListener('pointercancel', stop, true)
    return () => { window.removeEventListener('blur', stop); window.removeEventListener('pointerup', stop, true); window.removeEventListener('pointercancel', stop, true); stop() }
  }, [onDragState])
  const rayAt = (x: number, y: number) => {
    const rect = gl.domElement.getBoundingClientRect()
    raycaster.current.setFromCamera(new THREE.Vector2((x - rect.left) / rect.width * 2 - 1, -(y - rect.top) / rect.height * 2 + 1), camera)
    return raycaster.current.ray
  }
  const start = (ray: THREE.Ray, clientY: number) => {
    onSelect(source.id)
    if (first || !onMove) return false
    const position = new THREE.Vector3(...toScene(source.position))
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -position.y)
    const hit = ray.intersectPlane(plane, new THREE.Vector3())
    if (dragMode === 'horizontal' && !hit) return false
    drag.current = { plane, offset: hit ? position.clone().sub(hit) : new THREE.Vector3(), origin: { ...source.position }, clientY,
      units: camera.position.distanceTo(position) * 2 * Math.tan((camera as THREE.PerspectiveCamera).fov * Math.PI / 360) / Math.max(1, size.height) }
    onDragState(true); return true
  }
  const move = (ray: THREE.Ray, clientY: number) => {
    const state = drag.current
    if (!state || !onMove) return
    if (dragMode === 'height') onMove(source.id, { ...state.origin, y: Math.max(-100, Math.min(100, state.origin.y + (state.clientY - clientY) * state.units)) })
    else {
      const hit = ray.intersectPlane(state.plane, new THREE.Vector3())
      if (hit) { hit.add(state.offset); const point = fromScene(hit); onMove(source.id, { x: Math.max(-100, Math.min(100, point.x)), y: state.origin.y, z: Math.max(-100, Math.min(100, point.z)) }) }
    }
  }
  const capture = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation()
    if (event.button === 0 && start(event.ray, event.clientY)) (event.target as unknown as Element).setPointerCapture(event.pointerId)
  }
  const startLabel = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    event.stopPropagation(); event.currentTarget.focus({ preventScroll: true })
    if (start(rayAt(event.clientX, event.clientY), event.clientY)) event.currentTarget.setPointerCapture(event.pointerId)
  }
  const yaw = Math.atan2(listener.position.x - source.position.x, source.position.z - listener.position.z)
  const y = source.position.y
  return <group position={toScene(source.position)}>
    <group rotation-y={yaw} scale={markerScale} onPointerDown={capture} onPointerMove={event => { if (drag.current) { event.stopPropagation(); move(event.ray, event.clientY) } }}
      onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end} onPointerOver={event => { event.stopPropagation(); setHovered(true) }} onPointerOut={() => setHovered(false)}>
      <RoundedBox args={[0.5, 0.66, 0.36]} radius={0.075} smoothness={3} castShadow>
        <meshStandardMaterial color={selected ? '#91b3a2' : '#d4dace'} roughness={0.62} metalness={0.05} transparent opacity={muted ? 0.55 : 1} />
      </RoundedBox>
      <mesh position={[0, -0.08, 0.188]}><circleGeometry args={[0.165, 40]} /><meshStandardMaterial color={color} roughness={0.72} /></mesh>
      <mesh position={[0, -0.08, 0.194]}><torusGeometry args={[0.128, 0.016, 8, 40]} /><meshStandardMaterial color="#243f35" roughness={0.9} /></mesh>
      <mesh position={[0, -0.08, 0.2]}><sphereGeometry args={[0.07, 16, 12]} /><meshStandardMaterial color="#335749" roughness={0.8} /></mesh>
      <mesh position={[0, 0.2, 0.19]}><circleGeometry args={[0.05, 20]} /><meshStandardMaterial color="#354b40" roughness={0.8} /></mesh>
      <mesh position={[0.16, 0.24, 0.19]}><circleGeometry args={[0.012, 12]} /><meshBasicMaterial color={muted ? '#91a49b' : '#51997a'} /></mesh>
    </group>
    <Line points={[[0, -y + 0.035, 0], [0, -0.34 * markerScale, 0]]} color={color} lineWidth={selected ? 1.3 : 0.7} dashed dashSize={0.09} gapSize={0.08} transparent opacity={selected ? 0.65 : 0.25} />
    <mesh position={[0, -y + 0.025, 0]} rotation-x={-Math.PI / 2}><circleGeometry args={[selected ? 0.36 : 0.21, 40]} /><meshBasicMaterial color={color} transparent opacity={selected ? 0.18 : 0.1} depthWrite={false} /></mesh>
    <mesh position={[0, -y + 0.03, 0]} rotation-x={-Math.PI / 2}><ringGeometry args={[selected ? 0.31 : 0.16, selected ? 0.34 : 0.18, 40]} /><meshBasicMaterial color={color} transparent opacity={selected ? 0.8 : 0.4} depthWrite={false} /></mesh>
    {/* 标签避让只平移按钮；透明容器不参与命中，避免它挡住其他声源或场景拖动。 */}
    <Html position={[0, compact ? 0.5 : 1.55, 0]} center zIndexRange={[selected ? 9 : 6, 0]} style={{ pointerEvents: 'none' }}>
      <button type="button" className={`hse-spatial-source-label ${selected ? 'is-selected' : ''} ${compact ? 'is-compact' : ''}`} data-spatial-source={source.id}
        aria-label={`选择${label}`} aria-pressed={selected} style={{ '--source-color': color, pointerEvents: 'auto' } as React.CSSProperties}
        onClick={() => onSelect(source.id)} onPointerDown={startLabel}
        onPointerMove={event => { if (drag.current) { event.stopPropagation(); move(rayAt(event.clientX, event.clientY), event.clientY) } }}
        onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}>
        <span className="hse-spatial-source-index">{compact ? index + 1 : route || index + 1}</span>
        {!compact && <span><strong>{label}</strong>{(selected || hovered || first || muted) && <small>{muted ? '静音' : `${readout.distance.toFixed(1)} m · ${readout.direction}`}</small>}</span>}
      </button>
    </Html>
  </group>
}

function CameraRig({ view, command, frame, listener, selected, dragging, follow, layoutKey }: { view: WorldViewMode; command: CameraCommand
  frame: SpatialSceneFrame; listener: ListenerState; selected?: AudioObject; dragging: boolean; follow: boolean; layoutKey: string }) {
  const { camera, controls, size, gl } = useThree()
  const orbit = controls as unknown as { target: THREE.Vector3; enabled: boolean; update: () => void } | null
  const state = useRef({ frame, listener, selected, size }); state.current = { frame, listener, selected, size }
  const orientation = useRef(new THREE.Euler(0, 0, 0, 'YXZ'))
  const lastCommand = useRef(-1)
  const forward = useRef(new THREE.Vector3()), position = useRef(new THREE.Vector3()), lastFollow = useRef(new THREE.Vector3(...toScene(listener.position)))
  useEffect(() => { if (orbit) orbit.enabled = !dragging && view !== 'first' }, [orbit, dragging, view])
  useEffect(() => {
    if (!orbit || view === 'first') return
    const newCommand = lastCommand.current !== command.serial
    lastCommand.current = command.serial
    const { frame: box, listener: head, selected: source, size: viewport } = state.current
    camera.up.set(0, 1, 0)
    if (newCommand && (command.type === 'in' || command.type === 'out')) {
      camera.position.sub(orbit.target).multiplyScalar(command.type === 'in' ? 0.8 : 1.25).add(orbit.target)
      orbit.update(); return
    }
    const target = command.type === 'focus' && source ? new THREE.Vector3(...toScene(source.position)) : new THREE.Vector3(...box.center)
    const radius = command.type === 'focus' && source ? Math.max(1.6, Math.min(3, sourceReadout(source.position, head).distance * 0.5)) : box.radius
    const verticalFov = (camera as THREE.PerspectiveCamera).fov * Math.PI / 180
    const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * viewport.width / Math.max(1, viewport.height))
    const direction = view === 'top' ? new THREE.Vector3(0, 1, 0.001) : view === 'side' ? new THREE.Vector3(1, 0.14, 0) : new THREE.Vector3(0.7, 0.38, 1.25)
    const distance = command.type === 'focus' && source ? radius / Math.sin(Math.min(verticalFov, horizontalFov) / 2) * 1.12
      : fitSceneDistance(box, direction.toArray(), verticalFov, viewport.width / Math.max(1, viewport.height))
    if (view === 'top') camera.up.set(0, 0, -1)
    camera.position.copy(direction.normalize().multiplyScalar(distance).add(target)); orbit.target.copy(target); orbit.update()
    lastFollow.current.set(...toScene(head.position))
  }, [view, command.serial, orbit, camera, size.width, size.height, layoutKey])
  useFrame(() => {
    if (!orbit) return
    if (view === 'first') {
      orientation.current.set(listener.pitch * Math.PI / 180, -listener.yaw * Math.PI / 180, -listener.roll * Math.PI / 180, 'YXZ')
      position.current.set(...toScene(listener.position)); camera.position.copy(position.current)
      camera.up.set(0, 1, 0).applyEuler(orientation.current)
      forward.current.set(0, 0, -1).applyEuler(orientation.current).add(position.current)
      orbit.target.copy(forward.current); camera.lookAt(forward.current)
    } else if (follow && !dragging) {
      position.current.set(...toScene(listener.position)).sub(lastFollow.current)
      camera.position.add(position.current); orbit.target.add(position.current); lastFollow.current.set(...toScene(listener.position)); orbit.update()
    }
    // 供真实窗口检查渲染帧；无持续 React setState 或每帧消息。
    if (gl.domElement.dataset.spatialView !== view) gl.domElement.dataset.spatialView = view
  })
  return null
}

/** Html 只负责投影；少量标注在屏幕上避让，连线保留它与真实声源的关联。 */
function LabelLayout({ dragging }: { dragging: boolean }) {
  const { gl } = useThree(), elapsed = useRef(0), offsets = useRef(new WeakMap<HTMLButtonElement, { x: number; y: number }>())
  useFrame((_, delta) => {
    elapsed.current += delta
    if (elapsed.current < 0.1 || dragging) return
    elapsed.current = 0
    const viewport = gl.domElement.closest<HTMLElement>('[data-spatial-viewport]')
    if (!viewport) return
    const bounds = viewport.getBoundingClientRect()
    const buttons = Array.from(viewport.querySelectorAll<HTMLButtonElement>('[data-spatial-source]'))
    const anchors = buttons.map(button => {
      const rect = button.getBoundingClientRect(), id = button.dataset.spatialSource!, previous = offsets.current.get(button) ?? { x: 0, y: 0 }
      return { id, x: rect.x - bounds.x - previous.x, y: rect.y - bounds.y - previous.y, width: rect.width, height: rect.height, selected: button.getAttribute('aria-pressed') === 'true' }
    })
    const reserved = Array.from(viewport.querySelectorAll<HTMLElement>('.hse-spatial-listener-label, .hse-spatial-view-selection, .hse-spatial-scene-caption, .hse-spatial-camera-actions')).map((element, i) => {
      const rect = element.getBoundingClientRect(); return { id: `reserved-${i}`, x: rect.x - bounds.x, y: rect.y - bounds.y, width: rect.width, height: rect.height }
    })
    const next = layoutSpatialLabels(anchors, bounds, reserved)
    for (const button of buttons) {
      const point = next.get(button.dataset.spatialSource!)!
      button.style.translate = `${point.x.toFixed(1)}px ${point.y.toFixed(1)}px`
      button.style.setProperty('--sv-leader-length', `${Math.hypot(point.x, point.y).toFixed(1)}px`)
      button.style.setProperty('--sv-leader-angle', `${Math.atan2(-point.y, -point.x)}rad`)
      offsets.current.set(button, point)
    }
  })
  return null
}

function Trajectory({ data, playhead }: { data: TrajectoryKeyframes; playhead?: number }) {
  const points = data.keyframes.map(frame => toScene(frame.position))
  let head = data.keyframes[0]?.position
  if (playhead !== undefined) for (let i = 0; i < data.keyframes.length; i++) {
    const a = data.keyframes[i], b = data.keyframes[i + 1]
    head = a.position
    if (!b || playhead <= a.t) break
    if (playhead < b.t) { const t = (playhead - a.t) / (b.t - a.t); head = { x: a.position.x + (b.position.x - a.position.x) * t, y: a.position.y + (b.position.y - a.position.y) * t, z: a.position.z + (b.position.z - a.position.z) * t }; break }
  }
  return <group>{points.length >= 2 && <Line points={points} color="#6e8fba" lineWidth={1.6} dashed dashSize={0.12} gapSize={0.07} />}
    {points.map((point, index) => <mesh key={index} position={point}><sphereGeometry args={[0.055, 10, 8]} /><meshBasicMaterial color="#6e8fba" /></mesh>)}
    {head && playhead !== undefined && <mesh position={toScene(head)}><sphereGeometry args={[0.1, 12, 10]} /><meshBasicMaterial color="#416ba0" /></mesh>}
  </group>
}

export function SpatialWorldScene({ sources, sourceLabels, sourceRoutes, listener, selectedId, onSelectSource, onMoveSource, frame,
  view, command, dragMode, onDragState, dragging, colors, follow = false, trajectories, playhead, showGuides }: {
  sources: AudioObject[]; sourceLabels?: Record<string, string>; sourceRoutes?: Record<string, string>; listener: ListenerState
  selectedId: string | null; onSelectSource: (id: string | null) => void; onMoveSource?: (id: string, position: AudioObject['position']) => void
  frame: SpatialSceneFrame; view: WorldViewMode; command: CameraCommand; dragMode: SpatialDragMode; onDragState: (value: boolean) => void
  dragging: boolean; colors: SceneColors; follow?: boolean; trajectories?: TrajectoryKeyframes[]; playhead?: number; showGuides: boolean
}) {
  const selected = sources.find(source => source.id === selectedId)
  const trajectory = trajectories?.find(item => item.sourceId === selectedId)
  return <>
    <SpatialEnvironment frame={frame} colors={colors} first={view === 'first'} />
    {showGuides && <ListenerReference listener={listener} colors={colors} />}
    {view !== 'first' && <ListenerFigure listener={listener} colors={colors} />}
    {sources.map((source, index) => <SourceMarker key={source.id} source={source} index={index} route={sourceRoutes?.[source.id] ?? ''}
      label={sourceLabels?.[source.id] ?? source.id} listener={listener} selected={selectedId === source.id} first={view === 'first'}
      dragMode={dragMode} showLabel={sources.length <= 8} onSelect={onSelectSource} onMove={onMoveSource} onDragState={onDragState} />)}
    {selected && showGuides && <Line points={[toScene(listener.position), toScene(selected.position)]} color="#328674" lineWidth={1.4} dashed dashSize={0.13} gapSize={0.08} transparent opacity={0.65} />}
    {trajectory && <Trajectory data={trajectory} playhead={playhead} />}
    <OrbitControls makeDefault enablePan={view !== 'first'} enableDamping dampingFactor={0.12} minDistance={0.7} maxDistance={Math.max(80, frame.radius * 6)}
      maxPolarAngle={Math.PI * 0.495} minPolarAngle={0.01} enabled={!dragging && view !== 'first'} />
    <CameraRig view={view} command={command} frame={frame} listener={listener} selected={selected} dragging={dragging} follow={follow} layoutKey={sources.map(source => source.id).join('|')} />
    <LabelLayout dragging={dragging} />
  </>
}
