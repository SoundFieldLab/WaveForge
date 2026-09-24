'use strict'

// 「性能模式挡位」与 GPU 变更确认/回滚的接线契约测试。
// 挡位一键会改显卡偏好（强制独显/核显），和手动改显卡是同一类风险操作：
// 必须登记 pendingGpuChange 才能在重启后弹确认、超时自动回退；且启动时不能再用
// 挡位预设覆盖用户在磁盘上手动改过的开关。这段逻辑跑在 Electron 主进程里，无法直接单测，
// 因此沿用仓库既有的「源码契约断言」做法（见 vmp-status-wiring.test.cjs）钉住行为。
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8')
const main = read('desktop/main.cjs')
const types = read('src/electron.d.ts')
const appSource = read('src/App.tsx')

/** 取某个 ipcMain.handle 的处理体（到下一个 ipcMain.handle 为止） */
function handlerBody(name) {
  const start = main.indexOf(`ipcMain.handle('${name}'`)
  assert.ok(start >= 0, `未找到 ipc 处理器 ${name}`)
  const next = main.indexOf("ipcMain.handle('", start + 1)
  return main.slice(start, next === -1 ? undefined : next)
}

test('性能挡位：启动时不再用挡位预设覆盖磁盘上的手动开关', () => {
  assert.match(main, /function clearTierIfPresetDiverged\(\)/)
  // 旧的启动期覆盖块（每次启动都用预设改写 gpuPreference/highPerformanceMode/highRefreshRate）必须已删除
  assert.doesNotMatch(
    main,
    /if \(performanceSettings\.performanceTier\) \{\s*\n\s*const preset = PERF_TIER_PRESETS\[performanceSettings\.performanceTier\]/,
  )
})

test('性能挡位：手动开关覆盖预设置后清掉挡位标记（UI 显示为自定义）', () => {
  for (const handler of ['set-gpu-preference', 'set-high-performance-mode', 'display:set-high-refresh']) {
    assert.match(handlerBody(handler), /clearTierIfPresetDiverged\(\)/, `${handler} 应在写入前同步挡位标记`)
  }
})

test('性能挡位：强制显卡时登记待确认项，回退时整个挡位退回安全默认', () => {
  const tier = handlerBody('set-performance-tier')
  assert.match(tier, /pendingGpuChange = preset\.gpuPreference === 'auto'/)
  assert.match(tier, /fromTier: true/)

  const revert = handlerBody('revert-gpu-change')
  assert.match(revert, /pending\.fromTier/)
  assert.match(revert, /performanceSettings\.performanceTier = null/)
  assert.match(revert, /performanceTier: performanceSettings\.performanceTier/)
  // 全局高刷是运行时立即生效项，回退后必须同步把帧率降回去
  assert.match(revert, /applyHighRefreshRate\(\)/)
})

test('渲染后端仍走独立的 backend 待确认类型（不与挡位混淆）', () => {
  assert.match(handlerBody('set-render-backend'), /type: 'backend'/)
  assert.doesNotMatch(handlerBody('set-render-backend'), /fromTier/)
})

test('待确认项与回退返回值在前端类型定义中同步声明', () => {
  assert.match(types, /pendingGpuChange: \{ type: 'preference' \| 'acceleration' \| 'backend'; fromTier\?: boolean \} \| null/)
  assert.match(types, /revertGpuChange: \(\) => Promise<\{[^}]*performanceTier:/)
  assert.match(appSource, /fromTier\?: boolean/)
})
