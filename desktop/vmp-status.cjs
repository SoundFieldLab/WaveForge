'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

const MAX_CAPTURE_BYTES = 64 * 1024
const VERIFY_TIMEOUT_MS = 30_000
const MAX_REASONABLE_DAYS = 20 * 366
const DAY_MS = 24 * 60 * 60 * 1000
const VALID_SIGNATURE_RE = /^\s*-?\s*Signature is valid:\s*streaming,\s*(\d+)\s+days left\s*$/im

function stripAnsi(value) {
  return String(value || '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
}

function classifyDays(daysLeft) {
  if (daysLeft <= 0) return 'expired'
  if (daysLeft <= 180) return 'expiring'
  return 'valid'
}

function parseVerifyOutput(output, exitCode = 0, checkedAt = Date.now(), source = 'development-verify') {
  if (exitCode !== 0) {
    return { status: 'invalid', kind: null, daysLeft: null, expiresAt: null, checkedAt, source }
  }
  const match = stripAnsi(output).match(VALID_SIGNATURE_RE)
  if (!match) {
    return { status: 'invalid', kind: null, daysLeft: null, expiresAt: null, checkedAt, source }
  }
  const daysLeft = Number(match[1])
  if (!Number.isSafeInteger(daysLeft) || daysLeft < 0 || daysLeft > MAX_REASONABLE_DAYS) {
    return { status: 'invalid', kind: null, daysLeft: null, expiresAt: null, checkedAt, source }
  }
  return {
    status: classifyDays(daysLeft),
    kind: 'streaming',
    daysLeft,
    expiresAt: checkedAt + (daysLeft * DAY_MS),
    checkedAt,
    source,
  }
}

function pythonCandidates(env = process.env) {
  return [env.WAVEFORGE_EVS_PYTHON, env.PYTHON, 'D:\\Python\\python.exe', 'python', 'py'].filter(Boolean)
}

function runCaptured(exe, args, options = {}) {
  const spawnImpl = options.spawnImpl || spawn
  const timeoutMs = options.timeoutMs || VERIFY_TIMEOUT_MS
  return new Promise(resolve => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let child
    let timer
    try {
      child = spawnImpl(exe, args, {
        windowsHide: true,
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch {
      resolve({ status: null, output: '', error: 'spawn' })
      return
    }
    const finish = result => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const append = (current, chunk) => (current + String(chunk)).slice(-MAX_CAPTURE_BYTES)
    child.stdout?.on('data', chunk => { stdout = append(stdout, chunk) })
    child.stderr?.on('data', chunk => { stderr = append(stderr, chunk) })
    child.once('error', () => finish({ status: null, output: '', error: 'spawn' }))
    child.once('close', code => finish({ status: code, output: `${stdout}\n${stderr}`, error: null }))
    timer = setTimeout(() => {
      try { child.kill() } catch {}
      finish({ status: null, output: '', error: 'timeout' })
    }, timeoutMs)
    timer.unref?.()
  })
}

async function findPython(options = {}) {
  const env = options.env || process.env
  for (const candidate of pythonCandidates(env)) {
    const prefix = candidate === 'py' ? ['-3'] : []
    const result = await runCaptured(candidate, [...prefix, '-c', 'import castlabs_evs'], { ...options, env })
    if (result.status === 0) return { exe: candidate, prefix }
  }
  return null
}

async function verifyDevelopmentVmp(packageDir, options = {}) {
  const checkedAt = options.now ? options.now() : Date.now()
  const env = { ...(options.env || process.env), EVS_NO_ASK: '1' }
  delete env.EVS_ACCOUNT_NAME
  delete env.EVS_PASSWD
  const python = await findPython({ ...options, env })
  if (!python) {
    return { status: 'unavailable', kind: null, daysLeft: null, expiresAt: null, checkedAt, source: 'development-verify' }
  }
  const result = await runCaptured(python.exe, [
    ...python.prefix,
    '-m', 'castlabs_evs.vmp', 'verify-pkg', '--streaming', '--min-days', '0', packageDir,
  ], { ...options, env })
  if (result.error) {
    return { status: 'unavailable', kind: null, daysLeft: null, expiresAt: null, checkedAt, source: 'development-verify' }
  }
  return parseVerifyOutput(result.output, result.status, checkedAt, 'development-verify')
}

function createMetadata(status) {
  if (!status || !['valid', 'expiring'].includes(status.status) || status.kind !== 'streaming') {
    throw new Error('Cannot create VMP metadata from an invalid status')
  }
  return {
    schemaVersion: 1,
    status: status.status,
    kind: 'streaming',
    verifiedAt: status.checkedAt,
    daysLeft: status.daysLeft,
  }
}

function readPackagedMetadata(filePath, now = Date.now()) {
  const unavailable = { status: 'unavailable', kind: null, daysLeft: null, expiresAt: null, checkedAt: now, source: 'build-metadata' }
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    if (value?.schemaVersion !== 1 || value?.kind !== 'streaming' || !Number.isSafeInteger(value.daysLeft)
      || value.daysLeft < 0 || value.daysLeft > MAX_REASONABLE_DAYS || !Number.isFinite(value.verifiedAt)) return unavailable
    const elapsedDays = Math.max(0, Math.floor((now - value.verifiedAt) / DAY_MS))
    const daysLeft = Math.max(0, value.daysLeft - elapsedDays)
    return {
      status: classifyDays(daysLeft),
      kind: 'streaming',
      daysLeft,
      expiresAt: value.verifiedAt + (value.daysLeft * DAY_MS),
      checkedAt: now,
      source: 'build-metadata',
    }
  } catch {
    return unavailable
  }
}

function writePackagedMetadata(packageDir, status) {
  const resourcesDir = path.join(packageDir, 'resources')
  fs.mkdirSync(resourcesDir, { recursive: true })
  const target = path.join(resourcesDir, 'vmp-status.json')
  fs.writeFileSync(target, `${JSON.stringify(createMetadata(status), null, 2)}\n`, 'utf8')
  return target
}

function createVmpStatusProvider({ isPackaged, developmentPackageDir, resourcesPath, verifyOptions } = {}) {
  let cached = null
  let pending = null
  return async function getVmpStatus() {
    if (cached) return cached
    if (pending) return pending
    pending = Promise.resolve().then(() => (
      isPackaged
        ? readPackagedMetadata(path.join(resourcesPath, 'vmp-status.json'))
        : verifyDevelopmentVmp(developmentPackageDir, verifyOptions)
    )).then(value => {
      cached = value
      return value
    }).finally(() => { pending = null })
    return pending
  }
}

module.exports = {
  DAY_MS,
  classifyDays,
  createMetadata,
  createVmpStatusProvider,
  parseVerifyOutput,
  readPackagedMetadata,
  verifyDevelopmentVmp,
  writePackagedMetadata,
}
