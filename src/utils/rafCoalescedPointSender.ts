/**
 * 把高频指针位置合并成「每帧最多发一次」。
 *
 * 拖动/缩放副屏窗口时，pointermove 在 240Hz 屏上可达每秒数百次；每一次最终都会变成
 * 主进程的 `screen.getDisplayMatching()` + 同步 `setBounds()`（透明置顶窗口上尤其贵）。
 * 不合并的话拖动会明显发涩——同项目的桌面播放器（DesktopPlayerApp.startDrag）已经用
 * rAF + latest 缓存这么做了，桌面歌词与歌词岛此前是直发，属于遗漏。
 *
 * 语义：同一帧内的多次 push 只保留最后一次；结束拖动时必须 flush()，
 * 否则最后一次移动会丢（窗口停在差一帧的位置）。
 */
export interface RafCoalescedPointSender<P> {
  /** 记录最新位置，同一帧内多次调用只发最后一次 */
  push: (point: P) => void
  /** 立即送出尚未发送的最后位置（拖动结束时调用） */
  flush: () => void
  /** 丢弃待发送位置（卸载/取消时调用） */
  cancel: () => void
}

export interface RafCoalescedPointSenderOptions {
  raf?: (callback: FrameRequestCallback) => number
  caf?: (handle: number) => void
}

type RafLike = (callback: FrameRequestCallback) => number
type CafLike = (handle: number) => void

/** 取全局 rAF：渲染进程里 window === globalThis，且此时全局已被帧率限流器包装过，
 *  所以拖动发送天然跟随目标帧率。取不到时不合并（退化为直发），绝不因为缺少 rAF 而丢事件。 */
function getGlobalRaf(): RafLike | undefined {
  return (globalThis as { requestAnimationFrame?: RafLike }).requestAnimationFrame
}

function getGlobalCaf(): CafLike | undefined {
  return (globalThis as { cancelAnimationFrame?: CafLike }).cancelAnimationFrame
}

export function createRafCoalescedPointSender<P>(
  send: (point: P) => void,
  options: RafCoalescedPointSenderOptions = {},
): RafCoalescedPointSender<P> {
  const raf = options.raf ?? getGlobalRaf()
  const caf = options.caf ?? getGlobalCaf()
  let frame = 0
  let latest: P | null = null

  const sendLatest = () => {
    frame = 0
    if (latest === null) return
    const point = latest
    latest = null
    send(point)
  }

  const cancelScheduled = () => {
    if (frame !== 0 && caf) caf(frame)
    frame = 0
  }

  return {
    push(point: P) {
      latest = point
      if (!raf) {
        // 没有可用的帧源（理论上不会发生）：直发，保证位置不丢
        sendLatest()
        return
      }
      if (frame === 0) frame = raf(sendLatest)
    },
    flush() {
      cancelScheduled()
      sendLatest()
    },
    cancel() {
      cancelScheduled()
      latest = null
    },
  }
}
