/**
 * WaveForge 安装器 — 1:1 复刻 SnowLeopard-Vision 安装器视觉
 * 设计元素（逆向自 SnowLeopard-Vision-V2.0-Setup.exe）：
 * - 窗口 896x609
 * - 欢迎页：浅粉底 #FEE8F2 + 金色文字 + 右侧金色功能面板
 * - 安装页：白底 + 顶部/底部"分段进度条"（灰色段）
 * - 完成页：浅粉/白 + 完成文案
 * 输出 build/ui-clone/*.bmp（24 位 BMP，NSIS LoadImage 可加载）
 * 运行：node scripts/generate-installer-clone.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const OUT = join(ROOT, 'build', 'ui-clone')
const FONT = 'Microsoft YaHei, SimHei, "Noto Sans CJK SC", sans-serif'

const W = 896
const H = 609
// 雪豹配色
const PINK = '#FEE8F2'
const WHITE = '#FAFAFA'
const GOLD = '#C79659'
const GOLD_DARK = '#B07D3C'
const SEG_TOP = '#DCDCE1'
const SEG_BOT = '#ECECEC'
const DARK = '#333333'

function encodeBmp(width, height, rgb) {
  const rowSize = Math.ceil((width * 3) / 4) * 4
  const pixelDataSize = rowSize * height
  const fileSize = 54 + pixelDataSize
  const buf = Buffer.alloc(fileSize)
  buf.write('BM', 0, 'ascii')
  buf.writeUInt32LE(fileSize, 2)
  buf.writeUInt32LE(54, 10)
  buf.writeUInt32LE(40, 14)
  buf.writeInt32LE(width, 18)
  buf.writeInt32LE(height, 22)
  buf.writeUInt16LE(1, 26)
  buf.writeUInt16LE(24, 28)
  buf.writeUInt32LE(pixelDataSize, 34)
  for (let y = 0; y < height; y += 1) {
    const srcRow = (height - 1 - y) * width * 3
    const dstRow = 54 + y * rowSize
    for (let x = 0; x < width; x += 1) {
      const si = srcRow + x * 3
      buf[dstRow + x * 3] = rgb[si + 2]
      buf[dstRow + x * 3 + 1] = rgb[si + 1]
      buf[dstRow + x * 3 + 2] = rgb[si]
    }
  }
  return buf
}

async function svgToBmp(svg, width, height) {
  const png = await sharp(Buffer.from(svg)).png().toBuffer()
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true })
  const rgb = Buffer.alloc(width * height * 3)
  for (let i = 0; i < width * height; i += 1) {
    const si = i * info.channels
    rgb[i * 3] = data[si]
    rgb[i * 3 + 1] = data[si + 1]
    rgb[i * 3 + 2] = data[si + 2]
  }
  return encodeBmp(width, height, rgb)
}

const logoB64 = readFileSync(join(ROOT, 'logo.png')).toString('base64')

/** 分段进度条（雪豹签名元素）：顶部一排灰色段 */
function segBarSvg(x, y, w, h, color) {
  const segW = 156
  let segs = ''
  for (let sx = x; sx < x + w; sx += segW) {
    const sw = Math.min(segW, x + w - sx)
    segs += `<rect x="${sx}" y="${y}" width="${sw}" height="${h}" fill="${color}"/>`
  }
  return segs
}

/** 金色圆角按钮 */
function goldBtnSvg(w, h, text) {
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
<defs>
  <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#D9A95C"/>
    <stop offset="1" stop-color="${GOLD_DARK}"/>
  </linearGradient>
</defs>
<rect x="1" y="4" width="${w - 2}" height="${h - 2}" rx="22" fill="#000000" opacity="0.15"/>
<rect width="${w}" height="${h}" rx="22" fill="url(#g)"/>
<text x="${w / 2}" y="${h / 2 + 8}" font-family='${FONT}' font-size="17" font-weight="600" fill="#FFFFFF" text-anchor="middle">${text}</text>
</svg>`
}

/** 白底次按钮（金色描边） */
function whiteBtnSvg(w, h, text) {
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
<rect x="1" y="4" width="${w - 2}" height="${h - 2}" rx="22" fill="#000000" opacity="0.08"/>
<rect width="${w}" height="${h}" rx="22" fill="#FFFFFF" stroke="${GOLD}" stroke-width="1.5"/>
<text x="${w / 2}" y="${h / 2 + 8}" font-family='${FONT}' font-size="16" font-weight="600" fill="${GOLD_DARK}" text-anchor="middle">${text}</text>
</svg>`
}

/** 关闭按钮 */
function closeSvg() {
  return `<svg width="40" height="40" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
<circle cx="20" cy="20" r="17" fill="#000000" opacity="0.10"/>
<circle cx="20" cy="20" r="16" fill="#F6D9E6"/>
<line x1="14" y1="14" x2="26" y2="26" stroke="#B07D3C" stroke-width="2" stroke-linecap="round"/>
<line x1="26" y1="14" x2="14" y2="26" stroke="#B07D3C" stroke-width="2" stroke-linecap="round"/>
</svg>`
}

// ────────────── 欢迎页（浅粉 + 金色 + 右侧功能面板）──────────────
function welcomeSvg() {
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
<rect width="${W}" height="${H}" fill="${PINK}"/>
${segBarSvg(0, 0, W, 5, SEG_TOP)}
${segBarSvg(0, 484, W, 4, SEG_BOT)}
<image href="data:image/png;base64,${logoB64}" x="56" y="64" width="96" height="96"/>
<text x="172" y="106" font-family='${FONT}' font-size="34" font-weight="700" fill="${DARK}">WaveForge 澜音工坊</text>
<text x="172" y="140" font-family='${FONT}' font-size="14" fill="${GOLD_DARK}">沉浸式多平台音乐播放器 · 聆听 · 混音 · 共创</text>
<!-- 右侧功能面板 -->
<rect x="560" y="96" width="280" height="340" rx="16" fill="#FFFFFF" opacity="0.6" stroke="${GOLD}" stroke-width="1.5"/>
<text x="700" y="136" font-family='${FONT}' font-size="18" font-weight="700" fill="${GOLD_DARK}" text-anchor="middle">软件特性</text>
<line x1="600" y1="154" x2="800" y2="154" stroke="${GOLD}" stroke-width="1"/>
<text x="586" y="188" font-family='${FONT}' font-size="14" fill="${GOLD_DARK}">● 多平台聚合</text>
<text x="610" y="214" font-family='${FONT}' font-size="12" fill="#8A6B45">网易云 / QQ / 酷狗 / 汽水 / Spotify / Apple Music</text>
<text x="586" y="248" font-family='${FONT}' font-size="14" fill="${GOLD_DARK}">● 沉浸式视觉</text>
<text x="610" y="274" font-family='${FONT}' font-size="12" fill="#8A6B45">动态壁纸 · 歌词动效 · 频谱可视化</text>
<text x="586" y="308" font-family='${FONT}' font-size="14" fill="${GOLD_DARK}">● 无缝混音</text>
<text x="610" y="334" font-family='${FONT}' font-size="12" fill="#8A6B45">节拍对齐 · 平滑过渡 · 低音增强</text>
<text x="586" y="368" font-family='${FONT}' font-size="14" fill="${GOLD_DARK}">● 本地智能</text>
<text x="610" y="394" font-family='${FONT}' font-size="12" fill="#8A6B45">排行榜 · 歌手 / 专辑 · AI 推荐</text>
<!-- 版本框（左下） -->
<rect x="36" y="436" width="140" height="36" rx="8" fill="#FFFFFF" opacity="0.7" stroke="${GOLD}" stroke-width="1"/>
<text x="106" y="459" font-family='${FONT}' font-size="13" fill="${GOLD_DARK}" text-anchor="middle">v0.1.4</text>
</svg>`
}

// ────────────── 安装进度页（白底 + 分段条）──────────────
function installSvg() {
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
<rect width="${W}" height="${H}" fill="${WHITE}"/>
${segBarSvg(0, 0, W, 5, SEG_TOP)}
${segBarSvg(0, 484, W, 4, SEG_BOT)}
<image href="data:image/png;base64,${logoB64}" x="400" y="120" width="96" height="96"/>
<text x="448" y="260" font-family='${FONT}' font-size="24" font-weight="700" fill="${DARK}" text-anchor="middle">正在安装</text>
<text x="448" y="292" font-family='${FONT}' font-size="13" fill="#8A6B45" text-anchor="middle">正在将 WaveForge 澜音工坊 安装到你的电脑</text>
<!-- 进度条轨道（金色） -->
<rect x="196" y="330" width="504" height="8" rx="4" fill="#F0D9C2"/>
<rect x="36" y="436" width="140" height="36" rx="8" fill="#FFFFFF" stroke="${GOLD}" stroke-width="1"/>
<text x="106" y="459" font-family='${FONT}' font-size="13" fill="${GOLD_DARK}" text-anchor="middle">v0.1.4</text>
</svg>`
}

// ────────────── 完成页 ──────────────
function finishSvg() {
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
<rect width="${W}" height="${H}" fill="${PINK}"/>
${segBarSvg(0, 0, W, 5, SEG_TOP)}
${segBarSvg(0, 484, W, 4, SEG_BOT)}
<text x="448" y="200" font-family='${FONT}' font-size="90" fill="#7BC47F" text-anchor="middle">✓</text>
<text x="448" y="300" font-family='${FONT}' font-size="28" font-weight="700" fill="${DARK}" text-anchor="middle">安装完成</text>
<text x="448" y="334" font-family='${FONT}' font-size="14" fill="#8A6B45" text-anchor="middle">WaveForge 澜音工坊 已成功安装到你的电脑</text>
<rect x="36" y="436" width="140" height="36" rx="8" fill="#FFFFFF" opacity="0.7" stroke="${GOLD}" stroke-width="1"/>
<text x="106" y="459" font-family='${FONT}' font-size="13" fill="${GOLD_DARK}" text-anchor="middle">v0.1.4</text>
</svg>`
}

// ────────────── 生成 ──────────────
mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'welcome.bmp'), await svgToBmp(welcomeSvg(), W, H))
writeFileSync(join(OUT, 'install.bmp'), await svgToBmp(installSvg(), W, H))
writeFileSync(join(OUT, 'finish.bmp'), await svgToBmp(finishSvg(), W, H))
writeFileSync(join(OUT, 'close.bmp'), await svgToBmp(closeSvg(), 40, 40))
writeFileSync(join(OUT, 'btn-start.bmp'), await svgToBmp(goldBtnSvg(200, 44, '开始安装 →'), 200, 44))
writeFileSync(join(OUT, 'btn-open.bmp'), await svgToBmp(goldBtnSvg(200, 44, '立即打开'), 200, 44))
writeFileSync(join(OUT, 'btn-done.bmp'), await svgToBmp(whiteBtnSvg(160, 44, '完成'), 160, 44))
console.log('✅ 克隆 UI 位图已生成 →', OUT)
