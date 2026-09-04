const assert = require('node:assert/strict')
const { existsSync, readFileSync, statSync } = require('node:fs')
const { join } = require('node:path')
const test = require('node:test')

const root = join(__dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const legal = readFileSync(join(root, 'src', 'i18n', 'legal.ts'), 'utf8')
const oobe = readFileSync(join(root, 'src', 'i18n', 'oobe.ts'), 'utf8')
const installer = readFileSync(join(root, 'build', 'installer.nsh'), 'utf8')
const generator = readFileSync(join(root, 'scripts', 'generate-installer-ui.mjs'), 'utf8')
const preview = readFileSync(join(root, 'scripts', 'setup-preview', 'preview.nsi'), 'utf8')
const previewBuild = readFileSync(join(root, 'scripts', 'preview-setup.mjs'), 'utf8')

function block(source, start, end) {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from + start.length)
  assert.notEqual(from, -1, `${start} is missing`)
  assert.notEqual(to, -1, `${end} is missing after ${start}`)
  return source.slice(from, to)
}

function bmpInfo(file) {
  const data = readFileSync(file)
  return { magic: data.toString('ascii', 0, 2), width: data.readInt32LE(18), height: data.readInt32LE(22), bits: data.readUInt16LE(28) }
}

function bmpRgb(file) {
  const data = readFileSync(file)
  const width = data.readInt32LE(18)
  const height = data.readInt32LE(22)
  const offset = data.readUInt32LE(10)
  const rowSize = Math.ceil(width * 3 / 4) * 4
  const rgb = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    const src = offset + (height - 1 - y) * rowSize
    for (let x = 0; x < width; x += 1) {
      rgb[(y * width + x) * 3] = data[src + x * 3 + 2]
      rgb[(y * width + x) * 3 + 1] = data[src + x * 3 + 1]
      rgb[(y * width + x) * 3 + 2] = data[src + x * 3]
    }
  }
  return { width, height, rgb }
}

function pixelDelta(a, b, region = { x: 0, y: 0, width: a.width, height: a.height }) {
  let sum = 0
  for (let y = region.y; y < region.y + region.height; y += 1) for (let x = region.x; x < region.x + region.width; x += 1) {
    const i = (y * a.width + x) * 3
    sum += Math.abs(a.rgb[i] - b.rgb[i]) + Math.abs(a.rgb[i + 1] - b.rgb[i + 1]) + Math.abs(a.rgb[i + 2] - b.rgb[i + 2])
  }
  return sum
}

test('electron-builder keeps assisted install hooks and owns the install section', () => {
  assert.equal(pkg.devDependencies['electron-builder'], '^26.15.3')
  assert.equal(pkg.build.nsis.oneClick, false)
  assert.equal(pkg.build.nsis.allowToChangeInstallationDirectory, false)
  for (const hook of ['customInit', 'customWelcomePage', 'customInstallMode', 'customPageAfterChangeDir', 'customFinishPage', 'customInstall']) {
    assert.match(installer, new RegExp(`!macro ${hook}\\b`))
  }
  assert.doesNotMatch(installer, /^\s*Section(?:End|\s)/m)
  assert.match(installer, /\$isForceMachineInstall/)
  assert.match(installer, /\$isForceCurrentInstall/)
  assert.match(installer, /\$\{StdUtils\.ExecShellAsUser\}/)
  assert.match(installer, /StrCpy \$1 "--updated"/)
  assert.match(installer, /Delete "\$newDesktopLink"/)
})

test('interactive setup is borderless, keyboard accessible, and silent safe', () => {
  assert.match(installer, /MUI_CUSTOMFUNCTION_GUIINIT WaveGuiInit/)
  assert.match(installer, /0xFF3BFFFF/)
  assert.match(installer, /WF_SS_NOTIFY\}\|\$\{WF_WS_TABSTOP/)
  assert.match(installer, /GetAsyncKeyState\(i 13\)/)
  assert.match(installer, /GetAsyncKeyState\(i 32\)/)
  assert.match(installer, /Function WaveKeyboardActivate/)
  assert.match(installer, /close-dark-0\.bmp/)
  assert.ok(existsSync(join(root, 'build', 'ui', 'close-light-5.bmp')))
  assert.match(installer, /WaveCloseTicks >= 20/)
  assert.match(installer, /WaveCloseCurrentImage != \$8[\s\S]*STM_SETIMAGE/)
  assert.doesNotMatch(installer, /ShowWindow \$WaveClose \$\{SW_HIDE\}/)
  assert.match(installer, /\$\{If\} \$\{Silent\}[\s\S]*Return[\s\S]*InitPluginsDir/)
  assert.match(preview, /Function \.onGUIInit[\s\S]*Call WaveGuiInit/)
})

test('license is a summary of the complete in-app agreement with mandatory explicit acceptance', () => {
  const license = block(installer, 'Function WaveLicenseCreate', 'FunctionEnd')
  assert.doesNotMatch(license, /CreateControl "EDIT"|NSD_CreateCheckbox/)
  assert.match(license, /agreement-(?:dark|light)-(?:un)?checked\.bmp/)
  assert.match(installer, /Function WaveLicenseToggle/)
  assert.match(installer, /Function WaveLicenseNext[\s\S]*WaveAgreementState == "1"[\s\S]*Call WaveNext/)
  assert.match(installer, /Function WaveLicenseLeave[\s\S]*WaveAgreementState != "1"[\s\S]*Abort/)
  for (const phrase of ['重点条款摘要', '本页不替代完整《法律声明与用户协议》', '首次启动可查看全文', '我已阅读并同意完整《法律声明与用户协议》']) assert.match(generator, new RegExp(phrase))
  for (const ending of ['内容版权归平台和权利人。', 'Lrclib、AMLL、amlldb。', '可能用公网 IP 定位。', '风景或动漫图片 API 获取。', '再分发或商用。', 'THIRD_PARTY_NOTICES.md。']) assert.match(generator, new RegExp(ending.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(generator, /lines\.length > 3[\s\S]*throw new Error/)
  assert.doesNotMatch(generator, /return lines\.slice\(0, 3\)/)
  assert.doesNotMatch(generator, /默认不做统计或追踪|仅连接对应平台|安装即视为同意/)
})

test('installer legal summary is traceable to legal.ts and OOBE source clauses', () => {
  const mappings = [
    ['Cookie / Token', /Cookie \/ Token/],
    ['api.allorigins.win', /api\.allorigins\.win/],
    ['Lrclib', /Lrclib/],
    ['AMLL', /AMLL/],
    ['Open-Meteo', /Open-Meteo/],
    ['OpenStreetMap', /OpenStreetMap/],
    ['Photon', /Photon/],
    ['Esri', /Esri ArcGIS/],
    ['DataV', /DataV/],
    ['公网 IP 定位', /公网 IP 定位/],
    ['Gitee / GitHub', /Gitee \/ GitHub/],
    ['Bing 壁纸', /Bing 壁纸/],
    ['按“现状”', /按"现状"/],
  ]
  for (const [summaryPhrase, sourcePattern] of mappings) {
    assert.match(generator, new RegExp(summaryPhrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(legal, sourcePattern)
  }
  for (const sourcePhrase of ['非官方接口', '个人非商业', '账号风险', '本机']) assert.match(oobe, new RegExp(sourcePhrase))
})

test('UAC inner and upgrades skip mutable setup pages and preserve builder scope and path', () => {
  const skip = block(installer, 'Function WaveSkipInitialPage', 'FunctionEnd')
  assert.match(skip, /WaveIsUpdate == "1"[\s\S]*Abort/)
  assert.match(installer, /GetOptions.*"--updated"[\s\S]*StrCpy \$WaveIsUpdate "1"/)
  assert.match(installer, /GetOptions.*"\/allusers"[\s\S]*StrCpy \$WaveForceAllUsers "1"/)
  assert.match(skip, /WaveForceAllUsers == "1"[\s\S]*WaveInstallScope "all"[\s\S]*Abort/)
  for (const page of ['WaveThemeCreate', 'WaveWelcomeCreate', 'WaveLicenseCreate']) assert.match(installer, new RegExp(`Function ${page}\\s+Call WaveSkipInitialPage`))
  assert.match(installer, /Function WaveOptionsCreate[\s\S]*WaveIsUpdate == "1"[\s\S]*Abort/)
  const installMode = block(installer, '!macro customInstallMode', '!macroend')
  assert.match(installMode, /\$\{If\} \$WaveIsUpdate != "1"/)
  assert.doesNotMatch(skip, /StrCpy \$INSTDIR/)
})

test('fresh installs prefer a fixed D drive without overriding builder path decisions', () => {
  const init = block(installer, '!macro customInit', '!macroend')
  assert.match(init, /!insertmacro GetDParameter \$1/)
  assert.match(init, /hasPerUserInstallation == "0"/)
  assert.match(init, /hasPerMachineInstallation == "0"/)
  assert.match(init, /GetDriveTypeW\(w "D:\\\\"\)/)
  assert.match(init, /\$2 == 3[\s\S]*StrCpy \$INSTDIR "D:\\WaveForge"/)
  assert.match(init, /!ifdef WF_PREVIEW[\s\S]*StrCpy \$INSTDIR "D:\\WaveForge"/)
  assert.doesNotMatch(block(installer, 'Function WaveSkipInitialPage', 'FunctionEnd'), /StrCpy \$INSTDIR/)
})

test('rounded borderless window uses DWM with a Windows 10 region fallback', () => {
  assert.match(installer, /DwmSetWindowAttribute\(p \$HWNDPARENT, i 33, \*i 2, i 4\)/)
  assert.match(installer, /CreateRoundRectRgn\(i 0, i 0, i \$\{WF_W\}, i \$\{WF_H\}, i 28, i 28\)/)
  assert.match(installer, /SetWindowRgn/)
  assert.match(installer, /WF_WS_CLIPCHILDREN/)
  assert.match(generator, /windowBorder\([\s\S]*rx="14"/)
})

test('custom uninstaller wraps builder pages without replacing its uninstall section', () => {
  assert.match(installer, /!define MUI_CUSTOMFUNCTION_UNGUIINIT un\.WaveUnGuiInit/)
  const unWelcome = block(installer, '!macro customUnWelcomePage', '!macroend')
  assert.match(unWelcome, /UninstPage custom un\.WaveUnConfirmCreate/)
  assert.doesNotMatch(unWelcome, /PAGE_INSTALL_MODE|MUI_PAGE_CUSTOMFUNCTION/)
  assert.match(installer, /!macro customUnInstall[\s\S]*Call un\.WaveUnInstFilesShow/)
  assert.match(installer, /!macro customUninstallPage[\s\S]*UninstPage custom un\.WaveUnFinishCreate/)
  assert.match(installer, /Function un\.WaveSkipDefaultFinish[\s\S]*Abort/)
  assert.match(generator, /默认保留本地数据/)
  assert.match(generator, /配置、登录凭据、缓存、歌单和分析数据不会删除/)
  assert.match(installer, /Function WaveHoverTick\s+System::Call "user32::IsWindowVisible[\s\S]*GetForegroundWindow[\s\S]*GetCursorPos/)
  assert.match(installer, /Function WaveCloseFadeTick[\s\S]*WaveCloseLevel \$WaveCloseLevel \+ 1/)
  assert.match(installer, /NSD_CreateTimer\} WaveCloseFadeTick 40/)
  assert.match(installer, /Function un\.WaveReleasePageImages[\s\S]*WaveUnDeleteImage \$UnWaveBackgroundImage/)
  assert.match(installer, /Function un\.onGUIEnd[\s\S]*WaveUnDeleteImage \$UnWaveClose5/)
  assert.match(installer, /SetWindowRgn[\s\S]*\$0 == 0[\s\S]*DeleteObject\(p r1\)/)
  assert.match(installer, /ReadRegStr \$1 HKLM "\$\{INSTALL_REGISTRY_KEY\}" InstallLocation/)
})

test('directory validation requires a writable local absolute path with free-space headroom', () => {
  const options = block(installer, 'Function WaveOptionsCreate', 'FunctionEnd')
  assert.match(options, /NSD_CreateText/)
  assert.match(options, /GetWindowLongW\(p \$WaveDirEdit, i -16\)/)
  assert.match(options, /NSD_OnChange.*WaveDirectoryChanged/)
  assert.doesNotMatch(options, /NSD_CreateCheckbox/)
  const syntax = block(installer, 'Function WaveValidatePathSyntax', 'FunctionEnd')
  assert.match(syntax, /不支持网络 UNC 路径/)
  assert.match(syntax, /盘符开头的绝对路径/)
  assert.match(syntax, /不支持 Windows 设备路径/)
  assert.match(syntax, /Windows 不允许的字符/)
  assert.match(syntax, /Windows 保留设备名/)
  assert.match(syntax, /GetFullPathNameW/)
  const leave = block(installer, 'Function WaveOptionsLeave', 'FunctionEnd')
  assert.match(leave, /DriveSpace/)
  assert.match(leave, /ESTIMATED_SIZE/)
  assert.match(leave, /IntOp \$3 \$WaveRequiredMb \/ 10/)
  assert.match(leave, /IntOp \$3 \$3 \+ 64/)
  assert.match(leave, /CreateDirectory/)
  assert.match(leave, /GetTempFileName/)
  assert.match(leave, /Delete "\$WaveProbeFile"/)
  assert.match(installer, /desktop-dark-checked\.bmp/)
  assert.match(options, /NSD_CreateText\} 310 226 446 24/)
  assert.match(options, /WaveBrowseButton 776 215 52 44/)
  assert.match(options, /EM_SETSEL\} -1 -1[\s\S]*WF_EM_SCROLLCARET[\s\S]*SetFocus\(p \$WaveNext\)/)
  assert.match(generator, /text === '浏览'[\s\S]*<path/)
})

test('animation uses preloaded closed-loop frames, one throttled timer, and pauses when inactive', () => {
  assert.match(generator, /const ANIM_W = 600/)
  assert.match(generator, /const ANIM_H = H - ANIM_Y/)
  assert.match(generator, /const FRAME_COUNT = 16/)
  assert.match(generator, /2 \* Math\.PI \* frame \/ FRAME_COUNT/)
  assert.doesNotMatch(generator, /wavePaths| Q .* T /)
  assert.match(installer, /WaveLoadAnimationSet Theme theme/)
  assert.match(installer, /WaveLoadAnimationSet Dark dark/)
  assert.match(installer, /WaveLoadAnimationSet Light light/)
  assert.match(installer, /NSD_CreateTimer.*WaveHoverTick 250/)
  assert.doesNotMatch(installer, /NSD_CreateTimer.*WaveAnimationTick/)
  const tick = block(installer, 'Function WaveAnimationTick', 'FunctionEnd')
  assert.doesNotMatch(tick, /LoadImageW|DeleteObject|Invalidate|RedrawWindow/)
  assert.match(tick, /IsWindowVisible/)
  assert.match(tick, /IsIconic/)
  assert.match(tick, /GetForegroundWindow/)
  assert.match(tick, /WaveInstFilesActive == "1"[\s\S]*WaveAnimationTickCount < 5/)
  assert.match(tick, /WaveAnimationTickCount < 1/)
  assert.match(tick, /WaveAnimationFrame % 16/)
  assert.match(tick, /STM_SETIMAGE/)
  const uiTick = block(installer, 'Function WaveHoverTick', 'FunctionEnd')
  assert.match(uiTick, /IsWindowVisible[\s\S]*IsIconic[\s\S]*GetForegroundWindow[\s\S]*GetCursorPos/)
  assert.match(uiTick, /WaveHoverSlot[\s\S]*WaveAnimationTick/)
  const hoverMacro = block(installer, '!macro WaveHoverSlot', '!macroend')
  assert.match(hoverMacro, /\$\{If\} \$\{CURRENT\} != \$8[\s\S]*STM_SETIMAGE/)
  assert.equal((hoverMacro.match(/STM_SETIMAGE/g) || []).length, 1)
  const stop = block(installer, '!macro WavePageStop', '!macroend')
  assert.match(stop, /NSD_KillTimer.*WaveHoverTick/)
  assert.doesNotMatch(stop, /WaveAnimationTick/)
  assert.match(stop, /WaveDeleteImage \$WaveBackgroundImage/)
  assert.match(installer, /Function WaveInstFilesShow[\s\S]*WaveHoverTick 250/)
  const show = block(installer, 'Function WaveInstFilesShow', 'FunctionEnd')
  assert.match(show, /GetDlgItem \$WaveProgressPath \$WavePage 1004/)
  assert.match(show, /目标：\$INSTDIR/)
  assert.doesNotMatch(show, /ShowWindow \$WaveProgressPath \$\{SW_HIDE\}/)
  assert.match(show, /SetWindowTheme/)
  assert.match(show, /WF_PBM_SETBARCOLOR/)
  assert.match(show, /WF_PBM_SETBKCOLOR/)
  for (const theme of ['theme', 'dark', 'light']) {
    const frames = Array.from({ length: 16 }, (_, frame) => bmpRgb(join(root, 'build', 'ui', `anim-${theme}-${frame}.bmp`)))
    for (const frame of frames) assert.deepEqual({ width: frame.width, height: frame.height }, { width: 600, height: 48 })
    const adjacent = Array.from({ length: 15 }, (_, i) => pixelDelta(frames[i], frames[i + 1]))
    const seam = pixelDelta(frames[15], frames[0])
    const average = adjacent.reduce((a, b) => a + b, 0) / adjacent.length
    assert.ok(seam <= average * 1.25, `${theme} loop seam ${seam} exceeds 1.25x adjacent average ${average}`)
  }
  const animationBytes = ['theme', 'dark', 'light'].flatMap((theme) => Array.from({ length: 16 }, (_, frame) => statSync(join(root, 'build', 'ui', `anim-${theme}-${frame}.bmp`)).size)).reduce((a, b) => a + b, 0)
  assert.ok(animationBytes < 5 * 1024 * 1024, `animation assets are too large: ${animationBytes}`)
})

test('all bitmap buttons provide normal, hover, pressed, and disabled art', () => {
  assert.match(installer, /WaveImagePressedTemp/)
  assert.match(installer, /WavePointerDown/)
  assert.match(installer, /btn-primary-\$0-同意并继续-disabled\.bmp/)
  const buttons = [['primary', '下一步'], ['primary', '同意并继续'], ['primary', '安装'], ['primary', '立即打开'], ['secondary', '取消安装'], ['secondary', '上一步'], ['secondary', '完成'], ['secondary', '浏览']]
  for (const theme of ['dark', 'light']) {
    for (const [kind, label] of buttons) {
      for (const suffix of ['', '-hover', '-pressed', '-disabled']) assert.ok(existsSync(join(root, 'build', 'ui', `btn-${kind}-${theme}-${label}${suffix}.bmp`)))
    }
  }
})

test('close behavior is state aware and custom image replacements release GDI objects', () => {
  assert.match(installer, /Function WaveCancel[\s\S]*WaveFinishActive == "1"[\s\S]*Call WaveFinishDone/)
  assert.match(installer, /Function WaveFinishCreate[\s\S]*NSD_CreateLabel\} 304 344 512 18 ""[\s\S]*SetCtlColors \$WaveFinishPath[\s\S]*NSD_SetText\} \$WaveFinishPath "\$INSTDIR"[\s\S]*InvalidateRect/)
  assert.match(installer, /WavePointerWasDown/)
  assert.match(installer, /WaveInstFilesActive == "1"[\s\S]*WavePointerDown != 0[\s\S]*WavePointerWasDown == 0[\s\S]*Call WaveCancel/)
  assert.match(installer, /MUI_ABORTWARNING/)
  assert.match(installer, /!macro WaveReleaseImages/)
  assert.match(installer, /SendMessage \$WaveLicenseCheck \$\{WF_STM_SETIMAGE\} 0 \$5 \$6/)
  assert.match(installer, /SendMessage \$WaveDesktopShortcutControl \$\{WF_STM_SETIMAGE\} 0 \$1 \$2/)
  assert.match(installer, /WaveDeleteImage \$WaveBackgroundImage/)
})

test('generator owns a clean BMP directory and installer tests regenerate assets', () => {
  assert.match(generator, /rmSync\(OUT, \{ recursive: true, force: true \}\)/)
  assert.match(generator, /mkdirSync\(OUT, \{ recursive: true \}\)/)
  assert.match(pkg.scripts['test:installer'], /generate-installer-ui\.mjs/)
  assert.match(pkg.scripts['test:installer'], /installer\.test\.cjs/)
  assert.ok([...require('node:fs').readdirSync(join(root, 'build', 'ui'))].every((name) => name.endsWith('.bmp')))
})

test('preview reuses production UI, supports deterministic review pages, and calculates a real estimated size', () => {
  assert.match(preview, /!include "build\\installer\.nsh"/)
  assert.match(preview, /!define WF_PREVIEW/)
  assert.match(preview, /Section "Preview"/)
  assert.match(preview, /\$\{GetOptions\} \$0 "\/review=" \$ReviewTarget/)
  assert.doesNotMatch(installer, /ReviewTarget|\/review=/)
  for (const target of [
    'theme-hidden', 'theme-hover',
    'welcome-dark', 'welcome-light',
    'license-dark-unchecked', 'license-dark-checked',
    'license-light-unchecked', 'license-light-checked',
    'directory-dark', 'directory-light',
    'progress-dark', 'progress-light',
    'finish-dark', 'finish-light',
  ]) assert.match(preview, new RegExp(`ReviewTarget == "${target}"`))
  for (const callback of ['ReviewThemeCreate', 'ReviewWelcomeCreate', 'ReviewLicenseCreate', 'ReviewDirectoryCreate', 'ReviewInstFilesPre', 'ReviewFinishCreate']) {
    assert.match(preview, new RegExp(`(?:Page custom|MUI_PAGE_CUSTOMFUNCTION_PRE) ${callback}|Function ${callback}`))
  }
  assert.match(preview, /PBM_SETPOS\} 11400 0/)
  assert.match(previewBuild, /directorySize/)
  assert.match(previewBuild, /win-unpacked/)
  assert.match(previewBuild, /DESTIMATED_SIZE/)
})

test('production build generates UI before electron-builder', () => {
  const command = pkg.scripts['build:electron']
  assert.ok(command.indexOf('node scripts/generate-installer-ui.mjs') >= 0)
  assert.ok(command.lastIndexOf('electron-builder --prepackaged') > command.indexOf('node scripts/generate-installer-ui.mjs'))
})

test('full page assets are 880x580 24-bit BMPs', () => {
  for (const page of ['theme', 'welcome-dark', 'welcome-light', 'license-dark', 'license-light', 'dir-dark', 'dir-light', 'inst-dark', 'inst-light', 'finish-dark', 'finish-light']) {
    assert.deepEqual(bmpInfo(join(root, 'build', 'ui', `${page}.bmp`)), { magic: 'BM', width: 880, height: 580, bits: 24 })
  }
})
