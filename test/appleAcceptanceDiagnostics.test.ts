import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getAppleAcceptanceSnapshot,
  installAppleEmeAcceptanceInstrumentation,
  recordAppleAcceptanceEvent,
  resetAppleAcceptanceSnapshot,
} from '../src/services/appleAcceptanceDiagnostics'

describe('Apple acceptance diagnostics', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    resetAppleAcceptanceSnapshot()
  })

  it('does not collect events until EME acceptance instrumentation is installed', () => {
    recordAppleAcceptanceEvent('hls-attached')
    expect(getAppleAcceptanceSnapshot().hlsAttached).toBe(0)
  })

  it('collects lifecycle counters while installed and stops after restore', async () => {
    class FakeMediaKeySession {
      async update() {
        return undefined
      }
      async close() {
        return undefined
      }
    }
    class FakeMediaKeys {
      createSession() {
        return new FakeMediaKeySession()
      }
    }
    vi.stubGlobal('MediaKeys', FakeMediaKeys)
    vi.stubGlobal('MediaKeySession', FakeMediaKeySession)

    const restore = installAppleEmeAcceptanceInstrumentation()
    const keys = new MediaKeys()
    const session = keys.createSession()
    await session.update(new Uint8Array([1]))
    await session.close()
    await session.close()
    recordAppleAcceptanceEvent('hls-attached')
    recordAppleAcceptanceEvent('hls-ready')
    recordAppleAcceptanceEvent('hls-destroyed')

    expect(getAppleAcceptanceSnapshot()).toMatchObject({
      activeHls: 0,
      peakActiveHls: 1,
      hlsAttached: 1,
      hlsReady: 1,
      hlsDestroyed: 1,
      emeSessionsCreated: 1,
      emeSessionUpdates: 1,
      emeSessionsClosed: 1,
      activeEmeSessions: 0,
    })

    restore()
    recordAppleAcceptanceEvent('hls-attached')
    expect(getAppleAcceptanceSnapshot().hlsAttached).toBe(1)
  })
})
