import { describe, it, expect, vi } from 'vitest'
import { createPlaybackTimeStore } from '../src/audio/playbackTimeStore.ts'

describe('createPlaybackTimeStore（播放时间状态存储）', () => {
  it('默认初始值为 0/0/false', () => {
    const store = createPlaybackTimeStore()
    expect(store.getSnapshot()).toEqual({ currentTime: 0, duration: 0, isPlaying: false })
  })

  it('支持传入初始值并补齐缺省字段', () => {
    const store = createPlaybackTimeStore({ currentTime: 12.5, isPlaying: true })
    expect(store.getSnapshot()).toEqual({ currentTime: 12.5, duration: 0, isPlaying: true })
  })

  it('getSnapshot 返回同一引用（不可变快照语义）', () => {
    const store = createPlaybackTimeStore()
    expect(store.getSnapshot()).toBe(store.getSnapshot())
  })

  it('publish 更新快照并生成新引用', () => {
    const store = createPlaybackTimeStore()
    const before = store.getSnapshot()
    store.publish({ currentTime: 3.14 })
    const after = store.getSnapshot()
    expect(after).not.toBe(before)
    expect(after).toEqual({ currentTime: 3.14, duration: 0, isPlaying: false })
  })

  it('publish 部分字段时其余字段保持不变', () => {
    const store = createPlaybackTimeStore({ currentTime: 1, duration: 100, isPlaying: true })
    store.publish({ isPlaying: false })
    expect(store.getSnapshot()).toEqual({ currentTime: 1, duration: 100, isPlaying: false })
  })

  it('publish 无变化值时去重（不通知订阅者、不替换引用）', () => {
    const store = createPlaybackTimeStore({ currentTime: 1, duration: 100, isPlaying: true })
    const listener = vi.fn()
    store.subscribe(listener)

    const before = store.getSnapshot()
    store.publish({ currentTime: 1 }) // 与当前相同
    expect(listener).not.toHaveBeenCalled()
    expect(store.getSnapshot()).toBe(before)

    store.publish({ currentTime: 1, duration: 100, isPlaying: true }) // 全量相同
    expect(listener).not.toHaveBeenCalled()
  })

  it('subscribe 的监听器在状态变化时被通知', () => {
    const store = createPlaybackTimeStore()
    const listener = vi.fn()
    store.subscribe(listener)
    store.publish({ currentTime: 5 })
    expect(listener).toHaveBeenCalledTimes(1)
    store.publish({ isPlaying: true })
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('subscribe 返回的取消函数可解除订阅', () => {
    const store = createPlaybackTimeStore()
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)
    unsubscribe()
    store.publish({ currentTime: 1 })
    expect(listener).not.toHaveBeenCalled()
  })

  it('支持多个订阅者，且单个取消不影响其余订阅者', () => {
    const store = createPlaybackTimeStore()
    const first = vi.fn()
    const second = vi.fn()
    const unsubscribeFirst = store.subscribe(first)
    store.subscribe(second)
    unsubscribeFirst()
    store.publish({ currentTime: 1 })
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('重复取消安全（幂等）', () => {
    const store = createPlaybackTimeStore()
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)
    unsubscribe()
    unsubscribe()
    store.publish({ currentTime: 1 })
    expect(listener).not.toHaveBeenCalled()
  })
})
