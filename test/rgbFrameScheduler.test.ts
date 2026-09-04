import { describe, expect, it, vi } from 'vitest'
import { RgbFrameScheduler, type RgbSchedulerTimers } from '../src/plugins/rgb/RgbFrameScheduler'
import { createRgbRuntimeStore } from '../src/plugins/rgb/RgbRuntimeStore'

class FakeTimers implements RgbSchedulerTimers {
  time = 0
  private nextId = 1
  private tasks = new Map<number, { at: number; callback: () => void }>()

  now = () => this.time

  setTimeout = (callback: () => void, delayMs: number) => {
    const id = this.nextId++
    this.tasks.set(id, { at: this.time + Math.max(0, delayMs), callback })
    return id
  }

  clearTimeout = (handle: unknown) => {
    this.tasks.delete(handle as number)
  }

  advanceTo(targetMs: number, jitterMs = 0): void {
    while (true) {
      const due = Array.from(this.tasks.entries())
        .filter(([, task]) => task.at <= targetMs)
        .sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      this.tasks.delete(due[0])
      this.time = Math.min(targetMs, due[1].at + jitterMs)
      due[1].callback()
    }
    this.time = targetMs
  }

  get size(): number {
    return this.tasks.size
  }
}

const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('RgbFrameScheduler', () => {
  it('uses absolute deadlines so timer jitter does not accumulate', async () => {
    const timers = new FakeTimers()
    const scheduled: number[] = []
    const scheduler = new RgbFrameScheduler({
      fps: 30,
      timers,
      createFrame: scheduledAt => {
        scheduled.push(scheduledAt)
        return scheduledAt
      },
      sink: () => undefined,
    })
    scheduler.start()
    timers.advanceTo(205, 7)
    await flush()
    expect(scheduled).toHaveLength(7)
    scheduled.forEach((time, index) => expect(time).toBeCloseTo(index * 100 / 3, 9))
  })

  it('produces equivalent deadlines at 15 FPS and every second 30 FPS frame', async () => {
    const run = async (fps: number) => {
      const timers = new FakeTimers()
      const frames: number[] = []
      const scheduler = new RgbFrameScheduler({
        fps,
        timers,
        createFrame: time => {
        frames.push(time)
        return time
      },
      sink: () => undefined,
      })
      scheduler.start()
      timers.advanceTo(401)
      await flush()
      scheduler.stop()
      return frames
    }

    const at15 = await run(15)
    const at30 = await run(30)
    expect(at15).toHaveLength(7)
    const at30Even = at30.filter((_, index) => index % 2 === 0)
    expect(at30Even).toHaveLength(at15.length)
    at15.forEach((time, index) => expect(at30Even[index]).toBeCloseTo(time, 9))
  })

  it('invalidates queued work when stopped immediately', async () => {
    const timers = new FakeTimers()
    const sink = vi.fn()
    const scheduler = new RgbFrameScheduler({ fps: 30, timers, createFrame: () => 1, sink })
    const startedGeneration = scheduler.start()
    scheduler.stop()
    timers.advanceTo(1000)
    await flush()
    expect(sink).not.toHaveBeenCalled()
    expect(scheduler.generation).toBe(startedGeneration + 1)
    expect(timers.size).toBe(0)
  })

  it('keeps only the latest frame while an asynchronous sink is busy', async () => {
    const timers = new FakeTimers()
    const delivered: number[] = []
    let releaseFirst: (() => void) | undefined
    const firstPending = new Promise<void>(resolve => { releaseFirst = resolve })
    const scheduler = new RgbFrameScheduler({
      fps: 30,
      timers,
      createFrame: time => Math.round(time),
      sink: frame => {
        delivered.push(frame)
        return delivered.length === 1 ? firstPending : Promise.resolve()
      },
    })

    scheduler.start()
    timers.advanceTo(0)
    await flush()
    timers.advanceTo(34)
    timers.advanceTo(67)
    await flush()
    expect(delivered).toEqual([0])
    releaseFirst?.()
    await flush()
    expect(delivered).toEqual([0, 67])
  })
})

describe('RgbRuntimeStore', () => {
  it('separates status and preview subscriptions and tracks preview subscribers', () => {
    const store = createRgbRuntimeStore()
    const statusListener = vi.fn()
    const previewListener = vi.fn()
    store.subscribeStatus(statusListener)
    const unsubscribePreview = store.subscribePreview(previewListener)
    expect(store.getPreviewSubscriberCount()).toBe(1)

    store.publishStatus({ phase: 'running', connected: true })
    expect(statusListener).toHaveBeenCalledTimes(1)
    expect(previewListener).not.toHaveBeenCalled()

    store.publishPreview({ timestampMs: 1, colors: [{ r: 1, g: 0, b: 0 }] })
    expect(previewListener).toHaveBeenCalledTimes(1)
    expect(statusListener).toHaveBeenCalledTimes(1)

    unsubscribePreview()
    expect(store.getPreviewSubscriberCount()).toBe(0)
  })
})
