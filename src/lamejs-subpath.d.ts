/**
 * lamejs 1.2.1 子模块深导入声明（attachV3Engine 的打包器兼容补丁用）。
 * 包内各子文件以 CommonJS `module.exports = 类` 导出，Vite interop 下落在 default 上。
 */

declare module 'lamejs/src/js/MPEGMode.js' {
  const MPEGMode: unknown
  export default MPEGMode
}

declare module 'lamejs/src/js/Lame.js' {
  const Lame: unknown
  export default Lame
}

declare module 'lamejs/src/js/BitStream.js' {
  const BitStream: unknown
  export default BitStream
}
