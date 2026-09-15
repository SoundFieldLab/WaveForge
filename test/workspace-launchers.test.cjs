'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = relative => readFileSync(path.join(root, relative), 'utf8')

test('root startup batch anchors every service to its own project directory', () => {
  const script = read('start-full.bat')

  assert.match(script, /set "PROJECT_ROOT=%~dp0"/)
  assert.match(script, /pushd "%PROJECT_ROOT%"/)
  assert.match(script, /npm --prefix ""%PROJECT_ROOT%"" run dev:electron/)
  assert.doesNotMatch(script, /cd python-beat-service/)
})

test('root Python installer does not depend on the caller current directory', () => {
  const script = read('install-python-deps.bat')

  assert.match(script, /set "PROJECT_ROOT=%~dp0"/)
  assert.match(script, /set "REQUIREMENTS=%PROJECT_ROOT%requirements\.txt"/)
  assert.match(script, /install -r "%REQUIREMENTS%"/)
})

test('beat-service Python installer anchors both service and project roots', () => {
  const script = read('python-beat-service/install-deps.bat')

  assert.match(script, /set "SERVICE_ROOT=%~dp0"/)
  assert.match(script, /set "PROJECT_ROOT=%%~fI\\"/)
  assert.match(script, /set "REQUIREMENTS=%SERVICE_ROOT%requirements\.txt"/)
  assert.match(script, /--find-links="%PACKAGES%" -r "%REQUIREMENTS%"/)
})
