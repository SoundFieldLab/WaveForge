declare module '*.svg' {
  const content: string
  export default content
}

declare module '*?url' {
  const url: string
  export default url
}

declare module 'lamejs/src/js/MPEGMode.js' { const value: unknown; export default value }
declare module 'lamejs/src/js/Lame.js' { const value: unknown; export default value }
declare module 'lamejs/src/js/BitStream.js' { const value: unknown; export default value }
declare module 'lamejs' { const value: unknown; export default value }
