/**
 * playheadSync「随曲目播放」单元测试（jsdom：含 WorldPanel 冒烟接线）
 *
 * 纯模块部分：shouldEmitPlayhead 阈值逻辑（0.04 不发 / 0.06 发 / 负变化也发 /
 * 恰为阈值不发）+ createPlayheadSyncer 假 raf 手动驱动帧回调
 * （开启即对齐、节流生效、暂停停走、seek 回退、stop 停止、重启再对齐）。
 * WorldPanel 冒烟：无时钟源隐藏开关；有时钟源开启即对齐下发一次 playhead patch；
 * 手动拖动置覆盖标志暂停自动同步（200ms 防抖后恢复）；关闭开关停止跟随。
 * 注意：文件用 .tsx 后缀是因为 vitest.config.ts 对 ui/ 目录只收集
 * `ui/**\/*.test.tsx`；组件部分需要 DOM，故文件头启用 jsdom。
 */

// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Mock } from 'vitest'
import { render, fireEvent, screen, cleanup } from '@testing-library/react'
import { createDefaultSpatialParams } from '../../src/spatial/types'
import type { PlaybackTimeStore } from '../../../../audio/playbackTimeStore'
import { useHSETheme } from '../hse-theme'
import { WorldPanel } from './WorldPanel'
import {
  createPlayheadSyncer,
  shouldEmitPlayhead,
  PLAYHEAD_EMIT_THRESHOLD,
  PLAYHEAD_MANUAL_OVERRIDE_MS,
} from './playheadSync'
import type { PlayheadSyncer } from './playheadSync'

/* ── 假 raf：手动驱动帧回调，断言节流后 onChange 的次数与值 ── */

interface FakeRaf {
  raf: (cb: (now: number) => void) => number
  /** 假 cancelAnimationFrame（Mock 以便断言 stop 时被调用） */
  cancelRaf: Mock<(id: number) => void>
  /** 手动执行下一帧（若无挂起帧则 no-op） */
  next: () => void
  /** 当前是否有挂起帧 */
  hasPending: () => boolean
}

function makeFakeRaf(): FakeRaf {
  let pending: ((now: number) => void) | null = null
  let id = 0
  const cancelRaf = vi.fn<(id: number) => void>()
  return {
    raf: (cb) => {
      pending = cb
      return ++id
    },
    cancelRaf,
    next: () => {
      const cb = pending
      pending = null
      cb?.(0)
    },
    hasPending: () => pending !== null,
  }
}

/** 假播放时钟：模拟 playbackTimeStore 的 currentTime 返回值序列 */
function makeClock(initial = 0) {
  let time = initial
  const store: PlaybackTimeStore = {
    getSnapshot: () => ({ currentTime: time, duration: 300, isPlaying: true }),
    subscribe: () => () => undefined,
    publish: (s) => {
      if (s.currentTime !== undefined) time = s.currentTime
    },
  }
  return {
    store,
    set: (v: number) => {
      time = v
    },
    get: () => time,
  }
}

/* ═══════════ shouldEmitPlayhead：节流阈值 ═══════════ */

describe('shouldEmitPlayhead', () => {
  it('默认阈值 0.05s：0.04 不发 / 0.06 发', () => {
    expect(shouldEmitPlayhead(0, 0.04)).toBe(false)
    expect(shouldEmitPlayhead(0, 0.06)).toBe(true)
    expect(PLAYHEAD_EMIT_THRESHOLD).toBe(0.05)
  })

  it('恰为阈值（|Δ| === threshold）不发：严格大于才发', () => {
    // 用二进制定点可精确表示的 0.5 阈值避开浮点表示误差（如 1.05−1.0 ≠ 0.05）
    expect(shouldEmitPlayhead(1.0, 1.5, 0.5)).toBe(false)
    expect(shouldEmitPlayhead(1.5, 1.0, 0.5)).toBe(false)
  })

  it('负变化（seek 回退）同样触发', () => {
    expect(shouldEmitPlayhead(10, 9.98)).toBe(false) // Δ=0.02 不发
    expect(shouldEmitPlayhead(10, 9.5)).toBe(true)   // Δ=0.5 发
  })

  it('无变化不发', () => {
    expect(shouldEmitPlayhead(3.33, 3.33)).toBe(false)
  })

  it('自定义阈值生效', () => {
    expect(shouldEmitPlayhead(0, 0.2, 0.5)).toBe(false)
    expect(shouldEmitPlayhead(0, 0.6, 0.5)).toBe(true)
  })
})

/* ═══════════ createPlayheadSyncer：假 raf 驱动帧回调 ═══════════ */

describe('createPlayheadSyncer', () => {
  it('开启即对齐：start() 同步下发一次当前时钟（快照对齐）', () => {
    const clock = makeClock(42.5)
    const onChange = vi.fn()
    const raf = makeFakeRaf()
    const syncer = createPlayheadSyncer(() => clock.get(), onChange, { raf: raf.raf, cancelRaf: raf.cancelRaf })
    syncer.start()
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(42.5)
    expect(raf.hasPending()).toBe(true) // 循环已挂起首帧
  })

  it('节流生效：帧序列 [0.00, 0.04, 0.10, 0.12, 0.20] 只发 3 次（0.00/0.10/0.20）', () => {
    const clock = makeClock(0)
    const onChange = vi.fn()
    const raf = makeFakeRaf()
    const syncer = createPlayheadSyncer(() => clock.get(), onChange, { raf: raf.raf, cancelRaf: raf.cancelRaf })
    syncer.start() // 对齐下发 0.00
    for (const t of [0.04, 0.10, 0.12, 0.20]) {
      clock.set(t)
      raf.next()
    }
    expect(onChange).toHaveBeenCalledTimes(3)
    expect(onChange.mock.calls.map((c) => c[0])).toEqual([0, 0.1, 0.2])
  })

  it('播放暂停：时钟停走，帧继续跑但不再下发（playhead 停在暂停点）', () => {
    const clock = makeClock(5)
    const onChange = vi.fn()
    const raf = makeFakeRaf()
    const syncer = createPlayheadSyncer(() => clock.get(), onChange, { raf: raf.raf, cancelRaf: raf.cancelRaf })
    syncer.start() // 对齐下发 5
    for (let i = 0; i < 10; i++) raf.next()
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(5)
  })

  it('seek 回退（负跳变）跨过阈值即下发', () => {
    const clock = makeClock(10)
    const onChange = vi.fn()
    const raf = makeFakeRaf()
    const syncer = createPlayheadSyncer(() => clock.get(), onChange, { raf: raf.raf, cancelRaf: raf.cancelRaf })
    syncer.start() // 10
    clock.set(3) // seek 回退 7s
    raf.next()
    expect(onChange).toHaveBeenLastCalledWith(3)
  })

  it('stop()：取消挂起帧并停止循环（重复 stop 幂等）', () => {
    const clock = makeClock(0)
    const onChange = vi.fn()
    const raf = makeFakeRaf()
    const syncer = createPlayheadSyncer(() => clock.get(), onChange, { raf: raf.raf, cancelRaf: raf.cancelRaf })
    syncer.start()
    raf.next()
    syncer.stop()
    expect(raf.cancelRaf).toHaveBeenCalled()
    const callsAfterStop = onChange.mock.calls.length
    clock.set(5)
    raf.next() // 已停止：帧回调不再执行、不重挂
    expect(raf.hasPending()).toBe(false)
    expect(onChange.mock.calls.length).toBe(callsAfterStop)
    syncer.stop() // 幂等
  })

  it('start() 幂等；stop() 后 start() 重新对齐下发', () => {
    const clock = makeClock(5)
    const onChange = vi.fn()
    const raf = makeFakeRaf()
    const syncer = createPlayheadSyncer(() => clock.get(), onChange, { raf: raf.raf, cancelRaf: raf.cancelRaf })
    syncer.start()
    syncer.start() // 幂等：不重复对齐
    expect(onChange).toHaveBeenCalledTimes(1)
    syncer.stop()
    clock.set(12)
    syncer.start() // 重新对齐到新时钟
    expect(onChange).toHaveBeenLastCalledWith(12)
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it('自定义阈值 + 不传调度器时类型可用（默认 requestAnimationFrame 兜底）', () => {
    const clock = makeClock(0)
    const onChange = vi.fn()
    const raf = makeFakeRaf()
    const syncer: PlayheadSyncer = createPlayheadSyncer(() => clock.get(), onChange, {
      threshold: 1,
      raf: raf.raf,
      cancelRaf: raf.cancelRaf,
    })
    syncer.start()
    clock.set(0.5) // |0.5-0| < 1 → 不发
    raf.next()
    expect(onChange).toHaveBeenCalledTimes(1)
    clock.set(1.5) // > 1 → 发
    raf.next()
    expect(onChange).toHaveBeenLastCalledWith(1.5)
  })
})

/* ═══════════ WorldPanel 冒烟：开关 + 自动同步接线 ═══════════ */

/** 渲染 WorldPanel 测试挂具（useHSETheme 需在组件内调用） */
function makeWorldPanel(store?: PlaybackTimeStore, onTogglePlayback?: () => void) {
  const world = createDefaultSpatialParams().world
  const onChange = vi.fn()
  const onSelectSource = vi.fn()
  const onMove = vi.fn()
  const onRotate = vi.fn()
  const onReset = vi.fn()
  const Harness = () => {
    const theme = useHSETheme()
    return (
      <WorldPanel
        params={world}
        listener={world.listener}
        sources={world.sources}
        theme={theme}
        selectedId={null}
        onChange={onChange}
        onSelectSource={onSelectSource}
        onMove={onMove}
        onRotate={onRotate}
        onReset={onReset}
        onTogglePlayback={onTogglePlayback}
        playbackTimeStore={store}
      />
    )
  }
  render(<Harness />)
  return { onChange, onMove, onRotate, onReset, onSelectSource }
}

/** 找到「随曲目播放」胶囊开关（带 aria-pressed 的按钮） */
function findFollowToggle(): HTMLElement {
  const btn = screen.getAllByRole('button').find((b) => b.getAttribute('aria-pressed') !== null)
  expect(btn).toBeTruthy()
  return btn as HTMLElement
}

/** 轨迹时间预览滑块（range 列表第 2 个：移动速度 / 轨迹时间预览 / 各声源增益） */
function findPlayheadSlider(): HTMLInputElement {
  const slider = screen.getAllByRole('slider')[1]
  expect(slider).toBeTruthy()
  return slider as HTMLInputElement
}

describe('WorldPanel「随曲目播放」', () => {
  beforeEach(() => {
    cleanup()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('无播放时钟 store：开关隐藏，面板照常渲染', () => {
    makeWorldPanel()
    expect(screen.queryByText('随曲目播放')).toBeNull()
    expect(screen.getByText('轨迹时间预览')).toBeTruthy()
  })

  it('有时钟 store：开启即对齐下发一次 playhead patch（默认关，行为不回归）', () => {
    const clock = makeClock(12.34)
    const { onChange } = makeWorldPanel(clock.store)
    // 默认关：无任何自动下发
    expect(onChange).not.toHaveBeenCalledWith(expect.objectContaining({ playhead: expect.any(Number) }))
    // 开启 → 同步器 start() 快照对齐
    fireEvent.click(findFollowToggle())
    expect(onChange).toHaveBeenCalledWith({ playhead: 12.34 })
  })

  it('开启后时钟推进：raf 帧经节流自动下发；关闭开关停止跟随', () => {
    const clock = makeClock(5)
    const { onChange } = makeWorldPanel(clock.store)
    fireEvent.click(findFollowToggle())
    onChange.mockClear() // 清掉开启时的对齐下发
    // 时钟推进 0.1s（> 0.05 阈值）→ 帧回调下发
    clock.set(5.1)
    vi.advanceTimersByTime(16)
    expect(onChange).toHaveBeenCalledWith({ playhead: 5.1 })
    // 关闭开关 → 同步器 stop，时钟再推进也不再下发
    onChange.mockClear()
    fireEvent.click(findFollowToggle())
    clock.set(5.2)
    vi.advanceTimersByTime(200)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('手动拖动与自动同步互斥：拖动置覆盖标志，200ms 防抖后恢复自动', () => {
    const clock = makeClock(5)
    const { onChange } = makeWorldPanel(clock.store)
    fireEvent.click(findFollowToggle())
    onChange.mockClear()
    // 帧推进一次：5 → 5.1 自动下发
    clock.set(5.1)
    vi.advanceTimersByTime(16)
    expect(onChange).toHaveBeenCalledWith({ playhead: 5.1 })
    // 手动拖动滑块到 7s：直接下发 + 置覆盖标志（暂停自动同步）
    onChange.mockClear()
    fireEvent.change(findPlayheadSlider(), { target: { value: '7' } })
    expect(onChange).toHaveBeenCalledWith({ playhead: 7 })
    // 覆盖期间时钟推进：自动下发被跳过（不让步）
    onChange.mockClear()
    clock.set(7.2)
    vi.advanceTimersByTime(32) // 两帧
    expect(onChange).not.toHaveBeenCalled()
    // 200ms 防抖到期 → 恢复自动：时钟跨阈值后重新对齐下发
    vi.advanceTimersByTime(PLAYHEAD_MANUAL_OVERRIDE_MS)
    clock.set(7.3)
    vi.advanceTimersByTime(16)
    expect(onChange).toHaveBeenCalledWith({ playhead: 7.3 })
  })

  it('播放暂停（时钟停走）：playhead 停在暂停点不再推进', () => {
    const clock = makeClock(30)
    const { onChange } = makeWorldPanel(clock.store)
    fireEvent.click(findFollowToggle())
    onChange.mockClear()
    clock.set(30) // 暂停：currentTime 不再变化
    vi.advanceTimersByTime(500)
    expect(onChange).not.toHaveBeenCalled()
  })
})

/* ═══════════ WorldPanel 键盘：空格播放/暂停（onTogglePlayback 可选 prop） ═══════════ */

describe('WorldPanel 键盘：空格播放/暂停', () => {
  beforeEach(() => {
    cleanup()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('空格键 → onTogglePlayback 被调（即时触发，与 raf 采样无关）', () => {
    const onTogglePlayback = vi.fn()
    makeWorldPanel(undefined, onTogglePlayback)
    fireEvent.keyDown(window, { key: ' ' })
    expect(onTogglePlayback).toHaveBeenCalledTimes(1)
  })

  it('按住重复（e.repeat）不重复触发', () => {
    const onTogglePlayback = vi.fn()
    makeWorldPanel(undefined, onTogglePlayback)
    fireEvent.keyDown(window, { key: ' ', repeat: true })
    fireEvent.keyDown(window, { key: ' ', repeat: true })
    expect(onTogglePlayback).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: ' ' })
    expect(onTogglePlayback).toHaveBeenCalledTimes(1)
  })

  it('未接线（无 onTogglePlayback）空格键静默忽略，不抛', () => {
    makeWorldPanel()
    expect(() => fireEvent.keyDown(window, { key: ' ' })).not.toThrow()
  })
})
