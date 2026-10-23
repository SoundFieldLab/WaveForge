// 更新清单签名公钥。与 device-license 兑换码共用同一把 Ed25519 密钥
// （WaveForge License Studio 持私钥；本文件由该项目的公钥导出流程生成）。
// 主程序只包含公钥：无法伪造清单签名，只能由发布者签发可执行的 (urls, sha256) 组合。
const UPDATE_MANIFEST_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAHXWDrhMWyMVvO4kiqrx+opUuwT5THVEYcTIXb2YZJqA=
-----END PUBLIC KEY-----`

module.exports = { UPDATE_MANIFEST_PUBLIC_KEY }
