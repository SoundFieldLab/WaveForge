// 复测 dev-electron.mjs 的 isWaveForgeDevLeftover（正斜杠归一化版）
const projectRoot = process.cwd()
const isWaveForgeDevLeftover = (commandLine) => {
  if (!commandLine) return false
  const normalized = commandLine.replace(/[\\/]+/g, '/')
  const root = projectRoot.replace(/[\\/]+/g, '/')
  if (!normalized.includes(root)) return false
  return /vite\/bin\/vite|local-server\.mjs|compensation_server\.py|beat_analyzer\.py|loudness_server\.py/.test(normalized)
}

const cases = [
  ['真实残留 vite (反斜杠)', '"node" "D:\\opencode\\WaveForge\\node_modules\\.bin\\..\\vite\\bin\\vite.js" --port=3000 --host=0.0.0.0', true],
  ['vite 正斜杠', 'node D:/opencode/WaveForge/node_modules/vite/bin/vite.js --port 3000', true],
  ['local-server', 'node D:\\opencode\\WaveForge\\local-server.mjs', true],
  ['compensation python', 'python D:\\opencode\\WaveForge\\desktop\\workers\\compensation_server.py', true],
  ['ZCode 无关进程', 'C:\\Program Files\\node.exe C:\\Users\\Yoshino\\AppData\\Roaming\\ZCode\\index.js', false],
  ['electron 测试探针', 'D:\\opencode\\WaveForge\\node_modules\\electron\\dist\\electron.exe test/widget-x.cjs', false],
]
let allPass = true
for (const [name, cmd, expect] of cases) {
  const got = isWaveForgeDevLeftover(cmd)
  const ok = got === expect
  if (!ok) allPass = false
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + ' -> ' + got)
}
process.exit(allPass ? 0 : 1)
