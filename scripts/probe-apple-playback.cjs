/**
 * Apple Music 原生音源链路自检（Cider 式 webPlayback + HLS 变体）
 *
 * 用法：
 *   node scripts/probe-apple-playback.cjs <developerToken> <mediaUserToken> <songId> [storefront]
 *
 * 或环境变量：
 *   APPLE_DEV_TOKEN / APPLE_MEDIA_TOKEN / APPLE_SONG_ID
 *
 * 依次验证：
 * 1. POST https://play.itunes.apple.com/WebObjects/MZPlay.woa/wa/webPlayback
 * 2. 解析 songList[0]（keyURLs + 主清单 URL）
 * 3. 拉主清单 → 列出全部变体（codec/bandwidth/URL）→ 选最佳 AAC 变体
 * 4. 拉取媒体清单前若干行（检查 EXT-X-KEY 是否有加密标记）
 *
 * 输出可直接贴给开发者排查。注意：走 Node 直连，请求头与 Chrome 无关；
 * 若 Node 能取到流而应用内失败，那是 CORS/EME 方面问题（看控制台 [AppleHLS]）。
 */
const fs = require('fs')
const path = require('path')

const WEBPLAYBACK_URL = 'https://play.itunes.apple.com/WebObjects/MZPlay.woa/wa/webPlayback'

const devToken = process.argv[2] || process.env.APPLE_DEV_TOKEN || ''
const mediaToken = process.argv[3] || process.env.APPLE_MEDIA_TOKEN || ''
const songId = process.argv[4] || process.env.APPLE_SONG_ID || ''
if (!devToken || !mediaToken || !songId) {
  console.error([
    '用法: node scripts/probe-apple-playback.cjs <developerToken> <mediaUserToken> <songId>',
    '或设置环境变量 APPLE_DEV_TOKEN / APPLE_MEDIA_TOKEN / APPLE_SONG_ID 后直接运行',
  ].join('\n'))
  process.exit(1)
}

async function main() {
  console.log('▶ 1) webPlayback 取流 (songId=' + songId + ')')
  const headers = {
    Authorization: 'Bearer ' + devToken,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-Apple-Music-User-Token': mediaToken,
    Origin: 'https://music.apple.com',
    Referer: 'https://music.apple.com/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  }
  const response = await fetch(WEBPLAYBACK_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ salableAdamId: String(songId) }),
  })
  console.log('   HTTP', response.status)
  const text = await response.text()
  let data = null
  try { data = JSON.parse(text) } catch { data = null }
  if (!response.ok || !data || !Array.isArray(data.songList) || data.songList.length === 0) {
    console.error('✗ webPlayback 失败:', text.slice(0, 500))
    process.exit(2)
  }
  const item = data.songList[0]
  console.log('   songId:', item.songId)
  console.log('   hls-key-cert-url:', item['hls-key-cert-url'])
  console.log('   hls-key-server-url:', item['hls-key-server-url'])
  console.log('   widevine-cert-url:', item['widevine-cert-url'])
  const masterUrl = item.attributes?.assetUrl
    || item.attributes?.offers?.[0]?.hlsUrl
    || item.assets?.[0]?.URL
    || ''
  console.log('   主清单:', masterUrl)
  if (!masterUrl) {
    console.error('✗ 无主清单 URL；响应片段:', text.slice(0, 800))
    process.exit(3)
  }
  const resolvedMaster = masterUrl.startsWith('manifest://') ? masterUrl.replace(/^manifest:\/\//, 'https://') : masterUrl

  console.log('\n▶ 2) 拉取主清单')
  const masterResponse = await fetch(resolvedMaster, { headers: { 'User-Agent': headers['User-Agent'] } })
  const masterText = await masterResponse.text()
  console.log('   HTTP', masterResponse.status, '长度', masterText.length)

  const variants = []
  const re = /#EXT-X-STREAM-INF:([^\n]*)[\r\n]+([^\r\n]+)/g
  let match
  while ((match = re.exec(masterText)) !== null) {
    const attrs = match[1]
    const uri = String(match[2]).trim()
    if (!uri) continue
    const codec = /CODECS="([^"]*)"/.exec(attrs)?.[1] || ''
    const bandwidth = Number(/(?:^|,)BANDWIDTH=(\d+)/.exec(attrs)?.[1] || 0)
    const url = /^https?:\/\//.test(uri) ? uri : new URL(uri, resolvedMaster).href
    variants.push({ bandwidth, codec, url })
  }
  console.log('   变体数:', variants.length)
  variants.forEach(v => console.log('   -', v.bandwidth, v.codec, v.url.slice(0, 140)))

  const aac = variants.filter(v => /mp4a\.40\.2/i.test(v.codec)).sort((a, b) => b.bandwidth - a.bandwidth)
  const best = (aac.length ? aac : [...variants].sort((a, b) => b.bandwidth - a.bandwidth))[0]
  if (!best) {
    console.warn('   ⚠ 无变体，将直接用主清单（可能本身就是媒体清单）')
  } else {
    console.log('\n▶ 3) 媒体清单（前 12 行）:', best.url.slice(0, 140))
    const mediaResponse = await fetch(best.url, { headers: { 'User-Agent': headers['User-Agent'] } })
    const mediaText = await mediaResponse.text()
    console.log('   HTTP', mediaResponse.status, '长度', mediaText.length)
    mediaText.split('\n').slice(0, 12).forEach(line => console.log('   |', line))
    if (!/^#EXT/.test(mediaText)) console.warn('   ⚠ 内容不像 HLS 清单，可能是错误页：', mediaText.slice(0, 200))
    const keyTag = mediaText.match(/#EXT-X-KEY:[^\n]*/)
    console.log('\n▶ 4) KEY 标记:', keyTag ? keyTag[0] : '无（分段未加密，最理想）')
    if (keyTag) console.log('   密钥 URI:', /URI="([^"]*)"/.exec(keyTag[0])?.[1] || '(无)')
    console.log('\n✓ 链路验证完成。可把以上输出交给开发者；应用内失败则看控制台 [AppleHLS] 日志。')
  }
}

main().catch(err => {
  console.error('✗ 未捕获异常:', err)
  process.exit(4)
})