'use strict'

const http = require('node:http')

function startSignalRgbMock(options = {}) {
  const localHost = options.localHost || '127.0.0.1'
  const canvasHost = options.canvasHost || '127.0.0.1'
  const localPort = options.localPort === undefined ? 0 : Number(options.localPort)
  const canvasPort = options.canvasPort === undefined ? 0 : Number(options.canvasPort)
  const state = {
    localMode: options.localMode || 'ok',
    canvasPostStatus: Number(options.canvasPostStatus) || 200,
    effects: options.effects || [{ id: 'waveforge', title: 'WaveForge' }, { id: 'previous', name: 'Previous Effect' }],
    currentEffect: options.currentEffect || { id: 'previous', name: 'Previous Effect' },
    layouts: options.layouts || [{ id: 'desk', name: 'Desk' }],
    currentLayout: options.currentLayout || { id: 'desk', name: 'Desk' },
  }
  const metrics = { localRequests: [], applies: [], canvasEvents: [], canvasPosts: 0, canvasGets: 0 }

  const send = (response, status, body) => {
    const json = JSON.stringify(body)
    response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) })
    response.end(json)
  }
  const readBody = async (request) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const text = Buffer.concat(chunks).toString('utf8')
    if (!text) return null
    try { return JSON.parse(text) } catch { return text }
  }

  let actualLocalPort = localPort
  let actualCanvasPort = canvasPort
  const localServer = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${localHost}`)
    metrics.localRequests.push({ method: request.method, path: url.pathname })
    if (!url.pathname.startsWith('/api/v1/')) return send(response, 404, { error: 'not found' })
    if (state.localMode === 'forbidden') return send(response, 403, { error: 'SignalRGB Pro required' })
    if (state.localMode === 'error') return send(response, 503, { error: 'unavailable' })
    const endpoint = url.pathname.slice('/api/v1/'.length)
    if (request.method === 'GET' && endpoint === 'lighting') return send(response, 200, { data: { currentEffect: state.currentEffect } })
    if (request.method === 'GET' && (endpoint === 'lighting/effects' || endpoint === 'effects')) return send(response, 200, { result: { effects: state.effects } })
    if (request.method === 'GET' && (endpoint === 'scenes/layouts' || endpoint === 'layouts')) return send(response, 200, { data: { layouts: state.layouts } })
    if (request.method === 'GET' && (endpoint === 'scenes/current_layout' || endpoint === 'layouts/current')) return send(response, 200, { payload: state.currentLayout })
    if (request.method === 'POST' && /^(?:lighting\/effects\/(?:[^/]+)\/apply|lighting\/effects\/apply|effects\/(?:[^/]+)\/apply)$/.test(endpoint)) {
      const body = await readBody(request)
      const parts = endpoint.split('/')
      const id = endpoint === 'lighting/effects/apply' ? String(body?.effectId ?? body?.id ?? '') : decodeURIComponent(parts[parts.length - 2])
      const effect = state.effects.find((candidate) => String(candidate.id ?? candidate.effectId) === id) || { id }
      state.currentEffect = effect
      metrics.applies.push(id)
      return send(response, 200, { ok: true, effect })
    }
    return send(response, 404, { error: 'not found' })
  })

  const canvasServer = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${canvasHost}`)
    if (url.pathname !== '/canvas/event') return send(response, 404, { error: 'not found' })
    const body = await readBody(request)
    if (request.method === 'POST') metrics.canvasPosts += 1
    if (request.method === 'GET') metrics.canvasGets += 1
    metrics.canvasEvents.push({ method: request.method, sender: url.searchParams.get('sender'), event: url.searchParams.get('event'), body })
    return send(response, request.method === 'POST' ? state.canvasPostStatus : 200, { ok: true })
  })

  const listen = (server, port, host, setPort) => new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => { setPort(server.address().port); resolve() })
  })
  const ready = Promise.all([
    listen(localServer, localPort, localHost, (port) => { actualLocalPort = port }),
    listen(canvasServer, canvasPort, canvasHost, (port) => { actualCanvasPort = port }),
  ])
  let stopped = false
  const close = (server) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))

  return {
    state,
    metrics,
    ready,
    get localApiBase() { return `http://${localHost}:${actualLocalPort}/api/v1` },
    get canvasApiBase() { return `http://${canvasHost}:${actualCanvasPort}/canvas/event` },
    async stop() {
      if (stopped) return
      stopped = true
      await ready.catch(() => {})
      await Promise.all([localServer.listening ? close(localServer) : null, canvasServer.listening ? close(canvasServer) : null])
    },
  }
}

module.exports = { startSignalRgbMock }
