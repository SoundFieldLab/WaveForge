import { describe, expect, it, vi } from 'vitest'
import {
  clearArtworkFailures,
  clearArtworkMemoryCache,
  getArtworkEpoch,
  refreshArtworkAfterAuthChange,
  subscribeArtworkEpoch,
} from '../src/services/artworkLoader'

describe('artwork recovery epoch', () => {
  it('notifies mounted images after authentication cache invalidation', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeArtworkEpoch(listener)
    const before = getArtworkEpoch()

    clearArtworkMemoryCache()

    expect(getArtworkEpoch()).toBe(before + 1)
    expect(listener).toHaveBeenCalledOnce()
    unsubscribe()
  })

  it('refreshes after authentication changes without dropping successful markers', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeArtworkEpoch(listener)
    const before = getArtworkEpoch()

    refreshArtworkAfterAuthChange()

    expect(getArtworkEpoch()).toBe(before + 1)
    expect(listener).toHaveBeenCalledOnce()
    unsubscribe()
  })
  it('retries failed URLs on an online recovery without clearing successful URL markers', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeArtworkEpoch(listener)
    const before = getArtworkEpoch()

    clearArtworkFailures()

    expect(getArtworkEpoch()).toBe(before + 1)
    expect(listener).toHaveBeenCalledOnce()
    unsubscribe()
    clearArtworkFailures()
    expect(listener).toHaveBeenCalledOnce()
  })
})
