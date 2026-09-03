'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const {
  DAY_MS,
  createMetadata,
  createVmpStatusProvider,
  parseVerifyOutput,
  readPackagedMetadata,
  verifyDevelopmentVmp,
} = require('../desktop/vmp-status.cjs')

function fakeSpawn(results, calls) {
  return (exe, args, options) => {
    calls.push({ exe, args, options })
    const result = results.shift()
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => {}
    queueMicrotask(() => {
      if (result.stdout) child.stdout.emit('data', result.stdout)
      if (result.stderr) child.stderr.emit('data', result.stderr)
      child.emit('close', result.status)
    })
    return child
  }
}

test('parses only a successful production streaming signature', () => {
  const checkedAt = Date.UTC(2026, 7, 30)
  const valid = parseVerifyOutput('\u001b[32m - Signature is valid: streaming, 1416 days left\u001b[0m\r\n', 0, checkedAt)
  assert.equal(valid.status, 'valid')
  assert.equal(valid.kind, 'streaming')
  assert.equal(valid.daysLeft, 1416)
  assert.equal(valid.expiresAt, checkedAt + 1416 * DAY_MS)

  assert.equal(parseVerifyOutput('Signature is valid: persistent, 1416 days left', 0).status, 'invalid')
  assert.equal(parseVerifyOutput('Signature is valid: streaming, 1416 days left', 1).status, 'invalid')
  assert.equal(parseVerifyOutput('Signature is valid: streaming, 99999 days left', 0).status, 'invalid')
})

test('classifies expiring and expired signatures', () => {
  assert.equal(parseVerifyOutput('Signature is valid: streaming, 180 days left', 0).status, 'expiring')
  assert.equal(parseVerifyOutput('Signature is valid: streaming, 30 days left', 0).status, 'expiring')
  assert.equal(parseVerifyOutput('Signature is valid: streaming, 0 days left', 0).status, 'expired')
})

test('development verification strips EVS credentials and requests the actual remaining days', async () => {
  const calls = []
  const status = await verifyDevelopmentVmp('C:\\runtime', {
    now: () => 1234,
    env: { EVS_ACCOUNT_NAME: 'account', ['EVS_' + 'PASSWD']: 'test-value', WAVEFORGE_EVS_PYTHON: 'python-test' },
    spawnImpl: fakeSpawn([
      { status: 0 },
      { status: 0, stdout: ' - Signature is valid: streaming, 1416 days left\n' },
    ], calls),
  })

  assert.equal(status.status, 'valid')
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1].args.slice(0, -1), ['-m', 'castlabs_evs.vmp', 'verify-pkg', '--streaming', '--min-days', '0'])
  assert.equal(calls[1].options.env.EVS_ACCOUNT_NAME, undefined)
  assert.equal(calls[1].options.env.EVS_PASSWD, undefined)
})

test('packaged metadata ages without EVS at runtime', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waveforge-vmp-'))
  const file = path.join(dir, 'vmp-status.json')
  const verifiedAt = Date.UTC(2026, 0, 1)
  fs.writeFileSync(file, JSON.stringify(createMetadata({
    status: 'valid', kind: 'streaming', daysLeft: 200, expiresAt: null, checkedAt: verifiedAt, source: 'development-verify',
  })))

  const status = readPackagedMetadata(file, verifiedAt + 25 * DAY_MS)
  assert.equal(status.status, 'expiring')
  assert.equal(status.daysLeft, 175)
  assert.equal(status.source, 'build-metadata')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('provider caches one verification result for the process lifetime', async () => {
  let calls = 0
  const provider = createVmpStatusProvider({
    isPackaged: false,
    developmentPackageDir: 'C:\\runtime',
    verifyOptions: {
      env: { WAVEFORGE_EVS_PYTHON: 'python-test' },
      spawnImpl: fakeSpawn([
        { status: 0 },
        { status: 0, stdout: 'Signature is valid: streaming, 400 days left' },
      ], []),
      now: () => { calls += 1; return 10 },
    },
  })
  const [first, second] = await Promise.all([provider(), provider()])
  const third = await provider()
  assert.equal(first.daysLeft, 400)
  assert.strictEqual(first, second)
  assert.strictEqual(second, third)
  assert.equal(calls, 1)
})
