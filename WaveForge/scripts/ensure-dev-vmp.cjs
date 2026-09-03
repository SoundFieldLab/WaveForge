const path = require('node:path')
const { runEvs } = require('./evs-runner.cjs')

const target = path.resolve('node_modules/electron/dist')
const required = process.env.WAVEFORGE_REQUIRE_DEV_VMP === '1'

try {
  if (runEvs('verify-pkg', target, { required: false })) {
    console.log('[EVS/VMP] 开发 Electron 已是 production streaming VMP，无需重签')
    process.exit(0)
  }
  console.log('[EVS/VMP] 开发 Electron 缺少 production VMP，尝试签名（仅依赖重装/升级后发生）')
  const signed = runEvs('sign-pkg', target, { required })
  if (!signed) {
    console.warn('[EVS/VMP] 本次开发可继续，但 Apple 原生 CENC 验收不可用；配置 EVS 后重启即可自动签名')
    process.exit(required ? 1 : 0)
  }
  runEvs('verify-pkg', target, { required: true })
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(required ? 1 : 0)
}
