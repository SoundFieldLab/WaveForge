/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest'
import { VISUALIZER_REGISTRY, getVisualizerRegistryEntry, hasVisualizerMode } from '../src/vendor/folia/components/visualizer/registry'
import { normalizeHanabiTuning } from '../src/vendor/folia/components/visualizer/hanabi/hanabiTuning'
import { DEFAULT_HANABI_TUNING } from '../src/vendor/folia/components/visualizer/hanabi/types'

// 花火（上游 v0.7.22）移植冒烟：注册表收录、条目形状、tuning 归一化。
describe('hanabi visualizer registration', () => {
    it('registers 花火 in the folia style registry', () => {
        expect(hasVisualizerMode('hanabi')).toBe(true)
        const entry = getVisualizerRegistryEntry('hanabi')
        expect(entry.mode).toBe('hanabi')
        expect(entry.labelFallback).toBe('花火')
        expect(entry.tuningKind).toBe('hanabi')
        expect(typeof entry.render).toBe('function')
        expect(typeof entry.renderSettingsPanel).toBe('function')
        // 商籁/凝彩等既有样式不受影响
        expect(hasVisualizerMode('sonnet')).toBe(true)
        expect(hasVisualizerMode('tempera')).toBe(true)
        expect(hasVisualizerMode('lumiere')).toBe(true)
        // 注册表里只有这一个 hanabi 条目
        expect(VISUALIZER_REGISTRY.filter(entry => entry.mode === 'hanabi')).toHaveLength(1)
    })

    it('normalizes stored hanabi tuning: missing fields fall back, out-of-range clamps', () => {
        const tuning = normalizeHanabiTuning({
            sparkAmount: 99,
            blockOpacity: -3,
            colorMode: 'bogus',
            launches: false,
        })
        expect(tuning.sparkAmount).toBe(2)
        expect(tuning.blockOpacity).toBe(0)
        expect(tuning.colorMode).toBe(DEFAULT_HANABI_TUNING.colorMode)
        expect(tuning.launches).toBe(false)
        // 未提供的关键字段全部回到默认
        expect(tuning.riseSpeed).toBe(DEFAULT_HANABI_TUNING.riseSpeed)
        expect(tuning.renderQuality).toBe(DEFAULT_HANABI_TUNING.renderQuality)
    })
})
