const MAX_PLAYLIST_COVER_BYTES = 10 * 1024 * 1024
const PLAYLIST_COVER_SIZE = 600

export async function preparePlaylistCover(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error('请选择图片文件')
  }
  if (file.size > MAX_PLAYLIST_COVER_BYTES) {
    throw new Error('封面图片不能超过 10MB')
  }

  const objectUrl = URL.createObjectURL(file)
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error('无法读取封面图片'))
      img.src = objectUrl
    })

    const sourceSize = Math.min(image.naturalWidth, image.naturalHeight)
    const sourceX = Math.max(0, (image.naturalWidth - sourceSize) / 2)
    const sourceY = Math.max(0, (image.naturalHeight - sourceSize) / 2)
    const canvas = document.createElement('canvas')
    canvas.width = PLAYLIST_COVER_SIZE
    canvas.height = PLAYLIST_COVER_SIZE
    const context = canvas.getContext('2d')
    if (!context) throw new Error('无法处理封面图片')

    context.drawImage(
      image,
      sourceX,
      sourceY,
      sourceSize,
      sourceSize,
      0,
      0,
      PLAYLIST_COVER_SIZE,
      PLAYLIST_COVER_SIZE
    )
    return canvas.toDataURL('image/jpeg', 0.9)
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}
