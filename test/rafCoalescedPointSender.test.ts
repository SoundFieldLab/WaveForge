import { describe, expect, it, vi } from 'vitest'
import { createRafCoalescedPointSender } from '../src/utils/rafCoalescedPointSender'

// 拖动/缩放副屏窗口时 pointermove 频率远高于帧率（240Hz 屏可达每秒数百次），
// 每次都直发会让主进程做一次 screen.getDisplayMatching + 同步 setBounds。
// 这个工具负责合并成每帧一次；语义错了会表现为「拖动发涩」或「松手后窗口差一帧」。

type Point = { x: number; y: number }

/** 假帧源：手动触发，便于观察合并行为 */
function makeHarness() {
  const sent: Point[] = []
  const frames = new Map<number, FrameRequestCallback>()
  let nextHandle = 1
  const sender = createRafCoalescedPointSender<Point>(point => sent.push(point), {
    raf: (callback) => {
      const handle = nextHandle
      nextHandle += 1
      frames.set(handle, callback)
      return handle
    },
    caf: (handle) => {
      frames.delete(handle)
    },
  })
  return {
    sender,
    sent,
    /** 当前已注册但未触发的帧数 */
    armed: () => frames.size,
    /** 触发一次帧（与真实 rAF 一样，同帧注册的回调收到同一时间戳） */
    frame(ts = 16.7) {
      const snapshot = Array.from(frames.values())
      frames.clear()
      for (const callback of snapshot) callback(ts)
    },
  }
}

describe('createRafCoalescedPointSender', () => {
  it('同一帧内多次 push 只发送最后一次', () => {
    const h = makeHarness()
    h.sender.push({ x: 1, y: 0 })
    h.sender.push({ x: 2, y: 0 })
    h.sender.push({ x: 3, y: 0 })
    expect(h.sent).toEqual([]) // 尚未到帧，不应有任何发送
    h.frame()
    expect(h.sent).toEqual([{ x: 3, y: 0 }])
  })

  it('push 只调度一次帧（同一帧内不重复注册）', () => {
    const h = makeHarness()
    h.sender.push({ x: 1, y: 0 })
    h.sender.push({ x: 2, y: 0 })
    h.sender.push({ x: 3, y: 0 })
    expect(h.armed()).toBe(1)
  })

  it('连续拖动多帧时每帧只发一次', () => {
    const h = makeHarness()
    h.sender.push({ x: 1, y: 0 })
    h.sender.push({ x: 2, y: 0 })
    h.sender.push({ x: 3, y: 0 })
    h.frame(16.7)
    h.sender.push({ x: 4, y: 0 })
    h.sender.push({ x: 5, y: 0 })
    h.frame(33.4)
    expect(h.sent).toEqual([{ x: 3, y: 0 }, { x: 5, y: 0 }])
  })

  it('帧触发后允许下一次 push 重新调度', () => {
    const h = makeHarness()
    h.sender.push({ x: 1, y: 0 })
    h.frame()
    expect(h.armed()).toBe(0)
    h.sender.push({ x: 9, y: 0 })
    expect(h.armed()).toBe(1)
    h.frame()
    expect(h.sent).toEqual([{ x: 1, y: 0 }, { x: 9, y: 0 }])
  })

  it('flush 立即送出未发送的位置并取消已排的帧（不会重复发送）', () => {
    const h = makeHarness()
    h.sender.push({ x: 5, y: 5 })
    h.sender.flush()
    expect(h.sent).toEqual([{ x: 5, y: 5 }])
    expect(h.armed()).toBe(0)
    h.frame()
    expect(h.sent).toEqual([{ x: 5, y: 5 }]) // 已 flush 的帧不会再发一次
  })

  it('拖到一半松手时 flush 能补上最后一帧的位置', () => {
    const h = makeHarness()
    h.sender.push({ x: 1, y: 0 })
    h.frame()
    // 松手发生在两帧之间：最后一次移动还没被任何帧消费
    h.sender.push({ x: 100, y: 0 })
    h.sender.flush()
    expect(h.sent).toEqual([{ x: 1, y: 0 }, { x: 100, y: 0 }])
  })

  it('没有待发送位置时 flush 不发空包', () => {
    const h = makeHarness()
    h.sender.flush()
    h.frame()
    expect(h.sent).toEqual([])
  })

  it('cancel 丢弃待发送位置且不再调度', () => {
    const h = makeHarness()
    h.sender.push({ x: 7, y: 7 })
    h.sender.cancel()
    expect(h.armed()).toBe(0)
    h.frame()
    expect(h.sent).toEqual([])
  })

  it('未提供 raf/caf 时回退到全局 rAF（浏览器/Electron 环境）', () => {
    const rafSpy = vi.fn(() => 1)
    const cafSpy = vi.fn()
    vi.stubGlobal('requestAnimationFrame', rafSpy)
    vi.stubGlobal('cancelAnimationFrame', cafSpy)
    try {
      const sender = createRafCoalescedPointSender<number>(() => undefined)
      sender.push(1)
      expect(rafSpy).toHaveBeenCalledTimes(1)
      sender.push(2)
      expect(rafSpy).toHaveBeenCalledTimes(1)
      sender.cancel()
      expect(cafSpy).toHaveBeenCalledWith(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
