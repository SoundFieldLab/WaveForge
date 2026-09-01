/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 */
/**
 * Gapless 首选无缝拼接控制器 —— 专辑场景"头尾都不掐，直接拼接"
 *
 * 从 useAudioPlayer.ts 抽出的独立模块：承载首选拼接的全部业务逻辑
 * （预热缓存、静音预启动、ended 拼接、边界调度、兜底回退）。
 * 原 hook 只保留调用接口（构造时注入依赖，事件处理时调用本控制器方法）。
 *
 * 三方案分流：
 *   第一种（直接拼接）：仅专辑场景，standby 已缓存就绪时，source 完整播到尾、
 *                       standby 从 0 开头直接拼接（无提前淡入淡出）。
 *   第二种（60ms 淡入淡出）：非专辑场景默认；专辑场景 standby 未就绪时兜底。
 *   第三种（albumGapless 交叉淡化）：由 GaplessIntegration 保留实现（本模块不涉及）。
 */

import { debugLog } from '../../utils/debugLog'
import type { TransitionState, TransitionStrategy } from '../../audio/types'
import {
  GAPLESS_SEAMLESS_PREROLL_SECONDS,
  GAPLESS_SEAMLESS_PREROLL_POLL_MS,
  GAPLESS_SEAMLESS_TIMEOUT_MS,
  GAPLESS_SEAMLESS_WARMUP_BUFFER_SECONDS,
  GAPLESS_SEAMLESS_WARMUP_POLL_MS,
  GAPLESS_SEAMLESS_WARMUP_TIMEOUT_MS,
} from './gaplessConstants'

/** 依赖注入：useAudioPlayer 提供播放引擎内部访问器与回调 */
export interface SeamlessJoinDeps {
  getActiveAudio: () => HTMLAudioElement | null
  getStandbyAudio: () => HTMLAudioElement | null
  getStandbyGain: () => GainNode | null
  setDeckGain: (gain: GainNode | null, audio: HTMLAudioElement | null, value: number) => void
  isGaplessEnabled: () => boolean
  isTransitionRunning: () => boolean
  hasActiveTransition: () => boolean
  getRevision: () => number
  commitTransition: (strategy: TransitionStrategy, targetTime: number, revision: number) => void
  /** 回退备选：startTransition('gapless')（60ms 淡入淡出） */
  startGaplessTransition: () => void
  /** 停用 AlbumGapless 外部 deck（首选拼接优先的防御分支） */
  resetGaplessIntegration: () => void
  setTransitionState: (state: TransitionState, extra?: Record<string, unknown>) => void
  /** 边界调度 timer 挂载点（与 crossfade/autoMix 共用 transitionTimerRef） */
  setBoundaryTimer: (timer: number | null) => void
  getBoundaryTimer: () => number | null
}

export interface SeamlessJoinController {
  /** 专辑播放预热：结束前 20s 静音预启动 standby 并缓存前 10s（幂等） */
  warmup: () => void
  /** 边界调度：remaining ≤1s 时的三方案分流（arm 首选 / 备选 timer / 兜底 timer） */
  scheduleBoundary: (ctx: { active: HTMLAudioElement; remaining: number; albumPlayback: boolean }) => void
  /** source ended 时执行首选拼接；返回 true = 已处理（调用方应 return） */
  onEnded: (standby: HTMLAudioElement | null) => boolean
  /** 清除边界调度 timer（handleEnded 竞态兜底） */
  cancelBoundaryTimer: () => void
  /** 预热是否已完成（前 10s 已缓存、回拨 0 停住） */
  isWarmupDone: () => boolean
  /** 重置全部状态（切歌/暂停/seek/卸载时调用） */
  reset: () => void
}

export function createSeamlessJoinController(deps: SeamlessJoinDeps): SeamlessJoinController {
  // ── 内部状态（原 hook 的 refs，改为闭包字段）──
  let armed = false          // 首选拼接已武装（等待 ended 直接拼接）
  let prerolled = false      // standby 已静音预启动
  let boundaryScheduled = false  // 边界调度已挂起（timer 或 ended 竞态互斥）
  let warmupInFlight = false // 预热进行中（防重入）
  let warmupDone = false     // 预热已完成
  let prerollPollTimer: number | null = null   // 预启动窗口监测 timer
  let warmupPollTimer: number | null = null    // 预热缓冲进度轮询 timer
  let generation = 0

  const clearPrerollPoll = () => {
    if (prerollPollTimer !== null) {
      window.clearTimeout(prerollPollTimer)
      prerollPollTimer = null
    }
  }
  const clearWarmupPoll = () => {
    if (warmupPollTimer !== null) {
      window.clearTimeout(warmupPollTimer)
      warmupPollTimer = null
    }
  }

  // ── 专辑播放预热：结束前 20s 强制预启动 standby 并缓存前 10s ──
  const warmup = () => {
    if (!deps.isGaplessEnabled() || warmupInFlight || warmupDone) return
    const activeAudio = deps.getActiveAudio()
    const standbyAudio = deps.getStandbyAudio()
    if (!activeAudio || !standbyAudio || !standbyAudio.src || standbyAudio.error) return
    if (deps.isTransitionRunning()) return
    if (deps.hasActiveTransition()) return
    warmupInFlight = true

    try {
      deps.setDeckGain(deps.getStandbyGain(), standbyAudio, 0)
      standbyAudio.currentTime = 0
      void standbyAudio.play().then(() => {
        // 播放中推进缓冲；每 250ms 查一次前 10s 是否已缓冲
        let pollCount = 0
        const poll = () => {
          if (!warmupInFlight) return  // 已被取消（切歌/暂停/seek）
          pollCount += 1
          const bufferedOk = standbyAudio.buffered.length > 0
            && standbyAudio.buffered.end(standbyAudio.buffered.length - 1) >= GAPLESS_SEAMLESS_WARMUP_BUFFER_SECONDS
          if (bufferedOk || pollCount * GAPLESS_SEAMLESS_WARMUP_POLL_MS >= GAPLESS_SEAMLESS_WARMUP_TIMEOUT_MS) {
            // 缓冲到位（或超时）→ 暂停并回拨 0，结束预热。0 位置已缓冲，
            // 后续首选拼接的 seek(0) 毫秒级完成，无需重新拉取。
            warmupInFlight = false
            warmupDone = true
            warmupPollTimer = null
            try {
              standbyAudio.pause()
              standbyAudio.currentTime = 0
            } catch {
              // 元素可能已被释放
            }
            debugLog(`⚡ [Gapless] 首选预热完成：下一首前 ${GAPLESS_SEAMLESS_WARMUP_BUFFER_SECONDS}s 已缓存 (${pollCount * GAPLESS_SEAMLESS_WARMUP_POLL_MS}ms)`)
            return
          }
          warmupPollTimer = window.setTimeout(poll, GAPLESS_SEAMLESS_WARMUP_POLL_MS)
        }
        warmupPollTimer = window.setTimeout(poll, GAPLESS_SEAMLESS_WARMUP_POLL_MS)
      }).catch(() => {
        // 预启动被拦截/失败：放弃预热，剩余 1s 的判定会走备选淡入淡出
        warmupInFlight = false
        warmupDone = false
      })
    } catch {
      warmupInFlight = false
      warmupDone = false
    }
  }

  // ── 边界调度：remaining ≤1s 时的三方案分流 ──
  const scheduleBoundary = (ctx: { active: HTMLAudioElement; remaining: number; albumPlayback: boolean }) => {
    if (!deps.isGaplessEnabled() || boundaryScheduled || deps.hasActiveTransition()) return
    const { active, remaining, albumPlayback } = ctx
    const scheduledSource = active
    const scheduledStandby = deps.getStandbyAudio()

    const standbySeamlessReady = Boolean(
      // 预热已完成（前 10s 已缓存、回拨 0 停住）即视为就绪；否则按实时缓冲判定
      warmupDone
      || (
        scheduledStandby?.src
        && !scheduledStandby.error
        && scheduledStandby.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA
        && scheduledStandby.buffered.length > 0
        && scheduledStandby.buffered.end(scheduledStandby.buffered.length - 1) >= 0.5
      )
    )

    boundaryScheduled = true

    if (albumPlayback && standbySeamlessReady) {
      // ── 首选：无缝拼接（头尾都不掐）──
      armed = true
      prerolled = false
      debugLog('⚡ [Gapless] 首选：standby 已缓存就绪，source 完整播完后直接拼接下一首开头')

      // 高频监测：source 剩余 PREROLL 秒时静音预启动 standby，
      // 让切换瞬间 play() 已在解码，消除 ended→play 的启动延迟。
      const pollPreroll = () => {
        prerollPollTimer = null
        if (!armed) return
        const liveSource = deps.getActiveAudio()
        if (liveSource !== scheduledSource || liveSource.paused) return  // 已被取消/暂停/切歌
        if (prerolled) return  // 已预启动，停止监测
        const liveRemaining = (liveSource.duration || 0) - liveSource.currentTime
        if (liveRemaining <= GAPLESS_SEAMLESS_PREROLL_SECONDS) {
          prerolled = true
          const standbyAudio = deps.getStandbyAudio()
          try {
            deps.setDeckGain(deps.getStandbyGain(), standbyAudio, 0)
            if (standbyAudio) {
              standbyAudio.currentTime = 0
              void standbyAudio.play().catch(() => {
                // 预启动被拦截/失败：放弃首选，兜底 timer 回退备选
                debugLog('⚠️ [Gapless] 首选预启动失败，等待兜底回退备选')
                armed = false
                prerolled = false
              })
              debugLog('⚡ [Gapless] 首选：standby 静音预启动（对齐解码管线）')
            }
          } catch {
            armed = false
            prerolled = false
          }
          return
        }
        prerollPollTimer = window.setTimeout(pollPreroll, GAPLESS_SEAMLESS_PREROLL_POLL_MS)
      }
      prerollPollTimer = window.setTimeout(pollPreroll, GAPLESS_SEAMLESS_PREROLL_POLL_MS)

      // 兜底：正常情况由 source 的 ended 事件完成拼接；若异常未 ended（解码卡尾），
      // 超时后取消首选回退备选，避免歌曲永远切不过去。
      const fallbackDelayMs = Math.max(0, remaining * 1000) + GAPLESS_SEAMLESS_TIMEOUT_MS
      deps.setBoundaryTimer(window.setTimeout(() => {
        deps.setBoundaryTimer(null)
        boundaryScheduled = false
        if (!armed) return
        debugLog('⚠️ [Gapless] 首选超时未见 ended，回退备选淡入淡出')
        armed = false
        prerolled = false
        if (
          deps.getActiveAudio() === scheduledSource
          && deps.isGaplessEnabled()
          && !deps.isTransitionRunning()
          && deps.getStandbyAudio()?.src
          && !deps.hasActiveTransition()
        ) {
          deps.startGaplessTransition()
        }
      }, fallbackDelayMs))
    } else {
      // ── 第二种方案：60ms 淡入淡出 ──
      // 非专辑场景默认走这里（无需提前缓存）；专辑场景 standby 未就绪时兜底。
      // BUG-A2：不再提前 -12ms 丢弃原曲尾部，delayMs 取 remaining*1000 让原曲完整播完。
      const delayMs = Math.max(0, remaining * 1000)
      deps.setBoundaryTimer(window.setTimeout(() => {
        deps.setBoundaryTimer(null)
        boundaryScheduled = false
        if (
          deps.getActiveAudio() === scheduledSource
          && deps.isGaplessEnabled()
          && !deps.isTransitionRunning()
          && deps.getStandbyAudio()?.src
          && !deps.hasActiveTransition()
        ) {
          debugLog(albumPlayback
            ? '⚡ [Gapless] 第二种方案（专辑 standby 未就绪兜底）：60ms 淡入淡出'
            : '⚡ [Gapless] 第二种方案（非专辑）：60ms 淡入淡出')
          deps.startGaplessTransition()
        }
      }, delayMs))
    }
  }

  // ── source ended：首选拼接（头尾都不掐）──
  const onEnded = (standby: HTMLAudioElement | null): boolean => {
    if (!armed) return false
    armed = false
    prerolled = false
    warmupInFlight = false   // ended 已到，停止预热轮询（幂等）
    warmupDone = true        // 视为完成，无需再预热
    clearPrerollPoll()
    clearWarmupPoll()

    const standbyBufferedOk = Boolean(
      standby?.buffered.length
      && standby.buffered.end(standby.buffered.length - 1) >= 0.5
    )
    if (
      standby?.src
      && !standby.error
      && standbyBufferedOk
      && deps.isGaplessEnabled()
      && !deps.isTransitionRunning()
    ) {
      const joinGeneration = ++generation
      const scheduledStandbySrc = standby.currentSrc || standby.src
      const scheduledSource = deps.getActiveAudio()
      const scheduledRevision = deps.getRevision()
      // 防御：即使 AlbumGapless 意外激活（外部 preload deck 正在混音），首选拼接
      // 仍然优先——先 reset 停掉外部 deck（含其混音/主增益恢复），再接管 managed
      // standby deck 从头播放。专辑场景已由 gaplessIntegration 改为不激活
      // albumGapless，此分支仅作兜底。
      if (deps.hasActiveTransition()) {
        debugLog('⚡ [Gapless] 首选拼接优先：先停用 AlbumGapless 外部 deck')
        deps.resetGaplessIntegration()
      }
      debugLog('⚡ [Gapless] 首选拼接：source 完整播完，standby 无缝接上（从头开始）')
      void (async () => {
        try {
          deps.setDeckGain(deps.getStandbyGain(), standby, 0)
          if (standby.paused) {
            await standby.play().catch(() => { throw new Error('standby play failed') })
          }
          standby.currentTime = 0
          await waitForSeek(standby)
          if (standby.paused) return  // 拼接前被并发操作暂停，放弃
          if (joinGeneration !== generation
            || deps.getRevision() !== scheduledRevision
            || deps.getActiveAudio() !== scheduledSource
            || deps.getStandbyAudio() !== standby
            || (standby.currentSrc || standby.src) !== scheduledStandbySrc
            || !deps.isGaplessEnabled()
            || deps.isTransitionRunning()) return
          // 复用 commitTransition：先置 running-transition 通过状态校验，
          // 由它完成增益切换/翻转/transitionCommit（React 18 自动批处理，
          // 两次状态更新合并为一次渲染，无过渡动画闪烁）。
          deps.setTransitionState('running-transition', {
            transitioning: true,
            seamlessTransition: true,
            transitionStrategy: 'gapless',
          })
          deps.commitTransition('gapless', standby.currentTime, deps.getRevision())
        } catch (error) {
          console.warn('⚠️ [Gapless] 首选拼接失败，回退备选淡入淡出:', error)
          deps.startGaplessTransition()
        }
      })()
      return true
    }
    // 预启动未成功/standby 不可用：调用方走备选/普通分支
    return false
  }

  const cancelBoundaryTimer = () => {
    const timer = deps.getBoundaryTimer()
    if (timer !== null) {
      window.clearTimeout(timer)
      deps.setBoundaryTimer(null)
    }
    boundaryScheduled = false
  }

  const reset = () => {
    generation += 1
    armed = false
    prerolled = false
    warmupInFlight = false
    warmupDone = false
    clearPrerollPoll()
    clearWarmupPoll()
  }

  return {
    warmup,
    scheduleBoundary,
    onEnded,
    cancelBoundaryTimer,
    isWarmupDone: () => warmupDone,
    reset,
  }
}

/** 对齐播放位置（0 位置已缓冲时 seek 毫秒级完成） */
function waitForSeek(audio: HTMLAudioElement, timeoutMs = 120): Promise<void> {
  if (!audio.seeking) return Promise.resolve()
  return new Promise(resolve => {
    let timeoutId = 0
    const finish = () => {
      audio.removeEventListener('seeked', finish)
      if (timeoutId) window.clearTimeout(timeoutId)
      resolve()
    }
    audio.addEventListener('seeked', finish, { once: true })
    timeoutId = window.setTimeout(finish, timeoutMs)
  })
}
