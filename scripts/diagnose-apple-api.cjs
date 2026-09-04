/**
 * Apple Music amp-api 真实账号诊断（本地自用）
 * 用法: node scripts/diagnose-apple-api.cjs <devToken> <mediaToken> [songTerm]
 *
 * 1) 资料库歌单列表参数变体（定位 400 原因）
 * 2) webPlayback 取流 → 主清单 → 检查是否加密（EXT-X-KEY）
 */
const devToken = process.argv[2] || ''
const mediaToken = process.argv[3] || ''
const term = process.argv[4] || '七里香'
if (!devToken || !mediaToken) {
  console.error('用法: node scripts/diagnose-apple-api.cjs <devToken> <mediaToken> [songTerm]')
  process.exit(1)
}

const AMP = 'https://amp-api.music.apple.com'
const HEADERS = {
  Authorization: `Bearer ${devToken}`,
  'Media-User-Token': mediaToken,
  Accept: 'application/json',
  'Content-Type': 'application/json',
  Origin: 'https://music.apple.com',
  Referer: 'https://music.apple.com/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
}

async function getJson(path) {
  const res = await fetch(`${AMP}${path}`, { headers: HEADERS })
  const text = await res.text()
  let data = null
  try { data = JSON.parse(text) } catch { data = text.slice(0, 300) }
  return { status: res.status, data }
}

async function main() {
  // ── A: 资料库歌单列表参数变体 ──
  console.log('▶ A) 资料库歌单列表参数变体')
  const variants = [
    '/v1/me/library/playlists?limit=100&include=tracks',                 // 我们现在的（400?）
    '/v1/me/library/playlists?limit=100',                                // 去掉 include
    '/v1/me/library/playlists?limit=100&platform=web',                   // web 最小
    '/v1/me/library/playlists?platform=web&limit=100&omit[resource]=autos',
    '/v1/me/library/playlists?sort=type&platform=web&fields[playlists]=lastModifiedDate&include[library-playlists]=catalog&fields[library-playlists]=artwork,dateAdded,name,playParams', // web made-for-you 形
  ]
  for (const v of variants) {
    const r = await getJson(v)
    const count = Array.isArray(r.data?.data) ? r.data.data.length : (typeof r.data === 'object' ? JSON.stringify(r.data).slice(0, 120) : r.data)
    console.log('  HTTP', r.status, '|', v.slice(0, 92))
    if (r.status !== 200) console.log('     body:', typeof count === 'string' ? count : JSON.stringify(count))
  }

  // ── B: webPlayback 取流 + 清单加密检查 ──
  console.log('\n▶ B) webPlayback 取流 → 主清单加密检查 (term=' + term + ')')
  const search = await getJson(`/v1/catalog/cn/search?term=${encodeURIComponent(term)}&types=songs&limit=1`)
  const songId = search.data?.results?.songs?.data?.[0]?.id
  console.log('  搜索命中歌曲:', songId || '(无)')
  if (songId) {
    const wp = await fetch('https://play.itunes.apple.com/WebObjects/MZPlay.woa/wa/webPlayback', {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ salableAdamId: String(songId) }),
    })
    const wpText = await wp.text()
    console.log('  webPlayback HTTP', wp.status)
    let wpData = null
    try { wpData = JSON.parse(wpText) } catch {}
    const item = wpData?.songList?.[0]
    if (!item) {
      console.log('  webPlayback 响应片段:', wpText.slice(0, 300))
      return
    }
    console.log('  keyURLs:', { cert: item['hls-key-cert-url'], server: item['hls-key-server-url'], widevine: item['widevine-cert-url'] })
    const masterUrl = item.attributes?.assetUrl || item.attributes?.offers?.[0]?.hlsUrl || item.assets?.[0]?.URL || ''
    console.log('  主清单:', masterUrl.slice(0, 160))
    if (!masterUrl) return
    const master = await fetch(masterUrl.replace(/^manifest:\/\//, 'https://'), { headers: { 'User-Agent': HEADERS['User-Agent'] } })
    const mt = await master.text()
    console.log('  主清单 HTTP', master.status, '长度', mt.length)
    console.log('  前几行:')
    mt.split('\n').slice(0, 10).forEach(line => console.log('   |', line))
    const keyTag = mt.match(/#EXT-X-KEY:[^\n]*/)
    console.log('  EXT-X-KEY:', keyTag ? keyTag[0] : '（无 → 分段未加密，最理想）')
    const streamInf = mt.match(/#EXT-X-STREAM-INF:[^\n]*/)
    if (streamInf) console.log('  变体示例:', streamInf[0])
  }
}

main().catch(err => { console.error('✗ 异常:', err); process.exit(2) })