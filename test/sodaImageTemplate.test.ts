import { describe, expect, it } from 'vitest'
import { sodaTemplatedImageUrl } from '../server/qishui-api.mjs'

/**
 * 上游 URLInfo（{uri, urls[], template_prefix}）→ 可直出图片地址。
 *
 * 为什么值得单测：driven 出一个真 bug——听歌模式「探索更多新模式」的卡片封面全部裂图。
 * 原因是裸 `urls[0] + uri` **不带图片处理模板**，直接请求 404；必须补
 * `~<template_prefix>-image.image`（或退回封面统一在用的 `~c5_NxN.jpg` 裁剪模板）。
 */
describe('汽水图片地址模板补全', () => {
  it('有 template_prefix 时补 ~<prefix>-image.image', () => {
    const url = sodaTemplatedImageUrl({
      uri: 'tos-cn-v-2774c002/abc123',
      urls: ['https://p3-luna.douyinpic.com/img/'],
      template_prefix: 'tplv-b829550vbb',
    })
    expect(url).toBe('https://p3-luna.douyinpic.com/img/tos-cn-v-2774c002/abc123~tplv-b829550vbb-image.image')
  })

  it('没有 template_prefix 时退回传入的裁剪模板', () => {
    const url = sodaTemplatedImageUrl(
      { uri: 'tos-cn-i-x/def456', urls: ['https://p26-luna.douyinpic.com/'] },
      '~c5_375x375.jpg',
    )
    expect(url).toBe('https://p26-luna.douyinpic.com/tos-cn-i-x/def456~c5_375x375.jpg')
  })

  it('已经带模板（含 ~）的地址原样返回，不重复拼接', () => {
    const already = 'https://p3-luna.douyinpic.com/img/x~tplv-b829550vbb-image.image'
    expect(sodaTemplatedImageUrl({ uri: 'x', urls: [already] })).toBe(already)
  })

  it('裸字符串地址按无 prefix 处理', () => {
    expect(sodaTemplatedImageUrl('https://p3-luna.douyinpic.com/aaa.jpg', '~c5_100x100.jpg'))
      .toBe('https://p3-luna.douyinpic.com/aaa.jpg~c5_100x100.jpg')
  })

  it('空输入返回空串，不产出半截 URL', () => {
    expect(sodaTemplatedImageUrl(null)).toBe('')
    expect(sodaTemplatedImageUrl({})).toBe('')
    expect(sodaTemplatedImageUrl({ uri: 'only-uri-no-host' })).toBe('')
  })
})
