/**
 * 学歌插件 · 麦克风实时音高追踪。
 *
 * 链路：getUserMedia → MediaStreamSource → 高通（去低频隆隆声）→
 *       ScriptProcessor（128 帧回调攒 2048 窗）→ 主线程 YIN 检测。
 *
 * 为什么用 ScriptProcessor 而不是 AudioWorklet：学歌面板是按需启停的弹窗功能，
 * 每次开启都要新建/销毁 AudioContext；ScriptProcessor 免去 worklet 模块加载
 * 与线程开销，46ms 窗 + ~90ms 步进的主线程负载可忽略，且失败路径更简单
 * （引擎 v3 worklet 是常驻全链路场景，两者场景不同）。
 *
 * 主线程只做 YIN 检测（pitch.ts 纯函数），检测结果经回调上抛：
 *   { time, frequency, rms, voiced }
 */

import { detectPitchYin } from './pitch'

export interface PitchSample {
  /** 采样发生时的墙钟时刻（performance.now()，ms）。 */
  at: number
  /** 检测到的音高（Hz）；无效帧为 null。 */
  frequency: number | null
  /** 帧均方根（0..1），用于能量显示与发声判定。 */
  rms: number
}

const WINDOW_SIZE = 2048
/** 高通截止：去掉手持/环境低频（<60Hz），人声基频 75Hz 以上不受影响。 */
const HIGH_PASS_HZ = 60

export class MicPitchTracker {
  private stream: MediaStream | null = null
  private context: AudioContext | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private highPass: BiquadFilterNode | null = null
  private processor: ScriptProcessorNode | null = null
  private silentGain: GainNode | null = null
  private buffer: Float32Array = new Float32Array(WINDOW_SIZE)
  private bufferFill = 0
  private running = false

  /** 每个 2048 窗的检测结果回调。 */
  onSample: ((sample: PitchSample) => void) | null = null
  /** 用户按发声帧计算的能量包络回调（每窗一次，值 0..1）。 */
  onLevel: ((level: number) => void) | null = null

  get isRunning(): boolean {
    return this.running
  }

  async start(deviceId?: string): Promise<void> {
    if (this.running) return
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // 指定麦克风（用户在学歌设置里选的设备；空 = 系统默认）
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        // 关自动增益与降噪：会破坏音高检测的连续性（AGC 压缩让人声忽大忽小，
        // 降噪把拖长的尾音切掉），唱卡拉OK场景要的就是"原样"输入。
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    })
    this.stream = stream
    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const context = new AudioContextClass()
    this.context = context
    this.source = context.createMediaStreamSource(stream)

    // 高通去隆隆声（60Hz 二阶），避免环境振动干扰 YIN
    const highPass = context.createBiquadFilter()
    highPass.type = 'highpass'
    highPass.frequency.value = HIGH_PASS_HZ
    highPass.Q.value = 0.707
    this.highPass = highPass

    const processor = context.createScriptProcessor(1024, 1, 1)
    this.processor = processor
    processor.onaudioprocess = (event) => {
      if (!this.running) return
      const input = event.inputBuffer.getChannelData(0)
      this.accumulate(input, context.sampleRate)
    }

    // ScriptProcessor 必须连到 destination 才会驱动回调；经零增益静音输出
    const silentGain = context.createGain()
    silentGain.gain.value = 0
    this.silentGain = silentGain

    this.source.connect(highPass)
    highPass.connect(processor)
    processor.connect(silentGain)
    silentGain.connect(context.destination)

    if (context.state === 'suspended') await context.resume()
    this.running = true
  }

  /** 1024 块累积进 2048 滑窗；攒满即检测并按 50% 重叠滑动。 */
  private accumulate(input: Float32Array, sampleRate: number) {
    let offset = 0
    while (offset < input.length) {
      const take = Math.min(input.length - offset, WINDOW_SIZE - this.bufferFill)
      this.buffer.set(input.subarray(offset, offset + take), this.bufferFill)
      this.bufferFill += take
      offset += take
      if (this.bufferFill === WINDOW_SIZE) {
        this.emitWindow(sampleRate)
        // 滑窗：保留后半窗，下一块接着填（50% 重叠 → 约 23ms 步进）
        this.buffer.copyWithin(0, WINDOW_SIZE / 2)
        this.bufferFill = WINDOW_SIZE / 2
      }
    }
  }

  private emitWindow(sampleRate: number) {
    let energy = 0
    for (let i = 0; i < WINDOW_SIZE; i += 1) energy += this.buffer[i] * this.buffer[i]
    const rms = Math.sqrt(energy / WINDOW_SIZE)
    this.onLevel?.(Math.min(1, rms * 8))
    const frequency = detectPitchYin(this.buffer, sampleRate)
    this.onSample?.({ at: performance.now(), frequency, rms })
  }

  async stop(): Promise<void> {
    this.running = false
    try { this.processor && (this.processor.onaudioprocess = null) } catch { /* ignore */ }
    try { this.source?.disconnect() } catch { /* ignore */ }
    try { this.highPass?.disconnect() } catch { /* ignore */ }
    try { this.processor?.disconnect() } catch { /* ignore */ }
    try { this.silentGain?.disconnect() } catch { /* ignore */ }
    try { await this.context?.close() } catch { /* ignore */ }
    this.stream?.getTracks().forEach(track => track.stop())
    this.stream = null
    this.context = null
    this.source = null
    this.highPass = null
    this.processor = null
    this.silentGain = null
    this.bufferFill = 0
  }
}
