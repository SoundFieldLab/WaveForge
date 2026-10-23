#!/usr/bin/env node
'use strict'

const { createHeadTrackingBridge } = require('./lib/head-tracking-osc.cjs')

const HELP = `HSE 本机 OSC 头追桥

用法:
  node scripts/head-tracking-bridge.cjs [选项]

选项:
  --osc-port <端口>     UDP OSC 监听端口，默认 9000
  --ws-port <端口>      WebSocket 监听端口，默认 8989
  --path <路径>         WebSocket 订阅路径，默认 /pose
  --max-hz <1..240>     输出频率上限，默认 60 Hz；每帧仅发最新完整姿态
  --help, -h            显示本说明

固定绑定 127.0.0.1；无远程绑定、远程连接、UDP 回发或消息转发功能。
在 HSE 头追设置连接 ws://127.0.0.1:8989/pose，OSC 发送端同机发往
127.0.0.1:9000。Ctrl+C 或 SIGTERM 会停止服务并释放监听端口。

OSC 协议:
  /hse/pose 或 /head/pose : yaw, pitch, roll [, timestamp]
  /yaw、/pitch、/roll     : 对应轴值 [, timestamp]
  类型标签接受 f(float32)、i(int32)，时间戳可用 d(float64)，均为大端。
  三轴单位为度，右转/抬头/右倾为正；yaw/roll 范围 -360..360，
  pitch 范围 -90..90。timestamp 为发送设备单调毫秒，重复/倒序值丢弃。
  分轴输入收到三轴后才输出；不能混用多个 OSC 发送端拼成一个姿态。
  WebSocket 输出 {"yaw":25,"pitch":3,"roll":-2,"timestamp":1234.5}，
  timestamp 是桥进程的单调毫秒，HSE 页面负责校准和姿态平滑。

Bundle:
  支持 #bundle、64 位 NTP timetag（1900 起秒数+32位小数）；(0,1)
  表示立即执行。未来 bundle 最多提前 5 秒，按 timetag 后在输出帧合流；
  嵌套子时间不得早于父时间，嵌套立即标签继承父时间。过去时间立即执行。
  限制：单包 8192 字节、嵌套 4 层、单包 64 条、待调度 64 条、
  输入每秒 1000 包（突发容量 1000）、8 个本机订阅者；超额丢弃。
  畸形字符串/非零填充/截断/非有限数值/不支持类型整包拒绝。
  WebSocket 端只订阅输出，客户端发送数据会被断开。

设备提示:
  OSC 发送工具需将设备坐标先转换为上述 HSE 轴约定。
  本脚本不测量姿态、不连接蓝牙，也不能代替真实头追硬件验收。
`

function parseArguments(args) {
  const options = {}
  const fields = { '--osc-port': 'udpPort', '--ws-port': 'wsPort', '--path': 'path', '--max-hz': 'maxHz' }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--help' || arg === '-h') return { help: true }
    const field = fields[arg]
    if (!field || i + 1 >= args.length) throw new Error(`未知或缺少参数: ${arg}`)
    const value = args[++i]
    if (field === 'path') options[field] = value
    else {
      if (!/^\d+(?:\.\d+)?$/.test(value)) throw new Error(`参数必须为数字: ${arg}`)
      options[field] = Number(value)
    }
  }
  return options
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) { console.log(HELP); return }
  const bridge = await createHeadTrackingBridge({
    ...options, onError: error => console.error(`头追桥错误: ${error.message}`),
  })
  console.log(`HSE 头追桥: OSC udp://127.0.0.1:${bridge.udpAddress.port} -> ws://127.0.0.1:${bridge.wsAddress.port}${bridge.path}`)
  console.log('按 Ctrl+C 停止；协议和限制请运行 --help。')
  let stopping = false
  const shutdown = async () => {
    if (stopping) return
    stopping = true
    process.off('SIGINT', shutdown); process.off('SIGTERM', shutdown)
    await bridge.close()
  }
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown)
}

if (require.main === module) main().catch(error => {
  console.error(`无法启动 HSE 头追桥: ${error.message}`)
  process.exitCode = 1
})

module.exports = { parseArguments, HELP, main }
