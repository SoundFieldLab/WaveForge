/**
 * Apple Music 电台直播取流链路自检（Cider/MusicKit v3 同款 /v1/play/assets）
 *
 * 用法：
 *   node scripts/probe-apple-radio.cjs <developerToken> <mediaUserToken> [stationId] [storefront]
 *
 * 或环境变量：
 *   APPLE_DEV_TOKEN / APPLE_MEDIA_TOKEN / APPLE_STATION_ID / APPLE_STOREFRONT
 *
 * stationId 缺省用 Apple Music 1（ra.1351668450）。也可以先跑
 * scripts/diagnose-apple-api.cjs radio 拿电台列表。
 *
 * 依次验证：
 * 1. GET /v1/catalog/{sf}/stations/{id} → attributes.playParams（id/kind/format/…）
 * 2. GET api.music.apple.com/v1/play/assets?<playParams>&keyFormat=web → results.assets[0]
 * 3. 拉 HLS 主清单 → 列出全部变体（codec/bandwidth）→ 选最佳 AAC 变体
 * 4. 拉取媒体清单前若干行（检查 EXT-X-KEY 加密标记）
 *
 * 输出可直接贴给开发者排查。Node 直连与主进程 IPC 等价（无 CORS 问题）。
 */
const STATION_DEFAULT = 'ra.1351668450' // Apple Music 1

const devToken = process.argv[2] || process.env.APPLE_DEV_TOKEN || ''
const mediaToken = process.argv[3] || process.env.APPLE_MEDIA_TOKEN || ''
const stationId = process.argv[4] || process.env.APPLE_STATION_ID || STATION_DEFAULT
const storefront = process.argv[5] || process.env.APPLE_STOREFRONT || 'cn'
if (!devToken || !mediaToken) {
  console.error([
    '用法: node scripts/probe-apple-radio.cjs <developerToken> <mediaUserToken> [stationId] [storefront]',
    '或设置环境变量 APPLE_DEV_TOKEN / APPLE_MEDIA_TOKEN / APPLE_STATION_ID 后直接运行',
  ].join('\n'))
  process.exit(1)
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'
const headers = {
  Authorization: 'Bearer ' + devToken,
  Accept: 'application/json',
  'X-Apple-Music-User-Token': mediaToken,
  Origin: 'https://music.apple.com',
  Referer: 'https://music.apple.com/',
  'User-Agent': UA,
}

async function getJson(url, extraHeaders = {}) {
  const response = await fetch(url, { headers: { ...headers, ...extraHeaders } })
  const text = await response.text()
  let data = null
  try { data = JSON.parse(text) } catch { data = null }
  return { status: response.status, data, text }
}

async function main() {
  console.log(`▶ 0) 电台详情: storefront=${storefront} station=${stationId}`)
  const detail = await getJson(`https://amp-api.music.apple.com/v1/catalog/${encodeURIComponent(storefront)}/stations/${encodeURIComponent(stationId)}`)
  if (!detail.data?.data?.[0]) {
    console.error('✗ 电台详情获取失败:', (detail.text || '').slice(0, 500))
    process.exit(2)
  }
  const resource = detail.data.data[0]
  const attrs = resource.attributes || {}
  console.log('   名称:', attrs.name)
  console.log('   isLive:', attrs.isLive, '| mediaKind:', attrs.mediaKind, '| subType:', attrs.streamingRadioSubType)
  const playParams = attrs.playParams || {}
  console.log('   playParams:', JSON.stringify(playParams))

  console.log('\n▶ 1) /v1/play/assets 取流')
  const params = { keyFormat: 'web' }
  for (const key of ['id', 'kind', 'format', 'stationHash', 'hasDrm', 'mediaType']) {
    if (playParams[key] !== undefined) params[key] = String(playParams[key])
  }
  if (!params.id) params.id = stationId
  if (!params.kind) params.kind = 'radioStation'
  const query = new URLSearchParams(params).toString()
  const playAssets = await getJson(`https://api.music.apple.com/v1/play/assets?${query}`)
  if (!playAssets.data?.results?.assets?.length) {
    console.error('✗ play/assets 失败 HTTP', playAssets.status, ':', (playAssets.text || '').slice(0, 500))
    process.exit(3)
  }
  const asset = playAssets.data.results.assets[0]
  console.log('   HTTP', playAssets.status)
  console.log('   keyServerUrl:', asset.keyServerUrl || '(无)')
  console.log('   widevineKeyCertificateUrl:', asset.widevineKeyCertificateUrl || '(无)')
  console.log('   fairPlayKeyCertificateUrl:', asset.fairPlayKeyCertificateUrl || '(无)')
  const masterUrl = String(asset.url || '')
  console.log('   主清单:', masterUrl)
  if (!masterUrl) {
    console.error('✗ 无 HLS 主清单 URL；响应:', (playAssets.text || '').slice(0, 800))
    process.exit(4)
  }
  const resolvedMaster = masterUrl.startsWith('manifest://') ? masterUrl.replace(/^manifest:\/\//, 'https://') : masterUrl

  console.log('\n▶ 2) 拉取主清单')
  const masterResponse = await fetch(resolvedMaster, { headers: { 'User-Agent': UA } })
  const masterText = await masterResponse.text()
  console.log('   HTTP', masterResponse.status, '长度', masterText.length)
  if (!/^#EXT/.test(masterText)) {
    console.warn('   ⚠ 内容不像 HLS 清单，可能是错误页：', masterText.slice(0, 300))
  }

  const variants = []
  const re = /#EXT-X-STREAM-INF:([^\n]*)[\r\n]+([^\r\n]+)/g
  let match
  while ((match = re.exec(masterText)) !== null) {
    const attrsLine = match[1]
    const uri = String(match[2]).trim()
    if (!uri) continue
    const codec = /CODECS="([^"]*)"/.exec(attrsLine)?.[1] || ''
    const bandwidth = Number(/(?:^|,)BANDWIDTH=(\d+)/.exec(attrsLine)?.[1] || 0)
    const url = /^https?:\/\//.test(uri) ? uri : new URL(uri, resolvedMaster).href
    variants.push({ bandwidth, codec, url })
  }
  console.log('   变体数:', variants.length)
  variants.forEach(v => console.log('   -', v.bandwidth, v.codec, v.url.slice(0, 140)))
  if (variants.length === 0) {
    console.log('   （主清单即媒体清单，直接检查）')
  }
  const aac = variants.filter(v => /mp4a\.40\.2/i.test(v.codec)).sort((a, b) => b.bandwidth - a.bandwidth)
  const best = (aac.length ? aac : [...variants].sort((a, b) => b.bandwidth - a.bandwidth))[0]
  if (best) {
    console.log('\n▶ 3) 媒体清单（前 12 行）:', best.url.slice(0, 140))
    const mediaResponse = await fetch(best.url, { headers: { 'User-Agent': UA } })
    const mediaText = await mediaResponse.text()
    console.log('   HTTP', mediaResponse.status, '长度', mediaText.length)
    mediaText.split('\n').slice(0, 12).forEach(line => console.log('   |', line))
    const keyTag = mediaText.match(/#EXT-X-KEY:[^\n]*/)
    console.log('\n▶ 4) KEY 标记:', keyTag ? keyTag[0] : '无（分段未加密，最理想）')
    if (keyTag) console.log('   密钥 URI:', /URI="([^"]*)"/.exec(keyTag[0])?.[1] || '(无)')
  }
  console.log('\n✓ 电台取流链路验证完成。应用内播放失败则看控制台 [AppleHLS]/[ApplePlayback] 日志。')
}

main().catch(err => {
  console.error('✗ 未捕获异常:', err)
  process.exit(5)
})
