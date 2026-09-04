export class ByteLruCache {
  constructor({ maxBytes, maxEntries, ttlMs }) {
    this.maxBytes = maxBytes
    this.maxEntries = maxEntries
    this.ttlMs = ttlMs
    this.entries = new Map()
    this.totalBytes = 0
  }

  get(key, now = Date.now()) {
    const entry = this.entries.get(key)
    if (!entry) return null
    if (now - entry.at >= this.ttlMs) {
      this.delete(key)
      return null
    }
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.value
  }

  set(key, value, bytes, now = Date.now()) {
    this.pruneExpired(now)
    this.delete(key)
    if (bytes > this.maxBytes) return false
    this.entries.set(key, { value, bytes, at: now })
    this.totalBytes += bytes
    while (this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.delete(oldest)
    }
    return true
  }

  delete(key) {
    const entry = this.entries.get(key)
    if (!entry) return false
    this.totalBytes = Math.max(0, this.totalBytes - entry.bytes)
    return this.entries.delete(key)
  }

  pruneExpired(now = Date.now()) {
    for (const [key, entry] of this.entries) {
      if (now - entry.at >= this.ttlMs) this.delete(key)
    }
  }

  get size() { return this.entries.size }
  get bytes() { return this.totalBytes }
}

export async function readResponseWithLimit(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length') || 0)
  if (declared > maxBytes) throw new Error('response exceeds byte limit')
  if (!response.body?.getReader) {
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > maxBytes) throw new Error('response exceeds byte limit')
    return buffer
  }
  const reader = response.body.getReader()
  const chunks = []
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
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total)
}
