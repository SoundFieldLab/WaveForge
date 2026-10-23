import { Pcm16Quantizer } from './PcmQuantizer'
import type { QuantizationMode } from './PcmQuantizer'

/** 交错双声道 16-bit PCM WAV；每声道独立量化状态，避免噪声整形跨声道串扰。 */
export function encodePcm16Wav(channels: readonly Float32Array[], sampleRate: number, mode: QuantizationMode = 'tpdf'): Uint8Array {
  if (channels.length < 1 || channels.length > 2) throw new Error('WAV 仅支持单/双声道')
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 384000) throw new Error('invalid sample rate')
  const frames = channels[0].length
  if (channels.some((channel) => channel.length !== frames)) throw new Error('WAV 声道长度不一致')
  const dataBytes = frames * channels.length * 2
  if (dataBytes > 0xffffffff - 36) throw new Error('WAV 超过 RIFF 32-bit 大小限制')
  const bytes = new Uint8Array(44 + dataBytes)
  const view = new DataView(bytes.buffer)
  const ascii = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i)
  }
  ascii(0, 'RIFF')
  view.setUint32(4, bytes.length - 8, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels.length, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channels.length * 2, true)
  view.setUint16(32, channels.length * 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, dataBytes, true)
  const quantizers = channels.map((_, index) => new Pcm16Quantizer(mode, index === 0 ? 0x12345678 : 0x87654321))
  let offset = 44
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channels.length; channel++) {
      view.setInt16(offset, quantizers[channel].process(channels[channel][frame]), true)
      offset += 2
    }
  }
  return bytes
}
