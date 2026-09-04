import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// 启动 API 服务器
const apiServer = spawn('node', [resolve(__dirname, '../local-server.mjs')], {
  stdio: 'inherit',
  shell: true
})

apiServer.on('error', (error) => {
  console.error('API服务器启动失败:', error)
})

apiServer.on('close', (code) => {
  console.log(`API服务器退出，代码: ${code}`)
})
