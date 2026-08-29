// 多曲目音源可用性普查
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
  const up = await get('/api/soda/user/playlists?cookie=' + COOKIE);
  const uj = JSON.parse(up.body);
  const ids = [];
  for (const p of uj.playlists || []) {
    const td = await get('/api/soda/playlist/tracks?id=' + encodeURIComponent(p.id) + '&limit=50&cookie=' + COOKIE);
    const tj = JSON.parse(td.body);
    for (const t of tj.tracks || []) if (!ids.find(x => x.id === t.id)) ids.push({ id: t.id, name: t.name, artist: t.artist });
    if (ids.length >= 8) break;
  }
  let playable = 0;
  for (const t of ids.slice(0, 8)) {
    const su = await get('/api/soda/song/url?id=' + encodeURIComponent(t.id) + '&quality=high&cookie=' + COOKIE);
    const sj = JSON.parse(su.body);
    const ok = sj.playable && sj.url;
    if (ok) playable++;
    console.log(`[${String(t.name).slice(0,20)}] playable=${sj.playable} urlLen=${String(sj.url||'').length} tier=${sj.requiredTier || '-'} vip=${sj.membership && sj.membership.vipLabel} reason=${sj.reason || '-'} err=${String(sj.error || '').slice(0,50)}`);
  }
  console.log('=== 可播比例:', playable + '/' + Math.min(8, ids.length), '===');
  process.exit(0);
})().catch(e => { console.log('FAIL', e.message); process.exit(1); });
