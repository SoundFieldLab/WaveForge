/**
 * lamejs 最小类型声明（纯 JS MP3 编码器，无原生依赖，浏览器/Electron 可用）
 * 仅描述本工程导出用到的 Mp3Encoder 公开 API 面（lamejs 1.2.1 实测返回 Int8Array）。
 */
declare module 'lamejs' {
  /**
   * MP3 编码器：构造时指定声道数、采样率、比特率（kbps）。
   * encodeBuffer 喂入 Int16 PCM：立体声传左右声道，单声道只传 left（right 省略）；
   * 返回 MP3 帧字节（可能为空缓冲）；编码结束后调 flush() 冲刷尾部剩余数据。
   */
  export class Mp3Encoder {
    constructor(channels: number, sampleRate: number, kbps: number)
    /** 编码一块 Int16 PCM；返回 MP3 帧（Int8Array，可能为空）。单声道省略 right。 */
    encodeBuffer(left: Int16Array, right?: Int16Array): Int8Array
    /** 冲刷编码器尾部剩余 MP3 数据 */
    flush(): Int8Array
  }
}
