'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const main = fs.readFileSync(path.join(root, 'desktop', 'main.cjs'), 'utf8')
const preload = fs.readFileSync(path.join(root, 'desktop', 'preload.cjs'), 'utf8')
const autoMix = fs.readFileSync(path.join(root, 'src', 'services', 'autoMixAnalysisService.ts'), 'utf8')
const loudness = fs.readFileSync(path.join(root, 'src', 'services', 'audio-effects-v2', 'loudnessNormalization.ts'), 'utf8')
const compensation = fs.readFileSync(path.join(root, 'src', 'services', 'audio-effects-v2', 'compensationService.ts'), 'utf8')

function functionBody(name) {
  const start = main.indexOf(`async function ${name}(`)
  assert.notEqual(start, -1, `${name} must exist`)
  const next = main.indexOf('\nasync function ', start + 1)
  return main.slice(start, next === -1 ? main.length : next)
}

test('production startup leaves Python services lazy', () => {
  const startLocalBackend = functionBody('startLocalBackend')
  assert.match(startLocalBackend, /utilityProcess\.fork/)
  assert.doesNotMatch(startLocalBackend, /spawn\(pythonExe/)
  assert.match(main, /ipcMain\.handle\('local-python:ensure'/)
  assert.match(preload, /ensure: \(service\) => ipcRenderer\.invoke\('local-python:ensure', service\)/)
})

test('renderer requests ensure the matching service first', () => {
  assert.match(autoMix, /await window\.electron\.localPython\.ensure\('beat'\)[\s\S]*fetch\(`\$\{PYTHON_BEAT_SERVICE_URL\}\/health`/)
  assert.match(loudness, /await window\.electron\.localPython\.ensure\('loudness'\)[\s\S]*fetch\(`\$\{PYTHON_BEAT_SERVICE_URL\}\/lufs`/)
  assert.match(compensation, /await window\.electron\.localPython\.ensure\('compensation'\)[\s\S]*fetch\(`\$\{COMPENSATION_SERVICE_URL\}\/compensation`/)
})

test('on-demand manager single-flights startup and passes service environment', () => {
  const ensure = functionBody('ensurePythonService')
  assert.match(ensure, /if \(service\.starting\) return service\.starting/)
  assert.match(ensure, /service\.starting = starting/)
  assert.match(ensure, /WAVEFORGE_LOCAL_TOKEN: LOCAL_SERVICE_TOKEN/)
  assert.match(ensure, /WAVEFORGE_CACHE_PATH: configManager\.getCachePath\(\)/)
  assert.match(ensure, /await waitForPythonService\(service, child\)/)
})

test('idle shutdown waits for requests and app quit stops owned children', () => {
  assert.match(main, /service\.activeRequests\.size > 0/)
  assert.match(main, /service\.activeRequests\.add\(details\.id\)/)
  assert.match(main, /service\.activeRequests\.delete\(details\.id\)/)
  assert.match(main, /webRequest\.onCompleted\(pythonServiceRequestFilter, finishPythonServiceRequest\)/)
  assert.match(main, /webRequest\.onErrorOccurred\(pythonServiceRequestFilter, finishPythonServiceRequest\)/)
  assert.match(main, /stopAllPythonServices\('app quit'\)/)
  assert.match(main, /execFileSync\('taskkill', \['\/PID', String\(child\.pid\), '\/T', '\/F'\]/)
})
