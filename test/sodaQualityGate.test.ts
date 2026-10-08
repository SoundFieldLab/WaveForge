import { describe, expect, it } from 'vitest'
import {
  sodaTrackQualityGate,
  sodaQualityStageForKey,
  sodaStreamRequiredTier,
  sodaPickStreamForQuality,
} from '../server/qishui-api.mjs'

/**
 * 音质门槛回归：客户端 track.label_info.quality_map 是权威依据，
 * 旧实现只按标签正则猜，把免费的 higher/highest 判成 VIP、把 hi_res 判成 SVIP。
 * 样本取自真实客户端 track_v2 返回（track 7012995715072788482）。
 */
const clientLabel = {
  only_vip_download: true,
  quality_only_vip_can_play: ['lossless'],
  quality_map: {
    hi_res: { play_detail: { condition: 'benefit_play_hi_res', need_vip: true, need_purchase: false } },
    medium: { play_detail: { condition: 'benefit_play_medium', need_vip: false, need_purchase: false } },
    higher: { play_detail: { condition: 'benefit_play_higher', need_vip: false, need_purchase: false } },
    highest: { play_detail: { condition: 'benefit_play_highest', need_vip: false, need_purchase: false } },
    lossless: { play_detail: { condition: 'benefit_play_lossless', need_vip: true, need_purchase: false } },
    spatial: { play_detail: { condition: 'benefit_play_spatial', need_vip: true, need_purchase: false } },
  },
}

describe('汽水音质门槛（客户端 quality_map 优先）', () => {
  const gate = sodaTrackQualityGate({ label_info: clientLabel })

  it('解析出各档位的 need_vip 门槛', () => {
    expect(gate).toBeTruthy()
    expect(gate.byKey.medium.needVip).toBe(false)
    expect(gate.byKey.higher.needVip).toBe(false)
    expect(gate.byKey.highest.needVip).toBe(false)
    expect(gate.byKey.lossless.needVip).toBe(true)
    expect(gate.byKey.spatial.needVip).toBe(true)
    expect(gate.byKey.hi_res.needVip).toBe(true)
  })

  it('没有 quality_map 时返回 null，调用方回退启发式', () => {
    expect(sodaTrackQualityGate({})).toBeNull()
    expect(sodaTrackQualityGate({ label_info: {} })).toBeNull()
  })

  it('免费档不被误判成会员（旧实现在这里把 higher/highest 挡了）', () => {
    // 客户端实测：higher 132kbps、highest 324kbps 均可免费播放
    expect(sodaStreamRequiredTier({ quality: 'higher', bitrate: 132196, format: 'm4a' }, gate)).toBe('free')
    expect(sodaStreamRequiredTier({ quality: 'highest', bitrate: 324246, format: 'm4a' }, gate)).toBe('free')
    expect(sodaStreamRequiredTier({ quality: 'medium', bitrate: 68197, format: 'm4a' }, gate)).toBe('free')
  })

  it('会员档按产品定义落到 svip，而不是旧实现的 vip/svip 混判', () => {
    expect(sodaStreamRequiredTier({ quality: 'lossless', bitrate: 1079445, format: 'mp4' }, gate)).toBe('svip')
    expect(sodaStreamRequiredTier({ quality: 'spatial', bitrate: 324226, format: 'm4a' }, gate)).toBe('svip')
    // 旧实现把 hi_res 归到 hires 正则 → 误升 SVIP 是无意的；按客户端产品定义它确实是 svip
    expect(sodaStreamRequiredTier({ quality: 'hi_res', bitrate: 320424, format: 'm4a' }, gate)).toBe('svip')
  })

  it('流标签缺失时按码率归档到最近档位', () => {
    expect(sodaStreamRequiredTier({ bitrate: 132000, format: 'm4a' }, gate)).toBe('free')
    expect(sodaStreamRequiredTier({ bitrate: 1079000, format: 'flac' }, gate)).toBe('svip')
  })

  it('无门槛数据时回退启发式，且不再把 hi_res/spatial 当作 SVIP 之外的误判', () => {
    // 无 gate：hires 语义归 VIP（客户端实测这些档位 need_vip 而非 svip 专有）
    expect(sodaStreamRequiredTier({ quality: 'hires', bitrate: 320000 })).toBe('vip')
    expect(sodaStreamRequiredTier({ quality: 'spatial', bitrate: 324226 })).toBe('vip')
    expect(sodaStreamRequiredTier({ quality: 'lossless', bitrate: 1079445 })).toBe('vip')
    // 明确 svip 语义时才升 SVIP
    expect(sodaStreamRequiredTier({ quality: 'svip', bitrate: 1000000 })).toBe('svip')
    // 免费标签仍免费
    expect(sodaStreamRequiredTier({ quality: 'medium', bitrate: 68197 })).toBe('free')
  })

  it('档位名归一（别名/大小写/分隔符）', () => {
    expect(sodaQualityStageForKey('highest', false)).toBe('free')
    expect(sodaQualityStageForKey('hi_res', true)).toBe('svip')
    expect(sodaQualityStageForKey('HI-RES', true)).toBe('svip')
    expect(sodaQualityStageForKey('lossless', true)).toBe('svip')
    // 未知档位：有 need_vip 就是 vip，否则 free
    expect(sodaQualityStageForKey('mystery', true)).toBe('vip')
    expect(sodaQualityStageForKey('mystery', false)).toBe('free')
  })
})

describe('汽水自动档不上超级会员流（sodaPickStreamForQuality）', () => {
  const svipStream = { url: 'https://cdn/svip.flac', quality: 'lossless', format: 'flac', bitrate: 999000, duration: 200000 }
  const vipStream = { url: 'https://cdn/high.mp3', quality: 'highest', format: 'mp3', bitrate: 320000, duration: 200000 }
  const freeStream = { url: 'https://cdn/std.mp3', quality: 'medium', format: 'mp3', bitrate: 128000, duration: 200000 }

  it('缺省 quality（自动）剔除 SVIP 流，选普通档最优', () => {
    const pick = sodaPickStreamForQuality([svipStream, vipStream, freeStream], '', vipStream)
    expect(pick).toBe(vipStream)
  })

  it('只剩 SVIP 流时放行 fallback（断播比降档更糟）', () => {
    const pick = sodaPickStreamForQuality([svipStream], '', svipStream)
    expect(pick).toBe(svipStream)
  })

  it('显式请求档位不受剔除影响（用户手动选就如实给）', () => {
    const pick = sodaPickStreamForQuality([svipStream, vipStream], 'lossless', svipStream)
    expect(pick).toBe(svipStream)
  })

  it('码率未知但标签是 lossless 的流按 VIP 层级处理，自动档保留（VIP 允许）', () => {
    const unknownBrLossless = { url: 'https://cdn/x.flac', quality: 'lossless', format: 'flac', duration: 200000 }
    // 汽水的会员分层里 lossless 是 need_vip（不是 SVIP），自动档不剔除、就近选档时按请求档位对齐
    expect(sodaStreamRequiredTier(unknownBrLossless)).toBe('vip')
    const pick = sodaPickStreamForQuality([unknownBrLossless, freeStream], '', unknownBrLossless)
    expect(pick).toBe(unknownBrLossless)
  })
})
