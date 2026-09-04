import { afterEach, describe, expect, it, vi } from 'vitest'
import { startAirplayCapture } from '../src/services/airplayCapture'

const originalAudioWorkletNode = globalThis.AudioWorkletNode
const originalCreateObjectUrl = URL.createObjectURL
const originalRevokeObjectUrl = URL.revokeObjectURL

afterEach(() => {
  vi.restoreAllMocks()
  globalThis.AudioWorkletNode = originalAudioWorkletNode
  URL.createObjectURL = originalCreateObjectUrl
  URL.revokeObjectURL = originalRevokeObjectUrl
})

describe('AirPlay capture worklet', () => {
  it('复用固定块收集 128 帧量子并保持立体声交错顺序', async () => {
    let moduleBlob: Blob | undefined
    URL.createObjectURL = vi.fn((blob: Blob | MediaSource) => {
      moduleBlob = blob as Blob
      return 'blob:airplay-capture-test'
    })
    URL.revokeObjectURL = vi.fn()

    class FakeAudioWorkletNode {
      port = { onmessage: null, close: vi.fn() }
      disconnect = vi.fn()
    }
    globalThis.AudioWorkletNode = FakeAudioWorkletNode as unknown as typeof AudioWorkletNode

    const context = {
      sampleRate: 48000,
      audioWorklet: { addModule: vi.fn(async () => undefined) },
    } as unknown as AudioContext
    const sourceNode = { connect: vi.fn() } as unknown as AudioNode
    const handle = await startAirplayCapture(context, sourceNode, vi.fn())
    expect(moduleBlob).toBeDefined()

    const source = await moduleBlob!.text()
    expect(source).not.toContain('concat(')
    expect(source).not.toContain('const interleaved = new Float32Array')

    let Processor: new () => {
      port: { postMessage: (buffer: ArrayBuffer, transfer: ArrayBuffer[]) => void }
      process: (inputs: Float32Array[][]) => boolean
    }
    const posted: Array<{ buffer: ArrayBuffer, transfer: ArrayBuffer[] }> = []
    class FakeAudioWorkletProcessor {
      port = {
        postMessage: (buffer: ArrayBuffer, transfer: ArrayBuffer[]) => posted.push({ buffer, transfer }),
      }
    }
    const registerProcessor = (_name: string, ctor: typeof Processor) => { Processor = ctor }
    Function('AudioWorkletProcessor', 'registerProcessor', source)(FakeAudioWorkletProcessor, registerProcessor)
    const processor = new Processor!()

    for (let quantum = 0; quantum < 16; quantum += 1) {
      const left = new Float32Array(128)
      const right = new Float32Array(128)
      for (let frame = 0; frame < 128; frame += 1) {
        const globalFrame = quantum * 128 + frame
        left[frame] = globalFrame
        right[frame] = -globalFrame
      }
      expect(processor.process([[left, right]])).toBe(true)
    }

    expect(posted).toHaveLength(1)
    expect(posted[0].transfer).toEqual([posted[0].buffer])
    const chunk = new Float32Array(posted[0].buffer)
    expect(chunk).toHaveLength(4096)
    expect(Array.from(chunk.slice(0, 6))).toEqual([0, -0, 1, -1, 2, -2])
    expect(Array.from(chunk.slice(-4))).toEqual([2046, -2046, 2047, -2047])

    handle.stop()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:airplay-capture-test')
  })
})
