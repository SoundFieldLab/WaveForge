/**
 * soundtouchjs 最小类型声明（LGPL-2.1，未修改，仅描述本工程调用到的公开 API 面）
 * 完整类型可参考 npm 包内源码；本声明只覆盖 StretchLgplAdapter 用到的成员。
 */
declare module 'soundtouchjs' {
  export interface SoundTouchBuffer {
    frameCount: number
    putSamples(samples: Float32Array, position: number, numFrames: number): void
    receiveSamples(output: Float32Array, numFrames: number): void
    clear(): void
  }
  export class SoundTouch {
    tempo: number
    pitch: number
    process(): void
    clear(): void
    inputBuffer: SoundTouchBuffer
    outputBuffer: SoundTouchBuffer
  }
}
