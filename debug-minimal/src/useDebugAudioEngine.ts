/**
 * 调试平台的音频接入：把 <audio> 元素接到与主程序**同一套**分析管线。
 *
 * 关键：分析器参数、L/R 拆分方式与 src/hooks/useAudioPlayer.ts 的音频图保持一致，
 * 否则调试平台测出的波形强弱与主程序不可比（例如 smoothing/fftSize 不同会改变
 * beat 检测灵敏度与立体声分离度）。这里逐项对齐：
 *   fftSize=1024，minDecibels=-90，maxDecibels=-8，smoothingTimeConstant=0.58
 *   master → analyser（体感强度来源）；master → ChannelSplitter → L/R analyser（声像来源）
 *
 * 与主程序的差别只在「谁提供音频」：主程序是网易云/本地文件，这里是测试曲目。
 * 因此测的是真实映射逻辑，不是简化桩。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAudioAnalyzer } from '@/hooks/useAudioAnalyzer'
import {
  setGlobalAudioAnalyzerStore,
  setGlobalAudioAnalysers,
  setGlobalPlaybackActive,
} from '@/plugins/clients/DGLabClient'

export interface AudioGraphNodes {
  context: AudioContext
  analyser: AnalyserNode
  leftAnalyser: AnalyserNode
  rightAnalyser: AnalyserNode
  masterGain: GainNode
  outputGain: GainNode
}

export interface AudioEngineState {
  ready: boolean
  playing: boolean
  currentTime: number
  duration: number
  error: string | null
}

export function useDebugAudioEngine(audioRef: React.RefObject<HTMLAudioElement | null>) {
  const [nodes, setNodes] = useState<AudioGraphNodes | null>(null)
  const [state, setState] = useState<AudioEngineState>({
    ready: false, playing: false, currentTime: 0, duration: 0, error: null,
  })
  const nodesRef = useRef<AudioGraphNodes | null>(null)
  /** 分析流开关：跟随「播放且插件需要」——暂停时不必空转 rAF。 */
  const [analyzerEnabled, setAnalyzerEnabled] = useState(false)

  /** 建立音频图（幂等；需在用户手势后调用以解除 AudioContext 挂起）。 */
  const ensureGraph = useCallback(async (): Promise<AudioGraphNodes | null> => {
    if (nodesRef.current) {
      if (nodesRef.current.context.state === 'suspended') {
        await nodesRef.current.context.resume().catch(() => undefined)
      }
      return nodesRef.current
    }
    const el = audioRef.current
    if (!el) return null
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) {
      setState(s => ({ ...s, error: '当前环境不支持 Web Audio' }))
      return null
    }
    try {
      const context = new Ctor()
      const master = context.createGain()
      const analyser = context.createAnalyser()
      analyser.fftSize = 1024
      analyser.minDecibels = -90
      analyser.maxDecibels = -8
      analyser.smoothingTimeConstant = 0.58

      const outputGain = context.createGain()
      outputGain.gain.value = 1

      // 元素 → master → analyser → output → 扬声器（必须接通，否则 MediaElement 不再出声）
      const source = context.createMediaElementSource(el)
      source.connect(master)
      master.connect(analyser)
      analyser.connect(outputGain)
      outputGain.connect(context.destination)

      // 立体声拆分：从 master 直接取左右声道（与主程序一致）
      const splitter = context.createChannelSplitter(2)
      const leftAnalyser = context.createAnalyser()
      const rightAnalyser = context.createAnalyser()
      for (const node of [leftAnalyser, rightAnalyser]) {
        node.fftSize = 1024
        node.minDecibels = -90
        node.maxDecibels = -8
        node.smoothingTimeConstant = 0.58
      }
      // 分析器必须参与渲染才会更新；经零增益旁路到 destination（只分析不发声）
      const silentL = context.createGain()
      const silentR = context.createGain()
      silentL.gain.value = 0
      silentR.gain.value = 0
      master.connect(splitter)
      splitter.connect(leftAnalyser, 0)
      splitter.connect(rightAnalyser, 1)
      leftAnalyser.connect(silentL).connect(context.destination)
      rightAnalyser.connect(silentR).connect(context.destination)

      if (context.state === 'suspended') await context.resume().catch(() => undefined)

      const graph: AudioGraphNodes = { context, analyser, leftAnalyser, rightAnalyser, masterGain: master, outputGain }
      nodesRef.current = graph
      setNodes(graph)
      setState(s => ({ ...s, ready: true, error: null }))
      return graph
    } catch (error) {
      // 若元素已被别处 createMediaElementSource 过，会抛 InvalidStateError
      setState(s => ({ ...s, error: `音频图建立失败：${error instanceof Error ? error.message : String(error)}` }))
      return null
    }
  }, [audioRef])

  // 与主程序一致：注册全局 store / L-R 分析器 / 播放状态，供 DG-LAB 客户端消费
  const analyzer = useAudioAnalyzer(
    nodes?.analyser ?? null,
    analyzerEnabled,
    nodes?.leftAnalyser ?? null,
    nodes?.rightAnalyser ?? null,
  )

  useEffect(() => {
    setGlobalAudioAnalyzerStore(analyzer)
  }, [analyzer])

  useEffect(() => {
    setGlobalAudioAnalysers(nodes?.leftAnalyser ?? null, nodes?.rightAnalyser ?? null)
    // 调试：把音频图挂到 window，便于在 DevTools 里直接查 AudioContext 状态
    // （「音乐在播但分析器全 0」最常见的原因就是 context 处于 suspended）。
    ;(window as unknown as { __dglabAudioNodes?: AudioGraphNodes | null }).__dglabAudioNodes = nodes
  }, [nodes])

  useEffect(() => {
    setGlobalPlaybackActive(state.playing)
  }, [state.playing])

  /** 音量（调试用；不影响分析链——分析取 master 之后、outputGain 之前…… */
  /** 注意：analyser 在 outputGain 之前，改音量不会改变送进插件的数据。 */
  const setVolume = useCallback((value: number) => {
    const graph = nodesRef.current
    if (!graph) return
    graph.outputGain.gain.value = Math.max(0, Math.min(1, value))
  }, [])

  const play = useCallback(async () => {
    const el = audioRef.current
    if (!el) return
    const graph = await ensureGraph()
    if (!graph) return
    setAnalyzerEnabled(true)
    try {
      await el.play()
    } catch (error) {
      setState(s => ({ ...s, error: `播放失败：${error instanceof Error ? error.message : String(error)}` }))
    }
  }, [audioRef, ensureGraph])

  const pause = useCallback(() => {
    const el = audioRef.current
    if (!el) return
    el.pause()
  }, [audioRef])

  // 播放状态 / 进度同步
  useEffect(() => {
    const el = audioRef.current
    if (!el) return
    const onPlay = () => setState(s => ({ ...s, playing: true }))
    const onPause = () => setState(s => ({ ...s, playing: false }))
    const onEnded = () => setState(s => ({ ...s, playing: false }))
    const onTime = () => setState(s => ({ ...s, currentTime: el.currentTime }))
    const onMeta = () => setState(s => ({ ...s, duration: Number.isFinite(el.duration) ? el.duration : 0 }))
    const onError = () => setState(s => ({ ...s, error: `音频加载失败（${el.error?.code ?? '?'}）` }))
    el.addEventListener('play', onPlay)
    el.addEventListener('pause', onPause)
    el.addEventListener('ended', onEnded)
    el.addEventListener('timeupdate', onTime)
    el.addEventListener('loadedmetadata', onMeta)
    el.addEventListener('durationchange', onMeta)
    el.addEventListener('error', onError)
    return () => {
      el.removeEventListener('play', onPlay)
      el.removeEventListener('pause', onPause)
      el.removeEventListener('ended', onEnded)
      el.removeEventListener('timeupdate', onTime)
      el.removeEventListener('loadedmetadata', onMeta)
      el.removeEventListener('durationchange', onMeta)
      el.removeEventListener('error', onError)
    }
  }, [audioRef])

  // 卸载时释放 AudioContext，避免调试页反复 HMR 攒一堆上下文
  useEffect(() => () => {
    const graph = nodesRef.current
    nodesRef.current = null
    setGlobalAudioAnalyzerStore(null)
    setGlobalAudioAnalysers(null, null)
    if (graph && graph.context.state !== 'closed') void graph.context.close().catch(() => undefined)
  }, [])

  const seek = useCallback((time: number) => {
    const el = audioRef.current
    if (!el) return
    el.currentTime = Math.max(0, time)
  }, [audioRef])

  return useMemo(() => ({
    nodes,
    state,
    analyzer,
    ensureGraph,
    play,
    pause,
    seek,
    setVolume,
    /** 播放中：主程序此时才推送真实频谱（暂停推零帧）。 */
    analyzerEnabled,
  }), [nodes, state, analyzer, ensureGraph, play, pause, seek, setVolume, analyzerEnabled])
}
