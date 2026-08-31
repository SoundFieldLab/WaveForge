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

test('DG-LAB relay stays stopped until enabled and rejects a mismatched V3 target', async () => {
  const relay = createDGLabRelay()
  const port = await reservePort()
  relay._internal.settings.port = port

  assert.equal(relay.getStatus().running, false)
  assert.equal(relay._internal.server, null)

  relay.start()
  await waitFor(() => relay.getStatus().running)

  const close = await new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/wrong-target`)
    socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))
    socket.once('error', reject)
  })
  assert.deepEqual(close, { code: 4003, reason: 'targetId mismatch' })
  assert.equal(relay._internal.app.v3, null)

  relay.stop()
  await waitFor(() => !relay.getStatus().running)
  assert.equal(relay._internal.server, null)
})
