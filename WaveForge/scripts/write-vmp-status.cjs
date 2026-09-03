const path = require('node:path')
const { verifyDevelopmentVmp, writePackagedMetadata } = require('../desktop/vmp-status.cjs')

const packageDir = path.resolve(process.argv[2] || 'release/win-unpacked')

verifyDevelopmentVmp(packageDir)
  .then(status => {
    if (!['valid', 'expiring'].includes(status.status) || status.kind !== 'streaming') {
      throw new Error(`VMP metadata generation requires a valid streaming signature (status=${status.status})`)
    }
    const target = writePackagedMetadata(packageDir, status)
    console.log(`[EVS/VMP] 状态元数据已写入: ${target}（剩余 ${status.daysLeft} 天）`)
  })
  .catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
