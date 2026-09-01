'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const WebSocket = require('ws')
const {
  createRemoteServer,
  MAX_MESSAGE_BYTES,
} = require('../desktop/remote-server.cjs')

function createServer(overrides = {}) {
  return createRemoteServer({
    getComputerName: () => 'Test WaveForge',
    getSettings: () => ({}),
    getState: () => ({}),
    ...overrides,
  })
}

async function startServer(overrides = {}) {
  const server = createServer(overrides)
  const status = await server.start(0)
  return { server, status, baseUrl: `http://127.0.0.1:${status.port}` }
}

function request(url, options = {}) {
  return fetch(url, { redirect: 'manual', ...options })
}

function openSocket(url, options) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, options)
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })
}

function waitForClose(socket) {
  return new Promise((resolve, reject) => {
    socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))
    socket.once('error', error => {
      if (socket.readyState !== WebSocket.CLOSED) reject(error)
    })
  })
}

async function pair(baseUrl, token) {
  const response = await request(`${baseUrl}/?t=${encodeURIComponent(token)}`)
  assert.equal(response.status, 303)
  const cookie = response.headers.get('set-cookie')
  assert.match(cookie, /HttpOnly/)
  return cookie.split(';', 1)[0]
}

test('anonymous discover response contains service info but no token', async t => {
  const { server, status, baseUrl } = await startServer()
  t.after(() => server.stop())

  assert.ok(status.token)
  const response = await request(`${baseUrl}/discover`)
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.deepEqual(body, { name: 'Test WaveForge', port: status.port })
  assert.equal(JSON.stringify(body).includes(status.token), false)
})

test('expired and reused pairing tokens are rejected', async t => {
  let clock = 1000
  const expired = await startServer({ now: () => clock, pairingTokenTtlMs: 50 })
  t.after(() => expired.server.stop())
  clock += 51
  assert.equal((await request(`${expired.baseUrl}/?t=${expired.status.token}`)).status, 403)

  const active = await startServer()
  t.after(() => active.server.stop())
  await pair(active.baseUrl, active.status.token)
  assert.equal((await request(`${active.baseUrl}/?t=${active.status.token}`)).status, 403)
})

test('a pairing token cannot be replayed across WebSocket connections', async t => {
  const { server, status } = await startServer()
  t.after(() => server.stop())
  const wsUrl = `ws://127.0.0.1:${status.port}/ws?t=${status.token}`
  const first = await openSocket(wsUrl)
  t.after(() => first.close())

  const second = new WebSocket(wsUrl)
  const closed = await waitForClose(second)
  assert.equal(closed.code, 4001)
})

test('oversized WebSocket messages close the connection', async t => {
  const { server, status, baseUrl } = await startServer()
  t.after(() => server.stop())
  const cookie = await pair(baseUrl, status.token)
  const socket = await openSocket(`ws://127.0.0.1:${status.port}/ws`, { headers: { Cookie: cookie } })

  const closedPromise = waitForClose(socket)
  socket.send(JSON.stringify({ type: 'text-input', value: 'x'.repeat(MAX_MESSAGE_BYTES) }))
  const closed = await closedPromise
  assert.equal(closed.code, 1009)
})

test('WebSocket connection attempts are rate limited per IP', async t => {
  const { server, status } = await startServer({ connectionRateLimit: 2, connectionRateWindowMs: 60_000 })
  t.after(() => server.stop())
  const url = `ws://127.0.0.1:${status.port}/ws?t=invalid`

  for (let index = 0; index < 2; index += 1) {
    const socket = new WebSocket(url)
    const closed = await waitForClose(socket)
    assert.equal(closed.code, 4001)
  }
  const limited = new WebSocket(url)
  const closed = await waitForClose(limited)
  assert.deepEqual(closed, { code: 4008, reason: 'Rate limit exceeded' })
})
