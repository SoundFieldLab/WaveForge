export interface AudioFeatureFrame {
  /** Monotonic capture time in milliseconds. */
  timestampMs: number
  /** Elapsed time represented by this frame, in seconds. */
  dt: number
  /** Power values for the canonical 24 logarithmic bands. */
  bands: readonly number[]
  rms: number
  peak: number
  beat: number
  silent: boolean
}

export type RgbTransportPhase = 'idle' | 'starting' | 'running' | 'stopping' | 'error'

export interface RgbTransportState {
  phase: RgbTransportPhase
  connected: boolean
  generation: number
  fps: number
  lastFrameAtMs: number | null
  framesSent: number
  framesDropped: number
  error: string | null
}

export interface RgbColor {
  r: number
  g: number
  b: number
}

export interface RgbPreviewFrame {
  timestampMs: number
  colors: readonly RgbColor[]
}

export const EMPTY_RGB_TRANSPORT_STATE: Readonly<RgbTransportState> = Object.freeze({
  phase: 'idle',
  connected: false,
  generation: 0,
  fps: 0,
  lastFrameAtMs: null,
  framesSent: 0,
  framesDropped: 0,
  error: null,
})
