/**
 * WaveForge 自定义安装器 UI 位图生成器
 * 输出 build/ui/ 下所有位图：
 * - 每页全幅背景（880x580，含左侧阶段栏/文案/控件浅色井）
 * - 按钮位图（主/次 × 深浅主题 × 文案）
 * - 主题选择卡片（深/浅）
 * 全部为 24 位 BMP（NSIS LoadImage 可加载）。
 * 运行：node scripts/generate-installer-ui.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const OUT = join(ROOT, 'build', 'ui')
const FONT = 'Microsoft YaHei, SimHei, "Noto Sans CJK SC", sans-serif'

const W = 880
const H = 580
const RAIL = 232
const CX = 280

// 主题色（十六进制 RRGGBB）
const THEMES = {
  dark: { bg: '#0F172A', rail: '#101B31', card: '#1E293B', tx: '#E2E8F0', sub: '#94A3B8', brand: '#3B82F6', well: '#F0F0F0', wellEdit: '#FFFFFF' },
  light: { bg: '#F8FAFC', rail: '#101B31', card: '#FFFFFF', tx: '#0F172A', sub: '#64748B', brand: '#2563EB', well: '#F0F0F0', wellEdit: '#FFFFFF' },
}

// 页面阶段定义（阶段序号从 1 开始）
const PHASES = ['欢迎', '用户协议', '安装目录', '正在安装', '安装完成']

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

// ---------- 组件 ----------

/** 左侧阶段栏（深色固定） */
function railSvg(theme, phase) {
  const rail = THEMES[theme].rail
  let items = ''
  PHASES.forEach((name, i) => {
    const idx = i + 1
    const y = 214 + i * 56
    let marker = '#475569', markerText = '○', label = '#64748B', labelWeight = 400
    if (idx < phase) { marker = '#22C55E'; markerText = '✓'; label = '#94A3B8' }
    else if (idx === phase) { marker = '#3B82F6'; markerText = '●'; label = '#FFFFFF'; labelWeight = 700 }
    items += `<text x="47" y="${y + 18}" font-family='${FONT}' font-size="16" fill="${marker}" text-anchor="middle">${markerText}</text>
<text x="72" y="${y + 18}" font-family='${FONT}' font-size="14" font-weight="${labelWeight}" fill="${label}">${name}</text>`
  })
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
<rect width="${W}" height="${H}" fill="${THEMES[theme].bg}"/>
<rect width="${RAIL}" height="${H}" fill="${rail}"/>
<image href="data:image/png;base64,${logoB64}" x="68" y="26" width="96" height="96"/>
<text x="116" y="152" font-family='${FONT}' font-size="19" font-weight="700" fill="#FFFFFF" text-anchor="middle">WaveForge</text>
<text x="116" y="176" font-family='${FONT}' font-size="12" fill="#9FC3FF" text-anchor="middle">澜音工坊</text>
<rect x="46" y="192" width="140" height="2" rx="1" fill="#3B82F6"/>
${items}
<text x="116" y="566" font-family='${FONT}' font-size="12" fill="#64748B" text-anchor="middle">v0.1.4</text>
</svg>`
}

/** 内容区标题 */
function titleSvg(theme, y, text) {
  const t = THEMES[theme]
  return `<text x="${CX}" y="${y}" font-family='${FONT}' font-size="34" font-weight="700" fill="${t.tx}">${text}</text>`
}
function subSvg(theme, y, text) {
  const t = THEMES[theme]
  return `<text x="${CX}" y="${y}" font-family='${FONT}' font-size="14" fill="${t.sub}">${text}</text>`
}
/** 浅色控件井（供真实默认控件嵌入） */
function wellSvg(x, y, w, h, color = '#F0F0F0') {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${color}"/>`
}

// ---------- 各页背景 ----------

function themePageSvg() {
  // 两张主题卡片直接烤进背景（视觉永远可见），按钮仅作点击层
  const darkCard = cardSvg(true).replace('<svg width="284" height="172" viewBox="0 0 284 172"', '<g transform="translate(138,316)"><svg width="284" height="172" viewBox="0 0 284 172"')
    .replace('</svg>', '</svg></g>')
  const lightCard = cardSvg(false).replace('<svg width="284" height="172" viewBox="0 0 284 172"', '<g transform="translate(458,316)"><svg width="284" height="172" viewBox="0 0 284 172"')
    .replace('</svg>', '</svg></g>')
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#0B1220"/>
    <stop offset="0.5" stop-color="#132449"/>
    <stop offset="1" stop-color="#0A1428"/>
  </linearGradient>
  <radialGradient id="glow" cx="0.5" cy="0.24" r="0.55">
    <stop offset="0" stop-color="#3B82F6" stop-opacity="0.5"/>
    <stop offset="1" stop-color="#3B82F6" stop-opacity="0"/>
  </radialGradient>
</defs>
<rect width="${W}" height="${H}" fill="url(#bg)"/>
<rect width="${W}" height="${H}" fill="url(#glow)"/>
<path d="M-40 470 Q 110 430 260 470 T 560 470 T 860 470 T 1160 470 L 1160 580 L -40 580 Z" fill="#FFFFFF" opacity="0.04"/>
<path d="M-40 505 Q 110 465 260 505 T 560 505 T 860 505 T 1160 505 L 1160 580 L -40 580 Z" fill="#60A5FA" opacity="0.08"/>
<path d="M-40 540 Q 110 500 260 540 T 560 540 T 860 540 T 1160 540 L 1160 580 L -40 580 Z" fill="#FFFFFF" opacity="0.05"/>
<image href="data:image/png;base64,${logoB64}" x="376" y="36" width="128" height="128"/>
<text x="440" y="224" font-family='${FONT}' font-size="36" font-weight="700" fill="#FFFFFF" text-anchor="middle">WaveForge 澜音工坊</text>
<text x="440" y="262" font-family='${FONT}' font-size="14" fill="#94A3B8" text-anchor="middle">选择安装界面风格，点击卡片开始</text>
<line x1="330" y1="300" x2="550" y2="300" stroke="#3B82F6" stroke-width="2" stroke-linecap="round"/>
${darkCard}
${lightCard}
</svg>`
}

function cardSvg(dark, hover) {
  const bg = dark ? (hover ? '#1E2B49' : '#16213A') : '#FFFFFF'
  const tx = dark ? '#FFFFFF' : (hover ? '#1A1A2E' : '#0F172A')
  const sub = dark ? '#94A3B8' : '#64748B'
  const title = dark ? '深色模式' : '浅色模式'
  const desc = dark ? '深邃沉稳 · 适合夜间与专注场景' : '明亮清爽 · 适合白天与办公场景'
  const swatches = dark
    ? ['#0F172A', '#1E293B', '#3B82F6', '#E2E8F0']
    : ['#F8FAFC', '#FFFFFF', '#2563EB', '#0F172A']
  const sw = swatches.map((c, i) => `<rect x="${24 + i * 34}" y="116" width="26" height="18" rx="3" fill="${c}"/>`).join('')
  return `<svg width="284" height="172" viewBox="0 0 284 172" xmlns="http://www.w3.org/2000/svg">
<defs>
  <filter id="cardShadow" x="-25%" y="-25%" width="150%" height="150%">
    <feDropShadow dx="0" dy="8" stdDeviation="14" flood-color="#000000" flood-opacity="0.28"/>
  </filter>
</defs>
<rect width="284" height="172" rx="16" fill="${bg}" filter="url(#cardShadow)"/>
<text x="142" y="46" font-family='${FONT}' font-size="22" font-weight="700" fill="${tx}" text-anchor="middle">${title}</text>
<text x="142" y="92" font-family='${FONT}' font-size="13" fill="${sub}" text-anchor="middle">${desc}</text>
${sw}
<circle cx="142" cy="153" r="4" fill="#3B82F6"/>
</svg>`
}

function lighten(hex, amt) {
  const n = parseInt(hex.slice(1), 16)
  const r = Math.min(255, (n >> 16) + amt)
  const g = Math.min(255, ((n >> 8) & 0xff) + amt)
  const b = Math.min(255, (n & 0xff) + amt)
  return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')
}

function buttonSvg(w, h, text, primary, theme, hover) {
  const t = THEMES[theme]
  const bg1 = primary ? t.brand : (theme === 'dark' ? '#1E293B' : '#FFFFFF')
  const bg2 = primary ? (theme === 'dark' ? '#2563EB' : '#1D4ED8') : (theme === 'dark' ? '#24344D' : '#F1F5F9')
  const fg = primary ? '#FFFFFF' : (theme === 'dark' ? '#E2E8F0' : t.brand)
  const border = primary ? t.brand : (theme === 'dark' ? '#334155' : '#E2E8F0')
  const arrow = primary ? ' →' : ''
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
<defs>
  <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${hover ? lighten(bg1, 22) : bg1}"/>
    <stop offset="1" stop-color="${hover ? lighten(bg2, 22) : bg2}"/>
  </linearGradient>
  ${hover ? '<radialGradient id="hglow" cx="0.5" cy="0.3" r="0.8"><stop offset="0" stop-color="#FFFFFF" stop-opacity="0.35"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></radialGradient>' : ''}
</defs>
${hover ? '<rect width="${w}" height="${h}" rx="10" fill="url(#hglow)"/>' : ''}

<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="10" fill="url(#g)" stroke="${border}" stroke-width="1"/>
<rect x="8" y="4" width="${w - 16}" height="2" rx="1" fill="#FFFFFF" opacity="0.25"/>
<text x="${w / 2}" y="${h / 2 + 7}" font-family='${FONT}' font-size="15" font-weight="600" fill="${fg}" text-anchor="middle">${text}${arrow}</text>
</svg>`
}

function closeSvg() {
  return `<svg width="40" height="40" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
<circle cx="20" cy="21" r="17" fill="#000000" opacity="0.25"/>
<circle cx="20" cy="20" r="16" fill="#1E293B" stroke="#334155" stroke-width="1"/>
<line x1="14" y1="14" x2="26" y2="26" stroke="#94A3B8" stroke-width="2" stroke-linecap="round"/>
<line x1="26" y1="14" x2="14" y2="26" stroke="#94A3B8" stroke-width="2" stroke-linecap="round"/>
</svg>`
}

function waveFooter(theme) {
  return `<path d="M-40 540 Q 110 500 260 540 T 560 540 T 860 540 T 1160 540 L 1160 580 L -40 580 Z" fill="${THEMES[theme].brand}" opacity="0.06"/>
<path d="M-40 560 Q 110 525 260 560 T 560 560 T 860 560 T 1160 560 L 1160 580 L -40 580 Z" fill="#FFFFFF" opacity="0.05"/>`
}

// ---------- 生成 ----------
mkdirSync(OUT, { recursive: true })

// 主题选择页 + 卡片 + 关闭按钮
writeFileSync(join(OUT, 'theme.bmp'), await svgToBmp(themePageSvg(), W, H))
writeFileSync(join(OUT, 'card-dark.bmp'), await svgToBmp(cardSvg(true), 284, 172))
writeFileSync(join(OUT, 'card-light.bmp'), await svgToBmp(cardSvg(false), 284, 172))
// 卡片 hover 版（鼠标悬停提亮，供按钮点击层切换）
writeFileSync(join(OUT, 'card-dark-hover.bmp'), await svgToBmp(cardSvg(true, true), 284, 172))
writeFileSync(join(OUT, 'card-light-hover.bmp'), await svgToBmp(cardSvg(false, true), 284, 172))
writeFileSync(join(OUT, 'close.bmp'), await svgToBmp(closeSvg(), 40, 40))
writeFileSync(join(OUT, 'close.bmp'), await svgToBmp(closeSvg(), 40, 40))
console.log('✅ theme / cards')

// 各页背景
const pages = {
  welcome: (t) => `${railSvg(t, 1)}
${titleSvg(t, 84, '欢迎使用 WaveForge 澜音工坊')}
${subSvg(t, 122, '沉浸式多平台音乐播放器 · 聆听 · 混音 · 共创')}
<rect x="${CX}" y="170" width="560" height="220" rx="16" fill="${THEMES[t].card}" stroke="${THEMES[t].border}" stroke-width="1"/>
<text x="${CX + 32}" y="212" font-family='${FONT}' font-size="15" font-weight="600" fill="${THEMES[t].brand}">●</text>
<text x="${CX + 56}" y="212" font-family='${FONT}' font-size="15" fill="${THEMES[t].tx}">多平台聚合 · 网易云 / QQ / 酷狗 / 汽水 / Spotify / Apple Music</text>
<text x="${CX + 32}" y="256" font-family='${FONT}' font-size="15" font-weight="600" fill="${THEMES[t].brand}">●</text>
<text x="${CX + 56}" y="256" font-family='${FONT}' font-size="15" fill="${THEMES[t].tx}">沉浸式视觉 · 动态壁纸 · 歌词动效 · 频谱可视化</text>
<text x="${CX + 32}" y="300" font-family='${FONT}' font-size="15" font-weight="600" fill="${THEMES[t].brand}">●</text>
<text x="${CX + 56}" y="300" font-family='${FONT}' font-size="15" fill="${THEMES[t].tx}">无缝混音 · 节拍对齐 · 平滑过渡 · 低音增强</text>
<text x="${CX + 32}" y="344" font-family='${FONT}' font-size="15" font-weight="600" fill="${THEMES[t].brand}">●</text>
<text x="${CX + 56}" y="344" font-family='${FONT}' font-size="15" fill="${THEMES[t].tx}">本地智能 · 排行榜 · 歌手 / 专辑 · AI 推荐</text>
<line x1="${CX + 32}" y1="372" x2="${CX + 528}" y2="372" stroke="${THEMES[t].border}" stroke-width="1"/>
<text x="${CX + 280}" y="394" font-family='${FONT}' font-size="12" fill="${THEMES[t].sub}" text-anchor="middle">v0.1.4 · 一步到位，开始你的沉浸聆听</text>`,
  license: (t) => `${railSvg(t, 2)}
${titleSvg(t, 84, '用户协议')}
${subSvg(t, 122, '请仔细阅读以下条款，同意后继续安装')}
${wellSvg(CX, 146, 560, 268, THEMES[t].wellEdit)}
${wellSvg(CX, 436, 420, 26, THEMES[t].well)}`,
  dir: (t) => `${railSvg(t, 3)}
${titleSvg(t, 84, '选择安装位置')}
${subSvg(t, 122, '默认安装到 D:\\WaveForge，你也可以自定义目录')}
<text x="${CX}" y="182" font-family='${FONT}' font-size="14" fill="${THEMES[t].tx}">安装目录</text>
${wellSvg(CX, 200, 440, 36, THEMES[t].wellEdit)}
<text x="${CX}" y="262" font-family='${FONT}' font-size="12" fill="${THEMES[t].sub}">建议安装在 D 盘 · 预计需要 500MB 可用空间</text>
${wellSvg(CX, 292, 400, 26, THEMES[t].well)}`,
  inst: (t) => `${railSvg(t, 4)}
${titleSvg(t, 84, '正在安装')}
${subSvg(t, 122, '正在将 WaveForge 澜音工坊 安装到：')}
<text x="${CX}" y="152" font-family='${FONT}' font-size="14" font-weight="600" fill="${THEMES[t].brand}">D:\\WaveForge</text>
${wellSvg(CX, 210, 560, 12, THEMES[t].well)}
${wellSvg(CX, 244, 560, 26, THEMES[t].well)}`,
  finish: (t) => `${railSvg(t, 5)}
<text x="560" y="170" font-family='${FONT}' font-size="120" fill="#22C55E" text-anchor="middle">✓</text>
${titleSvg(t, 260, '安装完成')}
${subSvg(t, 300, 'WaveForge 澜音工坊 已成功安装到你的电脑')}
<text x="${CX}" y="330" font-family='${FONT}' font-size="12" fill="${THEMES[t].sub}">安装目录：D:\\WaveForge</text>`,
}

for (const [name, svgFn] of Object.entries(pages)) {
  for (const theme of ['dark', 'light']) {
    const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${svgFn(theme)}${waveFooter(theme)}</svg>`
    writeFileSync(join(OUT, `${name}-${theme}.bmp`), await svgToBmp(svg, W, H))
  }
  console.log(`✅ ${name} (dark/light)`)
}

// 按钮位图
const btns = [
  ['下一步', 'primary'], ['同意并继续', 'primary'], ['安装', 'primary'], ['立即打开', 'primary'],
  ['取消安装', 'secondary'], ['上一步', 'secondary'], ['完成', 'secondary'], ['浏览', 'secondary'],
]
for (const theme of ['dark', 'light']) {
  for (const [text, kind] of btns) {
    const w = text === '浏览' ? 110 : (text === '同意并继续' ? 200 : 160)
        const base = `btn-${kind}-${theme}-${text}`
    writeFileSync(join(OUT, base + '.bmp'), await svgToBmp(buttonSvg(w, 44, text, kind === 'primary', theme), w, 44))
    writeFileSync(join(OUT, base + '-hover.bmp'), await svgToBmp(buttonSvg(w, 44, text, kind === 'primary', theme, true), w, 44))

  }
  console.log(`✅ buttons (${theme})`)
}
console.log('完成，输出目录:', OUT)
