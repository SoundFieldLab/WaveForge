'use strict'

// 故障注入：cache 根被文件占据（ENOTDIR 全链路故障）时，构造层就应显式拒绝
// （'Unable to initialize audio cache directory'），不崩主进程、可被调用方捕获。
const test = require('node:test')
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { AudioDownloadService } = require('../desktop/audio-download.cjs')

test('fault injection: cache root occupied by a file (ENOTDIR) fails cleanly at construction', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-inject2-'))
  const blocker = path.join(root, 'blocker')
  fs.writeFileSync(blocker, 'I am a file, not a dir')
  // 构造层即拒绝（ensureTempDir/realDirectoryPath 对文件路径抛错）——坏配置在启动时
  // 显式失败，不会带着坏句柄运行；错误可被调用方捕获，进程不崩。
  assert.throws(
    () => new AudioDownloadService(blocker, {}),
    /Unable to initialize audio cache directory/,
  )
  fs.rmSync(root, { recursive: true, force: true })
})
