import { beatImpact, downbeatImpact } from '../../stores/motionSignals';
import { createBeatFxClockState, findNextBeatFxEvent, stepBeatFxClock, type BeatFxEvent } from './clock';

// WaveForge 移植（对齐上游 services/beatFx/beatFxLive.ts）：
// 全局唯一的节拍时钟——喂入当前曲目的拍点表，由宿主的帧循环每帧推进一步，把
// beatImpact / downbeatImpact 包络写进 stores/motionSignals 的 MotionValue。
// 无 React 状态。
//
// 与上游的差异：
// 1. 上游 tickBeatFx(audioElement, context) 从媒体元素读"听感时间"（扣输出延迟）；
//    WaveForge 的帧循环拿不到统一的 media element（多引擎），新增 tickBeatFxStore：
//    由宿主从 PlaybackTimeStore 快照取 currentTime/isPlaying 步进（WaveForge 的
//    smartBeatSample 同源口径）。tickBeatFx 保留上游签名但退化为 store 版的薄包装。
// 2. 上游 beatFxSource 携带 GPU/CPU beat-this 的来源枚举；我们的来源是本地
//    beat-this Python 服务，'beat-this-cpu' 一个值够用。

export type BeatFxSourceKind = 'beat-this-cpu' | 'beat-this-gpu' | 'drums-cpu' | 'none';

interface BeatFxDebug {
    beats: number;
    downbeats: number;
    lastT: number | null;
    heardT: number | null;
    source: BeatFxSourceKind | 'loading';
    note: string | null;
    trackKey: string | null;
    eventCount: number;
    latencyMs: number;
    beatImpact: number;
    downbeatImpact: number;
}

declare global {
    interface Window {
        __foliaBeatFx?: BeatFxDebug;
    }
}

/** How long a track change keeps the previous track's "ready" while the new one's beats load. */
const READY_HOLD_MS = 1500;

const readDebugFlag = (): boolean => {
    try {
        return typeof localStorage !== 'undefined' && localStorage.getItem('folia.dev.beatFxDebug') === '1';
    } catch {
        return false;
    }
};

const debug: BeatFxDebug | null = (import.meta.env.DEV || readDebugFlag())
    ? {
        beats: 0,
        downbeats: 0,
        lastT: null,
        heardT: null,
        source: 'none',
        note: null,
        trackKey: null,
        eventCount: 0,
        latencyMs: 0,
        beatImpact: 0,
        downbeatImpact: 0,
    }
    : null;
if (debug && typeof window !== 'undefined') window.__foliaBeatFx = debug;

const state = createBeatFxClockState();
let trackKey: string | null = null;
let lastStepAt: number | null = null;
let holdUntil = 0;
let hearing = false;
let heardAt: number | null = null;
const intensities = { beat: 1, downbeat: 1 };
const DEFAULT_BEAT_PERIOD = 0.5;
let beatPeriod = DEFAULT_BEAT_PERIOD;

/** Median gap between consecutive events, or the default for fewer than two. */
export const resolveBeatFxBeatPeriod = (events: readonly BeatFxEvent[]): number => {
    if (events.length < 2) return DEFAULT_BEAT_PERIOD;
    const gaps: number[] = [];
    for (let index = 1; index < events.length; index += 1) gaps.push(events[index].t - events[index - 1].t);
    gaps.sort((a, b) => a - b);
    const median = gaps[gaps.length >> 1];
    return median > 0 ? median : DEFAULT_BEAT_PERIOD;
};
const firedCounts = { beats: 0, downbeats: 0 };

/** The 轻拍 / 重拍 strengths (0..2) the envelopes are scaled by from the next step on. */
export const setBeatFxIntensities = (beat: number, downbeat: number) => {
    intensities.beat = beat;
    intensities.downbeat = downbeat;
};

/** The current 轻拍 / 重拍 strengths; one shared object, read it rather than keep it. */
export const getBeatFxIntensities = (): Readonly<{ beat: number; downbeat: number }> => intensities;

/** The live effects on screen and their strengths. */
let liveEffects: Readonly<Record<string, number>> = {};

/** Sets which beat effects play now and how strongly; a frame asks getBeatEffectStrength for its own. */
export const setBeatFxLiveEffects = (strengths: Readonly<Record<string, number>>) => {
    liveEffects = strengths;
};

/** The strength an effect plays at now, 0..2; 0 while it does not play. */
export const getBeatEffectStrength = (id: string): number => liveEffects[id] ?? 0;

/** Fired beat counts since app start - only ever growing, so a frame loop diffs them. */
export const getBeatFxFiredCounts = (): Readonly<{ beats: number; downbeats: number }> => firedCounts;

/** Switches the clock to a new track; events arrive later via setBeatFxEvents. */
export const beginBeatFxTrack = (key: string | null) => {
    const wasReady = isBeatFxReady();
    holdUntil = key && wasReady ? Math.max(holdUntil, performance.now() + READY_HOLD_MS) : 0;
    trackKey = key;
    state.events = [];
    state.cursor = 0;
    state.lastTime = null;
    state.lastBeat = null;
    state.lastDownbeat = null;
    if (debug) {
        debug.trackKey = key;
        debug.source = key ? 'loading' : 'none';
        debug.note = null;
        debug.eventCount = 0;
    }
};

/** Installs the beat list for `key`, with its dynamics scale; ignored if the track changed meanwhile. */
export const setBeatFxEvents = (
    key: string,
    events: BeatFxEvent[],
    source: BeatFxSourceKind,
    note?: string,
    trackScale = 1,
) => {
    if (key !== trackKey) return;
    state.events = events;
    state.trackScale = trackScale;
    beatPeriod = resolveBeatFxBeatPeriod(events);
    holdUntil = 0;
    // Resync on the next step rather than firing everything before the current position.
    state.lastTime = null;
    if (debug) {
        debug.source = source;
        debug.note = note ?? null;
        debug.eventCount = events.length;
    }
};

/** Whether the playing track's beat list is installed - or a track change is still inside its hold. */
export const isBeatFxReady = (): boolean =>
    trackKey !== null && (state.events.length > 0 || (holdUntil > 0 && performance.now() < holdUntil));

/** Whether a deck was being heard at the last step; continuous effects rest while it is not. */
export const isBeatFxHearing = (): boolean => hearing;

/** The installed track's key and the time in it the listener hears (null while nothing plays). */
export const getBeatFxHeard = (): Readonly<{ key: string | null; time: number | null }> => ({ key: trackKey, time: heardAt });

/** Stops the clock and zeroes both envelopes; called when the FX are switched off. */
export const stopBeatFx = () => {
    beginBeatFxTrack(null);
    state.beatImpact = 0;
    state.downbeatImpact = 0;
    beatImpact.set(0);
    downbeatImpact.set(0);
    lastStepAt = null;
    hearing = false;
};

/** The last fired plain beat (not a downbeat) of this track, or null. */
export const getBeatFxLastBeat = (): BeatFxEvent | null => state.lastBeat;

/** The last fired downbeat of this track, or null. */
export const getBeatFxLastDownbeat = (): BeatFxEvent | null => state.lastDownbeat;

/**
 * The installed track's whole beat list, sorted by time (empty until it is in). For a picture that
 * schedules ahead of the beat rather than reacting to it - hanabi launches a shell so it bursts on
 * the downbeat - and draws purely from the playback time. Read it rather than keep it.
 */
export const getBeatFxEvents = (): readonly BeatFxEvent[] => state.events;

/** The installed track's typical beat length in seconds (median gap), for effects timed in beats. */
export const getBeatFxBeatPeriod = (): number => beatPeriod;

/** The playing track's dynamics scale (0.45..1); 1 without accents. */
export const getBeatFxTrackScale = (): number => state.trackScale;

/** Alternating ±1 for the camera tilt; flips on every fired beat. */
export const getBeatFxRotationSign = (): number => state.rotationSign;

/** The next event strictly after `time` (binary search), for hosts that manage their own cursor. */
export const findNextBeatFxEventAt = (time: number): number => findNextBeatFxEvent(state.events, time);

/**
 * WaveForge 入口：一帧时钟步进。宿主从 PlaybackTimeStore 快照取"听感时间"
 * （isPlaying 时为 currentTime，暂停时 null），dt 由本函数按帧间隔自算。
 */
export const tickBeatFxStore = (heardTime: number | null) => {
    const now = performance.now();
    const dtSec = lastStepAt === null ? 0 : Math.min(0.1, (now - lastStepAt) / 1000);
    lastStepAt = now;
    hearing = heardTime !== null;
    heardAt = heardTime;
    stepBeatFxClock(state, heardTime, dtSec);
    firedCounts.beats = state.firedBeats;
    firedCounts.downbeats = state.firedDownbeats;
    beatImpact.set(state.beatImpact * intensities.beat);
    downbeatImpact.set(state.downbeatImpact * intensities.downbeat);
    if (debug) {
        debug.beats = state.firedBeats;
        debug.downbeats = state.firedDownbeats;
        debug.lastT = state.lastFiredT;
        debug.heardT = heardTime;
        debug.beatImpact = state.beatImpact;
        debug.downbeatImpact = state.downbeatImpact;
    }
};

/**
 * 上游签名保留：WaveForge 没有"每宿主一个 media element"的统一通道，这里退化为
 * store 版薄包装（audioElement 只用来判播放态，时间由宿主另行传入——见 tickBeatFxStore）。
 */
export const tickBeatFx = (audioElement: HTMLMediaElement | null, _context?: BaseAudioContext | null) => {
    const playing = Boolean(audioElement && !audioElement.paused && !audioElement.ended);
    tickBeatFxStore(playing && audioElement ? audioElement.currentTime : null);
};
