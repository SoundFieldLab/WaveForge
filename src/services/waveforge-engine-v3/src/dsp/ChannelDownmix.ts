import type { AudioBuffer } from './audioBuffer'

/** 四声道为 L/R/SL/SR；5.1/7.1 为 L/R/C/LFE/SL/SR[/BL/BR]。 */
export function downmixToStereo(channels: readonly Float32Array[], left: AudioBuffer, right: AudioBuffer,
  sourceOffset = 0, frameCount = Math.min(left.length, right.length)): void {
  const frontL = channels[0], frontR = channels[1]
  const count = Math.min(frameCount, left.length, right.length)
  if (channels.length === 4) {
    // Web Audio 四声道到双声道矩阵：同侧前后各取一半，不制造对侧串音。
    for (let i = 0; i < count; i++) {
      const sample = sourceOffset + i
      left[i] = 0.5 * ((frontL?.[sample] ?? 0) + (channels[2]?.[sample] ?? 0))
      right[i] = 0.5 * ((frontR?.[sample] ?? 0) + (channels[3]?.[sample] ?? 0))
    }
    return
  }
  const center = channels[2], lfe = channels[3]
  const surroundL = channels[4], surroundR = channels[5]
  const backL = channels[6], backR = channels[7]
  for (let i = 0; i < count; i++) {
    const sample = sourceOffset + i
    const common = (center?.[sample] ?? 0) * Math.SQRT1_2 + (lfe?.[sample] ?? 0) * 0.25
    const heightL = ((channels[8]?.[sample] ?? 0) + (channels[10]?.[sample] ?? 0)) * 0.5
    const heightR = ((channels[9]?.[sample] ?? 0) + (channels[11]?.[sample] ?? 0)) * 0.5
    left[i] = (frontL?.[sample] ?? 0) + common + (surroundL?.[sample] ?? 0) * Math.SQRT1_2 + (backL?.[sample] ?? 0) * 0.5 + heightL
    right[i] = (frontR?.[sample] ?? 0) + common + (surroundR?.[sample] ?? 0) * Math.SQRT1_2 + (backR?.[sample] ?? 0) * 0.5 + heightR
  }
}
