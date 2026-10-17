import { memo, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { AudioLines } from 'lucide-react'
import type { PlaybackTimeStore } from '../audio/playbackTimeStore'

/**
 * AutoMix 过渡 HUD 共享组件：原来只内嵌在 ModengPlayerPage（modeng 歌词模式），
 * modern 等其余歌词模式的播放页拿不到 → 用户在 modern 模式永远看不到过渡倒计时。
 * 抽成共享模块后，App 各播放页分支可直接复用同一徽标与进度提示。
 */

export interface AutomixHudInfo {
  /** armed=已排程等待；running=过渡音频正在播放 */
  phase: 'armed' | 'running'
  /** 过渡切入当前曲的时间点（秒） */
  startAt: number
  /** 过渡结束 = 目标曲开始（秒） */
  endAt: number
  /** 引擎名（供进度条上方金色提示直接显示）：AutoMix / AutoMix Pro / AutoMix Enhanced / Gapless。
   *  只写引擎名，不带「即将介入 / 正在介入 / 过渡效果」这类中间态措辞。 */
  engineLabel: string
  /** 过渡类型：automix=智能混音（药丸显示时间节点）；gapless=无缝衔接（只在进度条提示里显示引擎名） */
  kind?: 'automix' | 'gapless'
  /** 稳定键：`${当前曲 trackKey}|${切点}`。切点变化只影响「关闭」状态；
   *  通知「每曲只播一遍」按第一段（当前曲 trackKey）判定。 */
  key: string
}

/** 过渡前提示窗口：8 秒（不含淡入淡出）。
 *  进度条上方的金色引擎名在「切点前 8 + 淡入」出现，淡入结束的那一刻恰好还剩 8 秒，
 *  切点一到立刻淡出 —— 药丸（时间节点）不受此窗口限制，见 AUTOMIX_HUD_NODE_*。 */
export const AUTOMIX_HUD_LEAD_SECONDS = 8
export const AUTOMIX_HUD_GOLD = '#F5C044'

/** 药丸（时间节点）的提示节奏：本曲播放满 5 秒才提示一次，完全可见 8 秒后自动渐隐。
 *  8 秒是「不含淡入淡出」的纯驻留时长（总在场 = 淡入 + 8s + 淡出）。
 *  过渡计划若晚于 5 秒才就绪（冷启动 / 新歌新列表没预载），就绪那一刻立刻提示——
 *  判定写在 shouldShow 里：条件是「播放位置 ≥ 5s」+「计划已就绪」，晚到时后者才成立。 */
export const AUTOMIX_HUD_NODE_DELAY_SECONDS = 5
export const AUTOMIX_HUD_NODE_HOLD_SECONDS = 8

/** 淡入 / 淡出时长（秒）：JS 计时与 CSS 过渡共用同一值。
 *  淡出比淡入稍长、且两条曲线分开：进场 ease-out（出现跟手），离场 ease-in（先驻留再离场）。
 *  此前 0.22s/0.24s 的「快淡变」在观感上等同于瞬现/瞬隐（且单 rAF 淡入常被 React 的
 *  提交时序吞掉、直接跳到终值），用户反馈割裂 → 放宽到 0.4s / 0.5s 的可感知渐变。
 *  两段都长于播放时间轴 ~250ms 的量化台阶，进度条上方金色提示的出入场依旧被抹平。 */
export const AUTOMIX_HUD_FADE_IN_SECONDS = 0.4
export const AUTOMIX_HUD_FADE_OUT_SECONDS = 0.5
/** 鼠标从药丸移开后的宽限：给用户留出「再想一下」的余地，再渐隐。 */
export const AUTOMIX_HUD_HOVER_GRACE_SECONDS = 4
/** 点击时间节点药丸时，跳到「过渡切点前多少秒」。
 *  取 11 秒：比 AutoMix 的预介入窗口再早一点，落点仍在过渡之外，用户能听完最后一段。 */
export const AUTOMIX_HUD_JUMP_LEAD_SECONDS = 11

/** 药丸点击后的 seek 目标（秒）：过渡切点前 11 秒，且不早于 0。
 *  公式只此一处——药丸与调用方各自再减一次会把落点推成切点前 22 秒。 */
export function automixHudJumpTarget(startAt: number): number {
  const value = Number(startAt)
  if (!Number.isFinite(value)) return 0
  return Math.max(0, value - AUTOMIX_HUD_JUMP_LEAD_SECONDS)
}

/** 连续两帧后才把不透明度抬到 1：第一帧保证浏览器真的画下 opacity:0 那一帧，第二帧再改值。
 *  单 rAF 的回调可能抢在首帧绘制之前执行（React 提交时序不保证中间留有一帧绘制）——
 *  元素第一次被画出来就是 opacity:1，CSS 过渡从不触发，观感为「瞬现」。返回取消函数。 */
function scheduleOpacityFadeIn(setOpacity: (value: number) => void) {
  let inner = 0
  const outer = requestAnimationFrame(() => {
    inner = requestAnimationFrame(() => setOpacity(1))
  })
  return () => {
    cancelAnimationFrame(outer)
    cancelAnimationFrame(inner)
  }
}

/** 方向相关的 CSS 过渡：不透明度目标为 0 时是离场（ease-in），否则是进场（ease-out）。
 *  CSS 规范用「变化后的 transition 值」驱动过渡，所以按目标值选曲线是对的。 */
const fadeTransition = (opacity: number) =>
  `opacity ${opacity === 0 ? AUTOMIX_HUD_FADE_OUT_SECONDS : AUTOMIX_HUD_FADE_IN_SECONDS}s ${opacity === 0 ? 'ease-in' : 'ease-out'}`

/**
 * 通知播放记忆（模块级，跨播放页切换/组件卸载共享）：
 * 同一首「当前曲」只提示一遍 —— 同曲内 seek / 快进 / 重新排程（HUD key 变化）不再重复弹出。
 * done 的三个来源：提示满 8 秒自动收起、过渡开跑、用户点「关闭」。
 * 只有「换歌」（当前曲 key 变化）或「本曲重新从头播放」（currentTime 明显回落，如单曲循环）
 * 才重新允许显示一次。
 */
const NULL_TIME_SNAPSHOT = { currentTime: 0 }

const automixNotificationMemory = {
  trackKey: '',
  notified: false,
  maxTime: 0,
}

/** AutoMix 过渡倒计时订阅：徽标内部用（useSyncExternalStore 范式，重渲染仅徽标子树） */
export function useAutomixHudTime(playbackTimeStore: PlaybackTimeStore | null | undefined) {
  return useSyncExternalStore(
    playbackTimeStore ? playbackTimeStore.subscribe : () => () => undefined,
    playbackTimeStore ? playbackTimeStore.getSnapshot : () => NULL_TIME_SNAPSHOT,
    playbackTimeStore ? playbackTimeStore.getSnapshot : () => NULL_TIME_SNAPSHOT,
  ).currentTime
}

export const formatAutomixHudTime = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const whole = Math.floor(seconds)
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

/** 过渡引擎显示名（进度条上方金色提示 / 过渡徽标统一用它）——只写引擎名，
 *  不再出现「即将介入 / 正在介入 / 过渡效果」这类中间态措辞：
 *    · gapless              → Gapless（无缝衔接）
 *    · AutoMix standard     → AutoMix
 *    · AutoMix pro（v2）    → AutoMix Pro
 *    · AutoMix enhanced（QQ）→ AutoMix Enhanced
 *    · 其它（纯交叉淡化等）  → null（不显示任何名字） */
export function transitionEngineDisplayName(
  strategy: string | undefined,
  autoMixEnabled: boolean,
  tier: 'standard' | 'pro' | 'enhanced',
): string | null {
  if (strategy === 'gapless') return 'Gapless'
  if (!autoMixEnabled) return null
  // 只有「真的由 AutoMix 家族完成的过渡」才挂名字：降级成 fixed-crossfade / none 时
  // 不显示任何名字（宁可什么都不显示，也不写一个与实际执行引擎不符的档位名）。
  const isAutoMixStrategy = strategy === 'smart-rendered'
    || strategy === 'smart-rendered-v2'
    || strategy === 'smart-rendered-qq'
    || strategy === 'beat-crossfade'
  if (!isAutoMixStrategy) return null
  return tier === 'enhanced' ? 'AutoMix Enhanced' : tier === 'pro' ? 'AutoMix Pro' : 'AutoMix'
}

/** 徽标：过渡计划的**时间节点**（「即将在 m:ss 开始智能混音」，可关闭）。
 *  提示节奏：本曲播放满 5 秒提示一次，显示 8 秒后自动渐隐，每曲一遍；
 *  过渡计划晚于 5 秒才就绪时（冷启动 / 新歌没预载）就绪那一刻立刻提示。
 *  此前两版分别是「常显」与「切点前 8 秒倒计时」——均非用户预期。
 *  「关闭」的语义：**本曲不做智能混音**（想完整听完这首歌，末尾只留一次短交叉），
 *  不是"隐藏这条通知"——点击后引擎会把本曲对的计划换成短交叉安全网。 */
export const AutomixHudBadge = memo(function AutomixHudBadge({
  info, currentTime: currentTimeProp, playbackTimeStore, scale, colors, accentColor = null, onDismiss, onJumpToTransition,
}: {
  info: AutomixHudInfo
  /** 旧用法：外部传入时间（会迫使父级以 store 频率重渲染）。与 playbackTimeStore 二选一。 */
  currentTime?: number
  /** 新用法：徽标内部订阅时间 store——重渲染只发生在徽标子树，App 巨型组件不再 4Hz 全树 reconcile */
  playbackTimeStore?: PlaybackTimeStore
  /** 设计稿缩放系数：固定版式播放页传布局 scale，流式布局（modern 等）传 1 */
  scale: number
  colors: { chip: string; text: string; dim: string }
  /** 当前封面主题色：作为药丸底色的淡色染色（未提供时用 colors.chip 原值） */
  accentColor?: string | null
  onDismiss: () => void
  /** 点击药丸本体：跳到「过渡切点前 AUTOMIX_HUD_JUMP_LEAD_SECONDS 秒」。
   *  传 undefined 时药丸不可点（保留纯展示语义）。「关闭」按钮始终独立，不触发本回调。 */
  onJumpToTransition?: (startAt: number) => void
}) {
  const subscribedTime = useAutomixHudTime(playbackTimeStore)
  const currentTime = playbackTimeStore ? subscribedTime : (currentTimeProp ?? 0)
  // info.key = `${当前曲 trackKey}|${切点}`：第一段即「当前曲」身份，
  // 同一首歌内重新排程（seek / 快进）只会改变切点，不会改变这一段 → 通知不重复。
  const trackKey = info.key.split('|')[0] || info.key
  const memory = automixNotificationMemory
  if (memory.trackKey !== trackKey) {
    memory.trackKey = trackKey
    memory.notified = false
    memory.maxTime = 0
  }
  // 同一首歌重新从头播放（时间轴明显回落）：视为新一轮，允许再提示一次
  if (memory.notified && currentTime + 2 < memory.maxTime) {
    memory.notified = false
  }
  if (currentTime > memory.maxTime) memory.maxTime = currentTime

  if (info.phase !== 'armed') {
    // 过渡已经开跑：本曲的通知窗口到此为止，不再补播
    memory.notified = true
  }
  const remaining = info.startAt - currentTime
  // 入场条件：本曲播放满 5 秒 + 计划已就绪 + 本曲还没提示过 + 还没到切点。
  // 「计划晚到」的兜底不需要额外分支：那时播放位置早已 ≥5s，计划一就绪这里立刻成立。
  // 无缝衔接（gapless）同样出节点：文案为「开始无缝衔接」，切点 = 裁剪后的拼接位置。
  const eligible = info.phase === 'armed'
    && !memory.notified
    && remaining > 0
    && currentTime >= AUTOMIX_HUD_NODE_DELAY_SECONDS

  // 提示会话：一开始提示就落记「本曲已提示」（模块级 → 切播放页卸载重挂也不会对同曲重弹），
  // 淡入结束后才开始计满 8 秒驻留（淡入/淡出不计入显示时长），到点自动收起（渐隐由下面的进出场状态机负责）。
  const [holding, setHolding] = useState(false)
  // 悬停状态：鼠标停在药丸上时不倒数（让用户有时间决定「跳回去」还是「关闭」），
  // 移开后按 4 秒宽限再渐隐。用户诉求：悬停期间不要自动消失，移出后 4 秒收起。
  const [hovered, setHovered] = useState(false)
  /** 本次驻留的剩余计时长度：默认「淡入预算 + 8 秒」；悬停结束后改为 4 秒宽限 */
  const holdMsRef = useRef((AUTOMIX_HUD_FADE_IN_SECONDS + AUTOMIX_HUD_NODE_HOLD_SECONDS) * 1000)
  // 换歌（当前曲身份变化）：上一首的驻留窗口不延续到新歌，新歌从自己的第 5 秒重新开始计时
  useEffect(() => { setHolding(false) }, [trackKey])
  // 新一次提示开始：驻留时长复位（必须排在下面的计时 effect 之前，否则会读到上次的 4 秒宽限）
  useEffect(() => {
    if (!holding) return
    holdMsRef.current = (AUTOMIX_HUD_FADE_IN_SECONDS + AUTOMIX_HUD_NODE_HOLD_SECONDS) * 1000
  }, [holding])
  useEffect(() => {
    if (!eligible) return
    memory.notified = true
    setHolding(true)
  }, [eligible])
  useEffect(() => {
    if (!holding) return
    // 鼠标停在药丸上：暂停倒数（悬停期间不在中途消失，用户可能在纠结要不要跳/关）
    if (hovered) return
    // 驻留计时：默认「淡入预算 + 8 秒」；悬停结束后改用 4 秒宽限（见 onPointerLeave）
    const timer = window.setTimeout(() => setHolding(false), holdMsRef.current)
    return () => window.clearTimeout(timer)
  }, [holding, hovered])
  const shouldShow = holding && info.phase === 'armed' && remaining > 0

  // 进出场用「状态机 + CSS 过渡」而不是每帧算不透明度：
  // 出现时先以 0 不透明度挂载，双 rAF 后抬到 1（触发 ease-out 淡入）；
  // 隐藏时先淡出、淡出跑完再卸载 —— 切点到达、用户点关闭都是"滑走"而不是"啪地消失"。
  const [opacity, setOpacity] = useState(0)
  const [mounted, setMounted] = useState(false)
  const unmountTimerRef = useRef<number | null>(null)
  useEffect(() => {
    if (shouldShow) {
      if (unmountTimerRef.current !== null) {
        window.clearTimeout(unmountTimerRef.current)
        unmountTimerRef.current = null
      }
      setMounted(true)
      // 双 rAF：见 scheduleOpacityFadeIn —— 单 rAF 会抢在首帧绘制前执行，过渡不触发
      return scheduleOpacityFadeIn(setOpacity)
    }
    if (!mounted) return
    setOpacity(0)
    unmountTimerRef.current = window.setTimeout(() => {
      unmountTimerRef.current = null
      setMounted(false)
    }, AUTOMIX_HUD_FADE_OUT_SECONDS * 1000 + 60)
    return () => {
      if (unmountTimerRef.current !== null) {
        window.clearTimeout(unmountTimerRef.current)
        unmountTimerRef.current = null
      }
    }
  }, [shouldShow, mounted])
  // 卸载后归零：下一次通知仍从 0 淡入
  useEffect(() => {
    if (!mounted) setOpacity(0)
  }, [mounted])

  if (!mounted) return null
  const nodeTime = formatAutomixHudTime(info.startAt)
  // 底色：当前封面主题色的淡色（color-mix 混入原底色，保持可读的对比度）
  const chipBackground = accentColor
    ? `color-mix(in srgb, ${accentColor} 26%, ${colors.chip})`
    : colors.chip
  return (
    <div
      // 基线对齐：小字（关闭）与大字（主文案）的文字基线严格同一水平线；
      // 图标用 alignSelf:center 单独垂直居中（否则 SVG 会跟着基线往下沉）。
      className="flex items-baseline gap-2"
      // 点药丸本体 = 跳到过渡切点前 11 秒（想再听一遍最后一段）。
      // 淡入未完成时不响应，避免误触；「关闭」按钮自带 stopPropagation，不会走到这里。
      onClick={onJumpToTransition && opacity > 0.35
        ? () => onJumpToTransition(info.startAt)
        : undefined}
      title={onJumpToTransition ? `跳到过渡前 ${AUTOMIX_HUD_JUMP_LEAD_SECONDS} 秒` : undefined}
      // 悬停期间暂停自动收起；移开后按 4 秒宽限再渐隐（不是立刻消失，也不是重新数 8 秒）
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => {
        holdMsRef.current = AUTOMIX_HUD_HOVER_GRACE_SECONDS * 1000
        setHovered(false)
      }}
      style={{
        background: chipBackground,
        backdropFilter: 'blur(18px) saturate(150%)',
        WebkitBackdropFilter: 'blur(18px) saturate(150%)',
        borderRadius: 999,
        padding: `${5 * scale}px ${10 * scale}px ${5 * scale}px ${12 * scale}px`,
        opacity,
        transition: fadeTransition(opacity),
        pointerEvents: opacity > 0.35 ? 'auto' : 'none',
        cursor: onJumpToTransition ? 'pointer' : undefined,
      }}
    >
      <AudioLines style={{ width: 13 * scale, height: 13 * scale, color: colors.text, flexShrink: 0, alignSelf: 'center' }} />
      <span style={{ color: colors.text, fontSize: 11.5 * scale, lineHeight: 1.15, whiteSpace: 'nowrap' }}>
        {info.kind === 'gapless' ? `即将在 ${nodeTime} 开始无缝衔接` : `即将在 ${nodeTime} 开始智能混音`}
      </span>
      <button
        type="button"
        // 这块是药丸里「镂空」出来的独立热区：命中它只做单次取消，不冒泡到药丸的跳转。
        // 语义 = 本曲对（本曲→下一曲）不做智能混音/无缝衔接，只留一次短交叉。
        title={info.kind === 'gapless'
          ? '本曲不做无缝衔接（完整播放这首歌，到结尾再自然切换）'
          : '本曲不做智能混音（完整听完这首歌，末尾只做一次短交叉）'}
        aria-label={info.kind === 'gapless' ? '本曲不做无缝衔接，完整播放本曲' : '本曲不做智能混音，完整播放本曲'}
        onClick={event => {
          event.stopPropagation()
          // 手动关闭同样算「本曲已提示过」：之后 seek/重排导致 key 变化也不会再弹回来
          memory.notified = true
          onDismiss()
        }}
        style={{
          color: colors.dim,
          fontSize: 10.5 * scale,
          whiteSpace: 'nowrap',
          // 与主文案同一基线：inline-flex（基线取首行文字基线）+ lineHeight 1 + 对称内边距
          display: 'inline-flex',
          alignItems: 'center',
          lineHeight: 1,
          padding: `${3 * scale}px ${7 * scale}px`,
          marginLeft: -2 * scale,
          borderRadius: 999,
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
        }}
        className="hover:opacity-70 transition-opacity"
      >
        关闭
      </button>
    </div>
  )
})

/** 进度条上方提示：直接显示引擎名（AutoMix / AutoMix Enhanced）+ 辉光。
 *  不再有「即将介入 / 正在介入 / 过渡效果」这类中间态文案（用户要求）。 */
export const AutomixHudProgressHint = memo(function AutomixHudProgressHint({
  info, currentTime: currentTimeProp, playbackTimeStore, scale,
}: {
  info: AutomixHudInfo
  /** 旧用法：外部传入时间。与 playbackTimeStore 二选一（后者重渲染仅限本组件） */
  currentTime?: number
  playbackTimeStore?: PlaybackTimeStore
  scale: number
}) {
  const subscribedTime = useAutomixHudTime(playbackTimeStore)
  const currentTime = playbackTimeStore ? subscribedTime : (currentTimeProp ?? 0)
  const running = info.phase === 'running'
  const remaining = info.startAt - currentTime
  const visible = running || (remaining > 0 && remaining <= AUTOMIX_HUD_LEAD_SECONDS)
  const [opacity, setOpacity] = useState(0)
  useEffect(() => {
    if (!visible) {
      setOpacity(0)
      return
    }
    // 双 rAF：同药丸 —— 单 rAF 抢在首帧绘制前执行会让入场直接跳到终值（瞬现）
    return scheduleOpacityFadeIn(setOpacity)
  }, [visible])
  return (
    <div
      className="absolute text-center"
      style={{
        top: 688 * scale,
        width: '100%',
        fontSize: 10.5 * scale,
        fontWeight: 600,
        color: AUTOMIX_HUD_GOLD,
        letterSpacing: 0.4 * scale,
        // 辉光：过渡进行中更亮，等待期稍弱但同样带光晕
        textShadow: running
          ? `0 0 ${12 * scale}px rgba(245, 196, 68, 0.75), 0 0 ${24 * scale}px rgba(245, 196, 68, 0.3)`
          : `0 0 ${9 * scale}px rgba(245, 196, 68, 0.5)`,
        pointerEvents: 'none',
        opacity: visible ? opacity : 0,
        transition: fadeTransition(visible ? opacity : 0),
      }}
    >
      {info.engineLabel}
    </div>
  )
})
