// 一次性验证服务器：托管安卓构建产物 dist（SPA fallback），仅供本机/局域网浏览器验证移动端 UI。
// ?spoofua=touch|tv —— 在页面加载前伪装 navigator.userAgent（注入 <script>，产物文件不改动），
// 用于在 PC 浏览器里端到端实测「Android UA → 手机/平板/TV 自动判定」全链路（宽度即真实视口宽）。
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'

const DIST = 'D:/opencode/WaveForge/android/app/src/main/assets/nodejs-project/dist'
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2',
  '.json': 'application/json', '.ico': 'image/x-icon', '.mjs': 'text/javascript; charset=utf-8',
}

const SPOOF_UA = {
  // 普通安卓手机 / Fold（UA 不区分折叠与否——形态由视口宽度决定，Fold 折叠≈360dp、展开≥600dp）
  touch: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  // 无 TV 标记的电视盒子（考验原生 getUiMode 兜底——浏览器里没有该桥，会演示出「误判风险」）
  tvboxUnmarked: 'Mozilla/5.0 (Linux; Android 11; SomeBox) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.0.0 Safari/537.36',
  // UA 自带 TV 标记的电视
  tv: 'Mozilla/5.0 (Linux; Android 11; Redmi TV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.0.0 TV Safari/537.36',
}

createServer((req, res) => {
  const send = (data, type) => {
    res.writeHead(200, {
      'Content-Type': type, 'Content-Length': data.length,
      'Cache-Control': 'no-store', 'Connection': 'close',
    })
    res.end(req.method === 'HEAD' ? undefined : data)
  }
  const sendHtml = (data) => {
    const url = new URL(req.url, 'http://x')
    const ua = SPOOF_UA[url.searchParams.get('spoofua') || '']
    if (!ua) return send(data, 'text/html; charset=utf-8')
    // &sw=393&sh=853 伪装 screen（dp）：模拟设备物理屏（判定走屏幕最小边 sw600dp 语义）
    const sw = Number(url.searchParams.get('sw')) || 0
    const sh = Number(url.searchParams.get('sh')) || 0
    const spoofScreen = sw > 0 && sh > 0
      ? `Object.defineProperty(screen,'width',{get:()=>${sw}});Object.defineProperty(screen,'height',{get:()=>${sh}});`
      : ''
    const spoof = `<script>Object.defineProperty(navigator,'userAgent',{get:()=>${JSON.stringify(ua)}});Object.defineProperty(navigator,'maxTouchPoints',{get:()=>5});${spoofScreen}</script>`
    // 必须注入在应用模块脚本之前执行
    send(Buffer.from(String(data).replace(/<head>/i, `<head>${spoof}`)), 'text/html; charset=utf-8')
  }
  const url = new URL(req.url, 'http://x')
  const file = normalize(join(DIST, url.pathname)).replace(/\\/g, '/')
  if (!file.startsWith(DIST)) { res.writeHead(403, { 'Content-Length': 0 }); res.end(); return }
  stat(file).then(info => {
    if (info.isFile()) return readFile(file).then(d => send(d, MIME[extname(file)] || 'application/octet-stream'))
    throw new Error('dir')
  }).catch(() => {
    readFile(join(DIST, 'index.html')).then(sendHtml).catch(() => {
      res.writeHead(404, { 'Content-Length': 0 }); res.end()
    })
  })
}).listen(3999, '127.0.0.1', () => console.log('dist preview on http://127.0.0.1:3999 (支持 ?spoofua=touch|tv|tvboxUnmarked)'))
