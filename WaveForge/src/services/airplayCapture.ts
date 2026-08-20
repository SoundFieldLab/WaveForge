// AirPlay 投送音频采集：从播放引擎的 master gain 处旁路采集交错 f32 PCM，
// 经 AudioWorklet 传回主线程。挂点在 masterGain 之后，因此 gapless / AutoMix /
// 音效链的最终混音都能被采集到。

const WORKLET_NAME = 'waveforge-airplay-capture'

const WORKLET_SOURCE = `
class WaveforgeAirplayCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this._pending = new Float32Array(0)
  }
  process(inputs) {
    const input = inputs[0]
    if (!input || input.length === 0 || !input[0] || input[0].length === 0) return true
    const channels = Math.min(2, input.length)
    const frames = input[0].length
    const interleaved = new Float32Array(frames * channels)
    for (let c = 0; c < channels; c += 1) {
      const src = input[c]
      for (let i = 0; i < frames; i += 1) interleaved[i * channels + c] = src[i]
    }
    // 满 4096 帧（≈93ms@44.1k）发一块，控制 IPC 频率
    this._pending = concat(this._pending, interleaved)
    const BLOCK = 4096
    while (this._pending.length >= BLOCK) {
      const chunk = this._pending.slice(0, BLOCK)
      this._pending = this._pending.slice(BLOCK)
      this.port.postMessage(chunk.buffer, [chunk.buffer])
    }
    return true
  }
}
function concat(a, b) {
  const out = new Float32Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}
registerProcessor('${WORKLET_NAME}', WaveforgeAirplayCapture)
`

export interface AirplayCaptureHandle {
  stop: () => void
}

/**
 * 从音频图采集音频（sourceNode 可为 GainNode/AnalyserNode 等输出节点）。
 * onChunk 收到交错 f32 块（块长固定 4096 帧）。返回句柄用于停止采集。
 */
export async function startAirplayCapture(
  context: AudioContext,
  sourceNode: AudioNode,
  onChunk: (chunk: Float32Array, sampleRate: number) => void,
): Promise<AirplayCaptureHandle> {
  let node: AudioWorkletNode | null = null
  let url = ''
  try {
    const blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' })
    url = URL.createObjectURL(blob)
    await context.audioWorklet.addModule(url)
    node = new AudioWorkletNode(context, WORKLET_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    })
    node.port.onmessage = (event: MessageEvent) => {
      if (!event.data) return
      const f32 = new Float32Array(event.data)
      onChunk(f32, context.sampleRate)
    }
    sourceNode.connect(node)
  } catch (error) {
    if (url) URL.revokeObjectURL(url)
    throw error
  }

  return {
    stop: () => {
      try {
        if (node) {
          node.port.onmessage = null
          node.disconnect()
          node.port.close()
        }
      } catch { /* 忽略 */ }
      if (url) URL.revokeObjectURL(url)
      node = null
    },
  }
}
