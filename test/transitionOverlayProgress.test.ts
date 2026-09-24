import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const read = (file: string) => fs.readFileSync(path.resolve(file), 'utf8').replace(/\r\n/g, '\n')

/**
 * 过渡叠加层（封面背景 / 大封面 / 歌曲信息 / MV 背景）必须消费同一个进度源。
 *
 * 历史问题：封面与大封面用裸 transitionProgress（原点=音频过渡启动时刻），
 * MV 背景用 overlayProgress（原点=动画窗口起点，重新归一化到 0→1）。
 * 动画窗口比音频起点晚开，窗口开启瞬间裸 transitionProgress 会一次性跳上去
 * （v1 约 0.17、AI 长混音约 0.67），而 overlayProgress 恰好是 0。
 * 结果是同一屏里封面硬跳、MV 从 0 开始，两者长期不同步。
 */
describe('Transition overlay progress source', () => {
  it('derives overlayProgress so it starts at zero when the animation window opens', () => {
    const app = read('src/App.tsx')

    // 窗口未开时归零，且从起点重新归一化
    expect(app).toContain('if (!inAnimationWindow) return 0')
    expect(app).toContain('const start = 1 - span / dur')
    expect(app).toContain('return Math.max(0, Math.min(1, (transitionProgress - start) / (span / dur)))')
  })

  it('feeds every overlay consumer the same normalized progress', () => {
    const app = read('src/App.tsx')

    // 封面背景、MV 背景、两处大封面、进度条叠加
    const overlayConsumers = app.match(/transitionProgress=\{overlayProgress\}/g) || []
    expect(overlayConsumers.length).toBeGreaterThanOrEqual(4)

    // 封面/大封面/歌曲信息不得再吃裸 transitionProgress（进度指示器除外）
    expect(app).not.toContain('transitionProgress={transitionProgress}')
  })

  it('keeps the title crossfade layers on the same progress as the cover', () => {
    const app = read('src/App.tsx')

    // 两处歌曲信息交叉都必须用 overlayProgress，不能一处 transitionProgress 一处 overlayProgress
    expect(app).not.toContain('style={{ opacity: 1 - transitionProgress }}')
    expect(app).not.toContain('style={{ opacity: transitionProgress }}')
    const titleLayers = app.match(/style=\{\{ opacity: (1 - )?overlayProgress \}\}/g) || []
    expect(titleLayers.length).toBeGreaterThanOrEqual(3)
  })

  it('keeps whole-transition progress only on indicators that need it', () => {
    const app = read('src/App.tsx')

    // Folia conic 进度环是"进度指示器"，需要完整过渡进度而非叠加窗口进度
    expect(app).toContain('progress={transitionProgress}')
  })
})
