import { describe, expect, it } from 'vitest'
import { resizeArtworkSource } from '../src/services/artwork'

// 网易云封面常带 `enlarge=1|imageView=1` 与无值参数 `watermark`。
// 早期实现用 new URL() 往返重编码，会把 `=` 变 %3D、`watermark` 变 `watermark=`，
// 上游返回 400 → 发现页大量封面加载失败。这里锁定「原样拼接」的行为。
describe('网易云封面 URL 缩放', () => {
  it('保留原始编码，只追加 param', () => {
    const raw = 'https://p1.music.126.net/abc==/109951170463839462.jpg?imageView=1&thumbnail=800y800&enlarge=1%7CimageView=1&watermark&type=1&image=abc%3D%3D&dx=0&dy=0%7Cwatermark'
    const resized = resizeArtworkSource(raw, 300)
    expect(resized.startsWith(raw)).toBe(true)
    expect(resized.slice(raw.length)).toMatch(/^&param=\d+y\d+$/)
    expect(resized).not.toContain('%3D1&watermark=')
  })

  it('无 query 时用 ? 拼接', () => {
    const raw = 'https://p1.music.126.net/abc==/109951170463839462.jpg'
    const resized = resizeArtworkSource(raw, 300)
    expect(resized.startsWith(raw)).toBe(true)
    expect(resized.slice(raw.length)).toMatch(/^\?param=\d+y\d+$/)
  })

  // 同一张图会被解析两次（CachedImage 先解析出渲染地址，preloadArtwork 再解析一次），
  // 若第二次是追加 param，两次结果就不相等，组件会判定加载结果与当前地址不一致，
  // 一直停在空占位符（实测歌单详情封面整块空白）。
  it('可重复解析：同一 URL 解析两次结果一致', () => {
    const raw = 'https://p3.music.126.net/0a0pbgd36PnYb-OoqfkJoA==/109951170193415929.jpg'
    const once = resizeArtworkSource(raw, 256)
    expect(resizeArtworkSource(once, 256)).toBe(once)
    expect(once).not.toContain('param=256y256&param=256y256')
  })

  it('已有 param 时替换数值而不是叠加', () => {
    const raw = 'https://p3.music.126.net/abc==/1.jpg?param=300y300'
    expect(resizeArtworkSource(raw, 128)).toBe('https://p3.music.126.net/abc==/1.jpg?param=128y128')
  })

  it('已有 param 且带其它参数时只替换 param', () => {
    const raw = 'https://p3.music.126.net/abc==/1.jpg?imageView=1&param=300y300&enlarge=1'
    expect(resizeArtworkSource(raw, 512)).toBe('https://p3.music.126.net/abc==/1.jpg?imageView=1&param=512y512&enlarge=1')
  })
})
