/**
 * SpatialStudioLayout —— 空间音频专业四象限布局框架（页面内实现，规划书 §5.1 简化版）
 *
 * 简化版四象限（完整独立窗口级留后续 wave）：在空间音效页内以 CSS Grid
 * （240px 1fr）组织：
 *   ┌──────────────┬───────────────────────────┐
 *   │ 左面板        │ 中央（当前模式视图）        │
 *   │ 声源/扬声器   │ （页面复用既有模式组件传入） │
 *   ├──────────────┴───────────────────────────┤
 *   │ 右下面板：环境与设置（房间环境 + HRTF 只读） │
 *   ├──────────────────────────────────────────┤
 *   │ 状态栏：延迟 / 后端 / CPU / 活跃对象 / 采样率 / HRTF / 输出 / 模式 │
 *   └──────────────────────────────────────────┘
 *
 * 设计约束：
 *  - 编辑交互不在此重复实现——左面板只做摘要信息行（名称/方位角/仰角/距离），
 *    中央视图由父页面复用既有组件（SpatialModeVisual / SpatialRingEditor /
 *    SpatialWorldView / StagePanel）经 children 传入；
 *  - 右下面板房间环境按模式选择 patch 路径：非 stage 模式统一走
 *    instant.room/roomAmount（融合层 spatialConfigFromParams 语义），
 *    stage 模式房间由场景预设决定（只读展示），混响走 stage.reverbAmount；
 *  - 状态栏延迟/CPU 数据源：getSpatialStats()（fusion 层处理器统计回传缓存，
 *    worklet 每 ~80ms 回传一次），1s 轮询保持新鲜；CPU 经 fusion.estimateCpuPercent
 *    按 avgProcessMs（256 样本块 @48kHz）换算；活跃对象数 = 融合层当前配置的
 *    虚拟扬声器数（spatialConfigFromParams(spatial).speakers.length，spatial prop
 *    与 getSpatialParams 同源，useMemo 按 spatial 快照缓存避免每渲染重算，
 *    规划书 §5.6「活跃对象: [8/64]」，64 为展示上限）；
 *  - 响应式：min-width 900px 以下回退标准视图（useProViewEligible，
 *    由 SpatialPage 消费——窄窗仍渲染标准卡片流，本组件不渲染）。
 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Radio, SlidersHorizontal, Speaker } from 'lucide-react'
import { GlassCard, Segmented, Slider } from './Primitives'
import type { HSETheme } from '../hse-theme'
import type {
  DeepPartial,
  HeadLockedSettings,
  RoomPreset,
  SeatPosition,
  SpatialMode,
  SpatialParams,
  StagePreset,
} from '../../src/spatial/types'
import { instantSpeakers } from '../../src/spatial/types'
import { headLockedSpeakers } from '../../src/spatial/layouts'
import { stageRoom, stageSpeakers } from '../../src/spatial/scenes'
import { sourceName } from './worldControl'
// 共享常量（O3 审计：消除与 SpatialPage 的重复定义，单事实源见 spatialConstants.ts）
import { HEAD_LOCKED_LAYOUTS, SPATIAL_ROOM_OPTIONS } from './spatialConstants'

/** 专业视图可用性：视口 ≥ 900px（窄窗回退标准视图）。消费方：SpatialPage */
export function useProViewEligible(): boolean {
  const [eligible, setEligible] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true
    return window.matchMedia('(min-width: 900px)').matches
  })
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(min-width: 900px)')
    const onChange = (e: MediaQueryListEvent): void => setEligible(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return eligible
}

interface SpatialStudioLayoutProps {
  /** 当前空间模式（决定左面板摘要 / 右下面板房间 patch 路径） */
  mode: SpatialMode
  theme: HSETheme
  /** 空间参数快照（左面板摘要 / 房间环境读取） */
  spatial: SpatialParams
  /** 深合并写入（房间环境等全局设置；页面 patchSpatial 接线） */
  onPatch: (p: DeepPartial<SpatialParams>) => void
  /** 模式 B 布局预设切换（复用页面接线：预设同步 speakers 列表） */
  onHeadLockedLayout: (layout: HeadLockedSettings['layout']) => void
  /** 模式 C 当前选中声源 id（左面板高亮） */
  selectedWorldId: string | null
  /** 模式 C 声源选中回调（复用页面 state 接线） */
  onSelectWorld: (id: string | null) => void
  /** 中央模式视图（页面复用既有模式面板组件后传入，本组件不重复实现） */
  children?: ReactNode
  /** 状态栏实数据（页面经 bridge.getStats() 轮询 + rAF 帧率测量注入；缺省显示「—」） */
  status?: { latencyMs: number | null; fps: number | null }
}

/** 模式名映射（状态栏/左面板展示） */
const MODE_NAMES: Record<SpatialMode, string> = {
  off: '关闭',
  instant: '一键空间化',
  headLocked: '头锁定环绕',
  world: '世界漫游',
  stage: '舞台影院',
}

/** 场景预设名映射（左面板 stage 摘要；数值单事实源在 scenes.ts） */
const STAGE_NAMES: Record<StagePreset, string> = {
  stage: '音乐舞台',
  cinema: '电影院',
  piano: '钢琴独奏',
  nature: '自然场景',
}

/** 座位名映射（左面板 stage 摘要） */
const SEAT_NAMES: Record<SeatPosition, string> = {
  front: '前排',
  middle: '中排',
  back: '后排',
}

/** 房间预设全量标签（stage 模式只读展示用） */
const ROOM_LABELS: Record<RoomPreset, string> = {
  off: '关闭',
  studio: '录音棚',
  hall: '音乐厅',
  stage: '舞台',
  church: '教堂',
  outdoor: '户外',
  bathroom: '浴室',
  corridor: '走廊',
}

/** 活跃对象展示上限（规划书 §5.6「活跃对象: [8/64]」；实际为当前配置的虚拟扬声器数） */
const ACTIVE_OBJECTS_CAPACITY = 64

export default function SpatialStudioLayout({
  mode,
  theme,
  spatial,
  onPatch,
  onHeadLockedLayout,
  selectedWorldId,
  onSelectWorld,
  children,
  status,
}: SpatialStudioLayoutProps) {
  /* ── 状态栏：空间音频已内联 EngineV3（纯 TS DSP，无独立 worklet），
   *    延迟/后端/CPU 统计不再可用（原 fusion 层 worklet 回传已移除），
   *    状态栏静态显示「—」；活跃对象数按当前模式扬声器数即时计算。 ── */

  const stageActive = mode === 'stage'
  const roomDisabled = mode === 'off'

  /* ── 左面板摘要行数据（按模式派生，只读展示，编辑仍在中央/下方） ── */
  const leftCount = ((): number => {
    if (mode === 'instant') return 2
    if (mode === 'headLocked') return headLockedSpeakers(spatial.headLocked).length
    if (mode === 'world') return spatial.world.sources.length
    if (mode === 'stage') return stageSpeakers(spatial.stage).length
    return 0
  })()
  /** 活跃对象数（即时计算，与左面板 leftCount 同源：当前模式配置的虚拟扬声器数） */
  const activeObjects = leftCount

  const renderLeftPanel = (): ReactNode => {
    if (mode === 'off') {
      return (
        <div className={`${theme.textTertiary} text-[11px] leading-relaxed`}>
          空间音频未开启——选择上方模式后，此处显示声源/扬声器摘要。
        </div>
      )
    }
    if (mode === 'instant') {
      // 模式 A：2 只虚拟扬声器（instantSpeakers 单事实源：±spread/2、仰角 0、距离 1.5m）
      return (
        <div className="space-y-1">
          {instantSpeakers(spatial.instant).map((s) => (
            <div key={s.channel} className="flex items-center justify-between py-1 px-2 rounded-lg" style={{ backgroundColor: 'rgba(255,255,255,0.04)' }}>
              <span className={`hse-mono ${theme.textSecondary} text-[11px] font-medium`}>{s.channel === 0 ? 'L' : 'R'}</span>
              <span className={`hse-mono ${theme.textTertiary} text-[10px]`}>{Math.round(s.azimuthDeg)}°</span>
              <span className={`hse-mono ${theme.textTertiary} text-[10px]`}>{Math.round(s.elevationDeg)}°</span>
              <span className={`hse-mono ${theme.textTertiary} text-[10px]`}>{s.distance}m</span>
            </div>
          ))}
        </div>
      )
    }
    if (mode === 'headLocked') {
      // 模式 B：布局预设切换（复用页面接线）+ 扬声器列表（headLockedSpeakers 含仰角层过滤）
      const list = headLockedSpeakers(spatial.headLocked)
      return (
        <div>
          <div className={`${theme.textSecondary} text-xs mb-1`}>布局预设</div>
          <div className="mb-2">
            <Segmented options={HEAD_LOCKED_LAYOUTS} value={spatial.headLocked.layout} onChange={onHeadLockedLayout} theme={theme} small />
          </div>
          <div className={`${theme.textSecondary} text-xs mb-1`}>扬声器</div>
          <div className="space-y-1 max-h-64 overflow-y-auto pr-1">
            {list.map((s, i) => (
              <div key={i} className="flex items-center justify-between py-1 px-2 rounded-lg" style={{ backgroundColor: 'rgba(255,255,255,0.04)' }}>
                <span className={`hse-mono ${theme.textSecondary} text-[11px] font-medium`}>#{i + 1}</span>
                <span className={`hse-mono ${theme.textTertiary} text-[10px]`}>{Math.round(s.azimuthDeg)}°</span>
                <span className={`hse-mono ${theme.textTertiary} text-[10px]`}>{Math.round(s.elevationDeg)}°</span>
                <span className={`hse-mono ${theme.textTertiary} text-[10px]`}>{s.distance.toFixed(1)}m</span>
              </div>
            ))}
          </div>
        </div>
      )
    }
    if (mode === 'world') {
      // 模式 C：声源列表（名称 + 选中态；点击选中复用页面 state 接线）
      return (
        <div className="space-y-1">
          {spatial.world.sources.map((src) => {
            const selected = selectedWorldId === src.id
            return (
              <button
                key={src.id}
                type="button"
                onClick={() => onSelectWorld(selected ? null : src.id)}
                className={`flex items-center justify-between w-full py-1.5 px-2 rounded-lg text-[11px] transition-all ${selected ? 'text-white font-medium' : theme.textSecondary}`}
                style={selected
                  ? { background: theme.accentGradient, boxShadow: `0 4px 14px ${theme.accentColor}44` }
                  : { backgroundColor: 'rgba(255,255,255,0.04)', border: `1px solid transparent` }}
              >
                <span>{sourceName(src.id)}</span>
                {selected && <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'rgba(255,255,255,0.95)' }} />}
              </button>
            )
          })}
        </div>
      )
    }
    // 模式 D：场景名称 + 座位摘要（场景卡片网格在中央 StagePanel）
    return (
      <div className="space-y-1">
        <div className="flex items-center justify-between py-1.5 px-2 rounded-lg" style={{ backgroundColor: 'rgba(255,255,255,0.04)' }}>
          <span className={`${theme.textSecondary} text-[11px]`}>场景</span>
          <span className={`${theme.textPrimary} text-[11px] font-medium`}>{STAGE_NAMES[spatial.stage.preset]}</span>
        </div>
        <div className="flex items-center justify-between py-1.5 px-2 rounded-lg" style={{ backgroundColor: 'rgba(255,255,255,0.04)' }}>
          <span className={`${theme.textSecondary} text-[11px]`}>座位</span>
          <span className={`hse-mono ${theme.textSecondary} text-[11px]`}>{SEAT_NAMES[spatial.stage.seat]}</span>
        </div>
      </div>
    )
  }

  return (
    <div className="grid gap-3" style={{ gridTemplateColumns: '240px 1fr' }}>
      {/* 左面板：声源 / 扬声器摘要（240px 固定列） */}
      <GlassCard theme={theme}>
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1.5">
            <Speaker className="w-3.5 h-3.5" style={{ color: theme.accentColor }} />
            <span className={`${theme.textPrimary} text-xs font-medium`}>声源 / 扬声器</span>
          </div>
          {mode !== 'off' && <span className={`hse-mono ${theme.textTertiary} text-[10px]`}>{leftCount}</span>}
        </div>
        {renderLeftPanel()}
      </GlassCard>

      {/* 中央：当前模式视图（页面复用既有组件传入；本组件不重复实现编辑交互） */}
      <GlassCard theme={theme} style={{ minWidth: 0 }}>
        {children ?? (
          <div className={`${theme.textTertiary} text-[11px] py-8 text-center`}>请从上方选择模式开始空间化渲染。</div>
        )}
      </GlassCard>

      {/* 右下面板：环境与设置（房间环境 + HRTF 配置，占整行） */}
      <GlassCard theme={theme} style={{ gridColumn: '1 / -1' }}>
        <div className="flex items-center gap-1.5 mb-3">
          <SlidersHorizontal className="w-4 h-4" style={{ color: theme.accentColor }} />
          <span className={`${theme.textPrimary} text-sm font-medium`}>环境与设置</span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4">
          {/* 房间环境：非 stage 模式统一走 instant.room/roomAmount（融合层语义），
              stage 模式房间由场景预设决定（scenes.ts 单事实源）只读展示，混响走 reverbAmount */}
          <div>
            <div className={`${theme.textSecondary} text-xs mb-1.5`}>房间环境</div>
            {roomDisabled ? (
              <div className={`${theme.textTertiary} text-[11px] leading-relaxed`}>
                空间音频未开启——开启任意模式后可调节房间环境与混响。
              </div>
            ) : stageActive ? (
              <>
                <div className="flex items-center justify-between mb-2">
                  <span className={`${theme.textTertiary} text-[11px]`}>场景房间</span>
                  <span className={`hse-mono ${theme.textSecondary} text-[11px]`}>
                    {ROOM_LABELS[stageRoom(spatial.stage)]}
                    <span className={`${theme.textMuted} ml-1`}>（由场景预设决定）</span>
                  </span>
                </div>
                <Slider
                  label="氛围混响" value={Math.round(spatial.stage.reverbAmount * 100)} min={0} max={100} step={1}
                  onChange={(v) => onPatch({ stage: { reverbAmount: v / 100 } })}
                  display={`${Math.round(spatial.stage.reverbAmount * 100)}%`} theme={theme}
                />
              </>
            ) : (
              <>
                <div className="mb-2">
                  <Segmented
                    options={SPATIAL_ROOM_OPTIONS} value={spatial.instant.room}
                    onChange={(v) => onPatch({ instant: { room: v } })}
                    theme={theme} small
                  />
                </div>
                <Slider
                  label="房间混响" value={Math.round(spatial.instant.roomAmount * 100)} min={0} max={100} step={1}
                  onChange={(v) => onPatch({ instant: { roomAmount: v / 100 } })}
                  display={`${Math.round(spatial.instant.roomAmount * 100)}%`} theme={theme}
                />
              </>
            )}
          </div>

          {/* HRTF 配置：只读显示（数据集/插值切换后续 wave） */}
          <div>
            <div className={`${theme.textSecondary} text-xs mb-1.5`}>HRTF 配置</div>
            <div className="flex items-center justify-between mb-1">
              <span className={`${theme.textTertiary} text-[11px]`}>数据集</span>
              <span className={`hse-mono ${theme.textSecondary} text-[11px]`}>内置 MIT KEMAR</span>
            </div>
            <div className="flex items-center justify-between">
              <span className={`${theme.textTertiary} text-[11px]`}>插值</span>
              <span className={`hse-mono ${theme.textSecondary} text-[11px]`}>
                最近邻<span className={`${theme.textMuted} ml-1`}>（球谐开发中）</span>
              </span>
            </div>
            <p className={`${theme.textMuted} text-[10px] mt-2`}>
              HRTF 数据集与插值方式切换留待后续 wave（详见设置弹窗）。
            </p>
          </div>
        </div>
      </GlassCard>

      {/* 状态栏（底部整行）：延迟 / 后端 / 帧率 / 对象 / HRTF / 输出 / 模式。
          延迟与帧率为实数据（页面经 bridge.getStats() 500ms 轮询 + rAF 帧率测量，
          status prop 注入；缺省回退「—」）。HRTF 如实显示当前引擎数据源
          （analyticHrtf 合成网格——原「MIT KEMAR」为不实标签）。采样率列移除
          （引擎采样率随 AudioContext，状态栏拿不到可靠来源，假数据不如不显示）。 */}
      <div
        className="flex items-center justify-between gap-3 px-4 py-2 rounded-2xl hse-mono text-[11px]"
        style={{
          gridColumn: '1 / -1',
          backgroundColor: 'rgba(255,255,255,0.03)',
          border: `1px solid ${theme.cardBorder}`,
          backdropFilter: theme.glassCardBlur,
          WebkitBackdropFilter: theme.glassCardBlur,
        }}
      >
        <div className="flex items-center gap-1.5">
          <span className={theme.textMuted}>延迟</span>
          <span className={theme.textSecondary}>
            {status?.latencyMs !== undefined && status?.latencyMs !== null ? `${status.latencyMs}ms` : '—'}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={theme.textMuted}>后端</span>
          <span className={theme.textSecondary}>TS</span>
        </div>
        {/* 帧率（rAF 测量）：CPU 占用的直观代理（空间音频内联 EngineV3，无独立统计） */}
        <div className="flex items-center gap-1.5">
          <span className={theme.textMuted}>帧率</span>
          <span className={theme.textSecondary}>
            {status?.fps ? `${status.fps}fps` : '—'}
          </span>
        </div>
        {/* 活跃对象（规划书 §5.6「活跃对象: [8/64]」）：当前配置的虚拟扬声器数 / 展示上限 */}
        <div className="flex items-center gap-1.5">
          <span className={theme.textMuted}>对象</span>
          <span className={theme.textSecondary}>{activeObjects}/{ACTIVE_OBJECTS_CAPACITY}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={theme.textMuted}>HRTF</span>
          <span className={theme.textSecondary}>合成（解析式）</span>
        </div>
        {/* 输出设备（只读展示：sinkId 快照存在 → 已选设备，缺省 → 系统默认） */}
        <div className="flex items-center gap-1.5">
          <span className={theme.textMuted}>输出</span>
          <span className={theme.textSecondary}>{spatial.sinkId ? '已选设备' : '双耳渲染'}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={theme.textMuted}>模式</span>
          <span className={theme.textSecondary}>{MODE_NAMES[mode]}</span>
        </div>
      </div>
    </div>
  )
}
