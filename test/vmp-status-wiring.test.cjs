'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8')

test('VMP diagnostics bridge is wired through guarded main IPC, preload, and types', () => {
  const main = read('desktop/main.cjs')
  const preload = read('desktop/preload.cjs')
  const types = read('src/electron.d.ts')

  assert.match(main, /ipcMain\.handle\('diagnostics:get-vmp-status', guardTrustedIpc\('privileged'/)
  assert.match(preload, /getVmpStatus:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('diagnostics:get-vmp-status'\)/)
  assert.match(types, /getVmpStatus:\s*\(\)\s*=>\s*Promise<VmpStatus>/)
})

test('VMP card is visible only inside developer-mode branches in simple and mirrored settings', () => {
  const settings = read('src/components/SettingsPanel.tsx')
  const mirrored = read('src/components/MirroredGlobalSettings.tsx')
  const registry = read('src/services/globalSettingsRegistry.ts')

  const simpleBranch = settings.slice(settings.indexOf('{developerMode && ('), settings.indexOf('{/* 缓存清理 */}'))
  assert.match(simpleBranch, /<VmpStatusCard/)
  assert.match(mirrored, /group\.id === 'advanced' && getValue\('developerMode'\) === true/)
  assert.match(mirrored, /<VmpStatusCard/)
  assert.match(registry, /id: 'transitionDebugEnabled'[\s\S]*visibleIf: \(\) => readBool\('developerMode', false\)/)
})

test('release build writes VMP metadata after strict signature verification', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.match(pkg.scripts['build:electron:dir'], /vmp:verify:release && npm run vmp:status:release/)
  assert.equal(pkg.scripts['vmp:status:release'], 'node scripts/write-vmp-status.cjs release/win-unpacked')
})
