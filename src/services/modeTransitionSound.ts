/**
 * 模式切换转场音效（WebAudio 实时合成，零音频资源文件）
 *
 * Steam 大屏幕风格的「嗖 — 嗡」质感：
 *   底层 = 粉噪 + 带通滤波器扫频（whoosh，气流滑升）
 *   个体 = 每个模式叠一层专属音色（见 MODE_SOUND_RECIPES）：
 *     explore    探索：星海上升音 + 高频闪烁（正弦滑升 + 短泛音点缀）
 *     minimal    简约：暖意双音垫（大三度，慢起音，柔和不抢戏）
 *     traditional 传统：五度拨弦（三角波短衰减，类古筝/马林巴质感）
 *     desktop    桌面：科技双音 blip（轻微失谐正弦，干净利落）
 *     resonance  共振：和弦涌动（增三和弦慢起音，房间"开灯"感）
 *
 * 全部音量压得很低（峰值 ≈ -18dB），只在复杂转场时播放；
 * AudioContext 懒创建 + 播放前 resume（浏览器自动播放策略下首次点击后才出声）。
 */

export type TransitionSoundMode = 'explore' | 'minimal' | 'traditional' | 'desktop' | 'resonance' | 'singalong'

interface SoundRecipe {
  /** whoosh 起止频率（带通中心滑频，Hz） */
  sweep: [number, number]
  /** whoosh 时长（秒） */
  sweepDur: number
  /** 个体音色：频率（Hz）+ 类型 + 起止时间（秒）+ 包络 */
  tones: Array<{ freq: number; type: OscillatorType; at: number; dur: number; gain: number; glideTo?: number }>
  /** 个体音色总体电平 */
  level: number
}

const MODE_SOUND_RECIPES: Record<TransitionSoundMode, SoundRecipe> = {
  explore: {
    sweep: [280, 1500],
    sweepDur: 0.9,
    tones: [
      { freq: 392, type: 'sine', at: 0.12, dur: 0.9, gain: 0.5, glideTo: 784 },
      { freq: 1175, type: 'sine', at: 0.55, dur: 0.45, gain: 0.16 },
      { freq: 1568, type: 'sine', at: 0.75, dur: 0.5, gain: 0.1 },
    ],
    level: 0.9,
  },
  minimal: {
    sweep: [220, 620],
    sweepDur: 0.8,
    tones: [
      { freq: 523.25, type: 'sine', at: 0.2, dur: 1.1, gain: 0.34 },
      { freq: 659.25, type: 'sine', at: 0.32, dur: 1.0, gain: 0.24 },
    ],
    level: 0.85,
  },
  traditional: {
    sweep: [300, 900],
    sweepDur: 0.75,
    tones: [
      { freq: 392, type: 'triangle', at: 0.3, dur: 0.7, gain: 0.5 },
      { freq: 587.33, type: 'triangle', at: 0.42, dur: 0.75, gain: 0.36 },
      { freq: 784, type: 'triangle', at: 0.56, dur: 0.8, gain: 0.2 },
    ],
    level: 0.9,
  },
  desktop: {
    sweep: [340, 1100],
    sweepDur: 0.7,
    tones: [
      { freq: 659.25, type: 'sine', at: 0.18, dur: 0.3, gain: 0.4 },
      { freq: 987.77, type: 'sine', at: 0.34, dur: 0.35, gain: 0.3 },
    ],
    level: 0.8,
  },
  resonance: {
    sweep: [180, 700],
    sweepDur: 1.0,
    tones: [
      { freq: 329.63, type: 'sine', at: 0.15, dur: 1.4, gain: 0.3 },
      { freq: 415.3, type: 'sine', at: 0.25, dur: 1.3, gain: 0.24 },
      { freq: 493.88, type: 'sine', at: 0.35, dur: 1.2, gain: 0.18 },
    ],
    level: 0.95,
  },
  // 学歌：Do-Mi-So 上行三音（练声意象）+ 温和的滑频
  singalong: {
    sweep: [240, 820],
    sweepDur: 0.85,
    tones: [
      { freq: 523.25, type: 'sine', at: 0.16, dur: 0.5, gain: 0.3 },
      { freq: 659.25, type: 'sine', at: 0.34, dur: 0.5, gain: 0.28 },
      { freq: 783.99, type: 'sine', at: 0.52, dur: 0.7, gain: 0.26 },
    ],
    level: 0.85,
  },
}

let ctx: AudioContext | null = null
/** 粉噪 buffer 惰性生成一次（1.5s 够所有 whoosh 用） */
let noiseBuffer: AudioBuffer | null = null

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null
  try {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return null
    if (!ctx) ctx = new Ctor()
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined)
    return ctx
  } catch {
    return null
  }
}

function getNoiseBuffer(context: AudioContext): AudioBuffer {
  if (noiseBuffer) return noiseBuffer
  const length = Math.floor(context.sampleRate * 1.5)
  const buffer = context.createBuffer(1, length, context.sampleRate)
  const data = buffer.getChannelData(0)
  // 近似粉噪：白噪过低通累积（Voss 简化版），听感更"气流"
  let b0 = 0, b1 = 0, b2 = 0
  for (let i = 0; i < length; i++) {
    const white = Math.random() * 2 - 1
    b0 = 0.99765 * b0 + white * 0.099
    b1 = 0.963 * b1 + white * 0.2965
    b2 = 0.57 * b2 + white * 1.0526
    data[i] = (b0 + b1 + b2 + white * 0.1848) * 0.16
  }
  noiseBuffer = buffer
  return buffer
}

/**
 * 播放模式切换音效。失败静默（音频是锦上添花，绝不能影响切换流程）。
 */
export function playModeTransitionSound(mode: TransitionSoundMode): void {
  try {
    const context = getCtx()
    if (!context) return
    if (context.state === 'suspended') return // resume 没就绪就跳过这次，不打断切模式
    const recipe = MODE_SOUND_RECIPES[mode]
    const now = context.currentTime + 0.02

    // ── 底层 whoosh：粉噪 + 带通扫频 + 音量包络 ──
    const noise = context.createBufferSource()
    noise.buffer = getNoiseBuffer(context)
    const bandpass = context.createBiquadFilter()
    bandpass.type = 'bandpass'
    bandpass.Q.value = 1.1
    bandpass.frequency.setValueAtTime(recipe.sweep[0], now)
    bandpass.frequency.exponentialRampToValueAtTime(recipe.sweep[1], now + recipe.sweepDur)
    const noiseGain = context.createGain()
    noiseGain.gain.setValueAtTime(0.0001, now)
    noiseGain.gain.exponentialRampToValueAtTime(0.09 * recipe.level, now + recipe.sweepDur * 0.45)
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + recipe.sweepDur + 0.25)
    noise.connect(bandpass).connect(noiseGain).connect(context.destination)
    noise.start(now)
    noise.stop(now + recipe.sweepDur + 0.3)

    // ── 模式专属音色 ──
    for (const tone of recipe.tones) {
      const osc = context.createOscillator()
      osc.type = tone.type
      osc.frequency.setValueAtTime(tone.freq, now + tone.at)
      if (tone.glideTo) osc.frequency.exponentialRampToValueAtTime(tone.glideTo, now + tone.at + tone.dur)
      const gain = context.createGain()
      const peak = tone.gain * 0.055 * recipe.level
      gain.gain.setValueAtTime(0.0001, now + tone.at)
      gain.gain.exponentialRampToValueAtTime(peak, now + tone.at + Math.min(0.18, tone.dur * 0.3))
      gain.gain.exponentialRampToValueAtTime(0.0001, now + tone.at + tone.dur)
      osc.connect(gain).connect(context.destination)
      osc.start(now + tone.at)
      osc.stop(now + tone.at + tone.dur + 0.05)
    }
  } catch {
    // 音频失败不影响切换
  }
}
