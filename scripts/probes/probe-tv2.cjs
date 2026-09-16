const fs = require('fs');
const http = require('http');
const cfg = JSON.parse(fs.readFileSync(process.env.APPDATA + '/WaveForge 澜音工坊/soda-qr-login.json', 'utf8'));
const COOKIE = encodeURIComponent(cfg.cookie || '');
function get(path){ return new Promise((res,rej)=>{ http.get({host:'127.0.0.1',port:3999,path},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>res({status:r.statusCode,body:d}));}).on('error',rej);});}
(async()=>{
  const up = await get('/api/soda/user/playlists?cookie=' + COOKIE);
  const uj = JSON.parse(up.body);
  const p = (uj.playlists||[]).find(x=>x.trackCount>0) || uj.playlists[1];
  const td = await get('/api/soda/playlist/tracks?id=' + encodeURIComponent(p.id) + '&cookie=' + COOKIE);
  const tj = JSON.parse(td.body);
  const sid = tj.tracks[0].id;
  const dbg = await get('/api/soda/_debug/trackv2?id=' + encodeURIComponent(sid) + '&cookie=' + COOKIE);
  console.log('TRACK_ID=' + sid);
  console.log(dbg.body.slice(0, 700));
  process.exit(0);
})().catch(e=>{console.log('FAIL',e.message);process.exit(1)});
