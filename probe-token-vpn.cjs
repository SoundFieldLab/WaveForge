// 用真实会话测当前网络环境下 token 是否被风控失效
const fs = require('fs');
const http = require('http');
const cfg = JSON.parse(fs.readFileSync(process.env.APPDATA + '/WaveForge 澜音工坊/soda-qr-login.json', 'utf8'));
const COOKIE = encodeURIComponent(cfg.cookie || '');
function get(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: 3999, path }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    }).on('error', reject);
  });
}
(async () => {
  const st = await get('/api/soda/status?cookie=' + COOKIE);
  const j = JSON.parse(st.body);
  console.log('[status]', st.status, 'loggedIn=' + j.loggedIn, 'vipLabel=' + (j.membership && j.membership.vipLabel), 'err=' + String(j.error || '').slice(0, 60));
  const up = await get('/api/soda/user/playlists?cookie=' + COOKIE);
  const uj = JSON.parse(up.body);
  console.log('[user/playlists]', up.status, '数量=' + (uj.playlists || []).length);
  if ((uj.playlists || []).length) {
    const target = uj.playlists.find(p => p.trackCount > 0) || uj.playlists[0];
    const td = await get('/api/soda/playlist/tracks?id=' + encodeURIComponent(target.id) + '&cookie=' + COOKIE);
    const tj = JSON.parse(td.body);
    console.log('[tracks ' + String(target.id).slice(0, 18) + ']', td.status, 'count=' + tj.trackCount, 'tracks=' + (tj.tracks || []).length);
    if ((tj.tracks || []).length) {
      const sid = tj.tracks[0].id;
      const su = await get('/api/soda/song/url?id=' + encodeURIComponent(sid) + '&cookie=' + COOKIE);
      const sj = JSON.parse(su.body);
      console.log('[song/url]', su.status, 'playable=' + sj.playable, 'url长度=' + String(sj.url || '').length, 'reason=' + String(sj.reason || ''));
    }
  }
  process.exit(0);
})().catch(e => { console.log('FAIL', e.message); process.exit(1); });
