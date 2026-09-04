'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createDocumentUrlMatcher, createTrustedIpcGuard } = require('../desktop/trusted-ipc.cjs')

function makeWindow(url) {
  const mainFrame = { url }
  const webContents = {
    mainFrame,
    getURL: () => url,
  }
  return {
    webContents,
    isDestroyed: () => false,
    navigate(nextUrl) {
      url = nextUrl
      mainFrame.url = nextUrl
    },
  }
}

function eventFrom(win, frame = win.webContents.mainFrame) {
  return { sender: win.webContents, senderFrame: frame }
}

function createFixture() {
  const windows = {
    main: makeWindow('http://127.0.0.1:3000/'),
    player: makeWindow('http://127.0.0.1:3000/desktop-player.html'),
    lyrics: makeWindow('file:///C:/WaveForge/dist/desktop-lyrics.html'),
    taskbar: makeWindow('file:///C:/WaveForge/desktop/taskbar-widget.html'),
  }
  const guard = createTrustedIpcGuard({
    roles: {
      main: {
        getWindow: () => windows.main,
        isAllowedUrl: createDocumentUrlMatcher([
          'http://127.0.0.1:3000/',
          'file:///C:/WaveForge/dist/index.html',
        ]),
      },
      desktopPlayer: {
        getWindow: () => windows.player,
        isAllowedUrl: createDocumentUrlMatcher(['http://127.0.0.1:3000/desktop-player.html']),
      },
      desktopLyrics: {
        getWindow: () => windows.lyrics,
        isAllowedUrl: createDocumentUrlMatcher(['file:///C:/WaveForge/dist/desktop-lyrics.html']),
      },
      taskbarWidget: {
        getWindow: () => windows.taskbar,
        isAllowedUrl: createDocumentUrlMatcher(['file:///C:/WaveForge/desktop/taskbar-widget.html']),
      },
    },
    capabilities: {
      privileged: ['main'],
      desktopPlayer: ['main', 'desktopPlayer', 'desktopLyrics'],
      desktopLyrics: ['main', 'desktopLyrics'],
      taskbarWidget: ['main', 'taskbarWidget'],
    },
  })
  return { guard, windows }
}

test('trusted main frame can use privileged IPC', () => {
  const { guard, windows } = createFixture()
  assert.equal(guard.isTrusted(eventFrom(windows.main), 'privileged'), true)
  assert.equal(guard.handle('privileged', (_event, value) => value)(eventFrom(windows.main), 42), 42)
})

test('subframes are rejected even when their URL is trusted', () => {
  const { guard, windows } = createFixture()
  const childFrame = { url: windows.main.webContents.mainFrame.url }
  assert.equal(guard.isTrusted(eventFrom(windows.main, childFrame), 'privileged'), false)
  assert.throws(() => guard.assertTrusted(eventFrom(windows.main, childFrame), 'privileged'), /不允许/)
})

test('main window is rejected after navigation to an untrusted origin', () => {
  const { guard, windows } = createFixture()
  windows.main.navigate('https://attacker.example/')
  assert.equal(guard.isTrusted(eventFrom(windows.main), 'privileged'), false)
})

test('auxiliary windows cannot use privileged IPC', () => {
  const { guard, windows } = createFixture()
  assert.equal(guard.isTrusted(eventFrom(windows.player), 'privileged'), false)
  assert.equal(guard.isTrusted(eventFrom(windows.lyrics), 'privileged'), false)
  assert.equal(guard.isTrusted(eventFrom(windows.taskbar), 'privileged'), false)
})

test('auxiliary windows keep only their declared capabilities', () => {
  const { guard, windows } = createFixture()
  assert.equal(guard.isTrusted(eventFrom(windows.player), 'desktopPlayer'), true)
  assert.equal(guard.isTrusted(eventFrom(windows.player), 'desktopLyrics'), false)
  assert.equal(guard.isTrusted(eventFrom(windows.lyrics), 'desktopPlayer'), true)
  assert.equal(guard.isTrusted(eventFrom(windows.lyrics), 'desktopLyrics'), true)
  assert.equal(guard.isTrusted(eventFrom(windows.taskbar), 'taskbarWidget'), true)
  assert.equal(guard.isTrusted(eventFrom(windows.taskbar), 'desktopPlayer'), false)
})
