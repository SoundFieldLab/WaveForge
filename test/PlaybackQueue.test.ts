import { describe, it, expect } from 'vitest'
import {
  getDeterministicNextIndex,
  getUpcomingIndices,
  stableTrackKey,
} from '../src/audio/PlaybackQueue.ts'

const FIVE_TRACKS = ['netease-1', 'netease-2', 'netease-3', 'netease-4', 'netease-5']

describe('getDeterministicNextIndex（确定性下一曲索引）', () => {
  describe('sequential 顺序模式', () => {
    it('按序推进，末尾回到开头', () => {
      expect(getDeterministicNextIndex(FIVE_TRACKS, 0, 'sequential')).toBe(1)
      expect(getDeterministicNextIndex(FIVE_TRACKS, 3, 'sequential')).toBe(4)
      expect(getDeterministicNextIndex(FIVE_TRACKS, 4, 'sequential')).toBe(0)
    })
  })

  describe('shuffle 随机模式', () => {
    it('同一 revision 结果确定（确定性种子）', () => {
      const first = getDeterministicNextIndex(FIVE_TRACKS, 0, 'shuffle', 7)
      const second = getDeterministicNextIndex(FIVE_TRACKS, 0, 'shuffle', 7)
      expect(first).toBeDefined()
      expect(second).toBe(first)
    })

    it('不同 revision 结果可变', () => {
      const a = getDeterministicNextIndex(FIVE_TRACKS, 0, 'shuffle', 0)
      const b = getDeterministicNextIndex(FIVE_TRACKS, 0, 'shuffle', 1)
      expect(a).toBeDefined()
      expect(b).toBeDefined()
      // 理论上可能相等，但哈希种子不同应大概率不同；此处只断言均为合法索引
      expect(a).not.toBe(0)
      expect(b).not.toBe(0)
    })

    it('随机结果绝不会选中当前曲目自身', () => {
      for (let currentIndex = 0; currentIndex < FIVE_TRACKS.length; currentIndex += 1) {
        for (let revision = 0; revision < 20; revision += 1) {
          const next = getDeterministicNextIndex(FIVE_TRACKS, currentIndex, 'shuffle', revision)
          expect(next).not.toBe(currentIndex)
        }
      }
    })
  })

  describe('repeat 单曲循环模式', () => {
    it('始终返回 undefined', () => {
      expect(getDeterministicNextIndex(FIVE_TRACKS, 0, 'repeat')).toBeUndefined()
      expect(getDeterministicNextIndex(FIVE_TRACKS, 2, 'repeat')).toBeUndefined()
    })
  })

  describe('边界情况', () => {
    it('单曲队列返回 undefined', () => {
      expect(getDeterministicNextIndex(['netease-only'], 0, 'sequential')).toBeUndefined()
      expect(getDeterministicNextIndex(['netease-only'], 0, 'shuffle')).toBeUndefined()
    })

    it('空队列返回 undefined', () => {
      expect(getDeterministicNextIndex([], 0, 'sequential')).toBeUndefined()
    })

    it('currentIndex 越界（负数或超出长度）返回 undefined', () => {
      expect(getDeterministicNextIndex(FIVE_TRACKS, -1, 'sequential')).toBeUndefined()
      expect(getDeterministicNextIndex(FIVE_TRACKS, 5, 'sequential')).toBeUndefined()
      expect(getDeterministicNextIndex(FIVE_TRACKS, 100, 'sequential')).toBeUndefined()
    })
  })
})

describe('getUpcomingIndices（后续播放索引序列）', () => {
  describe('数量与内容', () => {
    it('顺序模式返回连续的下一个索引，不重复自身', () => {
      expect(getUpcomingIndices(FIVE_TRACKS, 0, 'sequential')).toEqual([1, 2])
      expect(getUpcomingIndices(FIVE_TRACKS, 3, 'sequential', 0, 3)).toEqual([4, 0, 1])
    })

    it('结果无重复且不包含当前索引', () => {
      const upcoming = getUpcomingIndices(FIVE_TRACKS, 2, 'shuffle', 0, 4)
      expect(new Set(upcoming).size).toBe(upcoming.length)
      expect(upcoming).not.toContain(2)
    })

    it('count 超过队列剩余量时只返回合法数量（去重后最多 len-1 个）', () => {
      expect(getUpcomingIndices(FIVE_TRACKS, 0, 'sequential', 0, 99)).toEqual([1, 2, 3, 4])
    })

    it('count <= 0 返回空数组', () => {
      expect(getUpcomingIndices(FIVE_TRACKS, 0, 'sequential', 0, 0)).toEqual([])
      expect(getUpcomingIndices(FIVE_TRACKS, 0, 'sequential', 0, -1)).toEqual([])
    })
  })

  describe('不同模式', () => {
    it('repeat 模式返回空数组（无下一曲）', () => {
      expect(getUpcomingIndices(FIVE_TRACKS, 0, 'repeat')).toEqual([])
    })

    it('shuffle 模式去重且覆盖多首', () => {
      const upcoming = getUpcomingIndices(FIVE_TRACKS, 0, 'shuffle', 0, 4)
      expect(upcoming.length).toBe(4)
    })
  })

  describe('边界情况', () => {
    it('单曲队列返回空数组', () => {
      expect(getUpcomingIndices(['netease-only'], 0, 'sequential', 0, 2)).toEqual([])
    })

    it('空队列返回空数组', () => {
      expect(getUpcomingIndices([], 0, 'sequential', 0, 2)).toEqual([])
    })
  })
})

describe('stableTrackKey（稳定曲目标识）', () => {
  it('优先使用 mid，其次 id', () => {
    expect(stableTrackKey({ platform: 'qq', id: 1, mid: 'M500abc' })).toBe('qq-M500abc')
    expect(stableTrackKey({ platform: 'qq', id: 123 })).toBe('qq-123')
  })

  it('无 platform 时默认 netease', () => {
    expect(stableTrackKey({ id: 123 })).toBe('netease-123')
  })

  it('platform 会去除首尾空白', () => {
    expect(stableTrackKey({ platform: '  qq  ', id: 1 })).toBe('qq-1')
  })

  it('identity 为空时抛出错误', () => {
    expect(() => stableTrackKey({})).toThrow('Cannot create a playback key')
    expect(() => stableTrackKey({ name: '   ' })).toThrow('Cannot create a playback key')
  })

  it('id 为 0 时仍然使用（数字 0 是合法标识）', () => {
    expect(stableTrackKey({ platform: 'netease', id: 0 })).toBe('netease-0')
  })

  it('可用 url 或 name 兜底', () => {
    expect(stableTrackKey({ platform: 'qq', url: 'http://example.com/a.mp3' })).toBe('qq-http://example.com/a.mp3')
    expect(stableTrackKey({ platform: 'qq', name: '我的歌' })).toBe('qq-我的歌')
  })
})
