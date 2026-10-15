import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { PlaybackTimeSnapshot } from '../audio/playbackTimeStore'
import type { LyricStyleMode } from '../utils/lyricStyle'
import { toRgba } from './quickSettingsPalette'
import QuickSettingsLiveMirror, { type QuickSettingsMirrorStatus } from './QuickSettingsLiveMirror'
import { PREVIEW_SCENES, type PreviewRow, type PreviewSceneContext, type PreviewSceneKey } from './quickSettingsPreviewScenes'

// 播放上下文类型单一定义在 quickSettingsPlaybackContext.ts（App/Host/Dialog 共用），
// 这里重导出保持旧 import 路径兼容 —— 双份定义会在加字段时静默失配（一边改一边没改）。
export type { QuickSettingsPreviewTrack, QuickSettingsPreviewLyric, QuickSettingsPlaybackContext } from './quickSettingsPlaybackContext'
import type { QuickSettingsPlaybackContext } from './quickSettingsPlaybackContext'

/**
 * 「播放设置」弹窗**顶部监视器**里的实时预览。
 *
 * 外壳是一块横版「仪器屏」：尺寸由弹窗决定（父级是机箱里 `aspect-video h-full` 的盒子）。
 * 机箱高度**不写死** —— 第九轮起弹窗上半块是 `flex-1`，吃「下半块固定高度」之外的全部剩余，
 * 所以窗口越高预览越大（1402×817 下约 704×396）。**比例始终由 `aspect-video` 锁 16:9**，
 * 与真机播放面一致，这是预览有意义的前提）。
 * 本组件只画屏幕本体 —— 四角托架由 `QuickSettingsDialog` 渲染，不要加到这里。
 *
 * ## 两条渲染路径（优先用真机，拿不到才回退）
 *
 * | 路径 | 条件 | 内容 |
 * |---|---|---|
 * | **实时镜像**（主） | 页面上存在 `[data-waveforge-playback-layer]`（简约模式层，含 MV 背景等兄弟节点） | `QuickSettingsLiveMirror` 把真实播放页克隆进来并逐帧同步 —— 预览就是真机 |
 * | **模拟场景**（回退） | jsdom 单测 / 简约层未挂载（home 页等） | `quickSettingsPreviewScenes.tsx` 那 7 套手绘版式 |
 *
 * 回退路径**不能删**：`test/QuickSettingsModal.test.tsx` 的
 * 「renders the preview from the injected playback context…」整条用例都建立在模拟场景上
 * （jsdom 里没有真实播放面，必然走回退）。它也保证「没有播放页可镜像」时预览不空白。
 *
 * 回退场景带 `data-wf-qs-scene`（测试据此断言预览跟着歌词模式换版式）。镜像路径下预览
 * 与外面的播放页一模一样，不叠加任何标注（顶部两枚 chip 已按用户要求移除）。
 *
 * ⚠️ **`<QuickSettingsLiveMirror>` 必须无条件挂载**，只有模拟场景那部分才吃
 * `mirrorStatus === 'absent'` 条件。镜像自己就是探测者：把它也塞进条件分支里，
 * `'absent'` 时它不挂载 → 永远没人上报 `'live'` → 预览永远停在模拟场景（本轮实测踩到）。
 *
 * ⚠️ **不要给根节点加 `min-h-[320px]`**（第五轮曾这么写）：父盒是固定高度的横版盒，
 * 最小高度会把它顶高、`aspect-video` 失效，比例又回到失真的状态。
 *
 * ⚠️ **回退路径的场景层必须留在「设计画布」里缩放**（见 `DESIGN_W / DESIGN_H`）：
 * 场景文件里全是写死的 px，盒子变矮（150/200）时不缩放就会溢出被裁。
 *
 * **预览会跟着 `lyricDisplayMode` 换版式** —— 六个模式的播放页长得完全不一样，
 * 用一套「左歌词 + 右下封面」的抽象去代表全部模式，用户根本看不出自己切的是哪个模式。
 * 各模式的骨架、以及它们与真机代码的对应关系，见 `quickSettingsPreviewScenes.tsx`。
 *
 * 回退路径的内容仍是**抽象模拟**（不是真实播放页），只让用户看清这几项设置的即时效果：
 * 歌词模式版式 / 背景效果 / 模糊程度 / 主题明暗 / 歌词字号 / 逐字歌词 / 歌词高光 /
 * 封面律动 / 频谱条 / 隐藏歌名艺人 / 播放进度。
 *
 * 二〇二四‑〇九 优化：预览**优先吃真实播放数据**（`playback` 上下文里的当前曲目 / 歌词 /
 * 播放时间），拿不到时才回退到内置示例。数据管道见 App.tsx 的 `quickSettingsPlayback`
 * → QuickSettingsHost → QuickSettingsDialog → 本组件。
 *
 * 时间订阅刻意放在**本组件内部**（而不是让宿主把 currentTime 当 prop 传下来）：
 * playbackTimeStore 每帧 publish，只有订阅它的组件会重渲染，弹窗其余控件不受影响。
 * 与 App.tsx 的 `LiveLyricsDisplay` / `LivePlayerControls` 同一套写法。
 *
 * 顶部原先还叠了两枚 chip（「实时预览」/ 模式 · 效果）—— 已按用户要求移除：
 * 镜像路径下预览就该与外面的播放页一模一样，任何叠加物都是「多出来的无关内容」。
 */
interface QuickSettingsPreviewProps {
  isDaylight: boolean
  accentColor: string
  /** 当前歌词模式（决定预览用哪套版式）；未知值退回现代 */
  lyricDisplayMode?: string | null
  backgroundEffect: 'transparent' | 'blur' | 'immersive' | 'modern'
  backgroundBlur: number
  showImmersiveBar: boolean
  lyricSize: number
  wordByWord: boolean
  lyricStyle: LyricStyleMode
  lyricGlow: boolean
  coverPulseEnabled: boolean
  coverPulseMode: 'dynamic' | 'soft' | 'restless'
  hideSongInfo: boolean
  showVisualizer: boolean
  playback?: QuickSettingsPlaybackContext | null
}

/** 无播放上下文时的兜底时间源（示例内容要照常动起来）。 */
const IDLE_SNAPSHOT: PlaybackTimeSnapshot = { currentTime: 0, duration: 0, isPlaying: false }
const subscribeIdle = () => () => {}
const getIdleSnapshot = () => IDLE_SNAPSHOT
/** 无播放上下文时的兜底播放状态：示例动画照常跑。 */
const getIdlePlaying = () => true

/** 示例歌词：中间那句正在唱。无真实歌词时使用。刻意给 7 句 —— 真机一屏就是这个密度。 */
const FALLBACK_LINES = [
  { text: '夜色渐浓 城市在低语', progress: 1 },
  { text: '路灯把影子拉得很长', progress: 1 },
  { text: '雨点敲在旧窗台上', progress: 1 },
  { text: '我们走过的每一条街', progress: 0.62 },
  { text: '都还留着你的温度', progress: 0 },
  { text: '风把回忆吹成了海', progress: 0 },
  { text: '我在浪里喊你的名字', progress: 0 },
] as const

/** 歌词窗口：当前句居中，前后各留 3 句。真机一屏大约就是这个行数。 */
const LYRIC_WINDOW = 7

/**
 * **设计画布**：`quickSettingsPreviewScenes.tsx` 里所有 px 尺寸都按这块 462×260（16:9）
 * 标定（对应弹窗在 `lg` 档的 260px 高监视器）。
 *
 * 盒子在矮档位（`h-[150px]` / `h-[200px]`）时，场景必须**整体等比缩放**而不是重新排版：
 * 场景里全是写死的 px，盒子变矮而尺寸不变 → 7 行歌词窗口（7 × 14px × 1.7 ≈ 167px）
 * 直接顶出容器，首行被顶部 chip 压住、末行被 `overflow-hidden` 切掉。
 * 缩放的依据是盒高（画布与实际盒子同为 16:9，所以不会出现留边）。
 */
const DESIGN_W = 462
const DESIGN_H = 260

const FALLBACK_TITLE = '夜色温柔'
const FALLBACK_ARTIST = '澜音工坊 · 试听'

/** 律动速度（folia 的一档：动感 / 柔和 / 躁动）。 */
const PULSE_DURATION: Record<QuickSettingsPreviewProps['coverPulseMode'], string> = {
  dynamic: '1.15s',
  soft: '2.4s',
  restless: '0.7s',
}

const formatClock = (seconds: number) => {
  const total = Math.max(0, Math.floor(seconds))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** 背景图 URL 里可能带引号/括号，包进 CSS url() 前先转义。 */
const toCssUrl = (url: string) => `url("${url.replace(/["\\]/g, (char) => encodeURIComponent(char))}")`

/** 模式名 → 版式。`PREVIEW_SCENES` 里没有的值（脏 localStorage 等）一律退回现代。 */
const resolveSceneKey = (mode?: string | null): PreviewSceneKey => (
  mode && Object.prototype.hasOwnProperty.call(PREVIEW_SCENES, mode) ? (mode as PreviewSceneKey) : 'modern'
)

export default memo(function QuickSettingsPreview({
  isDaylight,
  accentColor,
  lyricDisplayMode,
  backgroundEffect,
  backgroundBlur,
  showImmersiveBar,
  lyricSize,
  wordByWord,
  lyricStyle,
  lyricGlow,
  coverPulseEnabled,
  coverPulseMode,
  hideSongInfo,
  showVisualizer,
  playback,
}: QuickSettingsPreviewProps) {
  const overText = isDaylight ? '#000000' : '#ffffff'

  /**
   * 预览走哪条路径：'live' = 实时镜像真实播放面；'absent' = 回退到内置模拟场景
   * （jsdom 单测 / home 页 / Apple 电台、播客这类自带播放页的模式）。
   *
   * 初值给 'absent' 是安全的：镜像在 `useLayoutEffect` 里同步上报真实状态，
   * React 会在浏览器绘制前把这次 setState 刷掉，不会先闪一帧模拟画面。
   */
  const [mirrorStatus, setMirrorStatus] = useState<QuickSettingsMirrorStatus>('absent')

  /**
   * 场景画布的等比缩放系数 = 实际盒高 ÷ 设计画布高。
   *
   * 必须**实测**而不是按 Tailwind 断点硬编码：`h-[150px] sm:h-[200px] lg:h-[260px]`
   * 只是当前弹窗的取值，独立调试页（场景总览）与单测里盒子尺寸完全不同，
   * 按断点写死会在那些场景下缩错。jsdom 无 ResizeObserver、`clientHeight` 也是 0，
   * 此时保持 1（不缩放），单测里的断言不受影响。
   */
  const stageRef = useRef<HTMLDivElement | null>(null)
  const [stageScale, setStageScale] = useState(1)
  useEffect(() => {
    const el = stageRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const sync = () => {
      const height = el.clientHeight
      if (height > 0) setStageScale(height / DESIGN_H)
    }
    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  /**
   * 歌词配色照抄真机 LyricsDisplay（`isLightTheme` 那几行）：
   * 当前句 `activeLyricColor`、已唱句 0.72、未唱句 `inactiveLyricColor`，
   * 柔光也是白色系而不是主题色。**不在这里用 accent** —— 真机的当前句不是主题色，
   * 预览若用主题色会让人误以为「歌词高亮色 = 主题色」。
   */
  const lyricGlowShadow = isDaylight
    ? '0 3px 12px rgba(255, 255, 255, 0.36)'
    : '0 0 14px rgba(255, 255, 255, 0.25), 0 3px 12px rgba(0, 0, 0, 0.36)'

  const store = playback?.playbackTimeStore ?? null

  /**
   * 播放状态走一条**只取布尔值**的独立订阅（示例动画的播放/暂停跟随真机），
   * 与「有没有逐帧时间订阅」解耦。
   *
   * ⚠️ 曾经把它并进下面的 `needsTimeline` 条件里（镜像路径不订阅 store）—— 镜像路径下
   * `live` 会退回 `IDLE_SNAPSHOT`（`isPlaying: false`），回退场景的动画就会在歌在播时冻住。
   *
   * 只取布尔值**不会**带来 60fps 重渲染：store 每帧 publish 的那条 rAF 里只有时间在变，
   * 而 `useSyncExternalStore` 会用 `Object.is` 比较快照，布尔没变时 React 直接 bail out。
   */
  const getIsPlaying = useMemo(
    () => (store ? () => store.getSnapshot().isPlaying : getIdlePlaying),
    [store],
  )
  const isPlaying = useSyncExternalStore(
    store ? store.subscribe : subscribeIdle,
    getIsPlaying,
    getIsPlaying,
  )

  /**
   * 逐帧时间**只**在回退路径（内置模拟场景）里订阅。
   * 走镜像时预览显示的是真身，本组件没必要跟着 60fps 重渲染 —— 播放面自己的 rAF 才是
   * 唯一的驱动源，镜像通过节点配对去抄它，不经过 React。
   */
  const needsTimeline = mirrorStatus === 'absent'
  const live = useSyncExternalStore(
    store && needsTimeline ? store.subscribe : subscribeIdle,
    store && needsTimeline ? store.getSnapshot : getIdleSnapshot,
    store && needsTimeline ? store.getSnapshot : getIdleSnapshot,
  )

  const currentTime = Number.isFinite(live.currentTime) ? live.currentTime : 0
  const duration = Number.isFinite(live.duration) ? live.duration : 0
  const hasTimeline = Boolean(store) && duration > 0

  const coverUrl = playback?.track?.coverUrl?.trim() ?? ''
  const title = playback?.track?.title?.trim() || FALLBACK_TITLE
  const artist = playback?.track?.artist?.trim() || FALLBACK_ARTIST
  const lyricOffset = playback?.lyricOffset ?? 0

  /** 真实歌词（去掉纯间奏空行），空数组表示退回示例。 */
  const timeline = useMemo(
    () => (playback?.lyrics ?? []).filter(line => typeof line.time === 'number' && line.text?.trim()),
    [playback?.lyrics],
  )

  /** 与播放页一致的 0.5s 提前量 + 用户偏移。 */
  const currentIndex = useMemo(() => {
    if (timeline.length === 0) return -1
    const target = currentTime + 0.5 + lyricOffset
    for (let index = timeline.length - 1; index >= 0; index -= 1) {
      if (timeline[index].time <= target) return index
    }
    return -1
  }, [timeline, currentTime, lyricOffset])

  /**
   * 取「当前句前后各 3 句」一共 7 行，和真实播放页的视口密度一致
   * （只取 3 行会让竖长的预览盒中间空掉一大块）。
   */
  const rows = useMemo<PreviewRow[]>(() => {
    if (timeline.length === 0) {
      return FALLBACK_LINES.map((line, index) => ({
        key: `demo-${index}`,
        text: line.text,
        progress: line.progress,
        isCurrent: line.progress > 0 && line.progress < 1,
      }))
    }

    const target = currentTime + 0.5 + lyricOffset
    const center = currentIndex < 0 ? 0 : currentIndex
    const start = Math.max(0, Math.min(center - 3, timeline.length - LYRIC_WINDOW))

    return timeline.slice(start, start + LYRIC_WINDOW).map((line, offset) => {
      const index = start + offset
      if (index !== currentIndex) {
        return { key: `${index}`, text: line.text, progress: index < currentIndex ? 1 : 0, isCurrent: false }
      }
      // 当前句进度：优先行末时间，其次下一行起点，兜底按 4s 估
      const end = line.endTime ?? timeline[index + 1]?.time ?? line.time + 4
      const span = Math.max(0.2, end - line.time)
      return {
        key: `${index}`,
        text: line.text,
        progress: Math.min(1, Math.max(0, (target - line.time) / span)),
        isCurrent: true,
      }
    })
  }, [timeline, currentIndex, currentTime, lyricOffset])

  /** 「上一句 / 当前句 / 下一句」按窗口内的相对位置取，而不是按 progress 猜（猜法会拿到最早那句）。 */
  const currentRowIndex = rows.findIndex(row => row.isCurrent)
  const prevRow = currentRowIndex > 0 ? rows[currentRowIndex - 1] : undefined
  const currentRow = currentRowIndex >= 0 ? rows[currentRowIndex] : undefined
  const nextRow = currentRowIndex >= 0 ? rows[currentRowIndex + 1] : undefined

  // 模糊程度 0~100 → 预览里的实际模糊像素。预览区比真机小得多，所以做了压缩映射。
  const blurPx = (() => {
    if (backgroundEffect === 'transparent') return Math.round((backgroundBlur / 100) * 10)
    if (backgroundEffect === 'blur') return Math.round(8 + (backgroundBlur / 100) * 18)
    if (backgroundEffect === 'immersive') return Math.round(10 + (backgroundBlur / 100) * 22)
    return 0 // 摩登：纯渐变底，不铺封面
  })()

  // 歌词字号 1.5~4.5 → 设计画布（462×260）上的 10~20px。
  //
  // 标定依据是**真机比例**，不是「看起来够大」：真机摩登页 7 行歌词的行距是画布高的 8%
  // （基准 1312×951：行距 76px、当前行 ≈31px）。设计画布 260px 高 → 行距 ≈21px，
  // 配 lineHeight 1.7 反推出当前行 ≈12~14px。
  // 第五轮曾按「竖长盒（462×748）」上调到 13~30px，换成横版盒后 7 行会顶出容器
  // （摩登右栏实测溢出约 65px，首尾两行被 overflow-hidden 切掉）。
  // 盒子低于 260px 时**不再重算字号**，由画布整体的等比缩放兜底。
  const lyricPx = Math.round(10 + ((Math.max(1.5, Math.min(4.5, lyricSize)) - 1.5) / 3) * 10)

  const coverGradient = `linear-gradient(142deg, ${accentColor} 0%, ${toRgba(accentColor, 0.72)} 38%, ${toRgba(accentColor, 0.34)} 66%, ${toRgba(accentColor, 0.9)} 100%)`
  /** 有真封面且不是摩登（摩登刻意不铺封面）时才用真图，否则回落渐变，不会把渐变叠在封面上染色。 */
  const showRealCover = Boolean(coverUrl) && backgroundEffect !== 'modern'

  const coverBackdropStyle = showRealCover
    ? {
        backgroundImage: toCssUrl(coverUrl),
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        filter: `blur(${blurPx}px) saturate(${backgroundEffect === 'transparent' ? 130 : 150}%)`,
      }
    : { background: coverGradient, filter: `blur(${blurPx}px) saturate(150%)` }

  const animationPlayState = isPlaying ? 'running' : 'paused'
  const progressRatio = hasTimeline ? Math.min(1, Math.max(0, currentTime / duration)) : 0.4
  const clockText = hasTimeline ? formatClock(currentTime) : '1:24'
  const durationText = hasTimeline ? formatClock(duration) : '3:45'

  const sceneKey = resolveSceneKey(lyricDisplayMode)
  const Scene = PREVIEW_SCENES[sceneKey]

  /** 场景上下文：位置全用百分比，字号/配色/内容由这里统一注入。 */
  const ctx: PreviewSceneContext = {
    isDaylight,
    accentColor,
    overText,
    lyricPx,
    rows,
    prevRow,
    currentRow,
    nextRow,
    title,
    artist,
    // 「隐藏歌名艺人」只在沉浸式生效（与真机一致，其他模式不提供该开关）
    showSongInfo: !(hideSongInfo && sceneKey === 'immersive'),
    showImmersiveBar,
    showVisualizer,
    wordByWord,
    lyricGlow,
    lyricGlowShadow,
    lyricLineHeight: lyricStyle === 'modern' ? 1.5 : 1.7,
    coverPulse: coverPulseEnabled,
    coverPulseDuration: PULSE_DURATION[coverPulseMode],
    animationPlayState,
    progressRatio,
    clockText,
    durationText,
    counterLabel: `${String((currentIndex < 0 ? 0 : currentIndex) + 1).padStart(2, '0')} / ${String(timeline.length || 42).padStart(2, '0')}`,
    coverUrl,
    coverGradient,
    hasRealCover: showRealCover,
    toCssUrl,
  }

  return (
    <div
      ref={stageRef}
      data-wf-qs-preview
      data-wf-qs-scene={sceneKey}
      className="relative h-full w-full overflow-hidden rounded-[14px] border border-white/10 bg-black/20"
    >
      <style>{`
        @keyframes qs-preview-pulse {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.045); }
        }
        @keyframes qs-preview-bar {
          0%, 100% { transform: scaleY(0.34); }
          50% { transform: scaleY(1); }
        }
        @keyframes qs-preview-dot {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.35; }
        }
      `}</style>

      {/* 镜像**必须始终挂载**：它自己就是「有没有真实播放面」的探测者。
          若把它放进下面的条件分支里，'absent' 时它不挂载 → 没人上报 'live' → 永远回退，死锁。 */}
      <QuickSettingsLiveMirror onStatusChange={setMirrorStatus} />

      {mirrorStatus === 'absent' && (
        <>
          {/* 回退路径的背景层：真实封面（无封面或摩登模式退回渐变） */}
          <div className="absolute inset-0">
            <div className="absolute -inset-8" style={coverBackdropStyle} />
            {backgroundEffect === 'modern' && (
              <div
                className="absolute -inset-8"
                style={{
                  background: `linear-gradient(160deg, ${toRgba(accentColor, 0.5)} 0%, ${toRgba(accentColor, 0.14)} 48%, transparent 100%)`,
                }}
              />
            )}
            {/* 暗化/提亮：保证歌词可读。浅色主题的播放面是「浅底 + 深字」，
                所以这里必须跟着明暗走 —— 固定压深会让浅色主题的深色歌词彻底看不见。
                各模式的场景层还会在此基础上再铺自己的底（纸感 / 深空 / 金格）。 */}
            <div
              className="absolute inset-0"
              style={{
                background: backgroundEffect === 'immersive'
                  ? isDaylight
                    ? 'linear-gradient(90deg, rgba(255,255,255,0.9) 0%, rgba(255,255,255,0.72) 52%, rgba(255,255,255,0.46) 100%)'
                    : 'linear-gradient(90deg, rgba(0,0,0,0.82) 0%, rgba(0,0,0,0.62) 52%, rgba(0,0,0,0.34) 100%)'
                  : isDaylight
                    ? 'linear-gradient(90deg, rgba(255,255,255,0.78) 0%, rgba(255,255,255,0.5) 55%, rgba(255,255,255,0.28) 100%)'
                    : 'linear-gradient(90deg, rgba(0,0,0,0.66) 0%, rgba(0,0,0,0.36) 55%, rgba(0,0,0,0.12) 100%)',
              }}
            />
          </div>

          {/* ② 回退路径的前景：按歌词模式分派的版式。包进 462×260 的**设计画布**再等比缩放 ——
              场景里所有 px 都按 260px 高标定，盒子变矮时必须整体缩，不能让它溢出被裁。 */}
          <div
            className="absolute left-1/2 top-1/2 z-10"
            style={{
              width: DESIGN_W,
              height: DESIGN_H,
              transform: `translate(-50%, -50%) scale(${stageScale})`,
              transformOrigin: 'center center',
            }}
          >
            <Scene ctx={ctx} />
          </div>
        </>
      )}

      {/* ③ 顶部两枚 chip（「实时预览」/ 模式名）已按用户要求移除 —— 预览应与外面的播放页
          一模一样，任何叠加物（哪怕是状态标注）都是「多出来的无关内容」。 */}
    </div>
  )
})
