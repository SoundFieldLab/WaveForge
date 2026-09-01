const { spawnSync } = require('node:child_process')

const MIN_RELEASE_VMP_DAYS = 30

function pythonCandidates() {
  return [
    process.env.WAVEFORGE_EVS_PYTHON,
    process.env.PYTHON,
    'D:\\Python\\python.exe',
    'python',
    'py',
  ].filter(Boolean)
}

function findPython() {
  for (const candidate of pythonCandidates()) {
    const args = candidate === 'py' ? ['-3', '-c', 'import castlabs_evs'] : ['-c', 'import castlabs_evs']
    const result = spawnSync(candidate, args, { stdio: 'ignore', windowsHide: true })
    if (result.status === 0) return { exe: candidate, prefix: candidate === 'py' ? ['-3'] : [] }
  }
  return null
}

function runEvs(command, packageDir, { required = false } = {}) {
  const python = findPython()
  if (!python) {
    const message = '[EVS/VMP] castlabs-evs 未安装或 Python 不可用'
    if (required) throw new Error(message)
    console.warn(message + '，跳过非发布构建签名')
    return false
  }
  const args = [...python.prefix, '-m', 'castlabs_evs.vmp', command, '--streaming',
    '--min-days', String(MIN_RELEASE_VMP_DAYS),
    ...(command === 'sign-pkg' ? ['--multipart-part-size', '20', '--multipart-max-concurrency', '4', '--multipart-retries', '5'] : []),
    packageDir]
  const env = { ...process.env, EVS_NO_ASK: process.env.EVS_NO_ASK || '1' }
  const execute = () => spawnSync(python.exe, args, {
    stdio: 'inherit',
    windowsHide: true,
    env,
  })
  console.log(`[EVS/VMP] ${command}: ${packageDir}`)
  let result = execute()
  if (result.status !== 0 && command === 'sign-pkg') {
    console.warn('[EVS/VMP] 首次签名失败，刷新账户授权并重新获取上传槽后重试一次')
    spawnSync(python.exe, [...python.prefix, '-m', 'castlabs_evs.account', '-n', 'refresh'], {
      stdio: 'inherit', windowsHide: true, env,
    })
    result = execute()
  }
  if (result.status !== 0) {
    const message = `[EVS/VMP] ${command} 失败（exit=${result.status})`
    if (required) throw new Error(message)
    console.warn(message)
    return false
  }
  return true
}

// EVS/VMP 命令 helper。正式构建采用明确的两阶段流程：
// electron-builder --win dir → sign-pkg/verify-pkg → electron-builder --prepackaged ... nsis。
// 不依赖 electron-builder afterSign（无 Authenticode 时该 hook 会被跳过）。
exports.MIN_RELEASE_VMP_DAYS = MIN_RELEASE_VMP_DAYS
exports.findPython = findPython
exports.runEvs = runEvs
