'use strict'

const http = require('node:http')

const DEVICES = new Set(['keyboard', 'mouse', 'mousepad', 'headset', 'keypad', 'chromalink'])

function startChromaMock(options = {}) {
  const host = options.host || '127.0.0.1'
  const requestedPort = options.port === undefined ? 0 : Number(options.port)
  const basePath = `/${String(options.basePath || '/razer/chromasdk').replace(/^\/+|\/+$/g, '')}`
  const sessionId = Number(options.sessionId) || 1001
  const sessionReadyDelayMs = Math.max(0, Number(options.sessionReadyDelayMs) || 0)
  const legacyMousepad15 = options.legacyMousepad15 === true
  let sessionAvailableAt = 0
  const metrics = {
    registers: 0,
    heartbeats: 0,
    posts: 0,
    puts: 0,
    effectApplications: 0,
    deletes: 0,
    earlySessionRequests: 0,
    framesByDevice: Object.fromEntries(Array.from(DEVICES, (name) => [name, 0])),
    lastBodies: {},
  }

  let actualPort = requestedPort
  let stopped = false
  const server = http.createServer(async (request, response) => {
    const send = (status, body) => {
      const json = JSON.stringify(body)
      response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) })
      response.end(json)
    }

    let body = {}
    try {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      if (chunks.length) body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      send(400, { result: 1, message: 'invalid JSON' })
      return
    }

    const path = new URL(request.url, `http://${host}`).pathname.replace(/\/+$/, '') || '/'
    const sessionPath = `${basePath}/${sessionId}`
    if (request.method === 'GET' && path === basePath) {
      send(200, { core: '4.00.01', device: '4.00.01', version: '4.00.01' })
      return
    }
    if (request.method === 'POST' && path === basePath) {
      metrics.registers += 1
      sessionAvailableAt = Date.now() + sessionReadyDelayMs
      metrics.lastBodies.registration = body
      send(200, {
        result: 0,
        uri: `http://${host}:${actualPort}${sessionPath}`,
        sessionid: sessionId,
      })
      return
    }
    if (path.startsWith(sessionPath) && Date.now() < sessionAvailableAt) {
      metrics.earlySessionRequests += 1
      send(503, { result: 1, message: 'session starting' })
      return
    }
    if (request.method === 'PUT' && path === `${sessionPath}/heartbeat`) {
      metrics.heartbeats += 1
      metrics.lastBodies.heartbeat = body
      send(200, { result: 0 })
      return
    }
    if (request.method === 'DELETE' && path === sessionPath) {
      metrics.deletes += 1
      send(200, { result: 0 })
      return
    }

    const device = path.startsWith(`${sessionPath}/`) ? path.slice(sessionPath.length + 1) : ''
    if (DEVICES.has(device) && (request.method === 'POST' || request.method === 'PUT')) {
      if (legacyMousepad15 && device === 'mousepad' && Array.isArray(body?.param) && body.param.length === 20) {
        send(200, { result: 87, error: 'expecting an array of 15 elements with integer values' })
        return
      }
      if (request.method === 'POST') {
        metrics.posts += 1
        metrics.lastBodies[`${device}:created`] = body
        send(200, { result: 0, id: `${device}-effect-${metrics.posts}` })
        return
      }
      metrics.puts += 1
      metrics.framesByDevice[device] += 1
      metrics.lastBodies[device] = body
      send(200, { result: 0 })
      return
    }
    send(404, { result: 1, message: 'not found' })
  })

  const ready = new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(requestedPort, host, () => {
      actualPort = server.address().port
      resolve()
    })
  })

  const mock = {
    get baseUrl() { return `http://${host}:${actualPort}${basePath}` },
    metrics,
    ready,
    async stop() {
      if (stopped) return
      stopped = true
      await ready.catch(() => {})
      if (!server.listening) return
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    },
  }
  return mock
}

module.exports = { startChromaMock }
