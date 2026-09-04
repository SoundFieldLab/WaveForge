export interface AppleAcceptanceEvent {
  at: number
  type:
    | 'manifest-created'
    | 'manifest-revoked'
    | 'hls-attached'
    | 'hls-ready'
    | 'hls-destroyed'
    | 'license-request'
    | 'license-success'
    | 'license-failure'
    | 'eme-session-created'
    | 'eme-session-updated'
    | 'eme-session-closed'
}

export interface AppleAcceptanceSnapshot {
  activeHls: number
  peakActiveHls: number
  manifestsCreated: number
  manifestsRevoked: number
  hlsAttached: number
  hlsReady: number
  hlsDestroyed: number
  licenseRequests: number
  licenseSuccesses: number
  licenseFailures: number
  emeSessionsCreated: number
  emeSessionUpdates: number
  emeSessionsClosed: number
  activeEmeSessions: number
  peakActiveEmeSessions: number
  events: AppleAcceptanceEvent[]
}

const snapshot: AppleAcceptanceSnapshot = {
  activeHls: 0,
  peakActiveHls: 0,
  manifestsCreated: 0,
  manifestsRevoked: 0,
  hlsAttached: 0,
  hlsReady: 0,
  hlsDestroyed: 0,
  licenseRequests: 0,
  licenseSuccesses: 0,
  licenseFailures: 0,
  emeSessionsCreated: 0,
  emeSessionUpdates: 0,
  emeSessionsClosed: 0,
  activeEmeSessions: 0,
  peakActiveEmeSessions: 0,
  events: [],
}

let restoreEmeInstrumentation: (() => void) | null = null
let acceptanceEnabled = false
let acceptanceEpoch = 0

export function recordAppleAcceptanceEvent(type: AppleAcceptanceEvent['type']): void {
  if (!acceptanceEnabled) return
  if (type === 'manifest-created') snapshot.manifestsCreated += 1
  if (type === 'manifest-revoked') snapshot.manifestsRevoked += 1
  if (type === 'hls-attached') {
    snapshot.hlsAttached += 1
    snapshot.activeHls += 1
    snapshot.peakActiveHls = Math.max(snapshot.peakActiveHls, snapshot.activeHls)
  }
  if (type === 'hls-ready') snapshot.hlsReady += 1
  if (type === 'hls-destroyed') {
    snapshot.hlsDestroyed += 1
    snapshot.activeHls = Math.max(0, snapshot.activeHls - 1)
  }
  if (type === 'license-request') snapshot.licenseRequests += 1
  if (type === 'license-success') snapshot.licenseSuccesses += 1
  if (type === 'license-failure') snapshot.licenseFailures += 1
  if (type === 'eme-session-created') {
    snapshot.emeSessionsCreated += 1
    snapshot.activeEmeSessions += 1
    snapshot.peakActiveEmeSessions = Math.max(snapshot.peakActiveEmeSessions, snapshot.activeEmeSessions)
  }
  if (type === 'eme-session-updated') snapshot.emeSessionUpdates += 1
  if (type === 'eme-session-closed') {
    snapshot.emeSessionsClosed += 1
    snapshot.activeEmeSessions = Math.max(0, snapshot.activeEmeSessions - 1)
  }
  snapshot.events.push({ at: Date.now(), type })
  if (snapshot.events.length > 100) snapshot.events.splice(0, snapshot.events.length - 100)
}

export function installAppleEmeAcceptanceInstrumentation(): () => void {
  if (restoreEmeInstrumentation) return restoreEmeInstrumentation
  if (typeof MediaKeys === 'undefined' || typeof MediaKeySession === 'undefined') return () => undefined
  acceptanceEnabled = true

  const mediaKeysPrototype = MediaKeys.prototype
  const mediaKeySessionPrototype = MediaKeySession.prototype
  const originalCreateSession = mediaKeysPrototype.createSession
  const originalUpdate = mediaKeySessionPrototype.update
  const originalClose = mediaKeySessionPrototype.close
  const closedSessions = new WeakSet<MediaKeySession>()
  const sessionEpochs = new WeakMap<MediaKeySession, number>()

  mediaKeysPrototype.createSession = function (...args: Parameters<MediaKeys['createSession']>) {
    const session = originalCreateSession.apply(this, args)
    sessionEpochs.set(session, acceptanceEpoch)
    recordAppleAcceptanceEvent('eme-session-created')
    return session
  }
  mediaKeySessionPrototype.update = function (...args: Parameters<MediaKeySession['update']>) {
    return originalUpdate.apply(this, args).then(result => {
      if (sessionEpochs.get(this) === acceptanceEpoch) recordAppleAcceptanceEvent('eme-session-updated')
      return result
    })
  }
  mediaKeySessionPrototype.close = function (...args: Parameters<MediaKeySession['close']>) {
    if (!closedSessions.has(this)) {
      closedSessions.add(this)
      if (sessionEpochs.get(this) === acceptanceEpoch) recordAppleAcceptanceEvent('eme-session-closed')
    }
    return originalClose.apply(this, args)
  }

  restoreEmeInstrumentation = () => {
    mediaKeysPrototype.createSession = originalCreateSession
    mediaKeySessionPrototype.update = originalUpdate
    mediaKeySessionPrototype.close = originalClose
    acceptanceEnabled = false
    restoreEmeInstrumentation = null
  }
  return restoreEmeInstrumentation
}

export function getAppleAcceptanceSnapshot(): AppleAcceptanceSnapshot {
  return {
    ...snapshot,
    events: snapshot.events.map(event => ({ ...event })),
  }
}

export function resetAppleAcceptanceSnapshot(): void {
  acceptanceEpoch += 1
  snapshot.activeHls = 0
  snapshot.peakActiveHls = 0
  snapshot.manifestsCreated = 0
  snapshot.manifestsRevoked = 0
  snapshot.hlsAttached = 0
  snapshot.hlsReady = 0
  snapshot.hlsDestroyed = 0
  snapshot.licenseRequests = 0
  snapshot.licenseSuccesses = 0
  snapshot.licenseFailures = 0
  snapshot.emeSessionsCreated = 0
  snapshot.emeSessionUpdates = 0
  snapshot.emeSessionsClosed = 0
  snapshot.activeEmeSessions = 0
  snapshot.peakActiveEmeSessions = 0
  snapshot.events = []
}
