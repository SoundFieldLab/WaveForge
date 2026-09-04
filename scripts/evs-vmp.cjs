const path = require('node:path')
const { runEvs } = require('./evs-runner.cjs')

const command = process.argv[2]
const target = process.argv[3] || 'node_modules/electron/dist'
if (!['sign-pkg', 'verify-pkg'].includes(command)) {
  console.error('用法: node scripts/evs-vmp.cjs <sign-pkg|verify-pkg> [package-directory]')
  process.exit(2)
}
try {
  const ok = runEvs(command, path.resolve(target), { required: true })
  process.exit(ok ? 0 : 1)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
