'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = relative => readFileSync(path.join(root, relative), 'utf8')

// 启动脚本统一放在 launchers/ 下，因此 PROJECT_ROOT 需回退一级（%~dp0..\），
// 否则 pushd/npm --prefix 会指向 launchers/ 而不是项目根。
test('root startup batch anchors every service to its own project directory', () => {
  const script = read('launchers/start-full.bat')

  assert.match(script, /set "PROJECT_ROOT=%~dp0\.\.\\"/)
  assert.match(script, /pushd "%PROJECT_ROOT%"/)
  assert.match(script, /npm --prefix ""%PROJECT_ROOT%"" run dev:electron/)
  assert.doesNotMatch(script, /cd python-beat-service/)
})

test('root Python installer does not depend on the caller current directory', () => {
  const script = read('launchers/install-python-deps.bat')

  assert.match(script, /set "PROJECT_ROOT=%~dp0\.\.\\"/)
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

test('DG-LAB debug launcher anchors the project root and runs the debug platform', () => {
  const script = read('launchers/start-dglab-debug.bat')

  assert.match(script, /set "PROJECT_ROOT=%~dp0\.\.\\"/)
  assert.match(script, /npm run dglab:debug:all/)
})
