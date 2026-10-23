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
 *
 * 视觉轨道改造后：overlayProgress 仍在 App 派生（起点=动画窗口开启，**终点=90% 视觉
 * 轨道切换点**），作为"静态回退值"下发；逐帧平滑由 transitionVisualStore 直达叶子组件。
 */
describe('Transition overlay progress source', () => {
  it('derives overlayProgress so it starts at zero when the animation window opens and ends at the visual switch', () => {
    const app = read('src/App.tsx')

    // 窗口未开时归零，且从窗口起点重新归一化
    expect(app).toContain('if (!inAnimationWindow) return 0')
    // 修复后：start 从视觉切换点反推（渐变窗口不倒置），不再固定 1 - span/dur
    expect(app).toContain('const start = end - span / dur')
    expect(app).toContain('windowStart')
    // 交叉淡化在 90%（视觉轨道切换点）完成：此后叠加层退休、由 canonical 无缝接替
    expect(app).toContain('const end = 0.9')
    expect(app).toContain('if (transitionProgress >= end) return 1')
    expect(app).toContain('return Math.max(0, Math.min(1, (transitionProgress - start) / Math.max(1e-6, end - start)))')
  })

  it('feeds every overlay consumer the same normalized progress', () => {
    const app = read('src/App.tsx')

    // 封面背景、MV 背景、两处大封面、歌曲信息层
    const overlayConsumers = app.match(/transitionProgress=\{overlayProgress\}/g) || []
    expect(overlayConsumers.length).toBeGreaterThanOrEqual(4)

    // 封面/大封面/歌曲信息不得再吃裸 transitionProgress（进度指示器除外，见下一条用例）
    expect(app).not.toContain('transitionProgress={transitionProgress}')
  })

  it('keeps the title crossfade layers on the same progress as the cover', () => {
    const app = read('src/App.tsx')
    const titles = read('src/components/TransitionTrackTitles.tsx')

    // 歌曲信息双层交叉已抽到独立组件：App 传 overlayProgress（同一进度源），
    // 组件内部两层分别用 1-progress / progress —— 不允许再出现裸 transitionProgress。
    const titleConsumers = app.match(/progress=\{overlayProgress\}/g) || []
    expect(titleConsumers.length).toBeGreaterThanOrEqual(2)
    expect(app).not.toContain('transitionProgress={transitionProgress}')
    expect(titles).toContain('opacity: 1 - effective')
    expect(titles).toContain('opacity: effective')
    // 视觉轨道 store 直达（逐帧平滑，不再经 App 整树节流）
    expect(titles).toContain('useTransitionOverlayProgress(progressStore, progress)')
  })

  it('keeps whole-transition progress only on indicators that need it', () => {
    const app = read('src/App.tsx')

    // Folia conic 进度环是"进度指示器"，需要完整过渡进度而非叠加窗口进度
    expect(app).toContain('progress={transitionProgress}')
  })

  it('drives every smooth overlay from the transition visual store', () => {
    const app = read('src/App.tsx')
    const cover = read('src/components/AlbumCoverPlayer.tsx')
    const mv = read('src/components/BilibiliMvBackground.tsx')

    // 逐帧进度走 store（30fps 直达叶子组件），不再经 App 的 React 状态节流
    expect(app).toContain('transitionProgressStore={audioPlayer.transitionVisualStore}')
    expect(app).toContain('transitionVisualStore={audioPlayer.transitionVisualStore}')
    expect(cover).toContain('useTransitionOverlayProgress(transitionProgressStore, transitionProgress)')
    expect(cover).toContain("transition: 'opacity 120ms linear'")
    expect(mv).toContain('useTransitionOverlayProgress(transitionVisualStore, transitionProgress)')
  })
})
