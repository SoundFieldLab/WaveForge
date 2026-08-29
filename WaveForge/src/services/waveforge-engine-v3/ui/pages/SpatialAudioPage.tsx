/**
 * 空间音频页 —— Power 按钮 + 模式选择器 + 四模式面板（独立顶级选项卡）
 *
 * 从 SpatialPage 拆分而来（SpatialPage 现仅保留混响/3D环绕/立体声宽度等
 * V3EngineParams 效果卡）。本页只承载空间音频（Spatial Audio）：双耳渲染的
 * 4 档模式（instant/headLocked/world/stage）+ 标准/专业视图切换 +
 * 设置弹窗入口。状态走 V3EngineParams.spatial（EngineV3 第 15 级内联）。
 *
 * 视图模式：标准视图（卡片流，默认）/ 专业视图（四象限工作室布局，窄窗
 * < 900px 自动回退标准视图 useProViewEligible）。
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Radio, Headphones, Clapperboard, Volume2, Settings, Power } from 'lucide-react'
import { GlassCard, Toggle, Slider, Segmented, RangeStyle } from '../components/Primitives'
import { SpatialModeVisual } from '../components/SpatialModeVisual'
import { SpatialRingEditor } from '../components/SpatialRingEditor'
import { SpatialSphereEditor } from '../components/SpatialSphereEditor'
import { WorldPanel } from '../components/WorldPanel'
import { SpatialWorldView } from '../components/SpatialWorldView'
import StagePanel from '../components/StagePanel'
import SpatialStudioLayout, { useProViewEligible } from '../components/SpatialStudioLayout'
import SpatialSettingsModal from '../components/SpatialSettingsModal'
import { moveListener, rotateListener } from '../../src/spatial/controller'
import { stageSpeakers } from '../../src/spatial/scenes'
import type { HSETheme } from '../hse-theme'
import type { V3UiBridge } from '../bridge'
import type { V3ParamsController } from '../hooks'
import type { SpatialMode, DeepPartial, HeadLockedSettings, SpeakerRoute, VirtualSpeakerCfg } from '../../src/spatial/types'
import type { PlaybackTimeStore } from '../../../../audio/playbackTimeStore'
import { createDefaultSpatialParams } from '../../src/spatial/types'
import { createDefaultSpatialSettings } from '../../src/types'
import type { SpatialSettings } from '../../src/types'
import { createLayoutSpeakers, headLockedSpeakers } from '../../src/spatial/layouts'
// 共享常量（O3 审计：消除与 SpatialStudioLayout 的重复定义，单事实源见 spatialConstants.ts）
import { HEAD_LOCKED_LAYOUTS, SPATIAL_ROOM_OPTIONS } from '../components/spatialConstants'

interface SpatialAudioPageProps {
  bridge: V3UiBridge
  /** V3 引擎参数控制器：空间音频参数在 V3EngineParams.spatial（EngineV3 第 15 级内联）。 */
  controller: V3ParamsController
  theme: HSETheme
  onOpenEffect: (key: string) => void
  /** 播放时钟 store（可选）：透传给 WorldPanel「随曲目播放」；缺省 = 独立运行无播放器 */
  playbackTimeStore?: PlaybackTimeStore
}

/* ── 空间音频：模式选择 + 模式 A（一键空间化）/ 模式 B（头锁定环绕） ──
 *   模式选择器只列 4 档（instant/headLocked/world/stage）；on/off 由顶部
 *   Power 按钮负责（关闭态点击 → 默认开启 instant）。 */
const SPATIAL_MODES: { value: SpatialMode; label: string }[] = [
  { value: 'instant', label: '一键空间化' },
  { value: 'headLocked', label: '头锁定环绕' },
  { value: 'world', label: '世界漫游' },
  { value: 'stage', label: '舞台影院' },
]

/** 开发中（禁用）的模式：四模式已全量实现，暂留空集占位 */
const SPATIAL_DEV_MODES: ReadonlySet<SpatialMode> = new Set<SpatialMode>([])

/** 视图模式：标准（现状卡片流）/ 专业（四象限工作室布局） */
const SPATIAL_VIEWS: { value: 'standard' | 'pro'; label: string }[] = [
  { value: 'standard', label: '标准视图' },
  { value: 'pro', label: '专业视图' },
]

/** 模式 B 编辑器视图（规划书 §5.3：2D 环形保留为默认，3D 球形为新增视图） */
const HEAD_LOCKED_EDITOR_VIEWS: { value: 'ring' | 'sphere'; label: string }[] = [
  { value: 'ring', label: '2D 环形' },
  { value: 'sphere', label: '3D 球形' },
]

export default function SpatialAudioPage({ bridge, controller, theme, playbackTimeStore }: SpatialAudioPageProps) {
  /* ── 空间音频（V3EngineParams.spatial，EngineV3 第 15 级内联） ── */
  const { params, patch } = controller
  const spatial: SpatialSettings = params.spatial ?? createDefaultSpatialSettings()

  /* ── 视图模式：标准（默认）/ 专业四象限；窄窗（< 900px）回退标准视图 ── */
  const [viewMode, setViewMode] = useState<'standard' | 'pro'>('standard')
  const proEligible = useProViewEligible()
  const proActive = viewMode === 'pro' && proEligible

  /** 设置弹窗开关（专业视图工具栏「设置」按钮） */
  const [settingsOpen, setSettingsOpen] = useState(false)

  /** 模式 B 编辑器视图（仅 UI 状态不持久化）：2D 环形（默认）/ 3D 球形
   *  （规划书 §5.3 新增）；两视图共用 speakers/onChange 链路 */
  const [headLockedEditorView, setHeadLockedEditorView] = useState<'ring' | 'sphere'>('ring')

  /* 空间激活态与各模式命中（顶级选项卡直接渲染：模式由 spatial.mode 驱动，
     模式选择器始终展示，Power 按钮负责 on/off） */
  const spatialActive = spatial.mode !== 'off'
  const instantActive = spatial.mode === 'instant'
  const headLockedActive = spatial.mode === 'headLocked'
  const worldActive = spatial.mode === 'world'
  const stageActive = spatial.mode === 'stage'

  /** 深合并写入空间参数（V3EngineParams.spatial，EngineV3 第 15 级内联） */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const patchSpatial = (p: any): void => {
    patch({ spatial: { ...spatial, ...p } })
  }

  /** Power 开关（顶部 Power 按钮）：on/off 两态。
   *  - 关闭态（mode==='off'）→ 开启默认 instant（一键空间化）；
   *  - 开启态（mode!=='off'）→ 关闭（mode='off'）。 */
  const handlePowerToggle = (): void => {
    patchSpatial({ mode: spatialActive ? 'off' : 'instant' })
  }

  /* ── 模式 A 补全：切入 instant 时 2s 轻量过渡提示（showToast 事件，与 IR 导入提示同机制） ── */
  /** 过渡动画触发信号：模式从非 instant 切入 instant 时自增（初始 0），
   *  驱动 SpatialModeVisual 播放 2s「空间化过渡动画」（L/R 波形从耳机飘出
   *  扩散到扬声器，示意声音从颅内→颅内外渐变）；与 toast 提示双通道并存 */
  const [transitionKey, setTransitionKey] = useState(0)
  const prevModeRef = useRef(spatial.mode)
  useEffect(() => {
    const prev = prevModeRef.current
    prevModeRef.current = spatial.mode
    if (spatial.mode === 'instant' && prev !== 'instant') {
      window.dispatchEvent(new CustomEvent('showToast', {
        detail: { message: '已切换至一键空间化：立体声展开为双耳虚拟声场', type: 'info' },
      }))
      // 双通道并存：toast 文案提示 + transitionKey 自增触发画布过渡动画
      setTransitionKey((k) => k + 1)
    }
  }, [spatial.mode])

  /* ── 模式 C（世界漫游）：本地 UI 状态 + 事件接线 ── */
  const [selectedWorldId, setSelectedWorldId] = useState<string | null>(null)
  const [firstPerson, setFirstPerson] = useState(false)

  /* ── 状态栏实数据（专业视图）：引擎延迟（getStats().engineLatencySamples）500ms
     轮询 + rAF 帧率测量（CPU 占用的直观代理——无独立 worklet 统计） ── */
  const [statusInfo, setStatusInfo] = useState<{ latencyMs: number | null; fps: number | null }>({ latencyMs: null, fps: null })
  useEffect(() => {
    if (!proActive) return
    let disposed = false
    let frames = 0
    let fpsWindowStart = performance.now()
    let fps = 0
    const tickFrame = (): void => {
      frames++
      const now = performance.now()
      if (now - fpsWindowStart >= 1000) {
        fps = Math.round((frames * 1000) / (now - fpsWindowStart))
        frames = 0
        fpsWindowStart = now
      }
      if (!disposed) rafId = requestAnimationFrame(tickFrame)
    }
    let rafId = requestAnimationFrame(tickFrame)
    const statsTimer = window.setInterval(() => {
      const stats = bridge.getStats()
      const lat = stats?.engineLatencySamples
      const fs = 48000 // EngineV3 构造采样率（AudioContext 标准采样率；仅用于样本→毫秒换算）
      setStatusInfo({
        latencyMs: Number.isFinite(lat) && lat > 0 ? Math.round((lat / fs) * 1000) : 0,
        fps,
      })
    }, 500)
    return () => {
      disposed = true
      cancelAnimationFrame(rafId)
      window.clearInterval(statsTimer)
    }
  }, [proActive, bridge])

  /** 位移增量（世界系米）→ 引擎听者位置（controller.moveListener 不可变更新） */
  const handleWorldMove = (d: { x: number; y: number; z: number }): void => {
    patchSpatial({ world: { listener: moveListener(spatial.world.listener, d) } })
  }

  /** 偏航增量（度，右正）→ 引擎听者朝向（wrap 到 [-180,180)） */
  const handleWorldRotate = (dYawDeg: number): void => {
    patchSpatial({ world: { listener: rotateListener(spatial.world.listener, dYawDeg) } })
  }

  /** R 键：听者回默认位姿（原点 1.6m 高、朝前） */
  const handleWorldReset = (): void => {
    patchSpatial({ world: { listener: createDefaultSpatialSettings().world.listener } })
  }

  /** 拖拽声源改位置（世界系）：按 id 局部替换后数组整段回传（patch 深合并语义） */
  const handleWorldMoveSource = (id: string, position: { x: number; y: number; z: number }): void => {
    patchSpatial({
      world: {
        sources: spatial.world.sources.map((s) => (s.id === id ? { ...s, position } : s)),
      },
    })
  }

  /** 模式 B：切换布局预设（同步 speakers 列表，作为自定义编辑起点） */
  const handleHeadLockedLayout = (layout: HeadLockedSettings['layout']): void => {
    const patchObj: DeepPartial<HeadLockedSettings> = { layout }
    if (layout !== 'custom') {
      // 切到预设布局：同步 headLocked.speakers（数组整段替换；预设渲染仍走预设表）
      patchObj.speakers = createLayoutSpeakers(layout)
    }
    patchSpatial({ headLocked: patchObj })
  }

  /** 模式 B：扬声器列表编辑统一入口——预设布局下任何 speakers 修改都切到
   *  "自定义"承接（headLockedSpeakers 在预设分支忽略 speakers 字段，不转
   *  custom 改动不生效；预设定义不变，随时可重新选回） */
  const patchSpeakers = (next: VirtualSpeakerCfg[]): void => {
    patchSpatial(spatial.headLocked.layout === 'custom'
      ? { headLocked: { speakers: next } }
      : { headLocked: { layout: 'custom', speakers: next } })
  }

  const handleChangeSpeaker = (index: number, patchCfg: Partial<VirtualSpeakerCfg>): void => {
    patchSpeakers(spatial.headLocked.speakers.map((s, i) => (i === index ? { ...s, ...patchCfg } : s)))
  }

  /** 模式 B：删除第 index 只自定义扬声器（编辑器保证至少保留 1 只） */
  const handleDeleteSpeaker = (index: number): void => {
    patchSpeakers(spatial.headLocked.speakers.filter((_, i) => i !== index))
  }

  /** 模式 B：添加自定义扬声器（上限 16 只；新增点避开已有方位角——固定 0° 与
   *  预设 C 声道重合会导致拾取二义/极难选中） */
  const handleAddSpeaker = (): void => {
    const cur = spatial.headLocked.speakers
    if (cur.length >= 16) return
    const used = new Set(cur.map((s) => Math.round(s.azimuthDeg / 15) * 15))
    let az = 15
    while (used.has(az) && az < 360) az += 15
    if (az >= 360) az = 15
    patchSpeakers([...cur, { azimuthDeg: az, elevationDeg: 0, distance: 2, gain: 1, size: 0 }])
  }

  /** 模式 B：修改第 index 只扬声器的输入路由（数组整段替换；缺失项按方位角默认补齐
   *  ——az≤0→'l'、az>0→'r'，与 fusion 缺省语义一致，补齐后 routes 与 speakers 等长） */
  const handleChangeRoute = (index: number, route: SpeakerRoute): void => {
    const next = spatial.headLocked.speakers.map((s, i) =>
      spatial.headLocked.routes[i] ?? (s.azimuthDeg <= 0 ? 'l' : 'r'),
    )
    next[index] = route
    patchSpatial({ headLocked: { routes: next } })
  }

  /** 模式 B：切换第 index 只自定义扬声器的静音状态（右键菜单「静音/取消静音」）。
   *  muted 存于扬声器配置内（缺失视为未静音）——整段重建 speakers 数组，
   *  muted 布尔显式写回（muted:false 保留键位，与 VirtualSpeakerCfg.muted 缺省
   *  语义一致）；Solo 的「其它全 muted」归一化由编辑器逐只调用本函数完成。 */
  const handleToggleMuted = (index: number): void => {
    patchSpeakers(spatial.headLocked.speakers.map((s, i) =>
      i === index ? { ...s, muted: !(s.muted === true) } : s,
    ))
  }

  /** 模式 B：Solo 第 index 只扬声器（右键菜单「Solo」）——基于当前 params
   *  一次性构建目标数组（其它 muted=true、本只 muted=false），单次 patch。
   *
   *  修复 O3 审计 P1：编辑器旧 handleSolo 逐只调 handleToggleMuted，而后者闭包读
   *  spatial（React state，事件内不更新）构建 next 数组——后一次覆盖前一次，Solo
   *  多扬声器时仅末只生效。本回调绕过闭包陈旧，从当前快照一次性提交目标态，
   *  编辑器 handleSolo 优先走本路径（缺省回退逐只翻转，向后兼容）。 */
  const handleSoloSpeaker = (index: number): void => {
    patchSpeakers(spatial.headLocked.speakers.map((s, i) =>
      i === index ? { ...s, muted: false } : { ...s, muted: true },
    ))
  }

  /** 模式 B：复制第 index 只自定义扬声器并追加到列表尾部（右键菜单「复制」；
   *  上限 16，复用 handleAddSpeaker 的容量检查；routes 保持原长——融合层对
   *  长度不足按方位角就近补齐，不强制对齐，见 fusion headLocked 分支） */
  const handleDuplicateSpeaker = (index: number): void => {
    const cur = spatial.headLocked.speakers
    if (cur.length >= 16) return
    if (index < 0 || index >= cur.length) return
    patchSpeakers([...cur, { ...cur[index] }])
  }

  /* ════════════════ 模式面板渲染器（标准/专业视图共用，不重写编辑交互） ════════════════ */

  /** 模式选择器（标准视图行 / 专业视图工具栏复用同一份） */
  const modeSelector = (): ReactNode => (
    <div className="flex flex-wrap gap-1.5 mb-2">
      {SPATIAL_MODES.map((m) => {
        const isActive = spatial.mode === m.value
        const isDev = SPATIAL_DEV_MODES.has(m.value)
        return (
          <button
            key={m.value}
            type="button"
            disabled={isDev}
            onClick={() => patchSpatial({ mode: m.value })}
            className={`relative flex-1 min-w-[74px] py-2 rounded-xl text-xs transition-all ${isDev ? 'cursor-not-allowed opacity-45' : 'cursor-pointer'} ${isActive ? 'text-white font-medium' : theme.textSecondary}`}
            style={isActive
              ? { background: theme.accentGradient, boxShadow: `0 4px 14px ${theme.accentColor}44` }
              : { backgroundColor: 'rgba(255,255,255,0.06)' }}
          >
            {m.label}
            {isDev && (
              <span
                className="absolute -top-1 -right-1 px-1 py-px rounded text-[8px] leading-none"
                style={{ backgroundColor: 'rgba(255,255,255,0.12)', color: 'rgba(255,255,255,0.5)' }}
              >
                开发中
              </span>
            )}
          </button>
        )
      })}
    </div>
  )

  /**
   * 模式 A 核心（标准/专业共用）：俯视可视化 + 输入格式检测 + 展开/强度滑块。
   * 房间模拟/混响走 roomControls()（标准视图模式 A 卡 / 专业视图右下面板分别挂载）。
   */
  const instantCore = (): ReactNode => (
    <div className="space-y-1">
      <SpatialModeVisual
        spreadDeg={spatial.instant.spreadDeg}
        amount={spatial.instant.amount}
        active={instantActive}
        theme={theme}
        transitionKey={transitionKey}
        onSpreadChange={(v) => patchSpatial({ instant: { spreadDeg: v } })}
      />
      {/* 输入格式检测（本波静态显示；多声道输入自动检测后续 wave） */}
      <div className="flex items-center justify-between px-1">
        <span className={`${theme.textTertiary} text-[11px]`}>输入格式</span>
        <span className={`hse-mono ${theme.textSecondary} text-[11px]`}>Stereo (2ch)</span>
      </div>
      <Slider
        label="展开角度" value={spatial.instant.spreadDeg} min={20} max={120} step={1}
        onChange={(v) => patchSpatial({ instant: { spreadDeg: v } })}
        display={`${Math.round(spatial.instant.spreadDeg)}°`} theme={theme}
      />
      <Slider
        label="空间化强度" value={Math.round(spatial.instant.amount * 100)} min={0} max={100} step={1}
        onChange={(v) => patchSpatial({ instant: { amount: v / 100 } })}
        display={`${Math.round(spatial.instant.amount * 100)}%`} theme={theme}
      />
    </div>
  )

  /** 房间环境控制（标准视图模式 A 卡；非 stage 模式房间路径统一走 instant.room/roomAmount） */
  const roomControls = (): ReactNode => (
    <div>
      <div className="mb-2">
        <div className={`${theme.textSecondary} text-xs mb-1`}>房间模拟</div>
        <Segmented options={SPATIAL_ROOM_OPTIONS} value={spatial.instant.room} onChange={(v) => patchSpatial({ instant: { room: v } })} theme={theme} small />
      </div>
      <Slider
        label="房间混响" value={Math.round(spatial.instant.roomAmount * 100)} min={0} max={100} step={1}
        onChange={(v) => patchSpatial({ instant: { roomAmount: v / 100 } })}
        display={`${Math.round(spatial.instant.roomAmount * 100)}%`} theme={theme}
      />
    </div>
  )

  /** 模式 B 核心（标准/专业共用）：顶置/底部仰角层开关（7.1.4）+ 编辑器
   *  （2D 环形默认 / 3D 球形新增，视图 Segmented 切换）；布局预设见各自视图挂载 */
  const headLockedCore = (): ReactNode => (
    <>
      {(spatial.headLocked.layout === '714' || spatial.headLocked.layout === '514') && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 mb-2">
          <div className="flex items-center gap-2">
            <span className={`${theme.textSecondary} text-xs`}>顶部仰角层（4 顶置扬声器）</span>
            <Toggle
              checked={spatial.headLocked.heightLayer}
              onChange={(v) => patchSpatial({ headLocked: { heightLayer: v } })}
              theme={theme}
            />
          </div>
          {spatial.headLocked.layout === '714' && (
            <div className="flex items-center gap-2">
              <span className={`${theme.textSecondary} text-xs`}>底部仰角层（2 底部扬声器）</span>
              <Toggle
                checked={spatial.headLocked.bottomLayer}
                onChange={(v) => patchSpatial({ headLocked: { bottomLayer: v } })}
                theme={theme}
              />
            </div>
          )}
        </div>
      )}
      {/* 编辑器视图切换（模式 B 区块）：2D 环形（默认，现状）/ 3D 球形（规划书
          §5.3 新增）——纯 UI 状态不持久化；两视图共用 speakers/onChange 链路 */}
      <div className="mb-2">
        <Segmented
          options={HEAD_LOCKED_EDITOR_VIEWS}
          value={headLockedEditorView}
          onChange={(v) => setHeadLockedEditorView(v)}
          theme={theme}
          small
        />
      </div>
      {headLockedEditorView === 'sphere' ? (
        <SpatialSphereEditor
          speakers={spatial.headLocked.speakers}
          editable={true} // 预设布局直接可编辑（编辑动作自动转自定义承接）
          onChangeSpeaker={handleChangeSpeaker}
          onDeleteSpeaker={handleDeleteSpeaker}
          onAddSpeaker={handleAddSpeaker}
          theme={theme}
        />
      ) : (
        <SpatialRingEditor
          speakers={spatial.headLocked.speakers}
          editable={true} // 预设布局直接可编辑（编辑动作自动转自定义承接）
          onChangeSpeaker={handleChangeSpeaker}
          onDeleteSpeaker={handleDeleteSpeaker}
          onAddSpeaker={handleAddSpeaker}
          routes={spatial.headLocked.routes}
          onChangeRoute={handleChangeRoute}
          muted={spatial.headLocked.speakers.map((s) => s.muted === true)}
          onToggleMuted={handleToggleMuted}
          onSoloSpeaker={handleSoloSpeaker}
          onDuplicateSpeaker={handleDuplicateSpeaker}
          theme={theme}
        />
      )}
    </>
  )

  /**
   * 遮挡/衍射（§4.7 简化模型）：world.occlusion（0..1）经 fusion
   * spatialConfigFromParams 透传为 SpatialRenderConfig.occlusionAmount——
   * 增益衰减 + 高频低通（引擎后端已支持），下方滑块 0..100% 直写 world.occlusion。
   */
  const worldCore = (): ReactNode => (
    <>
      <div className="relative h-[340px] mb-3 rounded-xl overflow-hidden">
        <SpatialWorldView
          sources={spatial.world.sources}
          listener={spatial.world.listener}
          theme={theme}
          onMove={handleWorldMove}
          onRotate={handleWorldRotate}
          onSelectSource={setSelectedWorldId}
          onMoveSource={handleWorldMoveSource}
          selectedId={selectedWorldId}
          follow={firstPerson}
          trajectories={spatial.world.trajectories}
          playhead={spatial.world.playhead}
        />
      </div>
      <WorldPanel
        params={spatial.world}
        listener={spatial.world.listener}
        sources={spatial.world.sources}
        theme={theme}
        selectedId={selectedWorldId}
        onChange={(patch) => patchSpatial({ world: patch })}
        onSelectSource={setSelectedWorldId}
        onMove={handleWorldMove}
        onRotate={handleWorldRotate}
        onReset={handleWorldReset}
        onToggleFirstPerson={() => setFirstPerson((v) => !v)}
        onTogglePlayback={() => { /* 播放由主播放器驱动，空间层不再独立控制 */ }}
        keymap={(spatial as any).keymap}
        playbackTimeStore={playbackTimeStore}
      />

      {/* 遮挡/衍射（§4.7 简化模型）：增益衰减 + 高频低通，经 fusion 透传后端 */}
      <div className="mt-2">
        <Slider
          label="遮挡"
          value={Math.round(spatial.world.occlusion * 100)}
          min={0}
          max={100}
          step={1}
          onChange={(v) => patchSpatial({ world: { occlusion: v / 100 } })}
          display={`${Math.round(spatial.world.occlusion * 100)}%`}
          theme={theme}
        />
      </div>
    </>
  )

  /** 模式 D 核心（标准/专业共用）：场景卡片网格 + 座位 + 房间/氛围滑块 */
  const stageCore = (): ReactNode => (
    <StagePanel
      params={spatial.stage}
      theme={theme}
      onChange={(patch) => patchSpatial({ stage: patch })}
    />
  )

  return (
    <div className="space-y-4">
      <RangeStyle theme={theme} />

      {/* 空间音频（Spatial Audio）：Power 按钮 + 模式选择器 + 四模式面板 */}
      <GlassCard theme={theme}>
        {/* 头部行：标题 + Power 开关 + 视图切换（标准/专业）+ 状态徽标 */}
        <div className="flex items-center justify-between mb-3 gap-3">
          <div className="flex items-center gap-2">
            <Radio className="w-4 h-4" style={{ color: theme.accentColor }} />
            <span className={`${theme.textPrimary} text-sm font-medium`}>空间音频</span>
          </div>
          <div className="flex items-center gap-2">
            {/* Power 开关（on/off 两态，仿主页系统音效 Power 按钮）：
                关闭态（mode==='off'）= accent 衬底 + 高亮图标（呼应用户开启）；
                开启态 = 灰衬底 + 淡图标。点击：off→instant(默认一键空间化)/on→off。 */}
            <button
              type="button"
              onClick={handlePowerToggle}
              className="p-2 rounded-full transition-colors"
              style={{ background: spatialActive ? 'rgba(255,255,255,0.06)' : `${theme.accentColor}33` }}
              title={spatialActive ? '关闭空间音频' : '开启空间音频'}
            >
              <Power className="w-4 h-4" style={{ color: spatialActive ? 'rgba(255,255,255,0.35)' : theme.accentColor }} />
            </button>
            {/* 视图模式切换：专业视图 = 四象限工作室布局（窄窗 <900px 自动回退标准视图） */}
            <div className="w-[220px] shrink-0">
              <Segmented
                options={SPATIAL_VIEWS}
                value={viewMode}
                onChange={(v) => setViewMode(v)}
                theme={theme}
                small
              />
            </div>
            {/* 状态徽标 */}
            <span className={`flex items-center gap-1.5 text-[11px] ${spatialActive ? theme.textSecondary : theme.textMuted}`}>
              <span
                className="w-2 h-2 rounded-full"
                style={spatialActive
                  ? { background: theme.accentGradient, boxShadow: `0 0 10px ${theme.accentColor}cc` }
                  : { backgroundColor: 'rgba(255,255,255,0.28)' }}
              />
              {spatialActive ? '已开启' : '已关闭'}
            </span>
          </div>
        </div>

        {/* 专业视图：顶部工具栏（模式选择器复用 + 输出设备 + 设置弹窗入口）。
            原播放/暂停按钮为空操作占位（播放由主播放器驱动，空间页拿不到播放
            控制），已移除——假按钮比没有按钮更误导 */}
        {proActive ? (
          <div className="flex items-center gap-2 mb-3">
            {/* 模式选择器（复用标准视图同款） */}
            <div className="flex-1 min-w-0">{modeSelector()}</div>
            {/* 输出设备（状态展示；枚举/切换在设置弹窗「输出设备」区） */}
            <div
              className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px]"
              style={{ backgroundColor: theme.inputBg, border: `1px solid ${theme.cardBorder}`, color: theme.textSecondary }}
            >
              <Volume2 className="w-3.5 h-3.5" />
              {(spatial as any).sinkId ? '已选设备' : '默认耳机'}
            </div>
            {/* 设置弹窗入口 */}
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] transition-all hover:brightness-110"
              style={{ backgroundColor: theme.inputBg, border: `1px solid ${theme.cardBorder}`, color: theme.textSecondary }}
            >
              <Settings className="w-3.5 h-3.5" />
              设置
            </button>
          </div>
        ) : (
          /* 标准视图：模式选择器（on/off 由 Power 按钮负责，选择器只列 4 档） */
          modeSelector()
        )}

        {instantActive && (
          <p className={`${theme.textTertiary} text-[11px] mb-1`}>
            双耳渲染：把立体声展开到身前 ±{Math.round(spatial.instant.spreadDeg / 2)}° 的虚拟声场，增强临场感。
          </p>
        )}

        {/* 专业视图：四象限工作室布局（左面板摘要 + 中央模式视图 + 环境与设置 + 状态栏） */}
        {proActive ? (
          <SpatialStudioLayout
            mode={spatial.mode}
            theme={theme}
            spatial={spatial as any}
            onPatch={patchSpatial}
            onHeadLockedLayout={handleHeadLockedLayout}
            selectedWorldId={selectedWorldId}
            onSelectWorld={setSelectedWorldId}
            status={statusInfo}
          >
            {instantActive && instantCore()}
            {headLockedActive && headLockedCore()}
            {worldActive && worldCore()}
            {stageActive && stageCore()}
            {!spatialActive && (
              <div className="flex flex-col items-center justify-center py-20 text-center">
                <Radio className="w-8 h-8 mb-3 opacity-30" style={{ color: theme.accentColor }} />
                <span className={`${theme.textTertiary} text-xs`}>空间音频未开启——选择上方模式开始双耳渲染</span>
              </div>
            )}
          </SpatialStudioLayout>
        ) : (
          /* 标准视图（现状）：模式 A 面板（主卡内）+ 模式 B/C/D 独立卡片 */
          <>
            {/* 模式 A：一键空间化控制面板 */}
            {instantActive && (
              <div className="space-y-1">
                {instantCore()}
                {roomControls()}
              </div>
            )}

            {/* 模式 B：头锁定环绕（插在模式 A 面板之后） */}
            {headLockedActive && (
              <GlassCard theme={theme}>
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <Headphones className="w-4 h-4" style={{ color: theme.accentColor }} />
                    <span className={`${theme.textPrimary} text-sm font-medium`}>头锁定环绕</span>
                  </div>
                  <span className={`hse-mono ${theme.textTertiary} text-[11px]`}>
                    {headLockedSpeakers(spatial.headLocked).length} 扬声器
                  </span>
                </div>
                <p className={`${theme.textTertiary} text-[11px] mb-2`}>
                  双耳环绕：立体声输入按方位路由到环绕虚拟扬声器，声场固定于头部（耳机听感）。
                </p>

                {/* 布局预设 */}
                <div className="mb-2">
                  <div className={`${theme.textSecondary} text-xs mb-1`}>布局预设</div>
                  <Segmented
                    options={HEAD_LOCKED_LAYOUTS}
                    value={spatial.headLocked.layout}
                    onChange={(v) => handleHeadLockedLayout(v)}
                    theme={theme}
                    small
                  />
                </div>

                {headLockedCore()}
              </GlassCard>
            )}

            {/* 模式 C：世界漫游（3D 自由漫游 + 小地图 + WASD 操作） */}
            {worldActive && (
              <GlassCard theme={theme}>
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <Radio className="w-4 h-4" style={{ color: theme.accentColor }} />
                    <span className={`${theme.textPrimary} text-sm font-medium`}>世界漫游</span>
                  </div>
                  <span className={`hse-mono ${theme.textTertiary} text-[11px]`}>
                    {spatial.world.sources.length} 声源
                  </span>
                </div>
                <p className={`${theme.textTertiary} text-[11px] mb-2`}>
                  W/A/S/D 移动、Q/E 升降、鼠标拖拽转头、F 第一人称跟随、R 重置听者。
                </p>
                {worldCore()}
              </GlassCard>
            )}

            {/* 模式 D：舞台/影院（场景预设 + 座位 + 房间氛围） */}
            {stageActive && (
              <GlassCard theme={theme}>
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <Clapperboard className="w-4 h-4" style={{ color: theme.accentColor }} />
                    <span className={`${theme.textPrimary} text-sm font-medium`}>舞台影院</span>
                  </div>
                  <span className={`hse-mono ${theme.textTertiary} text-[11px]`}>
                    {stageSpeakers(spatial.stage).length} 扬声器
                  </span>
                </div>
                <p className={`${theme.textTertiary} text-[11px] mb-2`}>
                  固定座位：选择场景预设，微调座位前后与房间氛围。
                </p>
                {stageCore()}
              </GlassCard>
            )}
          </>
        )}
      </GlassCard>

      {/* 空间音频设置弹窗（专业视图工具栏入口；内部 open=false 时不渲染） */}
      <SpatialSettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        theme={theme}
        spatial={spatial as any}
        onPatch={patchSpatial}
      />
    </div>
  )
}
