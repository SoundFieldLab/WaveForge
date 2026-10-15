/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement, forwardRef, Fragment, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import QuickSettings from '../src/components/QuickSettings'
import QuickSettingsHost from '../src/components/QuickSettingsHost'
import { createPlaybackTimeStore } from '../src/audio/playbackTimeStore'
import {
  closeQuickSettings,
  getQuickSettingsState,
  openQuickSettings,
  resetQuickSettingsForTest,
} from '../src/services/quickSettingsStore'
import { dispatchTvBack } from '../src/tv/tvCore'

// framer-motion 在 jsdom 里的按需替身：AnimatePresence 变成同步透传（关闭后立即卸载，断言不必等动画），
// motion.* 变成同名 DOM 元素并吃掉动画专用 prop，避免把 initial/animate 当属性挂到 DOM 上。
vi.mock('framer-motion', () => {
  const passthrough = (tag: string) =>
    forwardRef<HTMLElement, Record<string, unknown>>((props, ref) => {
      const { initial, animate, exit, transition, whileHover, whileTap, ...rest } = props as Record<string, unknown>
      void initial; void animate; void exit; void transition; void whileHover; void whileTap
      return createElement(tag, { ...rest, ref })
    })
  return {
    AnimatePresence: ({ children }: { children?: ReactNode }) => createElement(Fragment, null, children),
    motion: new Proxy({}, {
      get: (_target, tag) => (typeof tag === 'string' ? passthrough(tag) : undefined),
    }),
  }
})

const TRIGGER_NAME = '播放设置'

function renderSettings(props: { isPureMusic?: boolean } = {}, playback?: Parameters<typeof QuickSettingsHost>[0]['playback']) {
  return render(
    <>
      <QuickSettings triggerAriaLabel={TRIGGER_NAME} {...props} />
      <QuickSettingsHost playback={playback} />
    </>,
  )
}

const trigger = () => screen.getByRole('button', { name: TRIGGER_NAME })
const dialog = () => screen.queryByRole('dialog', { name: TRIGGER_NAME })
const overlay = () => dialog()?.parentElement as HTMLElement

beforeEach(() => {
  resetQuickSettingsForTest()
  localStorage.clear()
})

afterEach(() => {
  cleanup()
  resetQuickSettingsForTest()
})

describe('QuickSettings 弹窗', () => {
  it('opens a dialog portaled to body, outside the trigger container', () => {
    const { container } = renderSettings()
    expect(dialog()).toBeNull()

    fireEvent.click(trigger())

    const panel = dialog()
    expect(panel).toBeTruthy()
    // portal 到 body：逃出播放面 minimal-playback-surface 的 transform 层叠上下文与祖先 overflow-hidden
    expect(document.body.contains(panel)).toBe(true)
    expect(container.contains(panel)).toBe(false)
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
  })

  it('closes on Escape and on backdrop click, but not on clicks inside the panel', () => {
    renderSettings()

    fireEvent.click(trigger())
    fireEvent.click(dialog() as HTMLElement)
    expect(getQuickSettingsState().isOpen).toBe(true)

    fireEvent.mouseDown(overlay())
    fireEvent.click(overlay())
    expect(getQuickSettingsState().isOpen).toBe(false)
    expect(dialog()).toBeNull()

    fireEvent.click(trigger())
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(getQuickSettingsState().isOpen).toBe(false)
    expect(dialog()).toBeNull()
  })

  it('ignores a press that starts inside the panel and releases on the backdrop', () => {
    renderSettings()
    fireEvent.click(trigger())

    // 拖歌词偏移滑块时很容易「在面板内按下、拖到遮罩上松开」：不应被当成点击遮罩
    fireEvent.mouseDown(dialog() as HTMLElement)
    fireEvent.click(overlay())
    expect(getQuickSettingsState().isOpen).toBe(true)
  })

  it('closes on the TV remote BACK while open', () => {
    renderSettings()
    fireEvent.click(trigger())
    expect(getQuickSettingsState().isOpen).toBe(true)

    act(() => { dispatchTvBack() })
    expect(getQuickSettingsState().isOpen).toBe(false)
  })

  it('keeps a single instance and does not remount when opened again while open', () => {
    renderSettings()
    fireEvent.click(trigger())

    const first = dialog()
    act(() => { openQuickSettings({ playerTheme: 'light' }) })

    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(dialog()).toBe(first)
  })

  it('scopes the features section by isPureMusic and switches sections in the header', () => {
    renderSettings({ isPureMusic: true })
    fireEvent.click(trigger())
    fireEvent.click(screen.getByRole('button', { name: '功能' }))

    // 功能段的第一张卡是音频可视化；folia 版式下卡片内只有一行 ToggleRow，
    // 分组名不再作为独立文本出现，所以按这一行的 label 断言。
    expect(screen.getByText('实时频谱条')).toBeTruthy()
    expect(screen.queryByText('逐字歌词')).toBeNull()
    expect(screen.queryByText('歌词风格样式')).toBeNull()

    cleanup()
    resetQuickSettingsForTest()
    renderSettings({ isPureMusic: false })
    fireEvent.click(trigger())
    fireEvent.click(screen.getByRole('button', { name: '功能' }))

    expect(screen.getByText('逐字歌词')).toBeTruthy()
    expect(screen.getByText('歌词风格样式')).toBeTruthy()
  })

  it('writes settings to storage and broadcasts the change event', () => {
    const onChanged = vi.fn()
    window.addEventListener('wordByWordLyricsChanged', onChanged)
    renderSettings()
    fireEvent.click(trigger())
    fireEvent.click(screen.getByRole('button', { name: '功能' }))

    // 按 aria-label 定位开关。folia 的 ToggleRow 把 aria-label 直接取成行标题，
    // 且标题与描述裹成一块、开关单独在右侧 ——「标题元素的 parentElement 里藏着开关」不再成立。
    fireEvent.click(screen.getByRole('button', { name: '逐字歌词' }))

    expect(localStorage.getItem('wordByWordLyrics')).toBe('false')
    expect(onChanged).toHaveBeenCalledTimes(1)
    window.removeEventListener('wordByWordLyricsChanged', onChanged)
  })

  it('re-reads stored values on every open', () => {
    renderSettings()

    localStorage.setItem('lyricSize', '3.4')
    fireEvent.click(trigger())
    fireEvent.click(screen.getByRole('button', { name: '功能' }))
    expect(screen.getByText('3.4')).toBeTruthy()

    act(() => { closeQuickSettings() })
    localStorage.setItem('lyricSize', '4.1')
    fireEvent.click(trigger())
    fireEvent.click(screen.getByRole('button', { name: '功能' }))
    expect(screen.getByText('4.1')).toBeTruthy()
  })

  it('switches the lyric mode through the shared storage + event channel', () => {
    const onChanged = vi.fn()
    window.addEventListener('lyricDisplayModeChanged', onChanged)
    renderSettings()
    fireEvent.click(trigger())
    fireEvent.click(screen.getByRole('button', { name: '功能' }))

    // 弹窗不自己切 App 的 mode：只落盘 + 广播，由 App 走完整切换流程（含目标 chunk 预加载）
    fireEvent.click(screen.getByRole('button', { name: '墙纸' }))

    expect(localStorage.getItem('lyricDisplayMode')).toBe('wallpaper')
    expect(onChanged).toHaveBeenCalledTimes(1)
    window.removeEventListener('lyricDisplayModeChanged', onChanged)
  })

  it('keeps the three playback transition modes mutually exclusive', () => {
    renderSettings()
    fireEvent.click(trigger())
    fireEvent.click(screen.getByRole('button', { name: '播放' }))

    fireEvent.click(screen.getByRole('button', { name: '无缝衔接' }))
    expect(localStorage.getItem('gaplessEnabled')).toBe('true')
    expect(localStorage.getItem('crossfadeEnabled')).toBe('false')
    expect(localStorage.getItem('autoMixEnabled')).toBe('false')

    fireEvent.click(screen.getByRole('button', { name: '渐入渐出' }))
    expect(localStorage.getItem('crossfadeEnabled')).toBe('true')
    expect(localStorage.getItem('gaplessEnabled')).toBe('false')
    // 渐入渐出时长滑块只在选中该方式后出现
    expect(screen.getByText('4s')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(localStorage.getItem('crossfadeEnabled')).toBe('false')
    expect(localStorage.getItem('gaplessEnabled')).toBe('false')
    expect(localStorage.getItem('autoMixEnabled')).toBe('false')
  })

  it('mirrors the lyric translation and romanization settings', () => {
    renderSettings()
    fireEvent.click(trigger())
    fireEvent.click(screen.getByRole('button', { name: '功能' }))

    fireEvent.click(screen.getByRole('button', { name: '歌词翻译' }))
    expect(localStorage.getItem('translationEnabled')).toBe('true')

    // 翻译位置只在翻译开启后出现
    fireEvent.click(screen.getByRole('button', { name: '现代（右下角）' }))
    expect(localStorage.getItem('translationPosition')).toBe('bottom-right')

    fireEvent.click(screen.getByRole('button', { name: '罗马音' }))
    expect(localStorage.getItem('romanEnabled')).toBe('true')
  })

  it('renders the preview from the injected playback context instead of the demo content', () => {
    const store = createPlaybackTimeStore({ currentTime: 12, duration: 200, isPlaying: true })
    // 逐字歌词开启时当前行会被拆成逐字 span（getByText 只拼直接文本子节点，读不到整行），
    // 这里先关掉，好按整行断言。
    localStorage.setItem('wordByWordLyrics', 'false')
    renderSettings({}, {
      track: { title: '测试曲目', artist: '测试歌手' },
      lyrics: [
        { time: 0, text: '第一句歌词' },
        { time: 10, text: '第二句歌词' },
        { time: 20, text: '第三句歌词' },
      ],
      playbackTimeStore: store,
    })
    fireEvent.click(trigger())

    expect(screen.getByText('测试曲目')).toBeTruthy()
    expect(screen.getByText('第二句歌词')).toBeTruthy()
    expect(screen.getByText('0:12')).toBeTruthy()
    // 真实歌词到位后不再出现写死的示例内容
    expect(screen.queryByText('夜色渐浓 城市在低语')).toBeNull()

    // 预览自己订阅 playbackTimeStore：时间推进要能反映到时间轴上
    act(() => { store.publish({ currentTime: 65 }) })
    expect(screen.getByText('1:05')).toBeTruthy()
  })

  it('switches the preview layout with the lyric display mode', () => {
    renderSettings()
    fireEvent.click(trigger())

    // 预览容器带 data-wf-qs-scene，标明当前用的是哪套版式
    const scene = () => document.querySelector('[data-wf-qs-preview]')?.getAttribute('data-wf-qs-scene')
    expect(scene()).toBe('modern')

    // 歌词模式的 chip 在「功能」分段里
    fireEvent.click(screen.getByRole('button', { name: '功能' }))
    // 「墙纸」「多维」这两个模式名在同一个弹窗里没有重名 chip（「摩登」「柔和」都另有含义），
    // 所以可以安全按可见名点击。
    fireEvent.click(screen.getByRole('button', { name: '墙纸' }))
    expect(scene()).toBe('wallpaper')

    fireEvent.click(screen.getByRole('button', { name: '多维' }))
    expect(scene()).toBe('multidimensional')
  })

  it('draws nothing on top of the preview and has no footer chrome', () => {
    renderSettings()
    fireEvent.click(trigger())

    // 预览应与外面的播放页一模一样：不再有「实时预览」/ 模式 · 效果两枚叠加 chip，
    // 也没有「设置即时生效」文案与「完成」按钮（关闭走右上角 ✕ / Esc / 点遮罩）。
    expect(screen.queryByText('实时预览')).toBeNull()
    expect(screen.queryByText(/已暂停/)).toBeNull()
    expect(screen.queryByText('设置即时生效，改动会被记住')).toBeNull()
    expect(screen.queryByRole('button', { name: '完成' })).toBeNull()
  })
})

/**
 * 预览的「实时镜像」契约。
 *
 * jsdom 里没有真实播放页 → 走内置模拟场景（上面那批用例覆盖）。这里**手工造一个**
 * `[data-waveforge-playback-layer]`（播放页模式层 = 镜像源），把镜像路径也钉住：
 * 真机播放页存在时，预览必须是真身的克隆，而不是另画的抽象画面。
 */
describe('播放设置预览 · 实时镜像', () => {
  /** 造一个最小的「播放页模式层」，并挂到 body 上（真机上它在 #root 里）。 */
  function mountFakeSurface() {
    const source = document.createElement('div')
    source.setAttribute('data-waveforge-playback-layer', 'true')
    source.innerHTML = `
      <div data-waveforge-playback-page="true">
        <div id="mirror-probe-line" style="color: rgba(255,255,255,0.4)">真身里的第一句</div>
        <div id="wf-wallpaper-controls-anchor">控件锚点</div>
        <div data-wf-upnext-card>即将播放</div>
        <video src="https://example.com/a.mp4" muted></video>
      </div>
    `
    document.body.appendChild(source)
    return source
  }

  const mirrorHost = () => document.querySelector('[data-wf-qs-mirror]')
  const cloneRoot = () => mirrorHost()?.firstElementChild?.firstElementChild as HTMLElement | null

  afterEach(() => {
    document.querySelector('[data-waveforge-playback-layer="true"]')?.remove()
  })

  it('mirrors the real playback surface instead of drawing a scene', () => {
    mountFakeSurface()
    renderSettings()
    fireEvent.click(trigger())

    const clone = cloneRoot()
    expect(clone).toBeTruthy()
    // 克隆体把真身内容带进来了
    expect(clone?.textContent).toContain('真身里的第一句')
    // 模拟场景不再渲染
    expect(screen.queryByText('夜色渐浓 城市在低语')).toBeNull()

    // 预览容器仍带 data-wf-qs-scene（测试与外部都按它判断当前版式）
    expect(document.querySelector('[data-wf-qs-preview]')?.getAttribute('data-wf-qs-scene')).toBe('modern')
  })

  it('sanitizes the clone so it cannot impersonate the real surface', () => {
    mountFakeSurface()
    renderSettings()
    fireEvent.click(trigger())

    const clone = cloneRoot() as HTMLElement
    // 留着源标记的话，镜像会认到自己的克隆体上 → 必须清掉，且全局仍然只有一个真身
    expect(clone.hasAttribute('data-waveforge-playback-layer')).toBe(false)
    expect(clone.hasAttribute('data-waveforge-playback-page')).toBe(false)
    expect(document.querySelectorAll('[data-waveforge-playback-layer]')).toHaveLength(1)
    expect(document.querySelectorAll('[data-waveforge-playback-page]')).toHaveLength(1)
    // 会被别处 querySelector / getElementById 当唯一实体用的标记与锚点 id
    expect(clone.hasAttribute('data-wf-upnext-card')).toBe(false)
    expect(clone.querySelector('#wf-wallpaper-controls-anchor')).toBeNull()
    // 预览是「看」的：不进可访问性树、不可交互
    expect(clone.hasAttribute('inert')).toBe(true)
    expect(clone.getAttribute('aria-hidden')).toBe('true')
    // 视频断源（不会出第二路声音），但画面由替身 canvas 继续逐帧抄 —— 预览里 MV 照常显示
    const frame = clone.querySelector('canvas[data-wf-mirror-video-frame]')
    expect(frame).toBeTruthy()
    expect(frame?.getAttribute('style')).toBe('')
  })

  it('copies the live inline styles of the source onto the clone', async () => {
    const source = mountFakeSurface()
    renderSettings()
    fireEvent.click(trigger())

    const line = () => document.querySelectorAll('#mirror-probe-line')
    expect(line()).toHaveLength(2)

    // 真机每帧由 rAF 写内联样式；镜像靠 MutationObserver + 逐帧同步抄过去
    ;(line()[0] as HTMLElement).style.color = 'rgba(255, 255, 255, 0.93)'
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)) })

    expect((line()[1] as HTMLElement).style.color).toBe('rgba(255, 255, 255, 0.93)')
    // 真身本身没被动过
    expect(source.getAttribute('style')).toBeNull()
  })

  it('does not overlay any play-state chrome while mirroring', () => {
    mountFakeSurface()
    // 顶部 chip（含「· 已暂停」标注）已删除：镜像路径下预览就是真身，
    // 播放状态由真身自己的控件表达，预览不再叠加任何状态标注。
    const store = createPlaybackTimeStore({ currentTime: 12, duration: 200, isPlaying: true })
    renderSettings({}, { playbackTimeStore: store })
    fireEvent.click(trigger())

    expect(cloneRoot()).toBeTruthy()
    expect(screen.queryByText(/已暂停/)).toBeNull()

    act(() => { store.publish({ isPlaying: false }) })
    expect(screen.queryByText(/已暂停/)).toBeNull()
  })

  it('re-skins the panel itself the moment a theme chip is pressed', () => {
    localStorage.setItem('playerTheme', 'dark')
    renderSettings()
    fireEvent.click(trigger())
    fireEvent.click(screen.getByRole('button', { name: '外观' }))

    // 面板配色全部由 isDaylight 派生的内联渐变，用 data 属性暴露主题供断言
    const panelTheme = () => (dialog() as HTMLElement).getAttribute('data-qs-theme')
    expect(panelTheme()).toBe('dark')

    fireEvent.click(screen.getByRole('button', { name: '浅色' }))

    // 关键：面板**自己**必须立刻换肤。若面板配色取 prop `playerTheme`，就得等 App 收到
    // `playerThemeChanged` → setState → 重渲染弹窗才变色，用户看到的是"点了一下、过会儿才变"。
    expect(panelTheme()).toBe('light')
    expect(localStorage.getItem('playerTheme')).toBe('light')

    // 反向也要立刻生效，避免只做成单向
    fireEvent.click(screen.getByRole('button', { name: '深色' }))
    expect(panelTheme()).toBe('dark')
  })
})
