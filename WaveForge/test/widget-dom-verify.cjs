// 全流程 DOM 验证：推送播放状态 + 设置（模式/暗化/模糊），检查条内按钮、纯享隐藏、图标切换、背景 CSS 变量、展开逻辑。
const { app, BrowserWindow, ipcMain, screen } = require('electron')
const path = require('path')

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
function log(...a) { console.log('[dom]', ...a) }

app.whenReady().then(async () => {
  const d = screen.getPrimaryDisplay()
  const win = new BrowserWindow({
    x: d.bounds.x + 100, y: d.bounds.y + 100, width: 340, height: 40, show: false,
    frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, '../desktop/taskbar-widget-preload.cjs'),
      nodeIntegration: false, contextIsolation: true, sandbox: false,
    },
  })
  const settings = { enabled: true, position: 'right', width: 340, mode: 'normal', darken: false, blur: false }
  ipcMain.handle('taskbar-widget:get-settings', () => settings)
  const actions = []
  ipcMain.on('taskbar-widget:action', (_e, a, p) => actions.push(p === undefined ? a : `${a}:${JSON.stringify(p)}`))
  ipcMain.on('taskbar-widget:set-expanded', (_e, on) => { log('ipc set-expanded ->', on) })
  const errors = []
  win.webContents.on('console-message', (_e, level, message) => {
    if (String(message).includes('Security Warning') || String(message).includes('electronjs.org') || String(message).includes('will not show') || String(message).includes('Content-Security')) return
    if (level >= 3) errors.push(String(message))
  })
  await win.loadFile(path.join(__dirname, '../desktop/taskbar-widget.html'))
  await sleep(400)

  const snap = () => win.webContents.executeJavaScript(`(() => {
    const v = (id) => document.getElementById(id)
    const vis = (el) => el ? getComputedStyle(el).display !== 'none' : 'MISSING'
    return {
      controls: vis(v('controls')), cover: vis(v('cover')), hint: vis(v('expandHint')),
      playShown: getComputedStyle(v('playIcon')).display !== 'none',
      pauseShown: getComputedStyle(v('pauseIcon')).display !== 'none',
      scrim: getComputedStyle(document.getElementById('root')).backgroundColor,
      backdrop: getComputedStyle(document.getElementById('root')).backdropFilter,
      popupBg: getComputedStyle(document.getElementById('popupPanel')).backgroundColor,
      line: v('linePrimary').textContent,
    }
  })()`)

  // 1) 播放状态推送（normal 模式，未开背景）
  win.webContents.send('taskbar-widget:state', {
    title: '测试歌曲', artist: '歌手', cover: '', playing: true, cur: 10, dur: 240,
    muted: false, accent: '#FB7299', theme: 'dark',
    lyric: { line: '第一句歌词', lineStart: 0, words: [{ word: '第一句', startTime: 0, duration: 800 }] },
  })
  await sleep(300)
  log('normal mode:', JSON.stringify(await snap()))

  // 2) 开启暗化 + 模糊
  settings.darken = true; settings.blur = true
  win.webContents.send('taskbar-widget:settings', { ...settings })
  await sleep(200)
  const s2 = await snap()
  log('darken+blur:', 'scrim=', s2.scrim, 'backdrop=', s2.backdrop, 'popupBg=', s2.popupBg)

  // 3) 纯享模式
  settings.mode = 'pure'
  win.webContents.send('taskbar-widget:settings', { ...settings })
  await sleep(200)
  log('pure mode:', JSON.stringify(await snap()))

  // 4) 切回 normal，合成点击条内按钮 + 根区域展开
  settings.mode = 'normal'
  win.webContents.send('taskbar-widget:settings', { ...settings })
  await sleep(200)
  await win.webContents.executeJavaScript(`(() => {
    document.getElementById('prev').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    document.getElementById('play').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    document.getElementById('next').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return 'clicked bar controls'
  })()`)
  await sleep(200)
  log('actions after bar clicks:', JSON.stringify(actions))
  const popupState = await win.webContents.executeJavaScript(`({
    open: document.getElementById('popup').classList.contains('open'),
    hint: getComputedStyle(document.getElementById('expandHint')).display,
  })`)
  log('popup after bar clicks (should be closed):', JSON.stringify(popupState))

  // 5) mousedown 兜底展开
  await win.webContents.executeJavaScript(`(() => {
    const root = document.getElementById('root')
    const rect = root.getBoundingClientRect()
    root.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: rect.left + 10, clientY: rect.top + 10 }))
    return 'mousedown sent'
  })()`)
  await sleep(200)
  const afterMousedown = await win.webContents.executeJavaScript(`document.getElementById('popup').classList.contains('open')`)
  log('popup open after root mousedown:', afterMousedown)

  // 6) 弹层按钮动作
  await win.webContents.executeJavaScript(`(() => {
    document.getElementById('popVol').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    document.getElementById('popClose').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return 'popup buttons clicked'
  })()`)
  await sleep(200)
  log('actions after popup clicks:', JSON.stringify(actions))
  log('page errors:', errors.length ? JSON.stringify(errors) : 'none')
  app.exit(0)
}).catch((e) => { console.error('[dom] fatal:', e); app.exit(1) })
