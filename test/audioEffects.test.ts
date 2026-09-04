import { describe, it, expect, beforeEach } from 'vitest'
import { AudioEffectsEngine } from '../src/services/audio-effects-v2/AudioEffectsEngine'
import { gainDbForLufs, TARGET_LUFS, MAX_GAIN_DB, MIN_GAIN_DB } from '../src/services/audio-effects-v2/loudnessNormalization'

// localStorage stub 由 test/setup.ts 注入；此处只需每次清空
beforeEach(() => {
  try { localStorage.clear() } catch { /* noop */ }
})

describe('AudioEffectsEngine 场景快照（快照式，ADR-0001）', () => {
  it('applyScene 写入参数并清除自定义标记', () => {
    const engine = new AudioEffectsEngine()
    engine.updateSettings({ effects: { bassBoost: { enabled: true, depth: 90, intensity: 5 } } })
    expect(engine.getSettings().customized).toBe(true)

    const scene = engine.getBuiltinScenes()[0] // 重低音
    engine.applyScene(scene)
    const s = engine.getSettings()
    expect(s.activeScene).toBe(scene.id)
    expect(s.customized).toBe(false)
    // 场景参数真正生效：重低音 = bassBoost + compressor（全景声厅已关闭，见 #5 需求——
    // 重低音+全景声同时开启会把中高频砍没）
    expect(s.effects.bassBoost.enabled).toBe(true)
    expect(s.effects.hall.enabled).toBe(false)
    expect(s.effects.compressor.enabled).toBe(true)
  })

  it('手动 updateSettings 自动进入自定义状态；applyScene 后保持场景记录', () => {
    const engine = new AudioEffectsEngine()
    const scene = engine.getBuiltinScenes()[0]
    engine.applyScene(scene)
    expect(engine.getSettings().customized).toBe(false)
    engine.updateSettings({ eq: { simpleBands: [1, 0, 0, 0, 0] } })
    expect(engine.getSettings().customized).toBe(true)
    expect(engine.getSettings().activeScene).toBe(scene.id) // 仍记录上次场景
  })

  it('保存/删除「我的场景」', () => {
    const engine = new AudioEffectsEngine()
    engine.updateSettings({ effects: { nightMode: { enabled: true, amount: 8 } } })
    expect(engine.saveAsMyScene('深夜')).toBe(true)
    expect(engine.saveAsMyScene('   ')).toBe(false) // 空名拒绝
    const mine = engine.getMyScenes()
    expect(mine.length).toBe(1)
    expect(mine[0].name).toBe('深夜')
    engine.deleteMyScene(mine[0].id)
    expect(engine.getMyScenes().length).toBe(0)
  })
})

describe('AudioEffectsEngine 可叠加 + 频响补偿互斥（ADR-0002）', () => {
  it('多效果可同时开启（不再互斥）', () => {
    const engine = new AudioEffectsEngine()
    engine.updateSettings({ effects: { bassBoost: { enabled: true, depth: 90, intensity: 5 } } })
    engine.updateSettings({ effects: { hall: { enabled: true, level: 5, reverb: 4 } } })
    const s = engine.getSettings()
    expect(s.effects.bassBoost.enabled).toBe(true)
    expect(s.effects.hall.enabled).toBe(true)
  })

  it('开启频响补偿自动关闭 EQ，开启 EQ 自动关闭频响补偿', () => {
    const engine = new AudioEffectsEngine()
    engine.updateSettings({ eq: { enabled: true } })
    expect(engine.getSettings().eq.enabled).toBe(true)
    engine.updateSettings({ effects: { loudnessCompensation: { enabled: true } } })
    expect(engine.getSettings().effects.loudnessCompensation.enabled).toBe(true)
    expect(engine.getSettings().eq.enabled).toBe(false)

    engine.updateSettings({ eq: { enabled: true } })
    expect(engine.getSettings().effects.loudnessCompensation.enabled).toBe(false)
    expect(engine.getSettings().eq.enabled).toBe(true)
  })

  it('响度归一化与频响补偿互斥（双向）', () => {
    const engine = new AudioEffectsEngine()
    // 开归一化 → 开补偿：补偿生效、归一化被关
    engine.updateSettings({ normalizationEnabled: true })
    expect(engine.getSettings().normalizationEnabled).toBe(true)
    engine.updateSettings({ effects: { loudnessCompensation: { enabled: true } } })
    expect(engine.getSettings().effects.loudnessCompensation.enabled).toBe(true)
    expect(engine.getSettings().normalizationEnabled).toBe(false)

    // 开归一化 → 补偿被关
    engine.updateSettings({ normalizationEnabled: true })
    expect(engine.getSettings().effects.loudnessCompensation.enabled).toBe(false)
    expect(engine.getSettings().normalizationEnabled).toBe(true)
  })
})

describe('AudioEffectsEngine 设置迁移（旧字段缺省补默认）', () => {
  it('旧格式 effects（无新字段）加载后自动补全新字段默认值', () => {
    // 模拟旧版本存盘（无 compressor/nightMode/loudnessCompensation/hall.type 等）
    localStorage.setItem('waveforge:audio-effects-settings', JSON.stringify({
      effects: {
        hall: { enabled: true, level: 3, reverb: 2 },
        surround3d: { enabled: false, distance: 3, speed: 1, angle: 0, direction: 1 },
        bassBoost: { enabled: false, depth: 100, intensity: 6 },
        vocalBoost: { enabled: false, intensity: 4 },
        accompanimentBoost: { enabled: false, intensity: 4 },
      },
      eq: { enabled: false, mode: 'simple', simpleBands: [0, 0, 0, 0, 0], proBands: [] },
      pitch: { enabled: false, semitones: 0, rate: 1, voiceBalance: 0 },
    }))
    const engine = new AudioEffectsEngine()
    const s = engine.getSettings()
    // 新字段取默认
    expect(s.effects.compressor.enabled).toBe(false)
    expect(s.effects.nightMode.amount).toBe(6)
    expect(s.effects.loudnessCompensation.enabled).toBe(false)
    expect(s.effects.hall.type).toBe('hall')
    expect(s.effects.hall.preDelay).toBe(18)
    // 旧字段保留
    expect(s.effects.hall.enabled).toBe(true)
    expect(s.effects.hall.level).toBe(3)
  })
})

describe('响度归一化增益换算', () => {
  it('目标响度 -14 LUFS：实际更响则衰减，更弱则提升', () => {
    expect(gainDbForLufs(TARGET_LUFS)).toBe(0) // -14 不补偿
    expect(gainDbForLufs(-8)).toBe(-6) // 偏响 → 压 6dB
    expect(gainDbForLufs(-20)).toBe(6) // 偏弱 → 提 6dB
  })

  it('增益 clamp 到 ±9dB，异常输入返回 0', () => {
    expect(gainDbForLufs(-5)).toBe(MIN_GAIN_DB) // -9 下限
    expect(gainDbForLufs(-30)).toBe(MAX_GAIN_DB) // +9 上限
    expect(gainDbForLufs(Number.NaN)).toBe(0)
    expect(gainDbForLufs(Number.POSITIVE_INFINITY)).toBe(0)
  })
})
