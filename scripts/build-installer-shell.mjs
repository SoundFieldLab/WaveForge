/**
 * 构建 WaveForge WebView2 安装器壳（原生 C# 小程序 + HTML UI）。
 *
 * 产物结构（NSIS 通过 File /r "${BUILD_RESOURCES_DIR}\webui" 整体打进安装包）：
 *   build/webui/WaveForgeSetupUI.exe      壳（.NET 4.8，系统 csc 编译）
 *   build/webui/WebView2Loader.dll        WebView2 加载器（可再分发）
 *   build/webui/Microsoft.Web.WebView2.Core.dll
 *   build/webui/ui/…                      HTML 界面 + logo.js + agreement.js
 *
 * 用法：
 *   npm run gen:installer-shell        构建（build:electron 链自动调用）
 *   npm run preview:setup-ui           构建并打开预览（模拟安装，不写任何系统文件）
 */
import { execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const SRC = join(ROOT, 'installer', 'webui')
const OUT = join(ROOT, 'build', 'webui')
const CSC_FRAMEWORK = join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
// 系统 in-box csc 只支持 C#5，编不过源码里的空条件运算符（?.）；优先用 dotnet SDK 自带 Roslyn。
const CSC_ROSLYN = 'C:\\Program Files\\dotnet\\sdk\\Roslyn\\bincore\\csc.dll'
const DOTNET = 'dotnet'

function findRoslynCsc() {
  const sdks = 'C:\\Program Files\\dotnet\\sdk'
  try {
    const latest = readdirSync(sdks)
      .filter((name) => /^\d+\.\d+/.test(name))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0]
    const candidate = join(sdks, latest, 'Roslyn', 'bincore', 'csc.dll')
    if (latest && existsSync(candidate)) return candidate
  } catch { }
  return null
}

// 安装器协议文案：按语言独立文件（installer/webui/legal/agreements/），与主程序 i18n 解耦
const AGREEMENT_LANGS = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko']
function extractAgreements() {
  const out = {}
  for (const lang of AGREEMENT_LANGS) {
    out[lang] = readFileSync(join(ROOT, 'installer', 'webui', 'legal', 'agreements', lang + '.txt'), 'utf8').replace(/\r\n/g, '\n').trim()
  }
  return out
}

function jsConst(name, value) {
  return `${name}=${JSON.stringify(value)};\n`
}

function main() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const previewOnly = process.argv.includes('--preview')

  const roslyn = findRoslynCsc()
  const useRoslyn = Boolean(roslyn)
  if (!useRoslyn && !existsSync(CSC_FRAMEWORK)) {
    console.error(`未找到 C# 编译器：Roslyn（dotnet SDK）与 ${CSC_FRAMEWORK} 均不可用`)
    process.exit(1)
  }

  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(join(OUT, 'ui'), { recursive: true })

  cpSync(join(SRC, 'ui'), join(OUT, 'ui'), { recursive: true })

  // 子资源指纹：把 index.html 里的 .css/.js 引用替换为 ?v=<内容哈希>，彻底杜绝 WebView2 缓存旧脚本
  {
    const htmlPath = join(OUT, 'ui', 'index.html')
    let ui = readFileSync(htmlPath, 'utf8')

    for (const res of ['styles.css', 'logo.js', 'agreement.js', 'i18n.js', 'host.js', 'intro.js', 'sound.js', 'app.js']) {
      const full = join(OUT, 'ui', res)
      if (!existsSync(full)) continue
      const hash = createHash('md5').update(readFileSync(full)).digest('hex').slice(0, 10)
      ui = ui.split(res).join(res + '?v=' + hash)
    }
    writeFileSync(htmlPath, ui)
  }
  writeFileSync(join(OUT, 'ui', 'logo.js'), jsConst('window.WF_LOGO', `data:image/png;base64,${readFileSync(join(ROOT, 'logo.png')).toString('base64')}`))
  writeFileSync(join(OUT, 'ui', 'agreement.js'), jsConst('window.WF_AGREEMENTS', extractAgreements())
    + jsConst('window.WF_VERSION', pkg.version))

  cpSync(join(SRC, 'shell', 'lib', 'WebView2Loader.dll'), join(OUT, 'WebView2Loader.dll'))
  cpSync(join(SRC, 'shell', 'lib', 'Microsoft.Web.WebView2.Core.dll'), join(OUT, 'Microsoft.Web.WebView2.Core.dll'))

  // Git Bash 会把 “/switch” 当路径转换；统一用 “-switch” + 关闭路径转换。
  // Roslyn 路径下要补 mscorlib/Microsoft.CSharp 引用（旧 csc 隐式自带）。
  const cscArgs = [
    '-nologo',
    '-codepage:65001',
    '-target:winexe',
    '-platform:anycpu',
    '-optimize+',
    `-out:${join(OUT, 'WaveForgeSetupUI.exe')}`,
    `-win32icon:${join(ROOT, 'build', 'setup-icon.ico')}`,
    `-win32manifest:${join(SRC, 'shell', 'app.manifest')}`,
    ...(useRoslyn
      ? (() => {
          const fw = join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319')
          return [
            `-r:${join(fw, 'mscorlib.dll')}`,
            `-r:${join(fw, 'System.dll')}`,
            `-r:${join(fw, 'System.Core.dll')}`,
            `-r:${join(fw, 'System.Drawing.dll')}`,
            `-r:${join(fw, 'System.Windows.Forms.dll')}`,
            `-r:${join(fw, 'System.Web.Extensions.dll')}`,
            `-r:${join(fw, 'Microsoft.CSharp.dll')}`,
          ]
        })()
      : [
          '-r:System.dll',
          '-r:System.Core.dll',
          '-r:System.Drawing.dll',
          '-r:System.Windows.Forms.dll',
          '-r:System.Web.Extensions.dll',
        ]),
    `-r:${join(SRC, 'shell', 'lib', 'Microsoft.Web.WebView2.Core.dll')}`,
    join(SRC, 'shell', 'Program.cs'),
  ]
  if (useRoslyn) {
    execFileSync(DOTNET, [roslyn, ...cscArgs], { stdio: 'inherit', cwd: ROOT, env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
  } else {
    execFileSync(CSC_FRAMEWORK, cscArgs, { stdio: 'inherit', cwd: ROOT, env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
  }

  const k = (p) => Math.ceil(statSync(p).size / 1024)
  console.log(`\n安装器壳构建完成 → ${OUT}`)
  console.log(`  WaveForgeSetupUI.exe ${k(join(OUT, 'WaveForgeSetupUI.exe'))} KB`)
  console.log(`  WebView2Loader.dll   ${k(join(OUT, 'WebView2Loader.dll'))} KB`)
  console.log(`  WebView2.Core.dll    ${k(join(OUT, 'Microsoft.Web.WebView2.Core.dll'))} KB`)

  if (previewOnly || process.argv.includes('--launch')) {
    spawn(join(OUT, 'WaveForgeSetupUI.exe'), ['--preview'], { detached: true, stdio: 'ignore' }).unref()
  }
}

main()
