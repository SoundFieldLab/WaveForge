/**
 * 学歌插件 · 正在播放信息桥。
 *
 * App.tsx 持有 currentSong / 歌词 / 播放进度 / 播控，这些是 React 树内部状态；
 * 插件弹窗渲染在 PluginOverlay（也是 App 子树，但拿到 props 要穿透十几层 memo）。
 * 这里用模块级单例做「App 写、插件读」的旁路，与 DGLab 的 setGlobalAudioAnalyzerStore
 * 同一套模式：App 在 useEffect 里注入，任何位置 import 即可用。
 *
 * 发布的快照只含学歌需要的最小集（歌曲元信息 + 可唱歌词行 + 进度 + 播控命令），
 * 不发布逐字词数组（UI 自己按 line.words 渲染）。
 */

import type { LyricLine, Song } from '../../../services/musicApi'
import type { PlaybackTimeStore } from '../../../audio/playbackTimeStore'

/** 学歌可用的播控命令（App 注入实现，插件面板调用）。 */
export interface NowPlayingControls {
  /** 播放/暂停切换。 */
  togglePlay: () => void
  /** 跳转到指定秒。 */
  seek: (timeSeconds: number) => void
}

export interface NowPlayingSnapshot {
  /** 当前歌（可能为 null = 没在放）。 */
  song: Song | null
  /** 当前歌的可唱歌词行（已过滤纯音乐标记/空行；带逐字或行级时间轴）。 */
  lyrics: LyricLine[]
  /** 歌词整体时间轴偏移（秒，与播放页一致）。 */
  lyricOffset: number
  /** 是否正在播放。 */
  isPlaying: boolean
}

const EMPTY_SNAPSHOT: NowPlayingSnapshot = {
  song: null,
  lyrics: [],
  lyricOffset: 0,
  isPlaying: false,
}

let snapshot: NowPlayingSnapshot = EMPTY_SNAPSHOT
let timeStore: PlaybackTimeStore | null = null
let controls: NowPlayingControls | null = null
const listeners = new Set<() => void>()

function notify() {
  listeners.forEach(listener => listener())
}

/** App.tsx 调用：注入快照（歌曲/歌词/播放态）。 */
export function publishNowPlaying(next: NowPlayingSnapshot) {
  const changed =
    next.song !== snapshot.song
    || next.lyrics !== snapshot.lyrics
    || next.lyricOffset !== snapshot.lyricOffset
    || next.isPlaying !== snapshot.isPlaying
  if (!changed) return
  snapshot = next
  notify()
}

/** App.tsx 调用：注入播放进度 store（订阅式，30fps 由 emit 管线驱动）。 */
export function setNowPlayingTimeStore(store: PlaybackTimeStore | null) {
  timeStore = store
}

/** App.tsx 调用：注入播控命令实现。 */
export function setNowPlayingControls(next: NowPlayingControls | null) {
  controls = next
}

export function getNowPlayingSnapshot(): NowPlayingSnapshot {
  return snapshot
}

export function getNowPlayingTimeStore(): PlaybackTimeStore | null {
  return timeStore
}

export function getNowPlayingControls(): NowPlayingControls | null {
  return controls
}

/** React 订阅（useSyncExternalStore 用）。 */
export function subscribeNowPlaying(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * 把 LyricLine[] 过滤为「可唱行」：
 * - 去掉空文本行与间奏占位（●/♪ 等装饰符）；
 * - 去掉纯元数据行（作词/作曲…）；
 * - 至少有行级 time 才可用。
 */
export function selectSingableLines(lyrics: LyricLine[]): LyricLine[] {
  const DECORATION = /^[●•·♪♩♫♬—\-\s~～]*(间奏|伴奏|纯音乐|interlude)?[●•·♪♩♫♬—\-\s~～]*$/i
  const METADATA = /^(词|曲|编曲|作词|作曲|演唱|歌手|制作人|录音|混音|母带|和声|吉他|键盘|贝斯|鼓|弦乐|配唱|监制|出品|OP|SP)[：:]/u
  return lyrics.filter(line => {
    if (!Number.isFinite(line.time) || line.time < 0) return false
    const text = (line.text || '').trim()
    if (!text) return false
    if (METADATA.test(text)) return false
    if (DECORATION.test(text)) return false
    return true
  })
}
