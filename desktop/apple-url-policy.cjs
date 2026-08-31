'use strict'

const APPLE_PROFILE_HOSTS = new Set([
  'music.apple.com',
  'account.apple.com',
  'appleid.apple.com',
])

function isAllowedApplePageUrl(value) {
  try {
    const url = new URL(String(value))
    const host = url.hostname.toLowerCase()
    return url.protocol === 'https:' && (APPLE_PROFILE_HOSTS.has(host) || host.endsWith('.music.apple.com'))
  } catch {
    return false
  }
}

async function readTextWithLimit(response, maxBytes = 2 * 1024 * 1024) {
  const declared = Number(response.headers?.get?.('content-length') || 0)
  if (declared > maxBytes) throw new Error('response exceeds byte limit')
  if (!response.body?.getReader) {
    const text = await response.text()
    if (Buffer.byteLength(text) > maxBytes) throw new Error('response exceeds byte limit')
    return text
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await Promise.resolve(reader.cancel('response exceeds byte limit')).catch(() => undefined)
        throw new Error('response exceeds byte limit')
      }
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

async function fetchAllowedApplePage(fetchImpl, initialUrl, init = {}, maxRedirects = 5) {
  let currentUrl = String(initialUrl)
  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    if (!isAllowedApplePageUrl(currentUrl)) throw new Error('Apple profile URL is not allowed')
    const response = await fetchImpl(currentUrl, { ...init, redirect: 'manual' })
    if (response.status < 300 || response.status >= 400) return response
    const location = response.headers.get('location')
    if (!location) throw new Error(`Apple profile redirect ${response.status} is missing Location`)
    currentUrl = new URL(location, currentUrl).href
  }
  throw new Error('Apple profile redirect limit exceeded')
}

module.exports = { isAllowedApplePageUrl, readTextWithLimit, fetchAllowedApplePage }
