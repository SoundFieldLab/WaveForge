'use strict'

// 全局高刷「关闭」档的目标帧率契约。
// 早期实现用 HIGH_REFRESH_MIN_HZ(=30) 当关闭后的目标帧率，于是**没开高刷的用户**
// 窗口被 setFrameRate(30) 压到 30fps（切歌/歌词滚动明显发涩）。关闭应回到 60Hz 基准；
// 而 HIGH_REFRESH_MIN_HZ 只是「自定义帧率」可选下限（UI 的档位里有 30），两者不能混用。
// 这段逻辑在 Electron 主进程里，沿用仓库既有的源码契约断言做法。
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const main = fs.readFileSync(path.join(root, 'desktop/main.cjs'), 'utf8')

/** 取顶层函数体（到第一个顶格右花括号为止） */
function functionBody(name) {
  const start = main.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `未找到函数 ${name}`)
  const end = main.indexOf('\n}', start)
  return main.slice(start, end === -1 ? undefined : end)
}

test('关闭全局高刷时回到 60Hz 基准，而不是被压到 30fps', () => {
  assert.match(main, /const FRAME_RATE_BASELINE_HZ = 60/)
  const body = functionBody('applyHighRefreshRate')
  assert.match(body, /: FRAME_RATE_BASELINE_HZ/, '关闭分支应使用 60Hz 基准')
  assert.doesNotMatch(body, /: HIGH_REFRESH_MIN_HZ/, '关闭分支不得再用自定义帧率下限当目标帧率')
})

test('自定义帧率的 30Hz 下限仍然保留（UI 档位里有 30）', () => {
  assert.match(main, /const HIGH_REFRESH_MIN_HZ = 30/)
  assert.match(functionBody('getWindowDisplayFrequency'), /Math\.max\(HIGH_REFRESH_MIN_HZ, hz\)/)
})
