import { describe, expect, it, vi } from 'vitest'
import { ByteLruCache, readResponseWithLimit } from '../server/byte-lru-cache.mjs'

describe('ByteLruCache', () => {
  it('evicts least-recently-used entries by byte budget', () => {
    const cache = new ByteLruCache({ maxBytes: 10, maxEntries: 10, ttlMs: 1_000 })
    cache.set('a', 'A', 4, 0)
    cache.set('b', 'B', 4, 0)
    expect(cache.get('a', 1)).toBe('A')
    cache.set('c', 'C', 4, 1)
    expect(cache.get('b', 2)).toBeNull()
    expect(cache.get('a', 2)).toBe('A')
    expect(cache.bytes).toBe(8)
  })

  it('prunes expired entries and rejects items above the total budget', () => {
    const cache = new ByteLruCache({ maxBytes: 5, maxEntries: 2, ttlMs: 10 })
    cache.set('a', 'A', 3, 0)
    expect(cache.get('a', 11)).toBeNull()
    expect(cache.set('huge', 'H', 6, 12)).toBe(false)
    expect(cache.size).toBe(0)
  })

  it('validates byte accounting and clears entries atomically', () => {
    expect(() => new ByteLruCache({ maxBytes: 0, maxEntries: 1, ttlMs: 1 })).toThrow(/maxBytes/)
    const cache = new ByteLruCache({ maxBytes: 10, maxEntries: 2, ttlMs: 1_000 })
    expect(() => cache.set('bad', 'value', -1)).toThrow(/bytes/)
    cache.set('a', 'A', 4)
    cache.clear()
    expect(cache.size).toBe(0)
    expect(cache.bytes).toBe(0)
  })
  it('reports hit/miss counters and supports active pruning', () => {
    const cache = new ByteLruCache({ maxBytes: 10, maxEntries: 2, ttlMs: 10 })
    cache.set('a', 'A', 4, 0)
    expect(cache.get('a', 1)).toBe('A')
    expect(cache.get('missing', 1)).toBeNull()
    expect(cache.prune(11)).toBe(1)
    expect(cache.stats()).toMatchObject({ size: 0, bytes: 0, hits: 1, misses: 1, expirations: 1 })
  })
})


describe('readResponseWithLimit', () => {
  it('rejects an oversized declared length without reading the body', async () => {
    const response = new Response('small', { headers: { 'content-length': '99' } })
    await expect(readResponseWithLimit(response, 10)).rejects.toThrow(/byte limit/)
  })

  it('rejects invalid content-length values', async () => {
    const response = new Response('small', { headers: { 'content-length': '-1' } })
    await expect(readResponseWithLimit(response, 10)).rejects.toThrow(/content-length/)
  })

  it('cancels a streaming response once actual bytes exceed the limit', async () => {
    const cancel = vi.fn()
    const chunks = [new Uint8Array(6), new Uint8Array(6)]
    const reader = {
      read: vi.fn(async () => chunks.length ? { done: false, value: chunks.shift() } : { done: true }),
      cancel,
      releaseLock: vi.fn(),
    }
    const response = { headers: new Headers(), body: { getReader: () => reader } }
    await expect(readResponseWithLimit(response, 10)).rejects.toThrow(/byte limit/)
    expect(cancel).toHaveBeenCalledOnce()
  })
})
