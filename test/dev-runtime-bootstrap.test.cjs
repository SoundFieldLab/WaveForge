'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')

test('development launcher enforces production VMP even when invoked directly', () => {
  const source = fs.readFileSync(path.join(root, 'scripts', 'dev-electron.mjs'), 'utf8')
  assert.match(source, /ensure-dev-vmp\.cjs/)
  assert.match(source, /spawnSync\(process\.execPath/)
  assert.match(source, /终止启动以避免静默退回非原生音源/)
})

test('all Python audio services pin their own directory before importing shared auth', () => {
  for (const file of ['beat_analyzer.py', 'loudness_server.py', 'compensation_server.py']) {
    const source = fs.readFileSync(path.join(root, 'python-beat-service', file), 'utf8')
    assert.match(source, /SCRIPT_DIR = Path\(__file__\)\.resolve\(\)\.parent/, file)
    assert.match(source, /sys\.path\.insert\(0, str\(SCRIPT_DIR\)\)/, file)
    assert.match(source, /from local_service_auth import/, file)
  }
})
