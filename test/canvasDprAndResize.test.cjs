'use strict'

// 画布 DPR 与 resize 重测量的结构契约。
//
// 这里断的是「结构不变量」而不是行为，因为这两类问题的本质就是位置错了：
//   1. devicePixelRatio 必须在「每次重设画布尺寸的那段代码里」读取。
//      在 effect 挂载时读一次存起来，窗口移到不同缩放的显示器后画布后备存储分辨率
//      就与新屏不匹配（高 DPI 上发糊）。这是纯结构问题：读的位置错了就是错了。
//   2. resize 回调必须合并成每帧一次，且不能在已有 ResizeObserver 的情况下
//      再挂一个 window resize —— 同一次变化会跑两遍，而回调里有强制同步布局
//      和 setState（拖动窗口边缘时可达每秒上百次）。
//
// 行为验证的替代说明：这两类改动都是 DOM 副作用，单测需要 jsdom + canvas mock，
// 收益远低于成本；结构不变量 + typecheck + 构建 + 人工复核是这里更划算的门。
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').split('\n')

test('画布组件必须在设置尺寸处读取 devicePixelRatio，不能缓存到 effect 作用域', () => {
  const files = [
    'src/components/DanmakuLayer.tsx',
    'src/components/DGLabWidget.tsx',
    'src/components/DGLabVizCanvas.tsx',
    'src/components/weatherVisualTheme.tsx',
    'src/services/waveforge-engine-v3/ui/components/SpatialRingEditor.tsx',
  ]
  for (const rel of files) {
    const lines = read(rel)
    const sizeAt = lines.findIndex((l) => /canvas\.width\s*=/.test(l))
    assert.ok(sizeAt > 0, `${rel}: 没找到 canvas.width 赋值`)
    // dpr 的读取必须紧邻尺寸赋值（同一段作用域），而不是文件/effect 顶部的缓存值
    const windowStart = Math.max(0, sizeAt - 12)
    const near = lines.slice(windowStart, sizeAt + 1).some((l) => /(const|let)\s+dpr\s*=/.test(l))
    assert.ok(near, `${rel}: canvas.width 赋值前 12 行内没有重新读取 dpr（可能被缓存成了陈旧值）`)
    // 整个文件只应有一处读取：多处读取说明还留着旧的缓存变量
    const reads = lines.filter((l) => /devicePixelRatio/.test(l) && !/^\s*(\/\/|\*)/.test(l)).length
    assert.equal(reads, 1, `${rel}: devicePixelRatio 应只在一处读取（当前 ${reads} 处）`)
  }
})

test('窗口 resize 回调必须合并成每帧一次（拖动边缘会连续触发）', () => {
  const zone = read('src/components/DesktopWidgetZone.tsx').join('\n')
  assert.match(zone, /requestAnimationFrame\(runMeasure\)/, 'Zone 的 measure 应走 rAF 合并')
  assert.match(zone, /if \(frame\) return/, 'Zone 的 resize 入口应去重，同一帧只排一次')

  const grid = read('src/components/PlaylistGrid3D.tsx').join('\n')
  assert.match(grid, /requestAnimationFrame\(runUpdateSize\)/, 'Grid 的 updateSize 应走 rAF 合并')
  assert.match(grid, /if \(frame\) return/, 'Grid 的 resize 入口应去重')
})

test('已有 ResizeObserver 时不得再挂 window resize 兜底（同一次变化会跑两遍）', () => {
  // 只针对「同时有 ResizeObserver 观察同一元素」的那个回调：
  // Zone 另一个依赖 window.innerHeight 的 measure 必须有 window resize 监听，那是合法的。
  const cases = [
    ['src/components/DesktopWidgetZone.tsx', 'updateScrollFades'],
    ['src/components/PlaylistGrid3D.tsx', 'updateSize'],
  ]
  for (const [rel, handler] of cases) {
    const lines = read(rel)
    const registration = `addEventListener('resize', ${handler})`
    const hits = lines.filter((l) => l.includes(registration))
    assert.ok(hits.length > 0, `${rel}: 没找到 ${handler} 的 resize 注册`)
    for (const line of hits) {
      assert.ok(
        line.trim().startsWith('else'),
        `${rel}: ${handler} 的 window resize 监听必须只在无 ResizeObserver 的 else 分支里注册，实际: ${line.trim()}`,
      )
    }
    assert.match(lines.join('\n'), /ResizeObserver/, `${rel}: 应优先用 ResizeObserver`)
  }
})

test('容器尺寸没变时不 setState（避免拖动窗口时反复重排）', () => {
  const grid = read('src/components/PlaylistGrid3D.tsx').join('\n')
  assert.match(grid, /prev\.width === newSize\.width && prev\.height === newSize\.height \? prev : newSize/, 'Grid 尺寸未变时应返回原 state')
})
