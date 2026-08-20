/**
 * WorldPanel —— 模式 C 世界漫游控制面板
 *
 * 内容：移动速度滑块 / 听者坐标·朝向只读 / 轨迹时间预览滑块（world.playhead，
 * 已落地契约字段，0..30s）/ 声源列表（名称 + 坐标 + 增益 + 选中）/ 选中声源的
 * 轨迹编辑区（关键帧只读列表 + 添加关键帧（playhead 时刻 + 声源当前位置）+
 * 清除该声源轨迹）/ 操作提示卡。键盘（window 级监听）→ raf 采样 → 移动/转头
 * 事件的逻辑在本组件内：按键集每帧经 worldControl.computeMoveDelta/computeYawDelta
 * 转成 onMove/onRotate 事件发出（语义与引擎侧 controller.ts 角度约定一致，
 * 引擎侧以收到的事件为准，本组件不做位置状态维护）。键位映射（§5.6）经可选
 * keymap prop 传入：合并 DEFAULT_KEYMAP 后比较（键统一小写），移动/升降/切换声源/
 * 播放暂停可重绑定；切换声源为即时事件（循环选源，SpatialWorldView 硬编码 Tab
 * 监听并存、重复触发幂等）；转头 ←/→ 与 R/F 为固定功能键不受映射影响。
 *
 * 注意：组件只发事件、不写引擎状态；R 键 onReset / F 键 onToggleFirstPerson
 * 由父面板（SpatialPage 收口）接线。GlassCard 由父面板包裹，本组件只用
 * Slider/按钮/小字提示（HSE 风格）。
 *
 * world.playhead / world.trajectories / TrajectoryKeyframes 契约字段已落地
 * （src/spatial/types.ts），按已定契约直接消费。
 *
 * 「随曲目播放」开关（本波新增，默认关，行为不回归）：开启后 playhead 自动
 * 跟随播放时钟——raf 循环每帧读 playbackTimeStore.currentTime，节流 0.05s
 * 经同一 onChange 通道下发 { playhead: t }（patch 触发 fusion 重发 config，
 * 节流 0.05s ≈ 20fps 轨迹精度）；播放暂停时 store 时钟自然停走，playhead 停在
 * 暂停点。手动拖动滑块时置「手动覆盖」标志暂停自动同步一拍（200ms 防抖后恢复）。
 * 同步循环逻辑在 playheadSync.ts 纯模块（可注入 raf，便于单测）。
 */

import { useEffect, useRef, useState } from 'react'
import type { HSETheme } from '../hse-theme'
import type { AudioObject, DeepPartial, ListenerState, TrajectoryKeyframes, WorldSettings } from '../../src/spatial/types'
import type { PlaybackTimeStore } from '../../../../audio/playbackTimeStore'
import { Slider, Toggle } from './Primitives'
import {
  computeMoveDelta,
  computeYawDelta,
  DEFAULT_KEYMAP,
  MAX_FRAME_DT,
  nextSourceIndex,
  sourceName,
} from './worldControl'
import type { KeyMap } from './worldControl'
import {
  createPlayheadSyncer,
  PLAYHEAD_MANUAL_OVERRIDE_MS,
} from './playheadSync'
import type { PlayheadSyncer } from './playheadSync'

/**
 * 面板补丁：WorldSettings（moveSpeed / playhead / trajectories）+ 声源列表。
 * 引擎侧参数模型（SpatialParams 世界漫游分支）是否把声源挂在 world 下由
 * 并行代理决定——此处仅以可选 sources 字段表达，父面板按实际模型接线。
 */
export type WorldPanelPatch = DeepPartial<WorldSettings> & { sources?: AudioObject[] }

interface WorldPanelProps {
  /** 世界漫游设置（moveSpeed / playhead / trajectories 等） */
  params: WorldSettings
  /** 听者实时状态（只读展示 X/Y/Z + Yaw；键盘移动按 listener.yaw 计算方向） */
  listener: ListenerState
  /** 声源列表（增益滑块按 id 局部修改后整体回传） */
  sources: AudioObject[]
  theme: HSETheme
  /** 当前选中声源 id（列表高亮；null = 未选中） */
  selectedId: string | null
  /** 参数补丁（moveSpeed / playhead / trajectories / sources）→ 父面板写入引擎 */
  onChange: (patch: WorldPanelPatch) => void
  /** 选中/取消选中声源 */
  onSelectSource: (id: string | null) => void
  /** 位移增量（米，世界系）——父面板接线到 patchSpatialParams */
  onMove: (d: { x: number; y: number; z: number }) => void
  /** 偏航角增量（度，右正） */
  onRotate: (dYawDeg: number) => void
  /** R 键：重置听者到默认位姿 */
  onReset: () => void
  /** F 键：第一人称跟随切换（镜头目标跟随听者；不接线则忽略） */
  onToggleFirstPerson?: () => void
  /**
   * 空格键：播放/暂停切换（暂停/恢复整个音频上下文，规划书「空格 | 播放/暂停」；
   * 即时触发不按住采样，不接线则忽略）。父面板接线到 fusion.togglePlayback。
   */
  onTogglePlayback?: () => void
  /**
   * 播放时钟 store（可选）：提供「随曲目播放」的时钟源（getSnapshot().currentTime
   * + 暂停自然停走）。缺省 = 无播放器上下文（独立运行/冒烟测试），隐藏该开关。
   */
  playbackTimeStore?: PlaybackTimeStore
  /**
   * 键位映射（§5.6，可选）：partial 覆盖 DEFAULT_KEYMAP——移动四键/升降/切换声源/
   * 播放暂停按本映射生效（未配置的动作回默认键），设置弹窗「快捷键」区编辑，
   * SpatialPage 传 spatial.keymap。转头 ←/→ 与 R/F 为固定功能键不受影响。
   */
  keymap?: Partial<KeyMap>
}

export function WorldPanel({
  params,
  listener,
  sources,
  theme,
  selectedId,
  onChange,
  onSelectSource,
  onMove,
  onRotate,
  onReset,
  onToggleFirstPerson,
  onTogglePlayback,
  playbackTimeStore,
  keymap,
}: WorldPanelProps) {
  /* ── 键盘 → 事件：window keydown/keyup 维护按键集，raf 每帧采样 ── */
  const keysRef = useRef<Set<string>>(new Set())
  // 最新值走 ref（raf 循环只启动一次，避免闭包过期）
  const speedRef = useRef(params.moveSpeed)
  speedRef.current = params.moveSpeed
  const yawRef = useRef(listener.yaw)
  yawRef.current = listener.yaw
  // 键位映射走 ref：合并 DEFAULT_KEYMAP 后的 km 在键盘监听内即时读取（effect 只挂载一次）
  const keymapRef = useRef<Partial<KeyMap> | undefined>(keymap)
  keymapRef.current = keymap
  // 声源/选中态走 ref：Tab 循环选源读取事件时刻的最新列表（与 SpatialWorldView 同范式）
  const sourcesRef = useRef(sources)
  sourcesRef.current = sources
  const selectedIdRef = useRef(selectedId)
  selectedIdRef.current = selectedId
  const callbacksRef = useRef({ onMove, onRotate, onReset, onToggleFirstPerson, onTogglePlayback, onSelectSource })
  callbacksRef.current = { onMove, onRotate, onReset, onToggleFirstPerson, onTogglePlayback, onSelectSource }
  const lastRef = useRef(0)
  const rafRef = useRef(0)

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // 组合键（Ctrl/Cmd/Alt 快捷键）与表单聚焦时不劫持按键
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const target = e.target as HTMLElement | null
      // 表单元素聚焦时让位原生交互：INPUT/TEXTAREA 输入、BUTTON/SELECT 的
      // Space/Enter 激活（避免按钮聚焦按 Space 既触发 click 又触发播放暂停的
      // 双重响应，O3 审计 P2）；isContentEditable 同理。
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'BUTTON' || target.tagName === 'SELECT' || target.isContentEditable)) return
      // 合并键位映射（partial 覆盖；键比较统一小写，与 worldControl 约定一致）——
      // 每次按键即时读取 keymapRef.current（ref 始终最新），避免在 effect 开头算
      // 一次导致改键位后失效到重挂载（O3 审计 P2 闭包陈旧）
      const km = { ...DEFAULT_KEYMAP, ...keymapRef.current }
      const key = e.key.toLowerCase()
      if (key === 'r') {
        if (!e.repeat) callbacksRef.current.onReset()
        return
      }
      if (key === 'f') {
        if (!e.repeat) callbacksRef.current.onToggleFirstPerson?.()
        return
      }
      // 播放/暂停（映射键位，即时触发不按住采样；preventDefault 防页面滚动）
      if (key === km.space.toLowerCase()) {
        e.preventDefault()
        if (!e.repeat) callbacksRef.current.onTogglePlayback?.()
        return
      }
      // 切换声源（映射键位，即时触发）：循环选源——SpatialWorldView 另有硬编码
      // Tab 监听并存，同一状态计算同一结果，重复触发幂等（默认键位行为不回归）
      if (key === km.tab.toLowerCase()) {
        e.preventDefault() // 防焦点跳转（Tab 默认语义）
        if (!e.repeat) {
          const srcs = sourcesRef.current
          const next = nextSourceIndex(srcs, selectedIdRef.current)
          if (next >= 0 && srcs[next].id !== selectedIdRef.current) {
            callbacksRef.current.onSelectSource(srcs[next].id)
          }
        }
        return
      }
      // 方向键默认滚动页面，接管之
      if (key === 'arrowleft' || key === 'arrowright') e.preventDefault()
      keysRef.current.add(key)
    }
    const onKeyUp = (e: KeyboardEvent) => {
      keysRef.current.delete(e.key.toLowerCase())
    }
    const onBlur = () => {
      // 失焦/切窗口：清空按键集，防止"粘键"持续移动
      keysRef.current.clear()
    }

    const frame = (now: number) => {
      const last = lastRef.current || now
      const dt = Math.min(MAX_FRAME_DT, (now - last) / 1000) // dt 上限防瞬移
      lastRef.current = now
      // 每帧即时合并键位映射（keymapRef 是 ref 始终最新；O3 审计 P2 闭包陈旧修复）
      const km = { ...DEFAULT_KEYMAP, ...keymapRef.current }
      // 映射键位随 km 传入（移动四键/升降可重绑定，未配置动作回默认键）
      const move = computeMoveDelta(keysRef.current, yawRef.current, speedRef.current, dt, km)
      if (move.x !== 0 || move.y !== 0 || move.z !== 0) callbacksRef.current.onMove(move)
      const yawDelta = computeYawDelta(keysRef.current, dt, km)
      if (yawDelta !== 0) callbacksRef.current.onRotate(yawDelta)
      rafRef.current = requestAnimationFrame(frame)
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    rafRef.current = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(rafRef.current)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      keysRef.current.clear()
    }
  }, [])

  /** 声源增益滑块 → 整数组回传（DeepPartial 数组为整段替换语义） */
  const patchSourceGain = (id: string, gain: number): void => {
    onChange({ sources: sources.map((s) => (s.id === id ? { ...s, gain } : s)) })
  }

  /* ── 「随曲目播放」：开关状态 + raf 同步循环 + 手动拖动互斥 ── */
  /** 开=playhead 自动跟随播放时钟；关=手动拖动（默认关，行为不回归） */
  const [followTrack, setFollowTrack] = useState(false)
  /** 手动覆盖标志：拖动滑块期间暂停自动同步（200ms 防抖后恢复） */
  const overrideRef = useRef(false)
  const overrideTimerRef = useRef<number | null>(null)
  /** 当前自动同步器（followTrack 开启且有时钟源期间存活） */
  const syncerRef = useRef<PlayheadSyncer | null>(null)
  // onChange 走 ref：父面板每次渲染都是新闭包，直接依赖会导致同步器反复重启
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    if (!followTrack || !playbackTimeStore) return
    const syncer = createPlayheadSyncer(
      // 时钟源：store 的 currentTime（播放暂停时自然停走，playhead 停在暂停点）
      () => playbackTimeStore.getSnapshot().currentTime,
      // 手动覆盖期间跳过下发（拖动滑块时自动同步让位一拍）
      (t) => { if (!overrideRef.current) onChangeRef.current({ playhead: t }) },
    )
    syncerRef.current = syncer
    syncer.start()
    return () => {
      syncer.stop()
      syncerRef.current = null
    }
  }, [followTrack, playbackTimeStore])

  // 组件卸载：清掉手动覆盖防抖定时器（同步循环由上面 effect 的 cleanup 停止）
  useEffect(() => () => {
    if (overrideTimerRef.current !== null) window.clearTimeout(overrideTimerRef.current)
  }, [])

  /** 轨迹时间预览滑块：手动拖动 → 置覆盖标志暂停自动同步，200ms 防抖后恢复 */
  const handlePlayheadSlider = (v: number): void => {
    overrideRef.current = true
    onChange({ playhead: v })
    if (overrideTimerRef.current !== null) window.clearTimeout(overrideTimerRef.current)
    overrideTimerRef.current = window.setTimeout(() => {
      overrideRef.current = false
      // 恢复自动：同步器仍在运行（期间仅跳过下发），时钟越过 0.05s 阈值后自动重新对齐
    }, PLAYHEAD_MANUAL_OVERRIDE_MS)
  }

  /** 选中声源的轨迹（world.trajectories 按 sourceId 合并；无则 undefined） */
  const selectedTrajectory = selectedId
    ? (params.trajectories ?? []).find((tr) => tr.sourceId === selectedId)
    : undefined

  /** 添加关键帧：playhead 当前时刻 + 声源当前位置（按 sourceId 合并，数组整段替换；按 t 升序保持曲线有序） */
  const addKeyframe = (): void => {
    const src = sources.find((s) => s.id === selectedId)
    if (!src) return
    const t = params.playhead ?? 0
    const kf: TrajectoryKeyframes['keyframes'][number] = { t, position: { ...src.position } }
    const next: TrajectoryKeyframes[] = params.trajectories ? [...params.trajectories] : []
    const idx = next.findIndex((tr) => tr.sourceId === selectedId)
    if (idx >= 0) {
      next[idx] = {
        ...next[idx],
        keyframes: [...next[idx].keyframes, kf].sort((a, b) => a.t - b.t),
      }
    } else {
      next.push({ sourceId: selectedId as string, keyframes: [kf] })
    }
    onChange({ trajectories: next })
  }

  /** 清除选中声源全部关键帧（移除该 sourceId 条目） */
  const clearTrajectory = (id: string): void => {
    onChange({ trajectories: (params.trajectories ?? []).filter((tr) => tr.sourceId !== id) })
  }

  return (
    <div>
      {/* 移动速度 */}
      <Slider
        label="移动速度" value={params.moveSpeed} min={0.5} max={5} step={0.1}
        onChange={(v) => onChange({ moveSpeed: v })}
        display={`${params.moveSpeed.toFixed(1)} m/s`} theme={theme}
      />

      {/* 听者坐标 / 朝向（只读实时展示） */}
      <div className="flex items-center justify-between mb-3">
        <span className={`${theme.textSecondary} text-xs`}>听者位置</span>
        <span className={`hse-mono ${theme.textTertiary} text-[10px]`}>
          X {listener.position.x.toFixed(1)}　Y {listener.position.y.toFixed(1)}　Z {listener.position.z.toFixed(1)}　Yaw {Math.round(listener.yaw)}°
        </span>
      </div>

      {/* 轨迹时间预览（world.playhead，已落地）：驱动 3D 曲线 playhead 指示 + 添加关键帧时刻 */}
      <Slider
        label="轨迹时间预览" value={params.playhead ?? 0} min={0} max={30} step={0.1}
        onChange={handlePlayheadSlider}
        display={`${(params.playhead ?? 0).toFixed(1)}s`} theme={theme}
      />

      {/* 随曲目播放：playhead 自动跟随播放时钟（无播放器上下文时隐藏；关=手动拖动，行为不回归） */}
      {playbackTimeStore && (
        <div className="flex items-center justify-between mb-3">
          <span className={`${theme.textSecondary} text-xs`}>随曲目播放</span>
          <Toggle checked={followTrack} onChange={setFollowTrack} theme={theme} />
        </div>
      )}

      {/* 声源列表 */}
      <div className={`${theme.textSecondary} text-xs mb-1.5`}>声源（{sources.length}）</div>
      {sources.length === 0 && (
        <div className={`${theme.textTertiary} text-[11px] mb-2`}>暂无声源</div>
      )}
      {sources.map((s) => {
        const sel = s.id === selectedId
        return (
          <div
            key={s.id}
            className="rounded-xl p-2 mb-2 transition-colors"
            style={{
              background: theme.inputBg,
              border: `1px solid ${sel ? theme.accentColor : theme.cardBorder}`,
            }}
          >
            <div className="flex items-center justify-between mb-1">
              <span className={`${theme.textPrimary} text-xs font-medium`}>{sourceName(s.id)}</span>
              <button
                type="button"
                onClick={() => onSelectSource(sel ? null : s.id)}
                className="px-2 py-0.5 rounded-md text-[10px] transition-all cursor-pointer"
                style={sel
                  ? { background: theme.accentGradient, color: '#fff' }
                  : { background: 'rgba(255,255,255,0.07)', color: 'rgba(255,255,255,0.6)' }}
              >
                {sel ? '已选中' : '选中'}
              </button>
            </div>
            <div className={`hse-mono ${theme.textTertiary} text-[10px] mb-1`}>
              X {s.position.x.toFixed(1)}　Y {s.position.y.toFixed(1)}　Z {s.position.z.toFixed(1)}
            </div>
            <Slider
              label="增益" value={s.gain} min={0} max={2} step={0.05}
              onChange={(v) => patchSourceGain(s.id, v)}
              display={`${s.gain.toFixed(2)}x`} theme={theme}
            />
          </div>
        )
      })}

      {/* 轨迹编辑区（选中声源时显示）：关键帧只读列表 + 添加/清除 */}
      {selectedId && (
        <div
          className="rounded-xl p-2 mb-2"
          style={{ background: theme.inputBg, border: `1px solid ${theme.cardBorder}` }}
        >
          <div className="flex items-center justify-between mb-1">
            <span className={`${theme.textSecondary} text-xs`}>轨迹 · {sourceName(selectedId)}</span>
            <button
              type="button"
              onClick={() => clearTrajectory(selectedId)}
              className="px-2 py-0.5 rounded-md text-[10px] transition-all cursor-pointer"
              style={{ background: 'rgba(255,255,255,0.07)', color: 'rgba(255,255,255,0.6)' }}
            >
              清除轨迹
            </button>
          </div>
          {(!selectedTrajectory || selectedTrajectory.keyframes.length === 0) ? (
            <div className={`${theme.textTertiary} text-[10px] mb-1.5`}>
              暂无关键帧——拖动声源位置后用「添加关键帧」逐帧记录运动轨迹。
            </div>
          ) : (
            <div className="mb-1.5">
              {selectedTrajectory.keyframes.map((kf, i) => (
                <div key={i} className={`hse-mono ${theme.textTertiary} text-[10px] py-0.5`}>
                  <span style={{ color: theme.accentTo }}>{kf.t.toFixed(1)}s</span>
                  {'　'}X {kf.position.x.toFixed(1)}　Y {kf.position.y.toFixed(1)}　Z {kf.position.z.toFixed(1)}
                </div>
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={addKeyframe}
            className="w-full py-1.5 rounded-lg text-[11px] transition-all cursor-pointer"
            style={{ background: `${theme.accentColor}16`, border: `1px dashed ${theme.accentColor}55`, color: theme.textSecondary }}
          >
            添加关键帧（{`${(params.playhead ?? 0).toFixed(1)}s`} 时刻 · 当前位置）
          </button>
        </div>
      )}

      {/* 操作提示卡（小字，中文；键位为默认值——可自定义，见下方提示行） */}
      <div
        className="rounded-lg px-2.5 py-2 text-[10px] leading-relaxed"
        style={{ background: 'rgba(255,255,255,0.04)', border: `1px dashed ${theme.cardBorder}` }}
      >
        <span className={theme.textSecondary}>操作：</span>
        <span className={theme.textTertiary}>
          W/A/S/D 移动 · Q/E 升降 · ←/→ 转头 · 鼠标拖拽旋转视角 · R 重置听者 · F 第一人称跟随 · 空格 播放/暂停 · Tab 切换声源
        </span>
        <br />
        <span className={theme.textTertiary}>键位可在设置中修改（空间音频设置 → 快捷键）。</span>
      </div>
    </div>
  )
}
