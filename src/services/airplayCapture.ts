// AirPlay 投送音频采集：从播放引擎的 master gain 处旁路采集交错 f32 PCM，
// 经 AudioWorklet 传回主线程。挂点在 masterGain 之后，因此 gapless / AutoMix /
// 音效链的最终混音都能被采集到。

const WORKLET_NAME = 'waveforge-airplay-capture'

const WORKLET_SOURCE = `
class WaveforgeAirplayCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this._block = new Float32Array(4096)
    this._writeOffset = 0
  }
  process(inputs) {
    const input = inputs[0]
    if (!input || input.length === 0 || !input[0] || input[0].length === 0) return true
    const channels = Math.min(2, input.length)
    const frames = input[0].length
    // 固定块内直接交错写入，避免每个 128 帧渲染量子分配并拼接 TypedArray。
    for (let i = 0; i < frames; i += 1) {
      for (let c = 0; c < channels; c += 1) {
        this._block[this._writeOffset] = input[c][i]
        this._writeOffset += 1
        if (this._writeOffset === this._block.length) {
          const chunk = this._block
          this._block = new Float32Array(4096)
          this._writeOffset = 0
          this.port.postMessage(chunk.buffer, [chunk.buffer])
        }
      }
    }
    return true
  }
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
