// @vitest-environment jsdom
import { describe, expect, it, vi, beforeAll } from 'vitest'
import { render, act } from '@testing-library/react'
import {
  createPlaybackTimeStore,
  type PlaybackTimeStore,
} from '../src/audio/playbackTimeStore'
import type { LyricLine } from '../src/services/musicApi'

/**
 * 汽水推荐页歌词面板的行为回归。
 *
 * 背景（用户实测两轮反馈）：
 *  1. 「整个歌词滚动就是有问题的」——旧实现滚动容器缺 `position:relative`，
 *     `offsetTop` 参照到外层页面 → scrollTo 目标出界 → 表现为不动/乱跳。
 *  2. 「逐字有问题」——旧实现直接读 4Hz 快照，扫线一卡一卡；客户端是 rAF 线性外推。
 *
 * 这里直接测行为：滚动跟随是否发生、目标位置是否落在容器范围内、逐字是否平滑推进。
 */

function makeLyrics(count = 30): LyricLine[] {
  return Array.from({ length: count }, (_, i) => ({
    time: i * 10, // 每 10 秒一行
    endTime: i * 10 + 9,
    text: `歌词第${i}行测试内容`,
  }))
}

function makeStore(): PlaybackTimeStore {
  return createPlaybackTimeStore({ currentTime: 0, duration: 300, isPlaying: true })
}

// jsdom 没有实现 Element.scrollTo / scrollHeight 布局，按 jsdom 惯例补最小桩：
// scrollTo 真正写入 scrollTop（这样能断言「跟随发生了、目标在容器范围内」）；
// offsetTop 由测试给行元素按 120(顶 padding) + index*行高 布线；scrollHeight 按内容推算。
beforeAll(() => {
  if (!Element.prototype.scrollTo) {
    Element.prototype.scrollTo = function scrollTo(this: HTMLElement, arg?: { top?: number }) {
      const top = typeof arg === 'number' ? arg : arg?.top
      if (typeof top === 'number') this.scrollTop = top
    }
  }
})

async function flushFrames(frames = 3) {
  for (let i = 0; i < frames; i += 1) await act(async () => { await new Promise(r => requestAnimationFrame(() => r(null))) })
}

// 组件未导出，从实现文件内部拿（Vite 支持）。为了稳定，直接引入默认导出的页面会拖入大依赖；
// 这里用一个最小 harness：把 SodaPcPlayerFeed 的歌词面板单独挂载是不可行的（未导出），
// 因此改为通过页面组件挂载（mock 掉网络与图片）。
import SodaPcPlayerFeed from '../src/features/traditionalPc/SodaPcPlayerFeed'

describe('汽水推荐页歌词面板（滚动 + 逐字）', () => {
  it('播放推进时滚动跟随：scrollTop 变化且落在容器范围内（offsetTop 参照正确）', async () => {
    const store = makeStore()
    const lyrics = makeLyrics(30)
    const { container } = render(
      <SodaPcPlayerFeed
        tone="dark"
        accent="#38bdf8"
        song={{ id: 1, mid: '1', name: '测试歌', artists: [{ name: 'A' }], album: { name: 'X', picUrl: '' }, duration: 300000, platform: 'soda' } as any}
        isPlaying
        liked={false}
        lyrics={lyrics}
        playbackTimeStore={store}
        onOpenComments={() => {}}
        onPlayPause={() => {}}
        onStartFeed={() => {}}
      />,
    )
    const scroller = container.querySelector<HTMLElement>('[data-testid="soda-pc-lyrics"]')
    expect(scroller).toBeTruthy()
    // 关键回归点：容器必须是定位元素（offsetTop 的参照祖先）
    expect(getComputedStyle(scroller!).position).toBe('relative')

    // 布线：jsdom 无布局，按组件常量模拟（顶/底 padding 120 + 行高 34 + 段间距 8）
    const rows = [...scroller!.querySelectorAll<HTMLElement>('[data-pi]')]
    expect(rows.length).toBe(30)
    rows.forEach((row, i) => {
      Object.defineProperty(row, 'offsetTop', { value: 120 + i * 42, configurable: true })
    })
    Object.defineProperty(scroller!, 'scrollHeight', { value: 120 + 30 * 42 + 120, configurable: true })
    let currentTop = 0
    Object.defineProperty(scroller!, 'scrollTop', {
      get: () => currentTop,
      set: (v: number) => { currentTop = v },
      configurable: true,
    })

    // 推进到第 20 行（200s），发布快照并跑几帧
    act(() => { store.publish({ currentTime: 200, isPlaying: true }) })
    await flushFrames(4)
    await act(async () => { await new Promise(r => setTimeout(r, 120)) })

    const scrollTop = scroller!.scrollTop
    // 滚动发生了（不是 0 卡死）
    expect(scrollTop).toBeGreaterThan(0)
    // 目标合理：不超出 scrollHeight（旧 bug 是目标出界导致根本滚不过去）
    expect(scrollTop).toBeLessThanOrEqual(scroller!.scrollHeight)
    // 目标 = 行20.offsetTop - 80 = 120 + 20*42 - 80 = 880（offsetTop 参照正确的直接证据）
    expect(scrollTop).toBe(120 + 20 * 42 - 80)
  })

  it('逐字平滑推进：两次采样之间 backgroundPositionX 单调变化（rAF 外推，非 4Hz 跳变）', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const store = makeStore()
      const lyrics: LyricLine[] = [{
        time: 100, // 行起点 100s
        endTime: 110,
        text: '逐字测试',
        words: [
          { word: '逐', startTime: 0, duration: 1000 },
          { word: '字', startTime: 1000, duration: 1000 },
          { word: '测', startTime: 2000, duration: 1000 },
          { word: '试', startTime: 3000, duration: 1000 },
        ],
      }]
      const { container } = render(
        <SodaPcPlayerFeed
          tone="dark"
          accent="#38bdf8"
          song={{ id: 1, mid: '1', name: '测试歌', artists: [{ name: 'A' }], album: { name: 'X', picUrl: '' }, duration: 300000, platform: 'soda' } as any}
          isPlaying
          liked={false}
          lyrics={lyrics}
          playbackTimeStore={store}
          onOpenComments={() => {}}
          onPlayPause={() => {}}
          onStartFeed={() => {}}
        />,
      )
      // 快照：进入第二字的行内位置
      act(() => { store.publish({ currentTime: 101.5, isPlaying: true }) })
      await flushFrames(3)
      const active = container.querySelector('[data-active-lyric]')
      expect(active).toBeTruthy()
      const spans = [...active!.querySelectorAll<HTMLElement>('span[data-ci]')]
      expect(spans.length).toBe(4)
      // 第 1 字应已 100%，第 2 字在推进中（0~100 之间），第 3/4 字应为 0%
      const pos = spans.map(s => parseFloat(s.style.backgroundPositionX))
      expect(pos[0]).toBe(100)
      expect(pos[1]).toBeGreaterThan(0)
      expect(pos[1]).toBeLessThan(100)
      expect(pos[3]).toBe(0)
      // 推进 0.5s（不发布新快照——纯 rAF 外推），第 2 字继续走
      const before = pos[1]
      await act(async () => { vi.advanceTimersByTime(500) })
      await flushFrames(3)
      const after = parseFloat(spans[1].style.backgroundPositionX)
      expect(after).toBeGreaterThan(before)
      // 且仍在推进区间内（没有跳满）
      expect(after).toBeLessThanOrEqual(100)
    } finally {
      vi.useRealTimers()
    }
  })

  it('滚轮暂停跟随：锁定期间活动行变了也不滚动，恢复后重新跟随', { timeout: 15000 }, async () => {
    const store = makeStore()
    const lyrics = makeLyrics(30)
    const { container } = render(
      <SodaPcPlayerFeed
        tone="dark"
        accent="#38bdf8"
        song={{ id: 1, mid: '1', name: '测试歌', artists: [{ name: 'A' }], album: { name: 'X', picUrl: '' }, duration: 300000, platform: 'soda' } as any}
        isPlaying
        liked={false}
        lyrics={lyrics}
        playbackTimeStore={store}
        onOpenComments={() => {}}
        onPlayPause={() => {}}
        onStartFeed={() => {}}
      />,
    )
    const scroller = container.querySelector<HTMLElement>('[data-testid="soda-pc-lyrics"]')!
    const rows = [...scroller.querySelectorAll<HTMLElement>('[data-pi]')]
    rows.forEach((row, i) => {
      Object.defineProperty(row, 'offsetTop', { value: 120 + i * 42, configurable: true })
    })
    Object.defineProperty(scroller, 'scrollHeight', { value: 120 + 30 * 42 + 120, configurable: true })
    let currentTop = 0
    Object.defineProperty(scroller, 'scrollTop', {
      get: () => currentTop,
      set: (v: number) => { currentTop = v },
      configurable: true,
    })

    // 正常跟随到第 2 行
    act(() => { store.publish({ currentTime: 20, isPlaying: true }) })
    await flushFrames(3)
    await act(async () => { await new Promise(r => setTimeout(r, 100)) })
    const followedTop = scroller.scrollTop
    expect(followedTop).toBe(120 + 2 * 42 - 80)

    // 用户滚轮 → 锁 5 秒；随后活动行跳到第 10 行
    await act(async () => {
      scroller.dispatchEvent(new WheelEvent('wheel'))
      store.publish({ currentTime: 100, isPlaying: true })
      await new Promise(r => setTimeout(r, 120))
    })
    const lockedTop = scroller.scrollTop
    // 锁定期间不跟随（停留在用户滚动位置语义 = 不被自动滚走）
    expect(lockedTop).toBe(followedTop)

    // 5 秒后（未发新快照）活动行再次变化 → 不主动滚（恢复是被动的，与客户端一致）；
    // 发新快照 → 重新跟随
    await act(async () => { await new Promise(r => setTimeout(r, 5200)) })
    act(() => { store.publish({ currentTime: 250, isPlaying: true }) })
    await flushFrames(3)
    await act(async () => { await new Promise(r => setTimeout(r, 120)) })
    const resumedTop = scroller.scrollTop
    expect(resumedTop).toBe(120 + 25 * 42 - 80)
  })

  it('切歌：首行时间变化时滚回顶部（引用相同但内容变了也触发）', { timeout: 15000 }, async () => {
    const store = makeStore()
    const lyricsA = makeLyrics(20)
    const { container, rerender } = render(
      <SodaPcPlayerFeed
        tone="dark"
        accent="#38bdf8"
        song={{ id: 1, mid: '1', name: 'A歌', artists: [{ name: 'A' }], album: { name: 'X', picUrl: '' }, duration: 300000, platform: 'soda' } as any}
        isPlaying
        liked={false}
        lyrics={lyricsA}
        playbackTimeStore={store}
        onOpenComments={() => {}}
        onPlayPause={() => {}}
        onStartFeed={() => {}}
      />,
    )
    const scroller = container.querySelector<HTMLElement>('[data-testid="soda-pc-lyrics"]')!
    const wire = (n: number) => {
      const rows = [...scroller.querySelectorAll<HTMLElement>('[data-pi]')]
      rows.forEach((row, i) => {
        Object.defineProperty(row, 'offsetTop', { value: 120 + i * 42, configurable: true })
      })
      Object.defineProperty(scroller, 'scrollHeight', { value: 120 + rows.length * 42 + 120, configurable: true })
    }
    let currentTop = 0
    Object.defineProperty(scroller, 'scrollTop', {
      get: () => currentTop,
      set: (v: number) => { currentTop = v },
      configurable: true,
    })

    wire(20) // 必须在 publish 前布线：滚动 effect 在 activeIndex 变化时同步读 offsetTop
    act(() => { store.publish({ currentTime: 150, isPlaying: true }) })
    await flushFrames(3)
    await act(async () => { await new Promise(r => setTimeout(r, 100)) })
    expect(scroller.scrollTop).toBeGreaterThan(0)

    // 同一首歌换了份歌词数据（引用变化、内容也变）→ 回顶
    // 首行时间也要真的不同（切歌 effect 的触发依据就是它）：B 歌从 5s 起唱
    const lyricsB = makeLyrics(20).map((l, i) => ({ ...l, text: l.text + '!', time: l.time + 5, endTime: (l.endTime ?? 0) + 5 }))
    rerender(
      <SodaPcPlayerFeed
        tone="dark"
        accent="#38bdf8"
        song={{ id: 2, mid: '2', name: 'B歌', artists: [{ name: 'B' }], album: { name: 'Y', picUrl: '' }, duration: 300000, platform: 'soda' } as any}
        isPlaying
        liked={false}
        lyrics={lyricsB}
        playbackTimeStore={store}
        onOpenComments={() => {}}
        onPlayPause={() => {}}
        onStartFeed={() => {}}
      />,
    )
    await flushFrames(3)
    expect(scroller.scrollTop).toBe(0)
  })
})
