declare module 'opencc-js' {
  export function Converter(options: { from: 'cn' | 'tw' | 'twp' | 'hk' | 'jp'; to: 'cn' | 'tw' | 'twp' | 'hk' | 'jp' }): (text: string) => string
}

declare module 'opencc-js/t2cn' {
  export function Converter(options: { from: 'cn' | 'tw' | 'twp' | 'hk' | 'jp'; to: 'cn' | 'tw' | 'twp' | 'hk' | 'jp' }): (text: string) => string
}
