'use strict'

// 多屏（副屏/多显示器）相关的窗口行为契约。
//
// 覆盖三件在多屏下容易出错、且用户很难自查的事：
//   1. 拔屏/插屏/分辨率变化后，落在不存在区域的副屏窗口必须被拉回可见范围；
//   2. 桌面播放器的位置必须跨重启保留（否则副屏用户每次启动都要重新拖）；
//   3. 副屏窗口首次出现时应落在主窗所在显示器，而不是写死主屏。
// 沿用仓库既有的源码契约断言做法（真实行为另由 test/frameRateLimiter.test.ts 覆盖）。
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const main = fs.readFileSync(path.join(root, 'desktop/main.cjs'), 'utf8')

function functionBody(name) {
  const start = main.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `未找到函数 ${name}`)
  const end = main.indexOf('\n}', start)
  return main.slice(start, end === -1 ? undefined : end)
}

test('离屏窗口回收：只搬屏外的窗口，且覆盖全部副屏窗口', () => {
  const body = functionBody('recoverOffscreenWindows')
  // 必须只处理「与所有显示器都无交集」的窗口，正常显示器变化下不能乱搬
  assert.match(body, /isBoundsOnAnyDisplay/, '需要用「是否与任一显示器相交」判断')
  assert.match(body, /if \(needsRecovery\(/, '应在搬动前先判定，不能无条件 setBounds')

  // 主窗 + 四个副屏窗口都要覆盖；漏一个就会出现「窗口消失且找不回来」
  for (const win of ['mainWindow', 'desktopPlayerWindow', 'desktopLyricsWindow', 'lyricsIslandWindow', 'taskbarWidgetWindow']) {
    assert.match(body, new RegExp(`needsRecovery\\(${win}\\)`), `漏了 ${win} 的回收`)
  }
  // 主窗位置变了必须落盘，否则下次启动仍回到屏外
  assert.match(body, /persistMainWindowState\(\)/, '主窗回收后要落盘')
  // 任务栏挂件是贴边的，重新贴边比夹取更准
  assert.match(body, /dockTaskbarWidgetWindow\(\)/, '任务栏挂件应重新贴边')
})

test('显示器增删事件必须接线（拔扩展坞是必现场景）', () => {
  assert.match(main, /screen\.on\('display-removed'/, '必须处理拔屏')
  assert.match(main, /screen\.on\('display-added'/, '必须处理插屏')
  const body = functionBody('bindDisplayRecovery')
  assert.match(body, /recoverOffscreenWindows\(\)/, '增删屏后要回收窗口')
  assert.match(body, /if \(displayRecoveryBound\) return/, '重复绑定会累积监听')
  // 任务栏可能随显示器增删换屏承载
  assert.match(body, /dockTaskbarWidgetWindow\(\)/)
  assert.match(main, /bindDisplayRecovery\(\)/, '启动时必须调用')
})

test('分辨率/缩放变化也要回收（右下角窗口会被推出屏外）', () => {
  const body = functionBody('bindTaskbarDisplayMetrics')
  assert.match(body, /recoverOffscreenWindows\(\)/, 'display-metrics-changed 后要回收窗口')
})

test('副屏窗口首次默认落在主窗所在显示器，而不是写死主屏', () => {
  const body = functionBody('getDefaultOverlayWorkArea')
  assert.match(body, /mainWindow/, '应优先取主窗所在显示器')
  assert.match(body, /getDisplayMatching\(mainWindow\.getBounds\(\)\)/, '按主窗 bounds 匹配显示器')
  assert.match(body, /getPrimaryDisplay\(\)/, '主窗不可用时要回退主屏')

  for (const fn of ['getDesktopLyricsDefaultBounds', 'getLyricsIslandDefaultBounds']) {
    assert.match(functionBody(fn), /getDefaultOverlayWorkArea\(\)/, `${fn} 应改用主窗所在显示器`)
  }
  // 这三个默认位曾经都写死主屏
  assert.doesNotMatch(main, /const workArea = screen\.getPrimaryDisplay\(\)\.workArea/, '不应再有写死主屏的默认工作区')
})

test('桌面播放器位置必须跨重启保留', () => {
  const load = functionBody('loadDesktopPlayerSettings')
  assert.match(load, /position/, '读取时必须解析 position')
  assert.match(load, /Number\.isFinite\(x\)/, '位置要做数值校验，脏数据不能直接落进窗口')

  const save = functionBody('saveDesktopPlayerSettings')
  assert.match(save, /position: desktopPlayerSavedPosition/, '写入时必须带上位置')
  // 只记位置不记尺寸：卡片高度随内容变化、形态切换尺寸也不同
  assert.doesNotMatch(save, /\bwidth:|\bheight:/, '不应把尺寸落盘')

  const remember = functionBody('rememberDesktopPlayerPosition')
  assert.match(remember, /getBounds\(\)/, '位置应取自活窗口')
})

test('只在拖动/缩放结束时记位置，形态切换不得覆盖用户摆位', () => {
  // 拖动结束与缩放结束各一次（缩放可能从左边拖，位置也会变）
  const dragEnd = main.slice(main.indexOf("ipcMain.on('desktop-player:drag-end'"))
  const dragEndBody = dragEnd.slice(0, dragEnd.indexOf('\n})'))
  assert.match(dragEndBody, /rememberDesktopPlayerPosition\(\)/)
  assert.match(dragEndBody, /saveDesktopPlayerSettings\(\)/)

  const resizeEnd = main.slice(main.indexOf("ipcMain.on('desktop-player:resize-end'"))
  const resizeEndBody = resizeEnd.slice(0, resizeEnd.indexOf('\n})'))
  assert.match(resizeEndBody, /rememberDesktopPlayerPosition\(\)/)
  assert.match(resizeEndBody, /saveDesktopPlayerSettings\(\)/)

  // 恢复：有记录用记录（并夹到该屏工作区），没记录才用默认位
  const restoreAt = main.indexOf('desktopPlayerSavedPosition) {')
  assert.ok(restoreAt > 0, '启动时应优先恢复保存的位置')
  const restoreBlock = main.slice(restoreAt, restoreAt + 600)
  assert.match(restoreBlock, /clampDesktopPlayerBounds/, '恢复的位置必须夹到所在屏工作区')
})
