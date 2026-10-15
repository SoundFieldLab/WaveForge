import { Readable } from 'node:stream'

/**
 * 流式代理的公共工具：上游拉取的两级超时守卫，以及字节范围解析。
 * 与 byte-lru-cache.mjs / image-proxy.mjs 同层：不依赖 express，便于单测直接注入 fetchImpl。
 */

export class StreamProxyError extends Error {
  constructor(status, message, cause) {
    super(message)
    this.name = 'StreamProxyError'
    this.status = status
    if (cause !== undefined) this.cause = cause
  }
}

export const DEFAULT_HEADER_TIMEOUT_MS = 15_000
export const DEFAULT_IDLE_TIMEOUT_MS = 15_000
// 仅用于截断病态上游（例如无限流）。正常音轨远低于此值，长无损整轨也在百 MB 量级。
export const DEFAULT_MAX_BYTES = 512 * 1024 * 1024

/**
 * 拉取上游并返回一个受空闲超时与字节上限约束的 Node 可读流。
 *
 * 超时语义（对齐 echo 的 RemoteStreamProxyService）：
 * - headerTimeoutMs：等待响应头的上限。CDN 只握手不吐数据时不必让客户端无限等。
 * - idleTimeoutMs：任意两次数据块之间的间隔上限，每收到一块就重新计时。整体时长不受限，
 *   因此慢速但持续推进的长音轨不会被误杀——只有真正卡死的连接才会被掐断。
 *
 * 上游返回非 2xx 时**不抛错**，而是把 response 交回调用方（沿用原有「镜像上游状态码」行为），
 * 此时 stream 为 null。
 *
 * @returns {Promise<{ response: Response, stream: Readable | null }>}
 */
export async function fetchStreamWithIdleTimeout(url, options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    headers,
    headerTimeoutMs = DEFAULT_HEADER_TIMEOUT_MS,
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    signal: externalSignal,
    /** 可选逐跳 SSRF 校验（async (url) => boolean，返回 true 表示拒绝该跳）。
     *  传入后 fetch 改为 redirect:'manual' 并循环重校验——防止公网跳板 302 到
     *  169.254.169.254 / 127.0.0.1 时被无条件跟随。未传时保持 follow（老调用方）。 */
    isUrlBlocked = null,
    maxRedirects = 5,
  } = options

  for (const [name, value] of Object.entries({ headerTimeoutMs, idleTimeoutMs, maxBytes })) {
    if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${name} must be a positive finite number`)
  }

  const controller = new AbortController()
  const abortWith = (error) => {
    if (!controller.signal.aborted) controller.abort(error)
  }
  let detachExternal = () => {}
  if (externalSignal) {
    if (externalSignal.aborted) abortWith(externalSignal.reason || new StreamProxyError(499, 'client aborted'))
    else {
      const onAbort = () => abortWith(externalSignal.reason || new StreamProxyError(499, 'client aborted'))
      externalSignal.addEventListener('abort', onAbort, { once: true })
      detachExternal = () => externalSignal.removeEventListener('abort', onAbort)
    }
  }

  const headerTimer = setTimeout(
    () => abortWith(new StreamProxyError(504, 'Audio upstream did not respond in time')),
    headerTimeoutMs,
  )
  // 计时器持有流与响应对象：不 unref 会让进程无法自然退出（开发期重启服务时尤其明显）
  headerTimer.unref?.()

  let response
  try {
    if (isUrlBlocked) {
      const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
      let currentUrl = url
      for (let hop = 0; hop <= maxRedirects; hop += 1) {
        if (await isUrlBlocked(currentUrl)) {
          throw new StreamProxyError(400, 'Audio upstream URL is not allowed')
        }
        const hopResponse = await fetchImpl(currentUrl, { headers, redirect: 'manual', signal: controller.signal })
        if (REDIRECT_STATUSES.has(hopResponse.status) && hop < maxRedirects) {
          const location = hopResponse.headers?.get?.('location')
          try { await hopResponse.body?.cancel?.() } catch { /* ignore */ }
          if (!location) throw new StreamProxyError(502, 'Audio upstream redirect missing location')
          currentUrl = new URL(location, currentUrl).href
          continue
        }
        response = hopResponse
        return finishResponse()
      }
      throw new StreamProxyError(502, 'Too many audio upstream redirects')
    }
    response = await fetchImpl(url, { headers, redirect: 'follow', signal: controller.signal })
    return finishResponse()
  } catch (error) {
    detachExternal()
    if (error instanceof StreamProxyError) throw error
    if (controller.signal.aborted) {
      const reason = controller.signal.reason
      throw reason instanceof StreamProxyError ? reason : new StreamProxyError(504, 'Audio upstream request aborted', reason)
    }
    throw new StreamProxyError(502, 'Failed to reach audio upstream', error)
  } finally {
    clearTimeout(headerTimer)
  }

  /** 拿到最终响应后的共同收尾：镜像非 2xx/206、字节上限检查、包 GuardedStream。 */
  function finishResponse() {
    if (!response.ok && response.status !== 206) {
      detachExternal()
      void response.body?.cancel?.().catch?.(() => undefined)
      return { response, stream: null }
    }

    const declared = readDeclaredLength(response)
    if (declared !== null && declared > maxBytes) {
      detachExternal()
      abortWith(new StreamProxyError(413, 'Audio upstream exceeds byte limit'))
      void response.body?.cancel?.().catch?.(() => undefined)
      throw new StreamProxyError(413, 'Audio upstream exceeds byte limit')
    }

    if (!response.body?.getReader) {
      detachExternal()
      return { response, stream: null }
    }

    const stream = createGuardedStream({
      body: response.body,
      controller,
      idleTimeoutMs,
      maxBytes,
      onSettled: detachExternal,
    })
    return { response, stream }
  }
}

function readDeclaredLength(response) {
  const raw = response.headers?.get?.('content-length')
  if (raw === null || raw === undefined) return null
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

/**
 * 把 web ReadableStream 包成带空闲超时与字节上限的 Node Readable。
 * 用 async generator 实现：消费方 destroy() 时会触发 generator 的 return，
 * finally 里取消上游 reader——与调用方 res.on('close') 的销毁路径自然衔接。
 */
function createGuardedStream({ body, controller, idleTimeoutMs, maxBytes, onSettled }) {
  const reader = body.getReader()
  let idleTimer = null
  let total = 0
  // 空闲超时先置此标记，再由主循环抛出：不能只依赖 abort/cancel 让 read() reject，
  // 手工构造的 ReadableStream（非 fetch 产物）不会因 abort 而中断，read() 会一直挂着。
  let stallError = null

  const clearIdle = () => {
    if (idleTimer !== null) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }
  const armIdle = () => {
    clearIdle()
    idleTimer = setTimeout(() => {
      idleTimer = null
      stallError = new StreamProxyError(504, 'Audio upstream stalled')
      // 双保险：abort 终止真实 fetch 的底层连接，cancel 让挂起的 read() 立刻 settle
      controller.abort(stallError)
      void reader.cancel(stallError).catch(() => undefined)
    }, idleTimeoutMs)
    idleTimer.unref?.()
  }

  const stream = Readable.from((async function* guarded() {
    try {
      while (true) {
        armIdle()
        const { done, value } = await reader.read()
        clearIdle()
        if (stallError) throw stallError
        if (done) return
        total += value.byteLength
        if (total > maxBytes) {
          throw new StreamProxyError(413, 'Audio upstream exceeds byte limit')
        }
        yield Buffer.from(value)
      }
    } finally {
      clearIdle()
      onSettled?.()
      await reader.cancel().catch(() => undefined)
    }
  })())

  // 在迭代开始前就被 destroy 时（客户端拿到响应头立刻断开），generator 的 finally
  // 还来不及注册，只能靠 close 事件兜底取消 reader，否则上游连接会一直挂着。
  stream.once('close', () => {
    clearIdle()
    onSettled?.()
    void reader.cancel().catch(() => undefined)
  })

  return stream
}

/**
 * 解析单段 Range 头。
 *
 * 返回：
 * - null            无 Range、语法非法、或为多段范围（多段不支持，按 200 全量处理，HTTP 允许忽略 Range）
 * - 'unsatisfiable' 语法合法但区间越界（调用方应回 416 + Content-Range: bytes *\/total）
 * - { start, end }  闭区间，end 已按 total-1 收敛
 *
 * 三种形式都要支持，尤其是后缀范围 `bytes=-N`：早期实现把它当成 `0-N`，
 * 取到的是文件开头而不是结尾（seek 到末尾的场景会拿到完全错误的数据）。
 */
export function parseByteRange(header, total) {
  if (!Number.isSafeInteger(total) || total <= 0) return 'unsatisfiable'
  if (typeof header !== 'string') return null
  const match = /^bytes=(.+)$/i.exec(header.trim())
  if (!match) return null
  const spec = match[1].trim()
  if (!spec || spec.includes(',')) return null

  const parts = /^(\d*)-(\d*)$/.exec(spec)
  if (!parts) return null
  const [, rawStart, rawEnd] = parts
  if (rawStart === '' && rawEnd === '') return null

  // 后缀范围：bytes=-N 表示「最后 N 字节」
  if (rawStart === '') {
    const suffixLength = Number(rawEnd)
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return 'unsatisfiable'
    return { start: Math.max(0, total - suffixLength), end: total - 1 }
  }

  const start = Number(rawStart)
  if (!Number.isSafeInteger(start) || start < 0) return null
  if (start >= total) return 'unsatisfiable'

  if (rawEnd === '') return { start, end: total - 1 }
  const end = Number(rawEnd)
  if (!Number.isSafeInteger(end) || end < 0) return null
  if (end < start) return 'unsatisfiable'
  return { start, end: Math.min(end, total - 1) }
}
