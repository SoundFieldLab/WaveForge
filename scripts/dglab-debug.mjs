/**
 * DG-LAB 最小化调试平台启动器：同时拉起调试后端与调试前端。
 *
 * 用法：npm run dglab:debug:all
 * 停止：Ctrl+C（两个子进程一并关闭）
 *
 * 为什么用 launcher 而不是 concurrently：
 * 后端必须先于前端就绪（前端启动即拉曲目列表 / 探测中继），
 * 且两者退出要联动，避免留下占着 3101/31082 的孤儿进程。
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const API_PORT = process.env.DGLAB_DEBUG_API_PORT || '3101'

const children = []
let shuttingDown = false

function launch(label, command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    // 不经 shell：process.execPath 在 Windows 上含空格（C:\Program Files\...），
    // shell:true 会把参数按空格重切，导致「'C:\Program' 不是内部或外部命令」。
    shell: false,
  })
  children.push(child)
  const prefix = `[${label}]`
  const pipe = (stream, isErr) => {
    stream.setEncoding('utf8')
    let buffer = ''
    stream.on('data', (chunk) => {
      buffer += chunk
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        ;(isErr ? process.stderr : process.stdout).write(`${prefix} ${line}\n`)
      }
    })
  }
  pipe(child.stdout, false)
  pipe(child.stderr, true)
  child.on('exit', (code) => {
    if (shuttingDown) return
    process.stdout.write(`${prefix} 进程退出（code=${code}），正在关闭其余进程…\n`)
    shutdown(code ?? 0)
  })
  return child
}

function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) {
    try { child.kill() } catch { /* ignore */ }
  }
  setTimeout(() => process.exit(code), 300)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

async function waitForApi(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${API_PORT}/api/debug/state`, { signal: AbortSignal.timeout(1200) })
      if (res.ok) return true
    } catch {
      /* 还没起来，继续等 */
    }
    await new Promise(r => setTimeout(r, 350))
  }
  return false
}

async function main() {
  process.stdout.write('\n启动 DG-LAB 最小化调试平台…\n\n')
  launch('后端', process.execPath, [path.join('debug-minimal', 'server', 'index.cjs')])
  const ready = await waitForApi()
  if (!ready) {
    process.stdout.write('调试后端未在预期时间内就绪，仍继续启动前端（请检查上方后端输出）。\n')
  }
  launch('前端', process.execPath, [path.join('node_modules', 'vite', 'bin', 'vite.js'), '--config', 'debug-minimal/vite.config.ts'])
  process.stdout.write('\n  调试平台地址：http://127.0.0.1:3100\n  按 Ctrl+C 停止\n\n')
}

void main()
