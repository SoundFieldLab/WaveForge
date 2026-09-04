/**
 * useDioramaSequencer —— folia Diorama 镜台 sequencer 的 React 编排 hook。
 *
 * 从 FoliaDioramaLyrics 抽离的"纯状态机 + 副作用"层：拥有 sequencer ref、5 个 sequencer
 * 相关 useState（globalIndex / transitionEpoch / outgoingGlobalIndex / flightActive /
 * linesEpoch）、4 个命令式 ref（epoch / round / lastIndex / globalIndex 镜像）、3 个
 * effect（切歌铺段 / 歌词晚到原位重建 / 行推进与单曲循环）+ globalIndex 镜像 effect
 * + setTimeout 跟踪与卸载清理。时间同步 rAF 与 WebGL 恢复留主组件（与 sequencer 无关）。
 *
 * 行为与原内联实现完全等价——仅搬位置不改逻辑，3 处 eslint-disable exhaustive-deps
 * 保留（sequencer ref 是可变状态，依赖列全反而误导）。dead ref（lastTrackKeyRef
 * 只写不读）顺手清理。
 */
import { useEffect, useRef, useState } from 'react'
import type { Line } from './types'
import {
    appendSegment,
    createSequencerState,
    pruneSegments,
    updateActiveSegmentLines,
    type SequencerState,
} from './dioramaSequencer'
import { pickTransitionOffset, TRANSITION_DURATION } from './dioramaTransition'

export interface UseDioramaSequencerArgs {
    /** 已转换的 folia 行（含空行占位，1:1 对齐 currentIndex）。 */
    lines: Line[]
    currentIndex: number
    /** 歌曲标识：变化时按 folia 语义铺新走廊段并飞过去。 */
    trackKey: string
}

export interface UseDioramaSequencerResult {
    /** Sequencer 状态机实例（命令式 ref，跨 render 持久；首次 mount 懒初始化，之后恒非空）。
     *  传给 DioramaScene / CameraRig。 */
    sequencer: SequencerState
    /** 当前全局行索引（核心，驱动场景挂载窗口）。 */
    globalIndex: number
    /** 过渡 epoch（每次切歌/循环 +1）。传给 CameraRig 触发飞行动画。 */
    transitionEpoch: number
    /** 出栈段的全局索引（切歌/循环时短暂设置，超时清空）。传给 DioramaScene 渲染渐远段。 */
    outgoingGlobalIndex: number | null
    /** 切歌/循环过渡飞行中（星河加速）。传给 StarRiver。 */
    flightActive: boolean
    /** 歌词原位重建 epoch（歌词晚到时 +1）。传给 DioramaScene 判废行级缓存。 */
    linesEpoch: number
}

export const useDioramaSequencer = ({ lines, currentIndex, trackKey }: UseDioramaSequencerArgs): UseDioramaSequencerResult => {
    const sequencerRef = useRef<SequencerState | null>(null)
    if (!sequencerRef.current) sequencerRef.current = createSequencerState()
    const epochRef = useRef(0)
    const roundRef = useRef(0)
    const lastIndexRef = useRef(-1)
    const globalIndexRef = useRef(0)

    const [globalIndex, setGlobalIndex] = useState(0)
    const [transitionEpoch, setTransitionEpoch] = useState(0)
    const [outgoingGlobalIndex, setOutgoingGlobalIndex] = useState<number | null>(null)
    // 切歌/循环过渡飞行中：星河加速，强化"飞向下一首"的速度感
    const [flightActive, setFlightActive] = useState(false)
    const [linesEpoch, setLinesEpoch] = useState(0)

    // 跟踪所有挂起的 setTimeout，组件卸载时统一清理，避免在已卸载组件上触发 setState
    // （React 18 已无"卸载后 setState"警告，但飞行/出栈计时器在切歌快进时仍会命中陈旧闭包）
    const pendingTimersRef = useRef<Set<number>>(new Set())
    const scheduleTimeout = (fn: () => void, delayMs: number) => {
        const id = window.setTimeout(() => {
            pendingTimersRef.current.delete(id)
            fn()
        }, delayMs)
        pendingTimersRef.current.add(id)
        return id
    }
    useEffect(() => () => {
        pendingTimersRef.current.forEach(id => window.clearTimeout(id))
        pendingTimersRef.current.clear()
    }, [])

    const beginFlight = () => {
        setFlightActive(true)
        scheduleTimeout(() => setFlightActive(false), (TRANSITION_DURATION + 0.4) * 1000)
    }

    // ── 切歌：铺新走廊段（首曲在原点，之后铺到远处并飞过去） ──────────────────────────────
    useEffect(() => {
        const sequencer = sequencerRef.current
        if (!sequencer) return
        const isFirst = sequencer.segments.length === 0
        epochRef.current += 1
        const epoch = epochRef.current
        const origin = isFirst ? { x: 0, y: 0, z: 0 } : pickTransitionOffset(trackKey, epoch)
        const segment = appendSegment(sequencer, {
            seed: trackKey,
            lines,
            round: roundRef.current,
            placementOrigin: origin,
        })
        lastIndexRef.current = currentIndex
        const target = segment.globalStart + Math.max(0, currentIndex)
        if (!isFirst) setOutgoingGlobalIndex(globalIndexRef.current)
        setGlobalIndex(target)
        setTransitionEpoch(epoch)
        if (!isFirst) beginFlight()
        scheduleTimeout(() => setOutgoingGlobalIndex(null), (TRANSITION_DURATION + 0.6) * 1000)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [trackKey])

    // ── 歌词晚到：切歌后新歌歌词异步加载完成时，原位重建当前段（避免显示上一首歌的歌词） ──
    useEffect(() => {
        const sequencer = sequencerRef.current
        if (!sequencer || sequencer.segments.length === 0) return
        const active = sequencer.segments[sequencer.segments.length - 1]
        // 仅当当前段仍是同一首歌时才重建（seed 即 trackKey；切歌铺的新段若已含正确歌词则幂等）
        if (active.seed === trackKey) {
            updateActiveSegmentLines(sequencer, lines)
            setLinesEpoch(epoch => epoch + 1)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [lines])

    // 记录 globalIndex 的即时值供切歌时读取（避免闭包过期）
    useEffect(() => {
        globalIndexRef.current = globalIndex
    }, [globalIndex])

    // ── 行推进 / 单曲循环 ──────────────────────────────────────────────────────────────────
    useEffect(() => {
        const sequencer = sequencerRef.current
        if (!sequencer || sequencer.segments.length === 0) return
        const segment = sequencer.segments[sequencer.segments.length - 1]
        const previous = lastIndexRef.current
        lastIndexRef.current = currentIndex

        // 单曲循环 / 跳回开头：铺新一轮走廊段（无缝飞过去）
        if (previous >= 0 && currentIndex < previous - 1) {
            roundRef.current += 1
            epochRef.current += 1
            const epoch = epochRef.current
            const origin = pickTransitionOffset(trackKey, epoch)
            const next = appendSegment(sequencer, {
                seed: trackKey,
                lines,
                round: roundRef.current,
                placementOrigin: origin,
            })
            setOutgoingGlobalIndex(globalIndexRef.current)
            setGlobalIndex(next.globalStart + Math.max(0, currentIndex))
            setTransitionEpoch(epoch)
            beginFlight()
            scheduleTimeout(() => setOutgoingGlobalIndex(null), (TRANSITION_DURATION + 0.6) * 1000)
            return
        }

        setGlobalIndex(segment.globalStart + Math.max(0, Math.min(currentIndex, lines.length - 1)))
        pruneSegments(sequencer, globalIndexRef.current - 10)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentIndex])

    return {
        sequencer: sequencerRef.current,
        globalIndex,
        transitionEpoch,
        outgoingGlobalIndex,
        flightActive,
        linesEpoch,
    }
}
