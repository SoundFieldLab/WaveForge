/** Generate the 24-bit BMP assets used by the native NSIS setup UI. */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'build', 'ui')
const FONT = 'Microsoft YaHei UI, Microsoft YaHei, SimHei, sans-serif'
const { version: APP_VERSION } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const logoB64 = readFileSync(join(ROOT, 'logo.png')).toString('base64')
const W = 880
const H = 580
const RAIL = 232
const CX = 280
const ANIM_X = 280
const ANIM_Y = 532
const ANIM_W = 600
const ANIM_H = H - ANIM_Y
const FRAME_COUNT = 16
const CLOSE_LEVELS = 6

const THEMES = {
  dark: { bg: '#0F172A', rail: '#101B31', panel: '#162033', panel2: '#1B2940', tx: '#E8EEF8', sub: '#9AAAC0', brand: '#4B91F7', brand2: '#22C7A9', border: '#31425C', edit: '#111C2F' },
  light: { bg: '#F7F9FC', rail: '#101B31', panel: '#FFFFFF', panel2: '#F0F4F9', tx: '#172033', sub: '#607086', brand: '#246BCE', brand2: '#078B77', border: '#CCD6E3', edit: '#FFFFFF' },
}
const PHASES = ['欢迎', '用户协议', '安装目录', '正在安装', '安装完成']

function encodeBmp(width, height, rgb) {
  const rowSize = Math.ceil((width * 3) / 4) * 4
  const buf = Buffer.alloc(54 + rowSize * height)
  buf.write('BM', 0, 'ascii')
  buf.writeUInt32LE(buf.length, 2)
  buf.writeUInt32LE(54, 10)
  buf.writeUInt32LE(40, 14)
  buf.writeInt32LE(width, 18)
  buf.writeInt32LE(height, 22)
  buf.writeUInt16LE(1, 26)
  buf.writeUInt16LE(24, 28)
  buf.writeUInt32LE(rowSize * height, 34)
  for (let y = 0; y < height; y += 1) {
    const src = (height - 1 - y) * width * 3
    const dst = 54 + y * rowSize
    for (let x = 0; x < width; x += 1) {
      buf[dst + x * 3] = rgb[src + x * 3 + 2]
      buf[dst + x * 3 + 1] = rgb[src + x * 3 + 1]
      buf[dst + x * 3 + 2] = rgb[src + x * 3]
    }
  }
  return buf
}

async function svgToRgb(svg, width, height) {
  const { data, info } = await sharp(Buffer.from(svg)).raw().toBuffer({ resolveWithObject: true })
  const rgb = Buffer.alloc(width * height * 3)
  for (let i = 0; i < width * height; i += 1) {
    const p = i * info.channels
    rgb[i * 3] = data[p]
    rgb[i * 3 + 1] = data[p + 1]
    rgb[i * 3 + 2] = data[p + 2]
  }
  return rgb
}

async function svgToBmp(svg, width, height) {
  return encodeBmp(width, height, await svgToRgb(svg, width, height))
}

function cropRgb(rgb, sourceWidth, left, top, width, height) {
  const out = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    const start = ((top + y) * sourceWidth + left) * 3
    rgb.copy(out, y * width * 3, start, start + width * 3)
  }
  return out
}

function esc(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function rail(theme, phase, phaseNames = PHASES) {
  let steps = ''
  phaseNames.forEach((name, index) => {
    const n = index + 1
    const y = 218 + index * 53
    const done = n < phase
    const active = n === phase
    steps += `<circle cx="47" cy="${y}" r="8" fill="${done ? '#22C7A9' : active ? '#4B91F7' : '#33445D'}"/>
      <text x="47" y="${y + 4}" font-family="${FONT}" font-size="10" font-weight="700" fill="#fff" text-anchor="middle">${done ? '✓' : n}</text>
      <text x="72" y="${y + 5}" font-family="${FONT}" font-size="14" font-weight="${active ? 700 : 400}" fill="${active ? '#FFFFFF' : done ? '#A8B8CC' : '#65758B'}">${name}</text>`
  })
  return `<rect width="${W}" height="${H}" fill="${THEMES[theme].bg}"/><rect width="${RAIL}" height="${H}" fill="${THEMES[theme].rail}"/>
    <image href="data:image/png;base64,${logoB64}" x="72" y="28" width="88" height="88"/>
    <text x="116" y="145" font-family="${FONT}" font-size="19" font-weight="700" fill="#fff" text-anchor="middle">WaveForge</text>
    <text x="116" y="168" font-family="${FONT}" font-size="12" fill="#9FC3FF" text-anchor="middle">澜音工坊</text>
    <rect x="46" y="188" width="140" height="2" rx="1" fill="#4B91F7"/>${steps}
    <text x="116" y="488" font-family="${FONT}" font-size="11" fill="#607086" text-anchor="middle">NATIVE SETUP</text>`
}

function heading(theme, title, sub) {
  const t = THEMES[theme]
  return `<text x="${CX}" y="82" font-family="${FONT}" font-size="30" font-weight="700" fill="${t.tx}">${esc(title)}</text>
    <text x="${CX}" y="114" font-family="${FONT}" font-size="13" fill="${t.sub}">${esc(sub)}</text>`
}

function footerBase(theme) {
  const t = THEMES[theme]
  return `<rect x="0" y="${ANIM_Y}" width="${RAIL}" height="${ANIM_H}" fill="${t.rail}"/>
    <rect x="${RAIL}" y="${ANIM_Y}" width="${W - RAIL}" height="${ANIM_H}" fill="${t.bg}"/>
    <text x="116" y="566" font-family="${FONT}" font-size="12" fill="#607086" text-anchor="middle">v${APP_VERSION}</text>`
}

function ambientStrip(theme, frame, yOffset = 0) {
  const t = THEMES[theme]
  const phase = 2 * Math.PI * frame / FRAME_COUNT
  const x1 = 420 + 72 * Math.cos(phase)
  const x2 = 690 + 54 * Math.cos(phase + Math.PI)
  const a1 = (0.105 + 0.025 * Math.sin(phase)).toFixed(4)
  const a2 = (0.075 + 0.018 * Math.sin(phase + Math.PI / 2)).toFixed(4)
  const lineA = (0.12 + 0.025 * Math.sin(phase + Math.PI / 3)).toFixed(4)
  return `<defs><filter id="ambientBlur"><feGaussianBlur stdDeviation="18"/></filter></defs>
    <ellipse cx="${x1.toFixed(2)}" cy="${552 - yOffset}" rx="250" ry="20" fill="${t.brand}" opacity="${a1}" filter="url(#ambientBlur)"/>
    <ellipse cx="${x2.toFixed(2)}" cy="${566 - yOffset}" rx="205" ry="15" fill="${t.brand2}" opacity="${a2}" filter="url(#ambientBlur)"/>
    <path d="M260 ${552 - yOffset}H470 M510 ${562 - yOffset}H632 M674 ${548 - yOffset}H824" stroke="${t.brand}" stroke-width="1" opacity="${lineA}"/>
    <path d="M330 ${569 - yOffset}H414 M590 ${543 - yOffset}H705" stroke="${t.brand2}" stroke-width="1" opacity="${a2}"/>`
}

function windowBorder(theme = 'dark') {
  const color = theme === 'light' ? '#BCC8D7' : '#3B4D67'
  return `<rect x="0.5" y="0.5" width="879" height="579" rx="14" fill="none" stroke="${color}" stroke-width="1"/>`
}

function pageSvg(theme, phase, title, sub, body, phaseNames = PHASES) {
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${rail(theme, phase, phaseNames)}${heading(theme, title, sub)}${body(THEMES[theme])}${footerBase(theme)}${ambientStrip(theme, 0)}${windowBorder(theme)}</svg>`
}

function themePage(frame = 0) {
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="themeBg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#0B1220"/><stop offset=".55" stop-color="#14274D"/><stop offset="1" stop-color="#0A162C"/></linearGradient></defs>
    <rect width="${W}" height="${H}" fill="url(#themeBg)"/><circle cx="440" cy="115" r="180" fill="#2D76DB" opacity=".11"/>
    <image href="data:image/png;base64,${logoB64}" x="388" y="34" width="104" height="104"/>
    <text x="440" y="185" font-family="${FONT}" font-size="32" font-weight="700" fill="#fff" text-anchor="middle">WaveForge 澜音工坊</text>
    <text x="440" y="218" font-family="${FONT}" font-size="13" fill="#A8B8CC" text-anchor="middle">选择界面主题和安装范围</text>
    <rect x="245" y="246" width="390" height="34" rx="8" fill="#0C172B" stroke="#334968"/>
    ${cardSvg(true, false, 138, 304)}${cardSvg(false, false, 458, 304)}
    <rect y="${ANIM_Y}" width="${W}" height="${ANIM_H}" fill="#0A162C"/>${ambientStrip('dark', frame)}
    <text x="440" y="566" font-family="${FONT}" font-size="12" fill="#7890AD" text-anchor="middle">v${APP_VERSION}</text>
    ${windowBorder('dark')}
  </svg>`
}

function cardSvg(dark, hover, x = 0, y = 0) {
  const bg = dark ? (hover ? '#213354' : '#17243D') : (hover ? '#F6FAFF' : '#FFFFFF')
  const tx = dark ? '#FFFFFF' : '#172033'
  const sub = dark ? '#A8B8CC' : '#607086'
  const border = hover ? '#4B91F7' : dark ? '#334968' : '#D5DEE9'
  return `<g transform="translate(${x},${y})"><rect width="284" height="172" rx="8" fill="${bg}" stroke="${border}" stroke-width="${hover ? 2 : 1}"/>
    <text x="24" y="42" font-family="${FONT}" font-size="20" font-weight="700" fill="${tx}">${dark ? '深色模式' : '浅色模式'}</text>
    <text x="24" y="69" font-family="${FONT}" font-size="12" fill="${sub}">${dark ? '沉稳专注，适合低光环境' : '清晰明亮，适合日间使用'}</text>
    ${['#0F172A', '#1E293B', '#4B91F7', '#22C7A9'].map((c, i) => `<rect x="${24 + i * 38}" y="103" width="30" height="22" rx="4" fill="${dark ? c : ['#F7F9FC', '#FFFFFF', '#246BCE', '#078B77'][i]}" stroke="${dark ? '#3B4A62' : '#D7E0EA'}"/>`).join('')}
    <text x="24" y="151" font-family="${FONT}" font-size="11" fill="${hover ? '#4B91F7' : sub}">${hover ? '点击应用此主题  →' : '点击选择'}</text></g>`
}

function wrapText(text, maxChars = 20) {
  const lines = []
  let line = ''
  for (const char of text) {
    if (line.length >= maxChars && /[，。；、：]/.test(char)) {
      lines.push(line + char)
      line = ''
    } else if (line.length >= maxChars + 3) {
      lines.push(line)
      line = char
    } else {
      line += char
    }
  }
  if (line) lines.push(line)
  if (lines.length > 3) throw new Error(`Installer license card text exceeds three lines: ${text}`)
  return lines
}

function licenseBody(t) {
  const sections = [
    ['01  平台、账号与版权', '独立第三方播放器，非官方客户端。Cookie / Token 凭证可能明文存于本机；非官方接口有账号风险。内容版权归平台和权利人。'],
    ['02  联网服务与代理', '音乐功能会访问平台；Apple 跨域请求可能经 api.allorigins.win 转发。歌词会查 Lrclib、AMLL、amlldb。'],
    ['03  天气、地图与定位', '天气地图会访问 Open-Meteo、气象地震源、OpenStreetMap、Photon、Esri、DataV；可能用公网 IP 定位。'],
    ['04  更新与第三方图片', '版本检查会访问 Gitee / GitHub 更新清单；壁纸和背景可能从 Bing 壁纸、风景或动漫图片 API 获取。'],
    ['05  本地数据与使用责任', '凭证、缓存、配置、歌单和分析数据主要存于本机，无系统级加密。不得批量抓取、绕过付费、侵权导出、再分发或商用。'],
    ['06  授权、风险与组件', '软件按“现状”提供。完整许可见随包 THIRD_PARTY_NOTICES.md。'],
  ]
  const cards = sections.map(([title, text], i) => {
    const x = CX + (i % 2) * 278
    const y = 136 + Math.floor(i / 2) * 91
    const lines = wrapText(text).map((line, lineIndex) => `<tspan x="${x + 15}" dy="${lineIndex === 0 ? 0 : 15}">${esc(line)}</tspan>`).join('')
    return `<rect x="${x}" y="${y}" width="268" height="82" rx="7" fill="${t.panel}" stroke="${t.border}"/>
      <rect x="${x}" y="${y}" width="4" height="82" rx="2" fill="${i % 2 ? t.brand2 : t.brand}"/>
      <text x="${x + 15}" y="${y + 23}" font-family="${FONT}" font-size="12" font-weight="700" fill="${i % 2 ? t.brand2 : t.brand}">${title}</text>
      <text x="${x + 15}" y="${y + 43}" font-family="${FONT}" font-size="10" fill="${t.tx}">${lines}</text>`
  }).join('')
  return cards
}

function dirBody(t) {
  return `<rect x="${CX}" y="140" width="560" height="224" rx="8" fill="${t.panel}" stroke="${t.border}"/>
    <rect x="${CX + 20}" y="160" width="42" height="42" rx="7" fill="${t.panel2}" stroke="${t.border}"/>
    <path d="M${CX + 30} 174h9l4 4h10v13H${CX + 30}z" fill="none" stroke="${t.brand}" stroke-width="2" stroke-linejoin="round"/>
    <text x="${CX + 76}" y="177" font-family="${FONT}" font-size="12" font-weight="700" fill="${t.tx}">目标文件夹</text>
    <text x="${CX + 76}" y="196" font-family="${FONT}" font-size="10.5" fill="${t.sub}">可直接编辑或粘贴路径</text>
    <rect x="${CX + 20}" y="216" width="468" height="42" rx="7" fill="${t.edit}" stroke="${t.border}"/>
    <rect x="${CX + 20}" y="278" width="520" height="48" rx="7" fill="${t.panel2}"/>
    <text x="${CX + 36}" y="298" font-family="${FONT}" font-size="10.5" fill="${t.sub}">磁盘与空间</text>
    <circle cx="${CX + 31}" cy="313" r="3" fill="${t.brand2}"/>
    <text x="${CX + 42}" y="317" font-family="${FONT}" font-size="11" fill="${t.tx}">空间数据将根据当前路径实时计算</text>
    <text x="${CX}" y="391" font-family="${FONT}" font-size="11" fill="${t.sub}">安装范围：所选用户范围 · 升级时保留原安装位置</text>`
}

const pages = {
  welcome: [1, '欢迎使用 WaveForge', '准备好你的沉浸式音乐工作台', (t) => `<rect x="${CX}" y="148" width="560" height="246" rx="8" fill="${t.panel}" stroke="${t.border}"/>
    <text x="${CX + 28}" y="184" font-family="${FONT}" font-size="13" font-weight="700" fill="${t.brand}">安装内容</text>
    ${['多平台音乐播放与曲库管理', '无缝衔接、智能混音与音频可视化', '桌面组件、歌词与沉浸式背景', '本地配置、缓存与可选模型支持'].map((x, i) => `<circle cx="${CX + 34}" cy="${220 + i * 42}" r="4" fill="${i % 2 ? t.brand2 : t.brand}"/><text x="${CX + 51}" y="${225 + i * 42}" font-family="${FONT}" font-size="13" fill="${t.tx}">${x}</text>`).join('')}
    <text x="${CX + 28}" y="377" font-family="${FONT}" font-size="10.5" fill="${t.sub}">继续前请关闭正在运行的 WaveForge，以便完整更新程序文件。</text>`],
  license: [2, '重点条款摘要', '本页不替代完整《法律声明与用户协议》；首次启动可查看全文', licenseBody],
  dir: [3, '选择安装位置', '路径可编辑；空间信息将随目录更新', dirBody],
  inst: [4, '正在安装', '正在部署 WaveForge 澜音工坊', (t) => `<rect x="${CX}" y="148" width="560" height="122" rx="8" fill="${t.panel}" stroke="${t.border}"/><text x="${CX + 24}" y="181" font-family="${FONT}" font-size="11" fill="${t.sub}">安装进度</text><rect x="${CX + 24}" y="204" width="512" height="12" rx="6" fill="${t.panel2}"/><text x="${CX + 24}" y="248" font-family="${FONT}" font-size="11" fill="${t.sub}">正在准备文件...</text>`],
  finish: [5, '安装完成', 'WaveForge 已准备就绪', (t) => `<circle cx="560" cy="224" r="58" fill="${t.brand2}" opacity=".12"/><circle cx="560" cy="224" r="38" fill="${t.brand2}"/><path d="M540 224l13 13 28-31" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/><rect x="${CX}" y="310" width="560" height="62" rx="8" fill="${t.panel}" stroke="${t.border}"/><text x="560" y="336" font-family="${FONT}" font-size="11" fill="${t.sub}" text-anchor="middle">安装目录</text>`],
}

function buttonSvg(w, h, text, kind, theme, state) {
  const t = THEMES[theme]
  const primary = kind === 'primary'
  const disabled = state === 'disabled'
  const pressed = state === 'pressed'
  const hover = state === 'hover'
  let fill = primary ? t.brand : t.panel
  let border = primary ? t.brand : t.border
  let fg = primary ? '#FFFFFF' : t.tx
  if (hover) fill = primary ? (theme === 'dark' ? '#66A5FA' : '#175BB8') : t.panel2
  if (pressed) fill = primary ? (theme === 'dark' ? '#2D6FCA' : '#134E9F') : (theme === 'dark' ? '#101A2A' : '#E3E9F1')
  if (disabled) { fill = theme === 'dark' ? '#273449' : '#DCE3EC'; border = fill; fg = theme === 'dark' ? '#718198' : '#8A98AA' }
  const y = pressed ? 1 : 0
  const content = text === '浏览'
    ? `<path d="M${w / 2 - 11} ${17 + y}h9l4 4h10v12h-23z" fill="none" stroke="${fg}" stroke-width="2" stroke-linejoin="round"/>`
    : `<text x="${w / 2}" y="${h / 2 + 5 + y}" font-family="${FONT}" font-size="14" font-weight="600" fill="${fg}" text-anchor="middle">${esc(text)}</text>`
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg"><rect width="${w}" height="${h}" fill="${t.bg}"/><rect x="1" y="${1 + y}" width="${w - 2}" height="${h - 3}" rx="7" fill="${fill}" stroke="${border}"/>${content}</svg>`
}

function checkSvg(w, text, theme, checked, kind) {
  const t = THEMES[theme]
  const accent = kind === 'agreement' ? t.brand : t.brand2
  return `<svg width="${w}" height="34" viewBox="0 0 ${w} 34" xmlns="http://www.w3.org/2000/svg"><rect width="${w}" height="34" fill="${t.bg}"/><rect x="1" y="1" width="32" height="32" rx="7" fill="${checked ? accent : t.panel}" stroke="${checked ? accent : t.border}" stroke-width="1.5"/>${checked ? '<path d="M9 17l6 6 11-13" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>' : ''}<text x="44" y="22" font-family="${FONT}" font-size="13" font-weight="600" fill="${t.tx}">${esc(text)}</text></svg>`
}

function scopeSvg(width, text, selected, hover = false) {
  const bg = '#10203B'
  const border = selected || hover ? '#4B91F7' : '#334968'
  return `<svg width="${width}" height="34" viewBox="0 0 ${width} 34" xmlns="http://www.w3.org/2000/svg"><rect width="${width}" height="34" fill="${bg}"/><circle cx="17" cy="17" r="8" fill="#0C172B" stroke="${border}" stroke-width="1.5"/>${selected ? '<circle cx="17" cy="17" r="4" fill="#4B91F7"/>' : ''}<text x="34" y="21" font-family="${FONT}" font-size="11" fill="#C5D2E3">${esc(text)}</text></svg>`
}

function compositeClose(baseRgb, level) {
  const out = Buffer.from(baseRgb)
  const alpha = level / (CLOSE_LEVELS - 1)
  for (let y = 0; y < 40; y += 1) {
    for (let x = 0; x < 40; x += 1) {
      const distance = Math.hypot(x - 19.5, y - 19.5)
      const circle = Math.max(0, Math.min(1, 15.5 - distance)) * alpha
      const d1 = Math.abs(x - y) / Math.SQRT2
      const d2 = Math.abs(x + y - 39) / Math.SQRT2
      const stroke = distance < 10 && Math.min(d1, d2) < 1.15 ? alpha : 0
      const i = (y * 40 + x) * 3
      if (circle > 0) {
        out[i] = Math.round(out[i] * (1 - circle) + 200 * circle)
        out[i + 1] = Math.round(out[i + 1] * (1 - circle) + 62 * circle)
        out[i + 2] = Math.round(out[i + 2] * (1 - circle) + 77 * circle)
      }
      if (stroke > 0) {
        out[i] = Math.round(out[i] * (1 - stroke) + 255 * stroke)
        out[i + 1] = Math.round(out[i + 1] * (1 - stroke) + 255 * stroke)
        out[i + 2] = Math.round(out[i + 2] * (1 - stroke) + 255 * stroke)
      }
    }
  }
  return out
}

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
const themeRgb = await svgToRgb(themePage(), W, H)
writeFileSync(join(OUT, 'theme.bmp'), encodeBmp(W, H, themeRgb))
for (const name of ['dark', 'light']) {
  const normal = cropRgb(themeRgb, W, name === 'dark' ? 138 : 458, 304, 284, 172)
  const hoverRgb = await svgToRgb(`<svg width="284" height="172" xmlns="http://www.w3.org/2000/svg">${cardSvg(name === 'dark', true)}</svg>`, 284, 172)
  writeFileSync(join(OUT, `card-${name}.bmp`), encodeBmp(284, 172, normal))
  writeFileSync(join(OUT, `card-${name}-hover.bmp`), encodeBmp(284, 172, hoverRgb))
  writeFileSync(join(OUT, `card-${name}-pressed.bmp`), encodeBmp(284, 172, hoverRgb))
}

for (const [name, [phase, title, sub, body]] of Object.entries(pages)) {
  for (const theme of ['dark', 'light']) writeFileSync(join(OUT, `${name}-${theme}.bmp`), await svgToBmp(pageSvg(theme, phase, title, sub, body), W, H))
}

for (const theme of ['dark', 'light']) {
  for (let frame = 0; frame < FRAME_COUNT; frame += 1) {
    const svg = `<svg width="${ANIM_W}" height="${ANIM_H}" viewBox="${ANIM_X} 0 ${ANIM_W} ${ANIM_H}" xmlns="http://www.w3.org/2000/svg">${footerBase(theme).replaceAll(`y="${ANIM_Y}"`, 'y="0"').replace('y="566"', 'y="34"')}${ambientStrip(theme, frame, ANIM_Y)}</svg>`
    writeFileSync(join(OUT, `anim-${theme}-${frame}.bmp`), await svgToBmp(svg, ANIM_W, ANIM_H))
  }
}
for (let frame = 0; frame < FRAME_COUNT; frame += 1) {
  const rgb = await svgToRgb(themePage(frame), W, H)
  writeFileSync(join(OUT, `anim-theme-${frame}.bmp`), encodeBmp(ANIM_W, ANIM_H, cropRgb(rgb, W, ANIM_X, ANIM_Y, ANIM_W, ANIM_H)))
}

const buttons = [['下一步', 'primary', 160], ['同意并继续', 'primary', 200], ['安装', 'primary', 160], ['立即打开', 'primary', 160], ['取消安装', 'secondary', 160], ['上一步', 'secondary', 120], ['完成', 'secondary', 120], ['浏览', 'secondary', 52]]
for (const theme of ['dark', 'light']) {
  for (const [text, kind, width] of buttons) {
    for (const state of ['normal', 'hover', 'pressed', 'disabled']) {
      const suffix = state === 'normal' ? '' : `-${state}`
      writeFileSync(join(OUT, `btn-${kind}-${theme}-${text}${suffix}.bmp`), await svgToBmp(buttonSvg(width, 44, text, kind, theme, state), width, 44))
    }
  }
  for (const [kind, text, width] of [['agreement', '我已阅读并同意完整《法律声明与用户协议》', 380], ['desktop', '创建桌面快捷方式', 260]]) {
    for (const checked of [false, true]) writeFileSync(join(OUT, `${kind}-${theme}-${checked ? 'checked' : 'unchecked'}.bmp`), await svgToBmp(checkSvg(width, text, theme, checked, kind), width, 34))
  }
}
const closePages = {
  theme: themeRgb,
  dark: await svgToRgb(pageSvg('dark', ...pages.welcome), W, H),
  light: await svgToRgb(pageSvg('light', ...pages.welcome), W, H),
}
for (const [theme, page] of Object.entries(closePages)) {
  const base = cropRgb(page, W, 828, 10, 40, 40)
  for (let level = 0; level < CLOSE_LEVELS; level += 1) {
    writeFileSync(join(OUT, `close-${theme}-${level}.bmp`), encodeBmp(40, 40, compositeClose(base, level)))
  }
}
for (const [name, text, width] of [['current', '当前用户', 140], ['all', '所有用户（需要管理员权限）', 220]]) {
  for (const selected of [false, true]) {
    writeFileSync(join(OUT, `scope-${name}-${selected ? 'selected' : 'normal'}.bmp`), await svgToBmp(scopeSvg(width, text, selected), width, 34))
  }
}

const uninstallPages = {
  unconfirm: [1, '卸载 WaveForge', '确认要从此电脑移除程序文件', (t) => `<rect x="${CX}" y="142" width="560" height="250" rx="8" fill="${t.panel}" stroke="${t.border}"/><text x="${CX + 24}" y="180" font-family="${FONT}" font-size="12" font-weight="700" fill="${t.tx}">将移除</text><text x="${CX + 24}" y="208" font-family="${FONT}" font-size="11" fill="${t.sub}">WaveForge 程序文件、开始菜单与桌面快捷方式</text><rect x="${CX + 24}" y="230" width="512" height="1" fill="${t.border}"/><text x="${CX + 24}" y="264" font-family="${FONT}" font-size="12" font-weight="700" fill="${t.brand2}">默认保留本地数据</text><text x="${CX + 24}" y="290" font-family="${FONT}" font-size="11" fill="${t.tx}">配置、登录凭据、缓存、歌单和分析数据不会删除</text><text x="${CX + 24}" y="326" font-family="${FONT}" font-size="10.5" fill="${t.sub}">安装目录</text><text x="${CX + 24}" y="357" font-family="${FONT}" font-size="10.5" fill="${t.sub}">安装范围</text>`],
  uninst: [2, '正在移除组件', '请稍候，卸载器正在清理程序文件', pages.inst[3]],
  unfinish: [3, '卸载完成', 'WaveForge 程序文件已从此电脑移除', pages.finish[3]],
}
const UNINSTALL_PHASES = ['确认卸载', '移除组件', '完成']
for (const [name, page] of Object.entries(uninstallPages)) writeFileSync(join(OUT, `${name}-dark.bmp`), await svgToBmp(pageSvg('dark', ...page, UNINSTALL_PHASES), W, H))
for (const [text, kind, width] of [['开始卸载', 'primary', 160], ['取消', 'secondary', 120], ['完成卸载', 'primary', 160]]) {
  for (const state of ['normal', 'hover', 'pressed', 'disabled']) {
    const suffix = state === 'normal' ? '' : `-${state}`
    writeFileSync(join(OUT, `btn-${kind}-dark-${text}${suffix}.bmp`), await svgToBmp(buttonSvg(width, 44, text, kind, 'dark', state), width, 44))
  }
}

console.log(`Installer UI generated: ${OUT} (${FRAME_COUNT} closed-loop animation frames, ${ANIM_H}px strips)`)
