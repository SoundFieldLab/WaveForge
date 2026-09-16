// 独立探针：复刻 track_v2 / me 的原始请求，观察当前网络下上游真实响应
const fs = require('fs');
const cfg = JSON.parse(fs.readFileSync(process.env.APPDATA + '/WaveForge 澜音工坊/soda-qr-login.json', 'utf8'));
const COOKIE = cfg.cookie;
const now = Date.now();
const deviceId = String(now);
const baseParams = {
  aid: '386088', app_name: 'luna_pc', region: 'cn', geo_region: 'cn', os_region: 'cn', sim_region: '',
  device_id: deviceId, cdid: '', iid: String(now + 1), version_name: '3.3.0', version_code: '30030000',
  channel: 'official', build_mode: 'master', network_carrier: '', ac: 'wifi', tz_name: 'Asia/Shanghai',
  resolution: '', device_platform: 'windows', device_type: 'Windows', os_version: 'Windows 11', fp: deviceId,
};
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) SodaMusic/3.1.0 Chrome/136 Safari/537.36';
function qs(params) { return Object.entries(params).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&'); }
async function probe(label, url, extraHeaders) {
  const headers = Object.assign({
    Accept: 'application/json,text/plain,*/*',
    'User-Agent': UA,
    Referer: 'https://www.qishui.com/',
    Cookie: COOKIE,
    'x-luna-background-type': 'foreground',
    'x-luna-is-background-req': '0',
    'x-luna-is-local-user': '1',
  }, extraHeaders || {});
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    const t = await r.text();
    console.log('[' + label + '] HTTP ' + r.status + ' ct=' + (r.headers.get('content-type') || '') + ' len=' + t.length);
    console.log('   head: ' + JSON.stringify(t.slice(0, 160)));
  } catch (e) {
    console.log('[' + label + '] FETCH_ERR: ' + (e && e.cause && e.cause.message || e.message));
  }
}
(async () => {
  const sid = process.argv[2] || '7649216937684191259';
  const v2url = 'https://api.qishui.com/luna/pc/track_v2?' + qs(Object.assign({}, baseParams, { track_id: sid, media_type: 'track' }));
  const meurl = 'https://api.qishui.com/luna/pc/me?' + qs(baseParams);
  await probe('track_v2 GET', v2url);
  await probe('me GET', meurl);
  // 对照组：火山公开目录（同网络）
  await probe('对照 volcengine search', 'https://api-vehicle.volcengine.com/v2/search/type?' + qs({ keyword: '周杰伦', search_type: 'music', limit: '3', real_offset: '0', search_source: 'qishui' }));
  process.exit(0);
})().catch(e => { console.log('FAIL', e.message); process.exit(1); });
