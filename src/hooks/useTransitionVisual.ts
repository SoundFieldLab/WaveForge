import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { TransitionVisualSnapshot, TransitionVisualStore } from '../audio/transitionVisualStore'

const NOOP_SUBSCRIBE = () => () => {}

const EMPTY_SNAPSHOT: TransitionVisualSnapshot = {
  active: false,
  progress: 0,
  duration: 0,
  sourceTime: 0,
  targetTime: 0,
  switched: false,
  fromTrackKey: '',
  toTrackKey: '',
  animationLeadSeconds: 10,
}

/**
 * 过渡叠加层的**展示进度**（0..1）——所有叠加面（封面 / 歌名歌手 / 整页背景 / MV）必须用同一个：
 *
 *   1. **窗口门控**：只在动画窗口内（源曲时间轴到达 `duration - animationLeadSeconds`）才离开 0，
 *      避免"窗口一开就硬跳到中段"（AI 长混音尤其明显）。
 *   2. **最后 4 秒窗口**：叠加在过渡的最后一段完成，时长取 `min(4, duration)`。
 *   3. **终点 = 90%**：交叉淡化在视觉轨道切换点（90%）恰好到 100%——随后叠加层退休、
 *      由 canonical（已是目标曲）无缝接替，提交帧不再有任何可见变化。
 *   4. **smoothstep 缓动**：把线性进度映射成 ease-in-out，避免"起步/收尾各一顿"。
 *
 * 这是纯函数：叶子组件用 `useTransitionOverlayProgress` 直接消费 store 的逐帧进度，
 * 不再经过 App 的 React 状态（那里有 10fps 节流，是"过渡看起来卡"的历史根因）。
 */
export function transitionOverlayProgress(progress: number, duration: number, animationLeadSeconds = 10): number {
  const dur = duration > 0 ? duration : 20
  const lead = Number.isFinite(animationLeadSeconds) && animationLeadSeconds > 0 ? animationLeadSeconds : 10
  // 窗口门控：源曲时间轴还没到动画窗口起点时保持 0
  const windowStart = 1 - lead / dur
  if (progress < windowStart) return 0
  const end = 0.9
  // 叠加渐变窗口：从动画窗口起点铺到 90% 视觉切换点。span 取 min(4s, 窗口可用时长)——
  // 不能直接用 min(4, dur)：AI 长混音（dur=60、lead=20）时 1-4/60=0.933 > 0.9，
  // start>end 会让渐变区间倒置 → progress 到 0.9 时叠加层从 0 直接跳 1（观感"瞬间变"）。
  const span = Math.min(4, dur, Math.max(0.1, dur * (end - windowStart)))
  const start = end - span / dur
  if (progress >= end) return 1
  const linear = Math.max(0, Math.min(1, (progress - start) / Math.max(1e-6, end - start)))
  // smoothstep：两端更缓、中段更快 —— 观感上更像"滑过去"而不是"推过去"
  return linear * linear * (3 - 2 * linear)
}

/**
 * 订阅过渡视觉轨道快照：进度/时间线以 ~30fps 更新，但**只重渲染订阅它的叶子组件**。
 * 未传 store（老调用点/非过渡场景）时返回一个稳定的空快照。
 */
export function useTransitionVisual(store?: TransitionVisualStore | null): TransitionVisualSnapshot {
  const subscribe = useCallback(
    (listener: () => void) => (store ? store.subscribe(listener) : NOOP_SUBSCRIBE()),
    [store],
  )
  const getSnapshot = useCallback(
    () => (store ? store.getSnapshot() : EMPTY_SNAPSHOT),
    [store],
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** 只要原始进度时用这个（避免订阅者因其它字段变化重渲染）。 */
export function useTransitionVisualProgress(store?: TransitionVisualStore | null, fallback = 0): number {
  const subscribe = useCallback(
    (listener: () => void) => (store ? store.subscribe(listener) : NOOP_SUBSCRIBE()),
    [store],
  )
  const getSnapshot = useCallback(
    () => (store ? store.getSnapshot().progress : fallback),
    [store, fallback],
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * 叠加层展示进度（窗口归一化 + 90% 终点 + smoothstep）。
 * `fallback` 用于未传 store 的老调用点（直接给 App 侧算好的 overlayProgress）。
 */
export function useTransitionOverlayProgress(store?: TransitionVisualStore | null, fallback = 0): number {
  const subscribe = useCallback(
    (listener: () => void) => (store ? store.subscribe(listener) : NOOP_SUBSCRIBE()),
    [store],
  )
  const getSnapshot = useCallback(() => {
    if (!store) return fallback
    const snapshot = store.getSnapshot()
    // 非过渡期一律 0：store 会在提交后"保留最后一帧"（progress=1）供 App 同批渲染使用，
    // 但叶子组件若把那一帧当成当前进度，就会在"下一首已武装（armed）、但还没开始过渡"时
    // 把预载槽按 opacity=1 显示出来（实测：歌曲开始 1-2 秒后 MV 背景变成下一首的画面）。
    if (!snapshot.active) return 0
    return transitionOverlayProgress(snapshot.progress, snapshot.duration, snapshot.animationLeadSeconds)
  }, [store, fallback])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * 歌词交叉淡化进度（0→1）：**覆盖整段过渡时长**，在视觉切换点（90%）恰好到 1。
 *
 * 与 `transitionOverlayProgress` 的区别：
 *   - 不做"最后 4 秒窗口"门控 —— 用户要求"前一首进入过渡就开始逐渐淡、后一首逐渐淡入"，
 *     所以过渡一开始两条时间线就交叉；
 *   - 终点同样锚在 90%（视觉切换帧），因此切换那一刻旧歌词已经是 0、新歌词已经是 1，
 *     帧与帧之间没有可见变化。
 */
export function transitionLyricsCrossfadeProgress(progress: number, switched: boolean): number {
  if (switched) return 1
  const p = Math.max(0, Math.min(1, (Number.isFinite(progress) ? progress : 0) / 0.9))
  // smoothstep：起步缓（刚进混音时歌词不会立刻变淡）、中段快、收尾稳
  return p * p * (3 - 2 * p)
}

export function useTransitionLyricsCrossfade(store?: TransitionVisualStore | null, fallback = 0): number {
  const subscribe = useCallback(
    (listener: () => void) => (store ? store.subscribe(listener) : NOOP_SUBSCRIBE()),
    [store],
  )
  const getSnapshot = useCallback(() => {
    if (!store) return fallback
    const snapshot = store.getSnapshot()
    if (!snapshot.active) return 0
    return transitionLyricsCrossfadeProgress(snapshot.progress, snapshot.switched)
  }, [store, fallback])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** 过渡的"离散事实"（是否有过渡 / 是否已切到目标曲 / 两端 trackKey）。
 *  进度以 ~30fps 变化，但这里只订阅这几个字段 —— 宿主组件不会跟着逐帧重渲染。 */
export function useTransitionVisualIdentity(store?: TransitionVisualStore | null): {
  active: boolean
  switched: boolean
  fromTrackKey: string
  toTrackKey: string
} {
  const subscribe = useCallback(
    (listener: () => void) => (store ? store.subscribe(listener) : NOOP_SUBSCRIBE()),
    [store],
  )
  const getSnapshot = useCallback(() => {
    if (!store) return ''
    const snapshot = store.getSnapshot()
    return `${snapshot.active ? 1 : 0}|${snapshot.switched ? 1 : 0}|${snapshot.fromTrackKey}|${snapshot.toTrackKey}`
  }, [store])
  const key = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  return useMemo(() => {
    const [active, switched, fromTrackKey, toTrackKey] = key.split('|')
    return {
      active: active === '1',
      switched: switched === '1',
      fromTrackKey: fromTrackKey || '',
      toTrackKey: toTrackKey || '',
    }
  }, [key])
}

/** 目标曲时间轴（过渡中为混音推进到的目标曲绝对时间；切换后与播放时钟一致）。
 *  只给"需要独立时钟"的叶子用（如过渡期先行淡入的下一首歌词）。 */
export function useTransitionTargetTime(store?: TransitionVisualStore | null, fallback = 0): number {
  const subscribe = useCallback(
    (listener: () => void) => (store ? store.subscribe(listener) : NOOP_SUBSCRIBE()),
    [store],
  )
  const getSnapshot = useCallback(
    () => (store ? store.getSnapshot().targetTime : fallback),
    [store, fallback],
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
