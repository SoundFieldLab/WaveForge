'use strict'

// 全局高刷「关闭」档的目标帧率契约。
// 早期实现用 HIGH_REFRESH_MIN_HZ(=30) 当关闭后的目标帧率，于是**没开高刷的用户**
// 窗口被 setFrameRate(30) 压到 30fps（切歌/歌词滚动明显发涩）。关闭应回到 60Hz 基准；
// 而 HIGH_REFRESH_MIN_HZ 只是「自定义帧率」可选下限（UI 的档位里有 30），两者不能混用。
// 这段逻辑在 Electron 主进程里，沿用仓库既有的源码契约断言做法。
//
// 2026-10 变更：目标帧率的解析从 applyHighRefreshRate() 抽到 resolveWindowFrameRate()，
// 以便**逐窗口**按所在显示器解析（旧实现只按主窗算一次再套给全部窗口）。
// 因此这段契约现在断言 resolveWindowFrameRate；真正校验限流行为的用例见
// test/frameRateLimiter.test.ts（源码文本断言测不出 API 是否真的生效）。
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
  const body = functionBody('resolveWindowFrameRate')
  assert.match(body, /: FRAME_RATE_BASELINE_HZ/, '关闭分支应使用 60Hz 基准')
  assert.doesNotMatch(body, /: HIGH_REFRESH_MIN_HZ/, '关闭分支不得再用自定义帧率下限当目标帧率')
})

test('自定义帧率的 30Hz 下限仍然保留（UI 档位里有 30）', () => {
  assert.match(main, /const HIGH_REFRESH_MIN_HZ = 30/)
  assert.match(functionBody('getWindowDisplayFrequency'), /Math\.max\(HIGH_REFRESH_MIN_HZ, hz\)/)
})

test('目标帧率逐窗口解析：不得再按主窗算一次套给全部窗口', () => {
  const body = functionBody('applyHighRefreshRate')
  // 每个窗口都要各自调用 resolveWindowFrameRate(win)
  assert.match(body, /resolveWindowFrameRate\(win\)/, '每个窗口应各自解析目标帧率')
  assert.match(body, /win\.webContents\.send\('frame-rate:set'/, '目标帧率需下发给渲染层')
  assert.match(body, /win\.webContents\.setFrameRate\(/, '保留 setFrameRate 调用以表达意图')
})

test('拖动窗口路径必须去重 + 合并，否则每次 move 事件都会扇出 IPC', () => {
  const body = functionBody('applyHighRefreshRate')
  assert.match(body, /lastAppliedFrameRate/, '需要按窗口缓存上次应用值')
  assert.match(body, /unchanged/, '目标未变时不得重复下发')
  // 去重必须真的挡住调用，而不是只算了变量
  assert.match(body, /if \(force \|\| !unchanged\)/, '未变化且非强制时应跳过 setFrameRate/send')
  // 窗口销毁后要清理缓存，避免反复重建时映射无限增长
  assert.match(body, /lastAppliedFrameRate\.delete/, '需要清理已销毁窗口的缓存项')

  const scheduleBody = functionBody('scheduleApplyHighRefreshRate')
  assert.match(scheduleBody, /HIGH_REFRESH_APPLY_COALESCE_MS/, 'move/resize 需要合并窗口')
  assert.match(scheduleBody, /now - highRefreshApplyAt < HIGH_REFRESH_APPLY_COALESCE_MS/, '应为前缘节流')

  // move/resize 监听必须挂合并版，display-metrics-changed 是低频事件可直接应用
  assert.match(main, /highRefreshHandlers\.move = scheduleApplyHighRefreshRate/)
  assert.match(main, /highRefreshHandlers\.resize = scheduleApplyHighRefreshRate/)
  assert.match(main, /highRefreshHandlers\.displayMetrics = \(\) => applyHighRefreshRate\(\)/)
})

test('渲染层限流模块与 IPC 查询接口都在位', () => {
  const limiter = fs.readFileSync(path.join(root, 'src/utils/frameRateLimiter.ts'), 'utf8')
  assert.match(limiter, /export function frameIntervalMs/, '限流间隔计算必须可单测')
  assert.match(limiter, /export function createFrameGate/, '帧闸门必须可单测')
  assert.match(limiter, /export function createRafThrottle/, 'rAF 蹦床必须可单测')
  assert.match(limiter, /window\.requestAnimationFrame = /, '必须真正替换全局 rAF')
  assert.match(main, /ipcMain\.handle\('display:get-frame-rate'/, '渲染层需要能拉取本窗口目标帧率')
})
