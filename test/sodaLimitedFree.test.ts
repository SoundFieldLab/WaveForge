import { describe, expect, it } from 'vitest'
import { mapSodaMedia } from '../server/qishui-api.mjs'

/**
 * 限免（limited_free）透传回归。
 *
 * 背景：汽水把「VIP 曲但当前可免费整首听」的凭证放在**列表/推荐流条目**的
 * `entity.track_wrapper.limited_free_info` 上（track_v2 那侧返回 null）。这份凭证必须整份透传给
 * 前端、再整份回传给 track_v2 的 `limited_free_param`，服务端才把 29s 试听流换成整曲。
 * 实测（客户端接口层）：整份传有效；只传 sign+sign_version 无效；改 expire_time 无效；
 * 跨曲复用 sign 无效——sign(v2.0) 签的是整个对象且与曲目绑定。
 *
 * 本测试锁的是「后端有没有把它透出来」这一环——漏了它，前端拿不到凭证，
 * 限免曲在 waveforge 里就永远只响 29 秒。
 */
const limitedFreeInfo = {
  queue_types: null,
  limited_free: true,
  expire_time: 1791558530,
  sign: 'a3a13162eac0946c09fe40ffbb44f981',
  sign_version: '2.0',
  limited_free_type: '',
  config: { rewind_previous_preview_popup: { intercept_type: 'vip' } },
  rewind_prev_intercept_type: 'only_sell',
  intercept_type: 'vip',
  track_value: '',
}

const wrapperItem = (limitedFree) => ({
  entity: {
    track_wrapper: Object.assign(
      {
        track: {
          id: '6968439713325680641',
          name: '又三郎',
          duration: 227732,
          artists: [{ id: '123', name: 'ヨルシカ' }],
          album: { id: '456', name: 'Matasaburo' },
          label_info: { only_vip_playable: true },
        },
      },
      limitedFree ? { limited_free_info: limitedFree } : {},
    ),
  },
})

describe('汽水限免凭证透传', () => {
  it('limited_free=true 时整份透出凭证，并标记 limitedFree', () => {
    const song = mapSodaMedia(wrapperItem(limitedFreeInfo), 0)
    expect(song).toBeTruthy()
    expect(song.limitedFree).toBe(true)
    expect(song.limitedFreeInfo).toEqual(limitedFreeInfo)
    // sign 是整份校验的，一个字段都不能掉
    expect(song.limitedFreeInfo.sign).toBe(limitedFreeInfo.sign)
    expect(song.limitedFreeInfo.sign_version).toBe('2.0')
    expect(song.limitedFreeInfo.expire_time).toBe(limitedFreeInfo.expire_time)
    expect(song.limitedFreeInfo.config).toEqual(limitedFreeInfo.config)
  })

  it('条目不带宽免信息时不编造', () => {
    const song = mapSodaMedia(wrapperItem(null), 0)
    expect(song.limitedFree).toBeUndefined()
    expect(song.limitedFreeInfo).toBeUndefined()
  })

  it('limited_free=false（如 only_sell 的付费曲）不算限免', () => {
    const notFree = Object.assign({}, limitedFreeInfo, { limited_free: false, limited_free_type: 'only_sell' })
    const song = mapSodaMedia(wrapperItem(notFree), 0)
    // 关键：不能因为「有这个对象」就当限免——必须以 limited_free 为准，
    // 否则会把只能试听的付费曲当成可整曲播放
    expect(song.limitedFree).toBeUndefined()
    expect(song.limitedFreeInfo).toBeUndefined()
  })

  it('VIP 标记与限免标记相互独立', () => {
    const free = mapSodaMedia(wrapperItem(limitedFreeInfo), 0)
    // VIP 专享曲 + 当前限免 = 客户端显示「限免」角标；两个标记都要在
    expect(free.onlyVipPlayable).toBe(true)
    expect(free.limitedFree).toBe(true)
  })
})
