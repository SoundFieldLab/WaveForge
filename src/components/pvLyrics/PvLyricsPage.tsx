/**
 * PvLyricsPage —— WaveForge 「PV」歌词模式适配层（pv-tool 引擎 + 凝彩式逐字动画，全自动版）。
 *
 * - pv-tool 移植引擎（src/vendor/pv）承担模板/特效/后期/节拍：按曲目自动选模板，
 *   段落级平滑切换（fadeToTemplate），能量驱动参数曲线 + 镜头慢呼吸 + 切镜爆发 + 间奏演出
 * - 凝彩式逐字动画：wfLyricOverlay 词级飞入/高亮/散开（真实逐字时间戳；无逐字歌词
 *   用分词 + 行时长等分自动合成词级时间戳 — 凝彩 buildLineGraphemeTimeline 思路），
 *   任何歌都有逐词动画，绝不退化为整行静态
 * - PlaybackTimeStore → 60fps rAF 外推（seek/暂停精确）；MV 背景激活时引擎透明露出
 *   BilibiliMvBackground，无 MV 时封面取色铺底；无任何用户设置
 *
 * 隔离边界：只依赖 src/vendor/pv 与通用歌词/播放接口，不改动任何既有歌词页。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { LyricLine } from '../../services/musicApi'
import type { PlaybackTimeStore } from '../../audio/playbackTimeStore'
import type { TrackAnalysis } from '../../audio/types'
import { PVEngine } from '../../vendor/pv/core/engine'
import { templates } from '../../vendor/pv/templates'
import { autoMixAnalysisService } from '../../services/autoMixAnalysisService'
import { toPvLyrics, buildBeats } from './pvBridge'
import { recommendTemplates, type StyleSignals } from './pvStyleMapping'
import { compileScenes, type PvScene } from './pvDirector'

export interface PvLyricsPageProps {
  lyrics: LyricLine[]
  currentIndex: number
  playbackTimeStore: PlaybackTimeStore
  timeOffset: number
  isPlaying: boolean
  playerTheme: 'dark' | 'light'
  accentColor: string
  songTitle: string
  songArtist: string
  songAlbum?: string
  coverUrl?: string
  trackId: string | number
  /** WaveForge songKey（`platform-id`），用于拉取节拍分析缓存 */
  trackKey?: string
  translationEnabled: boolean
  romanEnabled: boolean
  onSeek?: (time: number) => void
  /** MV 背景激活：引擎透明露出 MV DOM 层（BilibiliMvBackground） */
  mvBackgroundActive?: boolean
  /** 封面取色主色（自动模板推荐用） */
  dominantColor?: string
}

const JAPANESE_RE = /[\u3040-\u30ff\u4e00-\u9fff]/

/** 段落强度 → 引擎参数目标（能量越高越激烈） */
function resolveTargets(intensity: number) {
  return {
    beatReactivity: 0.35 + intensity * 0.5,
    animationSpeed: 1.4 + intensity * 1.4,
    motionIntensity: 0.8 + intensity * 0.5,
    effectOpacity: 0.85 + (1 - intensity) * 0.15,
    shake: intensity * 0.16,
    zoom: intensity * 0.06,
    tilt: intensity * 0.14,
    glitch: intensity * 0.22,
    hueShift: intensity > 0.66 ? 24 : 0,
  }
}

export const PvLyricsPage = memo(function PvLyricsPage({
  lyrics,
  playbackTimeStore,
  timeOffset,
  isPlaying,
  songTitle,
  coverUrl,
  trackKey,
  translationEnabled,
  romanEnabled,
  mvBackgroundActive,
  dominantColor,
  accentColor,
}: PvLyricsPageProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<PVEngine | null>(null)
  const initPromiseRef = useRef<Promise<void> | null>(null)
  const disposedRef = useRef(false)
  // 播放状态实时镜像（React prop 一定准确；不依赖 store 订阅，暂停后 store 停止发布）
  const playingRef = useRef(isPlaying)
  playingRef.current = isPlaying
  const animationControlRef = useRef<{ start: () => void; stop: () => void } | null>(null)
  const [ready, setReady] = useState(false)
  const [analysis, setAnalysis] = useState<TrackAnalysis | null>(null)

  // ── 引擎生命周期 ──
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const engine = new PVEngine()
    engineRef.current = engine
    disposedRef.current = false
    let cancelled = false
    initPromiseRef.current = engine.init(el).then(() => {
      if (cancelled) return
      engine.seek(Math.max(0, playbackTimeStore.getSnapshot().currentTime + timeOffset))
      setReady(true)
    }).catch((err: unknown) => {
      console.warn('[PvLyricsPage] Pixi 初始化失败，PV 页不可用：', err)
    })
    return () => {
      cancelled = true
      disposedRef.current = true
      try { engine.destroy() } catch { /* 已销毁 */ }
      engineRef.current = null
      initPromiseRef.current = null
      setReady(false)
    }
    // 只在挂载时初始化一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── 父容器尺寸变化 → 引擎重设渲染器 ──
  useEffect(() => {
    const el = containerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => engineRef.current?.resize())
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // ── 节拍分析拉取（getCached 只读缓存）──
  useEffect(() => {
    let cancelled = false
    if (!trackKey) {
      setAnalysis(null)
      return
    }
    autoMixAnalysisService.getCached(trackKey).then((track) => {
      if (!cancelled) setAnalysis(track)
    }).catch(() => {
      if (!cancelled) setAnalysis(null)
    })
    return () => { cancelled = true }
  }, [trackKey])

  // ── 推荐信号 + 场景编译 ──
  const signals = useMemo<StyleSignals>(() => ({
    bpm: analysis?.estimatedBpm,
    avgEnergy: analysis?.beatFeatures?.length
      ? analysis.beatFeatures.reduce((s, f) => s + (f.energy ?? 0), 0) / analysis.beatFeatures.length
      : undefined,
    dominantSection: dominantSectionOf(analysis),
    dominantColor: dominantColor || accentColor,
    hasVideo: !!mvBackgroundActive,
    isJapanese: JAPANESE_RE.test(songTitle + (lyrics[0]?.text ?? '')),
  }), [analysis, dominantColor, accentColor, mvBackgroundActive, songTitle, lyrics])

  const recommended = useMemo(() => recommendTemplates(signals), [signals])
  const pvLyrics = useMemo(() => toPvLyrics(lyrics), [lyrics])
  const scenes = useMemo(
    () => compileScenes({ lyrics: pvLyrics, analysis, recommended }),
    [pvLyrics, analysis, recommended],
  )
  const scenesRef = useRef<PvScene[]>(scenes)
  scenesRef.current = scenes

  // ── 凝彩式逐字动画 overlay（每次模板重载后由 engine 回调统一挂载）──
  const attachOverlay = useCallback((engine: PVEngine) => {
    engine.addEffect('wfLyricOverlay', {
      fontSize: 56,
      y: 0.76,
      beatPulse: true,
      glowOnSung: true,
      showTranslation: translationEnabled,
      showRoman: romanEnabled,
      color: '$text',
      sungColor: '$accent',
      sungBright: true,
      enterDist: 110,
      releaseSpread: 0.05,
    }, 'overlay')
  }, [translationEnabled, romanEnabled])

  // ── 数据初始化/重置：歌词时间轴、拍点、初始模板、背景 ──
  useEffect(() => {
    const engine = engineRef.current
    const initPromise = initPromiseRef.current
    if (!engine || !initPromise) return
    let cancelled = false
    initPromise.then(() => {
      if (cancelled || disposedRef.current) return

      engine.onTemplateReload = () => {
        if (engineRef.current === engine) attachOverlay(engine)
      }

      if (pvLyrics.length === 0) engine.setText(songTitle || '')
      else engine.setLyricTimeline(pvLyrics)
      engine.lyricOffset = timeOffset
      engine.setBeats(buildBeats(analysis))

      const transparent = !!mvBackgroundActive
      engine.alphaMode = transparent

      const first = scenes[0]?.templateIndex ?? recommended[0] ?? 0
      engine.loadTemplate(templates[first])
      if (analysis?.estimatedBpm && analysis.estimatedBpm > 0) {
        engine.beat.bpm = Math.round(analysis.estimatedBpm)
      }

      if (!transparent && coverUrl) void addCoverToEngine(engine, coverUrl)
    })
    return () => { cancelled = true }
  }, [pvLyrics, timeOffset, analysis, mvBackgroundActive, coverUrl, songTitle, scenes, recommended, attachOverlay])

  // ── 60fps 播放时钟：store 锚点 + rAF 外推 → seek + 段落编排执行 ──
  // 暂停可靠性关键：不依赖 store 订阅（暂停后 store 停止发布，订阅回调不再触发，playing
  // 闭包值会停留 true → 引擎 resume 后自走 = "音频停了歌词还在动"）。
  // 这里每帧直接 getSnapshot() 实时读 isPlaying（getSnapshot 总返回最新值），
  // 并在播放/暂停、seek/切歌翻转时重设锚点消除外推残留。
  useEffect(() => {
    let raf = 0
    let anchorTime = 0
    let anchorWall = performance.now()
    let playing = false
    let lastFrame = 0
    let lastTemplate = -1
    let lastIntensity = -1
    let spike = 0 // 段落切镜爆发（glitch/shake 一次性冲击，指数衰减）
    let params = { ...resolveTargets(0.5) }
    const FRAME_MIN_INTERVAL_MS = 1000 / 60
    const applyParams = (engine: PVEngine, target: ReturnType<typeof resolveTargets>, dt: number) => {
      const k = 1 - Math.exp(-dt * 2.5)
      params.beatReactivity += (target.beatReactivity - params.beatReactivity) * k
      params.animationSpeed += (target.animationSpeed - params.animationSpeed) * k
      params.motionIntensity += (target.motionIntensity - params.motionIntensity) * k
      params.effectOpacity += (target.effectOpacity - params.effectOpacity) * k
      params.shake += (target.shake - params.shake) * k
      params.zoom += (target.zoom - params.zoom) * k
      params.tilt += (target.tilt - params.tilt) * k
      params.glitch += (target.glitch - params.glitch) * k
      params.hueShift += (target.hueShift - params.hueShift) * k
      engine.beatReactivity = params.beatReactivity
      engine.animationSpeed = params.animationSpeed
      engine.motionIntensity = params.motionIntensity
      engine.effectOpacity = params.effectOpacity
      engine.shake = params.shake
      engine.zoom = params.zoom
      engine.tilt = params.tilt
      engine.glitch = params.glitch
      engine.hueShift = params.hueShift
    }
    const tick = (now: number) => {
      raf = 0
      if (!playingRef.current || document.visibilityState !== 'visible') return

      const dt = lastFrame ? Math.min(0.2, (now - lastFrame) / 1000) : 1 / 60
      if (now - lastFrame >= FRAME_MIN_INTERVAL_MS) {
        lastFrame = now

        // 实时读取播放状态：以 React prop 为准（一定准确），进度锚点来自 store
        const snapshot = playbackTimeStore.getSnapshot()
        const playingNow = playingRef.current
        if (playingNow !== playing || (playing && Math.abs(snapshot.currentTime - anchorTime) > 0.05)) {
          anchorTime = snapshot.currentTime
          anchorWall = now
          playing = playingNow
        }

        const extrapolated = playing ? Math.min(0.5, (now - anchorWall) / 1000) : 0
        const target = anchorTime + extrapolated + timeOffset
        const engine = engineRef.current
        if (engine && initPromiseRef.current) {
          if (playing) {
            engine.resume()
            engine.seek(target)
            const scene = findScene(scenesRef.current, target)
            // 间奏演出：落点越过当前场景 end（歌词间隙）→ 提升节奏响应/相机运动
            const intensity = Math.max(0.7, scene?.intensity ?? 0.5)
            // 段落切镜：平滑换模板 + glitch/shake 爆发（剪辑切镜感）；首帧仅记账
            if (scene && scene.templateIndex !== lastTemplate) {
              const next = scene.templateIndex
              if (lastTemplate === -1) lastTemplate = next
              else {
                lastTemplate = next
                spike = 1
                engine.fadeToTemplate(templates[next])
              }
            }
            if (Math.abs(intensity - lastIntensity) > 0.02) {
              lastIntensity = intensity
            }
            // 参数目标 + 镜头慢呼吸 + 切镜爆发叠加
            const targets = resolveTargets(intensity)
            const breathe = (Math.sin(now * 0.0009) + 1) * 0.5
            targets.zoom += (breathe - 0.5) * 0.05
            targets.shake += (breathe - 0.5) * 0.04 + spike * 0.3
            targets.tilt += spike * 0.05
            targets.glitch = Math.min(1, targets.glitch + spike * 0.45)
            targets.hueShift = Math.max(targets.hueShift, spike * 80)
            // 镜头：段落强度 → 推近幅度；切镜瞬间横扫（组件维护 spike 衰减，引擎只消费值）
            engine.cameraIntensity = intensity
            engine.cameraSweepX = spike * (Math.sin(now * 0.01) >= 0 ? 1 : -1)
            engine.cameraSweepY = spike * 0.3
            applyParams(engine, targets, dt)
            spike *= Math.exp(-dt * 2.4)
          } else {
            // 暂停：完全冻结 —— 不再 seek（引擎 time 停在最后位置）、全特效 deltaTime=0
            engine.pause()
          }
        }
      }
      if (playingRef.current && document.visibilityState === 'visible') {
        raf = requestAnimationFrame(tick)
      }
    }
    const stop = () => {
      if (raf !== 0) cancelAnimationFrame(raf)
      raf = 0
      playing = false
      lastFrame = 0
      engineRef.current?.pause()
    }
    const start = () => {
      if (raf !== 0 || !playingRef.current || document.visibilityState !== 'visible') return
      raf = requestAnimationFrame(tick)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') start()
      else stop()
    }

    animationControlRef.current = { start, stop }
    document.addEventListener('visibilitychange', onVisibilityChange)
    start()
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibilityChange)
      if (animationControlRef.current?.start === start) animationControlRef.current = null
    }
  }, [playbackTimeStore, timeOffset])

  useEffect(() => {
    if (isPlaying) animationControlRef.current?.start()
    else animationControlRef.current?.stop()
  }, [isPlaying])

  return (
    <div className="relative w-full h-full min-h-[280px] overflow-hidden">
      <div ref={containerRef} className="w-full h-full min-h-[280px]" />
      {!ready && (
        <div className="absolute inset-0 flex items-center justify-center text-white/70 text-sm">
          PV 引擎初始化中…
        </div>
      )}
    </div>
  )
})

function findScene(scenes: PvScene[], time: number): PvScene | null {
  for (let i = scenes.length - 1; i >= 0; i--) {
    if (time >= scenes[i].start) return scenes[i]
  }
  return scenes[0] ?? null
}

function dominantSectionOf(track: TrackAnalysis | null): string | undefined {
  if (!track || !Array.isArray(track.sections) || track.sections.length === 0) return undefined
  const count = new Map<string, number>()
  for (const s of track.sections) {
    count.set(s.type, (count.get(s.type) ?? 0) + 1)
  }
  let best: string | undefined
  let bestCount = 0
  for (const [type, n] of count) {
    if (n > bestCount) { bestCount = n; best = type }
  }
  return best
}

/** 封面图 → 引擎媒体层（取色/铺底）。fetch 经本地代理 /api/cover，same-origin 无跨域问题。 */
async function addCoverToEngine(engine: PVEngine, coverUrl: string): Promise<void> {
  try {
    const res = await fetch(coverUrl)
    if (!res.ok) return
    const blob = await res.blob()
    const file = new File([blob], 'cover', { type: blob.type || 'image/jpeg' })
    await engine.addMedia(file, 'fit')
  } catch {
    // 封面加载失败静默降级为模板自带背景
  }
}

/** 默认导出组件本体：App.tsx 用 lazy(() => import('.../PvLyricsPage')) 直接消费（与 Folia/看歌一致） */
export default PvLyricsPage