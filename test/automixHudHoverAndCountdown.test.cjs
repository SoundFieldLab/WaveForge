'use strict'

// 两处播放体验契约（都来自用户实测反馈）：
//   1. 时间节点药丸悬停时不得自动消失；移开后按 4 秒宽限渐隐（方便用户纠结要不要跳/关）。
//   2. 右上角「即将进入过渡」倒计时在暂停时不得跳成曲末剩余：暂停时过渡计划被暂时摘掉，
//      若回退到 duration 会把「切点前 1 秒」显示成「曲末前 9 秒」（实测 2:39/2:48 两张截图）。
//
// 这两处都是「定时器 / 取值回退」的时序逻辑，单测需要 jsdom + fake timer 才能覆盖到，
// 成本高于收益；这里守住结构不变量（谁负责暂停、谁负责宽限、不许回退到 duration）。
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const badge = fs.readFileSync(path.join(root, 'src/components/AutomixHudBadge.tsx'), 'utf8')
const app = fs.readFileSync(path.join(root, 'src/App.tsx'), 'utf8')

test('药丸悬停：暂停倒数 + 移开后 4 秒宽限', () => {
  assert.match(badge, /export const AUTOMIX_HUD_HOVER_GRACE_SECONDS = 4/, '宽限常量应为 4 秒')
  assert.match(badge, /const \[hovered, setHovered\] = useState\(false\)/, '需要悬停状态')
  assert.match(badge, /if \(hovered\) return/, '悬停期间必须停掉自动收起的定时器')
  assert.match(badge, /window\.setTimeout\(\(\) => setHolding\(false\), holdMsRef\.current\)/, '驻留时长应走 holdMsRef')
  assert.match(badge, /onPointerEnter=\{\(\) => setHovered\(true\)\}/, '需要监听进入')
  assert.match(
    badge,
    /holdMsRef\.current = AUTOMIX_HUD_HOVER_GRACE_SECONDS \* 1000[\s\S]{0,120}setHovered\(false\)/,
    '移出时先改成 4 秒宽限再结束悬停',
  )
  // 新一次提示必须复位成 8 秒，否则上一次的 4 秒宽限会泄漏到下一曲（容忍 CRLF 行尾）
  assert.match(
    badge,
    /if \(!holding\) return\r?\n\s*holdMsRef\.current = \(AUTOMIX_HUD_FADE_IN_SECONDS \+ AUTOMIX_HUD_NODE_HOLD_SECONDS\) \* 1000/,
    'holding 开始时驻留时长要复位',
  )
})

test('倒计时目标：暂停时沿用本曲已知切点，不回退到曲末', () => {
  const memoAt = app.indexOf('const upNextEventTime = useMemo(')
  assert.ok(memoAt > 0, '找不到 upNextEventTime')
  const body = app.slice(memoAt, app.indexOf('}, [automixHud?.startAt', memoAt) + 40)

  // 必须按曲目身份记住真实切点，并在计划被摘掉时回退到该记录而不是 duration
  assert.match(body, /lastTransitionCutRef/, '需要记住本曲切点')
  assert.match(body, /const realCut = automixHud\?\.startAt \?\? gaplessBoundaryStartAt \?\? null/, '只把真实切点记入记忆')
  assert.match(body, /songKey === currentSongKey\) return remembered\.cutAt/, '同曲暂停时沿用记录值')
  assert.match(app, /lastTransitionCutRef = useRef<\{ songKey: string; cutAt: number \} \| null>\(null\)/, '记忆结构按曲目 key 区分')
  // 换歌必须自动失效（依赖里要有 currentSongKey，否则新歌会继承上一首的切点）
  const deps = app.slice(memoAt, memoAt + 2400)
  assert.match(deps, /currentSongKey\s*\]/, '依赖里需要 currentSongKey')
})
