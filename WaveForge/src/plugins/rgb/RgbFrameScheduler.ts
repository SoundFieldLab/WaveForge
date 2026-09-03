export type RgbFrameSink<Frame> = (frame: Frame) => void | Promise<void>

export interface RgbSchedulerTimers {
  now: () => number
  setTimeout: (callback: () => void, delayMs: number) => unknown
  clearTimeout: (handle: unknown) => void
}

export interface RgbFrameSchedulerOptions<Frame> {
  fps: number
  createFrame: (scheduledAtMs: number, generation: number) => Frame
  sink: RgbFrameSink<Frame>
  timers?: Partial<RgbSchedulerTimers>
  onError?: (error: unknown) => void
}

const systemTimers: RgbSchedulerTimers = {
  now: () => performance.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export class RgbFrameScheduler<Frame> {
  private readonly frameIntervalMs: number
  private readonly createFrame: RgbFrameSchedulerOptions<Frame>['createFrame']
  private readonly sink: RgbFrameSink<Frame>
  private readonly timers: RgbSchedulerTimers
  private readonly onError: (error: unknown) => void
  private generationValue = 0
  private running = false
  private timer: unknown = null
  private nextFrameAtMs = 0
  private inFlight = false
  private pending: { frame: Frame; generation: number } | null = null

  constructor(options: RgbFrameSchedulerOptions<Frame>) {
    if (!Number.isFinite(options.fps) || options.fps <= 0) throw new RangeError('fps must be positive')
    this.frameIntervalMs = 1000 / options.fps
    this.createFrame = options.createFrame
    this.sink = options.sink
    this.timers = { ...systemTimers, ...options.timers }
    this.onError = options.onError ?? (() => undefined)
  }

  get generation(): number {
    return this.generationValue
  }

  get isRunning(): boolean {
    return this.running
  }

  start(): number {
    if (this.running) return this.generationValue
    this.running = true
    const generation = ++this.generationValue
    this.nextFrameAtMs = this.timers.now()
    this.schedule(generation)
    return generation
  }

  stop(): void {
    this.running = false
    this.generationValue += 1
    this.pending = null
    if (this.timer !== null) {
      this.timers.clearTimeout(this.timer)
      this.timer = null
    }
  }

  private schedule(generation: number): void {
    if (!this.running || generation !== this.generationValue) return
    const delay = Math.max(0, this.nextFrameAtMs - this.timers.now())
    this.timer = this.timers.setTimeout(() => this.tick(generation), delay)
  }

  private tick(generation: number): void {
    this.timer = null
    if (!this.running || generation !== this.generationValue) return

    const now = this.timers.now()
    if (now + 1e-6 < this.nextFrameAtMs) {
      this.schedule(generation)
      return
    }

    const scheduledAtMs = this.nextFrameAtMs
    const elapsedIntervals = Math.max(1, Math.floor((now - this.nextFrameAtMs) / this.frameIntervalMs) + 1)
    this.nextFrameAtMs += elapsedIntervals * this.frameIntervalMs
    this.enqueue(this.createFrame(scheduledAtMs, generation), generation)
    this.schedule(generation)
  }

  private enqueue(frame: Frame, generation: number): void {
    if (this.inFlight) {
      this.pending = { frame, generation }
      return
    }
    this.deliver(frame, generation)
  }

  private deliver(frame: Frame, generation: number): void {
    if (!this.running || generation !== this.generationValue) return
    this.inFlight = true
    Promise.resolve()
      .then(() => this.sink(frame))
      .catch(error => {
        if (generation === this.generationValue) this.onError(error)
      })
      .finally(() => {
        this.inFlight = false
        const next = this.pending
        this.pending = null
        if (next && this.running && next.generation === this.generationValue) {
          this.deliver(next.frame, next.generation)
        }
      })
  }
}
