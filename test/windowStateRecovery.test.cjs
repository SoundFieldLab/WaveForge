'use strict'

// 显示器布局变化后的窗口回收选址逻辑（纯函数）。
//
// 为什么单独测这段：拔掉外接显示器/断开扩展坞在现场无法模拟，而这是多屏下
// 最容易出现「窗口消失且找不回来」的场景。选址逻辑抽到 window-state.cjs 里就是为了能这样测。
const test = require('node:test')
const assert = require('node:assert/strict')

const { clampBoundsToWorkArea, pickRecoveryWorkArea, rectsIntersect } = require('../desktop/window-state.cjs')

const PRIMARY = {
  id: 1,
  bounds: { x: 0, y: 0, width: 2560, height: 1600 },
  workArea: { x: 0, y: 0, width: 2560, height: 1560 }, // 底部 40px 任务栏
}
const SECONDARY = {
  id: 2,
  bounds: { x: 2560, y: 0, width: 2560, height: 1440 },
  workArea: { x: 2560, y: 0, width: 2560, height: 1400 },
}
const LEFT = {
  id: 3,
  bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
  workArea: { x: -1920, y: 0, width: 1920, height: 1040 },
}

test('矩形相交判定：接触边不算相交', () => {
  assert.equal(rectsIntersect({ x: 0, y: 0, width: 100, height: 100 }, { x: 100, y: 0, width: 100, height: 100 }), false)
  assert.equal(rectsIntersect({ x: 0, y: 0, width: 101, height: 100 }, { x: 100, y: 0, width: 100, height: 100 }), true)
  assert.equal(rectsIntersect({ x: 50, y: 50, width: 10, height: 10 }, { x: 0, y: 0, width: 100, height: 100 }), true)
})

test('窗口在屏内时不搬动（正常的显示器变化不该乱搬窗口）', () => {
  const displays = [PRIMARY, SECONDARY]
  assert.equal(pickRecoveryWorkArea(displays, { x: 100, y: 100, width: 800, height: 600 }), null)
  // 跨在两块屏之间也算可见
  assert.equal(pickRecoveryWorkArea(displays, { x: 2500, y: 100, width: 800, height: 600 }), null)
  // 与任务栏重叠也算可见（不能用 workArea 判定可见性）
  assert.equal(pickRecoveryWorkArea(displays, { x: 100, y: 1500, width: 800, height: 200 }), null)
})

test('拔掉副屏后，留在那块屏上的窗口被拉回主屏工作区', () => {
  const before = { x: 2800, y: 200, width: 600, height: 300 } // 原本在副屏
  assert.equal(pickRecoveryWorkArea([PRIMARY, SECONDARY], before), null, '副屏还在时不应搬动')

  const workArea = pickRecoveryWorkArea([PRIMARY], before) // 副屏已拔
  assert.ok(workArea, '副屏拔掉后必须给出回退工作区')
  assert.deepEqual(workArea, PRIMARY.workArea)

  // 夹取后窗口必须落在该工作区内
  const recovered = clampBoundsToWorkArea(before, workArea)
  assert.ok(recovered.x >= workArea.x && recovered.x + recovered.width <= workArea.x + workArea.width)
  assert.ok(recovered.y >= workArea.y && recovered.y + recovered.height <= workArea.y + workArea.height)
})

test('分辨率变小后，被推到屏外的窗口能拉回来', () => {
  const shrunk = [{ ...PRIMARY, bounds: { ...PRIMARY.bounds, width: 1280 }, workArea: { ...PRIMARY.workArea, width: 1280 } }]
  const offscreen = { x: 2000, y: 100, width: 600, height: 400 }
  const workArea = pickRecoveryWorkArea(shrunk, offscreen)
  assert.ok(workArea, '缩小后屏外的窗口必须能拉回')
  const recovered = clampBoundsToWorkArea(offscreen, workArea)
  assert.ok(recovered.x + recovered.width <= 1280)
})

test('多块屏都不相交时选最近的一块（含左侧负坐标屏）', () => {
  const displays = [PRIMARY, LEFT]
  // 窗口在左侧更近
  const fromLeft = pickRecoveryWorkArea(displays, { x: -2600, y: 100, width: 400, height: 300 })
  assert.deepEqual(fromLeft, LEFT.workArea)
  // 窗口在右侧（右侧无屏）→ 主屏更近
  const fromRight = pickRecoveryWorkArea(displays, { x: 4000, y: 100, width: 400, height: 300 })
  assert.deepEqual(fromRight, PRIMARY.workArea)
})

test('返回的是工作区而不是显示器 bounds（任务栏区域不该被占用）', () => {
  const workArea = pickRecoveryWorkArea([PRIMARY], { x: 9000, y: 9000, width: 400, height: 300 })
  assert.deepEqual(workArea, PRIMARY.workArea)
  assert.notDeepEqual(workArea, PRIMARY.bounds)
})

test('拿不到显示器列表时返回 null（不动窗口，避免误搬）', () => {
  assert.equal(pickRecoveryWorkArea([], { x: 0, y: 0, width: 100, height: 100 }), null)
  assert.equal(pickRecoveryWorkArea(null, { x: 0, y: 0, width: 100, height: 100 }), null)
  assert.equal(pickRecoveryWorkArea(undefined, { x: 0, y: 0, width: 100, height: 100 }), null)
})

test('脏数据里的显示器项被跳过，不会抛错', () => {
  const displays = [null, { id: 9 }, PRIMARY, { bounds: { x: 1, y: 1, width: 10, height: 10 } }]
  const workArea = pickRecoveryWorkArea(displays, { x: 9000, y: 9000, width: 400, height: 300 })
  assert.ok(workArea, '应跳过脏项并仍给出可用的回退工作区')
})
