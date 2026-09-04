/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const instances: FakeHls[] = []
  const release = vi.fn()
  class FakeHls {
    static isSupported = () => true
    static Events = { FRAG_BUFFERED: 'frag', ERROR: 'error' }
    static attachError: Error | null = null
    static loadError: Error | null = null
    handlers = new Map<string, Set<(...args: any[]) => void>>()
    destroyed = false
    source = ''
    media: HTMLMediaElement | null = null
    constructor() { instances.push(this) }
    on(event: string, callback: (...args: any[]) => void) {
      const callbacks = this.handlers.get(event) || new Set()
      callbacks.add(callback)
      this.handlers.set(event, callbacks)
    }
    off(event: string, callback: (...args: any[]) => void) { this.handlers.get(event)?.delete(callback) }
    emit(event: string, data?: any) { for (const callback of this.handlers.get(event) || []) callback(event, data) }
    attachMedia(element: HTMLMediaElement) {
      if (FakeHls.attachError) throw FakeHls.attachError
      this.media = element
    }
    loadSource(url: string) {
      if (FakeHls.loadError) throw FakeHls.loadError
      this.source = url
    }
    destroy() { this.destroyed = true }
  }
  return { FakeHls, instances, release }
})

vi.mock('hls.js', () => ({ default: mocks.FakeHls }))
vi.mock('../src/services/appleAuth', () => ({ getAppleCredentials: () => ({ developerToken: 'dev', mediaUserToken: 'user' }) }))
vi.mock('../src/services/applePlayback', () => ({
  createAppleHlsConfig: () => ({}),
  releaseAppleNativeStream: mocks.release,
}))

import { attachAppleHls, detachAppleHls, getActiveAppleStream } from '../src/services/appleHlsPlayer'
import type { AppleNativeStream } from '../src/services/applePlayback'

const stream = (id: string) => ({ url: `blob:${id}#apple-hls.m3u8`, masterUrl: `https://example/${id}`, songId: id }) as AppleNativeStream

beforeEach(() => {
  mocks.instances.length = 0
  mocks.release.mockClear()
  mocks.FakeHls.attachError = null
  mocks.FakeHls.loadError = null
})

describe('Apple HLS deck lifecycle', () => {
  it('keeps two deck sessions independent', async () => {
    const firstDeck = new Audio()
    const secondDeck = new Audio()
    const firstStream = stream('first')
    const secondStream = stream('second')
    const firstAttach = attachAppleHls(firstDeck, firstStream)
    await vi.waitFor(() => expect(mocks.instances).toHaveLength(1))
    mocks.instances[0].emit('frag')
    await firstAttach

    const secondAttach = attachAppleHls(secondDeck, secondStream)
    await vi.waitFor(() => expect(mocks.instances).toHaveLength(2))
    mocks.instances[1].emit('frag')
    await secondAttach

    detachAppleHls(firstDeck)
    expect(mocks.instances[0].destroyed).toBe(true)
    expect(mocks.instances[1].destroyed).toBe(false)
    expect(getActiveAppleStream(secondDeck)).toBe(secondStream)
    expect(mocks.release).toHaveBeenCalledWith(firstStream)
    expect(mocks.release).not.toHaveBeenCalledWith(secondStream)

    detachAppleHls(secondDeck)
  })

  it('cancels and releases an in-flight attach when the deck is replaced', async () => {
    const deck = new Audio()
    const oldStream = stream('old')
    const pending = attachAppleHls(deck, oldStream)
    await vi.waitFor(() => expect(mocks.instances).toHaveLength(1))

    detachAppleHls(deck)
    await expect(pending).rejects.toThrow('已取消')
    expect(mocks.instances[0].destroyed).toBe(true)
    expect(mocks.release).toHaveBeenCalledWith(oldStream)
  })

  it('does not treat stale media canplay as an encrypted-fragment readiness signal', async () => {
    const deck = new Audio()
    const pending = attachAppleHls(deck, stream('canplay'))
    await vi.waitFor(() => expect(mocks.instances).toHaveLength(1))
    deck.dispatchEvent(new Event('canplay'))
    let settled = false
    void pending.finally(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    mocks.instances[0].emit('frag')
    await pending
    detachAppleHls(deck)
  })

  it('cleans up when attachMedia throws synchronously', async () => {
    const failedStream = stream('sync-failure')
    mocks.FakeHls.attachError = new Error('attach failed')
    await expect(attachAppleHls(new Audio(), failedStream)).rejects.toThrow('attach failed')
    expect(mocks.instances[0].destroyed).toBe(true)
    expect(mocks.release).toHaveBeenCalledWith(failedStream)
  })

  it('reports and releases a fatal error that occurs after standby became ready', async () => {
    const deck = new Audio()
    const readyStream = stream('ready-then-failed')
    const onFatal = vi.fn()
    const pending = attachAppleHls(deck, readyStream, onFatal)
    await vi.waitFor(() => expect(mocks.instances).toHaveLength(1))
    mocks.instances[0].emit('frag')
    await pending

    mocks.instances[0].emit('error', { fatal: true, details: 'FRAG_LOAD_ERROR' })
    expect(onFatal).toHaveBeenCalledOnce()
    expect(mocks.instances[0].destroyed).toBe(true)
    expect(mocks.release).toHaveBeenCalledWith(readyStream)
  })

  it('destroys and releases its stream on a license error', async () => {
    const deck = new Audio()
    const failedStream = stream('failed')
    const pending = attachAppleHls(deck, failedStream)
    await vi.waitFor(() => expect(mocks.instances).toHaveLength(1))
    mocks.instances[0].emit('error', { fatal: false, details: 'KEY_SYSTEM_LICENSE_REQUEST_FAILED' })

    await expect(pending).rejects.toThrow('Apple HLS 加载失败')
    expect(mocks.instances[0].destroyed).toBe(true)
    expect(mocks.release).toHaveBeenCalledWith(failedStream)
  })
})
