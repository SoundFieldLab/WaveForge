'use strict'

function normalizeDocumentUrl(value) {
  try {
    const url = new URL(String(value || ''))
    url.hash = ''
    url.search = ''
    return url.href
  } catch {
    return null
  }
}

function createDocumentUrlMatcher(urls) {
  const allowed = new Set((urls || []).map(normalizeDocumentUrl).filter(Boolean))
  return value => allowed.has(normalizeDocumentUrl(value))
}

function createTrustedIpcGuard({ roles, capabilities }) {
  const roleEntries = { ...roles }
  const capabilityEntries = Object.fromEntries(
    Object.entries(capabilities || {}).map(([name, allowedRoles]) => [name, new Set(allowedRoles)])
  )

  function isTrusted(event, capability) {
    const allowedRoles = capabilityEntries[capability]
    if (!allowedRoles || !event?.sender || !event?.senderFrame) return false

    for (const role of allowedRoles) {
      const entry = roleEntries[role]
      const win = entry?.getWindow?.()
      if (!win || win.isDestroyed?.() || !win.webContents) continue
      if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) continue

      const senderUrl = event.sender.getURL?.()
      const frameUrl = event.senderFrame.url
      if (!entry.isAllowedUrl?.(senderUrl) || !entry.isAllowedUrl(frameUrl)) continue
      return true
    }
    return false
  }

  function assertTrusted(event, capability) {
    if (!isTrusted(event, capability)) throw new Error('不允许的 IPC 请求来源')
  }

  function handle(capability, handler) {
    return (event, ...args) => {
      assertTrusted(event, capability)
      return handler(event, ...args)
    }
  }

  return { isTrusted, assertTrusted, handle }
}

module.exports = { createDocumentUrlMatcher, createTrustedIpcGuard }
