'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const WebSocket = require('ws')
const { createDGLabRelay } = require('../server/dglab-relay.cjs')

const waitFor = async (predicate, timeoutMs = 1500) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('condition timed out')
}

const reservePort = () => new Promise((resolve, reject) => {
  const server = net.createServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port
    server.close(error => error ? reject(error) : resolve(port))
  })
})

test('DG-LAB relay stays stopped until enabled and rejects unauthenticated control clients', async t => {
  const relay = createDGLabRelay()
  const port = await reservePort()
  relay._internal.settings.port = port
  t.after(() => relay.stop())

  assert.equal(relay.getStatus().running, false)
  assert.equal(relay._internal.server, null)

  relay.start()
  await waitFor(() => relay.getStatus().running)

  const unauthenticated = await new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/dglab/ctrl`)
    socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))
    socket.once('error', reject)
  })
  assert.deepEqual(unauthenticated, { code: 4003, reason: 'invalid control token' })

  const authenticated = new WebSocket(`ws://127.0.0.1:${port}/dglab/ctrl?token=${encodeURIComponent(relay._internal.controlToken)}`)
  await new Promise((resolve, reject) => {
    authenticated.once('open', resolve)
    authenticated.once('error', reject)
  })
  authenticated.close()

  relay.stop()
  await waitFor(() => !relay.getStatus().running)
  assert.equal(relay._internal.server, null)
})

test('DG-LAB relay rejects a mismatched V3 target', async t => {
  const relay = createDGLabRelay()
  const port = await reservePort()
  relay._internal.settings.port = port
  t.after(() => relay.stop())
  relay.start()
  await waitFor(() => relay.getStatus().running)

  const close = await new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/wrong-target`)
    socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))
    socket.once('error', reject)
  })
  assert.deepEqual(close, { code: 4003, reason: 'targetId mismatch' })
  assert.equal(relay._internal.app.v3, null)
})
