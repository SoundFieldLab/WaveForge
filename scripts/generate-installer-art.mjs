/**
 * 生成 NSIS 安装器品牌位图（electron-builder 自动读取）：
 * - build/installerSidebar.bmp  164x314  欢迎/完成页左侧栏
 * - build/installerHeader.bmp   150x57   顶部右侧标题条
 *
 * NSIS MUI2 只认 24 位 BMP，sharp 不支持 BMP 输出，这里手工编码（BGR、自底向上、行对齐 4 字节）。
 * 运行：node scripts/generate-installer-art.mjs（幂等，可重复执行）
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const FONT = 'Microsoft YaHei, SimHei, "Noto Sans CJK SC", sans-serif'

// ── 24 位 BMP 编码（NSIS MUI2 兼容）──
function encodeBmp(width, height, rgb) {
  const rowSize = Math.ceil((width * 3) / 4) * 4
  const pixelDataSize = rowSize * height
  const fileSize = 54 + pixelDataSize
  const buf = Buffer.alloc(fileSize)
  buf.write('BM', 0, 'ascii')
  buf.writeUInt32LE(fileSize, 2)
  buf.writeUInt32LE(54, 10) // 像素数据偏移（BITMAPFILEHEADER+BITMAPINFOHEADER）
  buf.writeUInt32LE(40, 14) // BITMAPINFOHEADER 长度
  buf.writeInt32LE(width, 18)
  buf.writeInt32LE(height, 22)
  buf.writeUInt16LE(1, 26) // planes
  buf.writeUInt16LE(24, 28) // bpp
  buf.writeUInt32LE(pixelDataSize, 34)
  for (let y = 0; y < height; y += 1) {
    const srcRow = (height - 1 - y) * width * 3 // BMP 行自底向上
    const dstRow = 54 + y * rowSize
    for (let x = 0; x < width; x += 1) {
      const si = srcRow + x * 3
      buf[dstRow + x * 3] = rgb[si + 2] // B
      buf[dstRow + x * 3 + 1] = rgb[si + 1] // G
      buf[dstRow + x * 3 + 2] = rgb[si] // R
    }
  }
  return buf
}

async function renderBmp(svg, width, height) {
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

/** ICO 编码（PNG 帧，Vista+ 支持，NSIS Icon 命令可加载） */
function encodeIco(images) {
  const count = images.length
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(count, 4)
  let offset = 6 + count * 16
  const entries = []
  for (const img of images) {
    const e = Buffer.alloc(16)
    e[0] = img.size >= 256 ? 0 : img.size
    e[1] = img.size >= 256 ? 0 : img.size
    e[2] = 0
    e[3] = 0
    e.writeUInt16LE(1, 4) // planes
    e.writeUInt16LE(32, 6) // bpp
    e.writeUInt32LE(img.buffer.length, 8)
    e.writeUInt32LE(offset, 12)
    entries.push(e)
    offset += img.buffer.length
  }
  return Buffer.concat([header, ...entries, ...images.map(item => item.buffer)])
}

const logoB64 = readFileSync(join(ROOT, 'logo.png')).toString('base64')

// ── setup 图标：logo → 多尺寸 ICO（PNG 帧）──
{
  const pngs = []
  for (const size of [256, 128, 64, 48, 32, 16]) {
    pngs.push({ size, buffer: await sharp(join(ROOT, 'logo.png')).resize(size, size).png().toBuffer() })
  }
  writeFileSync(join(ROOT, 'build', 'setup-icon.ico'), encodeIco(pngs))
  console.log('✅ 已生成 setup-icon.ico（logo 多尺寸）')
}

// ── 自定义安装器 UI 用 logo 位图（合成到纯色底，24 位 BMP 无透明通道）──
async function logoOnBg(size, hex) {
  const svg = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${size}" height="${size}" fill="#${hex}"/>
  <image href="data:image/png;base64,${logoB64}" x="0" y="0" width="${size}" height="${size}"/>
</svg>`
  return renderBmp(svg, size, size)
}
writeFileSync(join(ROOT, 'build', 'installerRailLogo.bmp'), await logoOnBg(96, '101B31'))
writeFileSync(join(ROOT, 'build', 'installerHeroLogo.bmp'), await logoOnBg(128, '0F172A'))
console.log('✅ 已生成 installerRailLogo.bmp / installerHeroLogo.bmp')

// ── 侧栏 164x314：深蓝渐变 + 辉光 + 波浪 + logo + 产品名 ──
const sidebarSvg = `<svg width="164" height="314" viewBox="0 0 164 314" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#0b1220"/>
      <stop offset="0.55" stop-color="#152646"/>
      <stop offset="1" stop-color="#0a1428"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.26" r="0.62">
      <stop offset="0" stop-color="#3b82f6" stop-opacity="0.45"/>
      <stop offset="1" stop-color="#3b82f6" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="164" height="314" fill="url(#bg)"/>
  <rect width="164" height="314" fill="url(#glow)"/>
  <image href="data:image/png;base64,${logoB64}" x="27" y="30" width="110" height="110"/>
  <text x="82" y="172" font-family='${FONT}' font-size="20" font-weight="bold" fill="#ffffff" text-anchor="middle">WaveForge</text>
  <text x="82" y="196" font-family='${FONT}' font-size="13" fill="#9fc3ff" text-anchor="middle">澜音工坊</text>
  <rect x="52" y="210" width="60" height="2" rx="1" fill="#3b82f6"/>
  <path d="M-20 236 Q 22 218 62 236 T 150 236 T 250 236 L 250 314 L -20 314 Z" fill="#ffffff" opacity="0.05"/>
  <path d="M-20 258 Q 22 240 62 258 T 150 258 T 250 258 L 250 314 L -20 314 Z" fill="#60a5fa" opacity="0.10"/>
  <path d="M-20 280 Q 22 262 62 280 T 150 280 T 250 280 L 250 314 L -20 314 Z" fill="#ffffff" opacity="0.07"/>
</svg>`

// ── 顶栏 150x57：水平渐变 + 波浪线 + 小 logo ──
const headerSvg = `<svg width="150" height="57" viewBox="0 0 150 57" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="hg" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#14233f"/>
      <stop offset="1" stop-color="#1d3c70"/>
    </linearGradient>
  </defs>
  <rect width="150" height="57" fill="url(#hg)"/>
  <path d="M-10 42 Q 30 28 70 42 T 170 42" stroke="#60a5fa" stroke-opacity="0.35" stroke-width="2" fill="none"/>
  <path d="M-10 51 Q 30 37 70 51 T 170 51" stroke="#ffffff" stroke-opacity="0.16" stroke-width="1.5" fill="none"/>
  <image href="data:image/png;base64,${logoB64}" x="113" y="12" width="32" height="32"/>
</svg>`

const [sidebarBmp, headerBmp] = await Promise.all([
  renderBmp(sidebarSvg, 164, 314),
  renderBmp(headerSvg, 150, 57),
])

mkdirSync(join(ROOT, 'build'), { recursive: true })
writeFileSync(join(ROOT, 'build', 'installerSidebar.bmp'), sidebarBmp)
writeFileSync(join(ROOT, 'build', 'installerHeader.bmp'), headerBmp)
console.log(`✅ 已生成 installerSidebar.bmp (${sidebarBmp.length} B) / installerHeader.bmp (${headerBmp.length} B)`)
