/**
 * 学歌插件本地进度/设置/练习记录单测（localStorage 持久层）。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  loadMasteredLines,
  saveMasteredLines,
  loadSingAlongSettings,
  saveSingAlongSettings,
} from '../src/plugins/clients/singalong/settings'
import {
  getSongRecord,
  getLineBest,
  recordLineScore,
  recordSongAttempt,
  getAllSongRecords,
  removeSongRecord,
  getRecentSongKeys,
} from '../src/plugins/clients/singalong/records'

beforeEach(() => {
  localStorage.clear()
})

describe('loadMasteredLines', () => {
  it('无记录返回空集合', () => {
    expect(loadMasteredLines('song-a').size).toBe(0)
  })

  it('读回写集合（行起始 ms 为键）', () => {
    const lines = new Set([10000, 15400, 22000])
    saveMasteredLines('song-a', lines)
    const loaded = loadMasteredLines('song-a')
    expect(loaded.size).toBe(3)
    expect(loaded.has(10000)).toBe(true)
    expect(loaded.has(15400)).toBe(true)
    expect(loaded.has(22000)).toBe(true)
  })

  it('歌曲之间互不影响', () => {
    saveMasteredLines('song-a', new Set([1000]))
    saveMasteredLines('song-b', new Set([2000, 3000]))
    expect(loadMasteredLines('song-a').size).toBe(1)
    expect(loadMasteredLines('song-b').size).toBe(2)
  })

  it('坏 JSON 返回空集合', () => {
    localStorage.setItem('wf_singalong_progress:song-a', '{oops')
    expect(loadMasteredLines('song-a').size).toBe(0)
  })

  it('非数字元素被过滤', () => {
    localStorage.setItem('wf_singalong_progress:song-a', JSON.stringify([1, 'x', null, 5]))
    const loaded = loadMasteredLines('song-a')
    expect(loaded.size).toBe(2)
  })
})

describe('saveMasteredLines', () => {
  it('空集合删除整个键', () => {
    saveMasteredLines('song-a', new Set([1000]))
    expect(localStorage.getItem('wf_singalong_progress:song-a')).not.toBeNull()
    saveMasteredLines('song-a', new Set())
    expect(localStorage.getItem('wf_singalong_progress:song-a')).toBeNull()
  })

  it('更新覆盖旧值', () => {
    saveMasteredLines('song-a', new Set([1000, 2000]))
    saveMasteredLines('song-a', new Set([1000]))
    expect(loadMasteredLines('song-a').size).toBe(1)
  })
})

describe('singAlongSettings', () => {
  it('默认值：自动开麦/翻译开/标准字号/停顿关/5 秒', () => {
    const settings = loadSingAlongSettings()
    expect(settings.autoStartMic).toBe(true)
    expect(settings.showTranslation).toBe(true)
    expect(settings.lyricSize).toBe('normal')
    expect(settings.pauseAfterLine).toBe(false)
    expect(settings.pauseDuration).toBe(5)
  })

  it('写读回环', () => {
    saveSingAlongSettings({ autoStartMic: false, showTranslation: false, lyricSize: 'large', pauseAfterLine: true, pauseDuration: 8 })
    const loaded = loadSingAlongSettings()
    expect(loaded.autoStartMic).toBe(false)
    expect(loaded.showTranslation).toBe(false)
    expect(loaded.lyricSize).toBe('large')
    expect(loaded.pauseAfterLine).toBe(true)
    expect(loaded.pauseDuration).toBe(8)
  })

  it('pauseDuration 越界被夹到 2..15', () => {
    localStorage.setItem('wf_singalong_settings', JSON.stringify({ pauseDuration: 99 }))
    expect(loadSingAlongSettings().pauseDuration).toBe(15)
    localStorage.setItem('wf_singalong_settings', JSON.stringify({ pauseDuration: 0 }))
    expect(loadSingAlongSettings().pauseDuration).toBe(2)
  })

  it('坏 JSON 回默认', () => {
    localStorage.setItem('wf_singalong_settings', 'not-json')
    expect(loadSingAlongSettings().autoStartMic).toBe(true)
  })
})

describe('练习记录 records', () => {
  it('无记录返回 null / 空列表', () => {
    expect(getSongRecord('song-x')).toBeNull()
    expect(getLineBest('song-x', 1000)).toBeNull()
    expect(getAllSongRecords()).toEqual([])
  })

  it('recordLineScore 写入逐句 PB，低分不覆盖', () => {
    expect(recordLineScore('song-a', 1000, { total: 80, pitch: 85, rhythm: 70 })).toBe(true)
    expect(getLineBest('song-a', 1000)?.best).toBe(80)
    // 更低分不刷新
    expect(recordLineScore('song-a', 1000, { total: 60, pitch: 60, rhythm: 60 })).toBe(false)
    expect(getLineBest('song-a', 1000)?.best).toBe(80)
    // 更高分刷新
    expect(recordLineScore('song-a', 1000, { total: 90, pitch: 92, rhythm: 88 })).toBe(true)
    expect(getLineBest('song-a', 1000)?.best).toBe(90)
    expect(getLineBest('song-a', 1000)?.pitch).toBe(92)
  })

  it('recordSongAttempt：整曲 PB + 练习次数 + 最近练习', () => {
    expect(recordSongAttempt('song-a', { total: 75, pitch: 80, rhythm: 66 }, 10)).toBe(true)
    const record = getSongRecord('song-a')!
    expect(record.bestTotal).toBe(75)
    expect(record.bestPitch).toBe(80)
    expect(record.practiceCount).toBe(1)
    // 第二次低分：非 PB 但次数 +1
    expect(recordSongAttempt('song-a', { total: 65, pitch: 70, rhythm: 58 }, 8)).toBe(false)
    const record2 = getSongRecord('song-a')!
    expect(record2.bestTotal).toBe(75)
    expect(record2.practiceCount).toBe(2)
    expect(getRecentSongKeys()[0]).toBe('song-a')
  })

  it('0 分或 0 句不写入', () => {
    expect(recordSongAttempt('song-empty', { total: 0, pitch: 0, rhythm: 0 }, 0)).toBe(false)
    expect(getSongRecord('song-empty')).toBeNull()
    expect(recordLineScore('song-empty', 500, { total: 0, pitch: 0, rhythm: 0 })).toBe(false)
  })

  it('getAllSongRecords 按最近练习倒序，removeSongRecord 删除', async () => {
    recordSongAttempt('song-old', { total: 60, pitch: 60, rhythm: 60 }, 5)
    // lastAt 精度是毫秒：隔一毫秒再写第二首，保证「最近」排序可断言
    await new Promise(resolve => setTimeout(resolve, 5))
    recordSongAttempt('song-new', { total: 70, pitch: 70, rhythm: 70 }, 5)
    const all = getAllSongRecords()
    expect(all[0].songKey).toBe('song-new')
    removeSongRecord('song-old')
    expect(getSongRecord('song-old')).toBeNull()
    expect(getRecentSongKeys()).not.toContain('song-old')
  })
})
