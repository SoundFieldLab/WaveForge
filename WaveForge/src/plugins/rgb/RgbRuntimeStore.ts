import {
  EMPTY_RGB_TRANSPORT_STATE,
  type RgbPreviewFrame,
  type RgbTransportState,
} from './rgbTypes'

type Listener = () => void

export interface RgbRuntimeStore {
  getStatusSnapshot: () => Readonly<RgbTransportState>
  getPreviewSnapshot: () => Readonly<RgbPreviewFrame> | null
  publishStatus: (update: Partial<RgbTransportState>) => void
  publishPreview: (preview: RgbPreviewFrame | null) => void
  subscribeStatus: (listener: Listener) => () => void
  subscribePreview: (listener: Listener) => () => void
  getPreviewSubscriberCount: () => number
}

export function createRgbRuntimeStore(
  initialStatus: Partial<RgbTransportState> = {},
): RgbRuntimeStore {
  let status: Readonly<RgbTransportState> = Object.freeze({
    ...EMPTY_RGB_TRANSPORT_STATE,
    ...initialStatus,
  })
  let preview: Readonly<RgbPreviewFrame> | null = null
  const statusListeners = new Set<Listener>()
  const previewListeners = new Set<Listener>()

  return {
    getStatusSnapshot: () => status,
    getPreviewSnapshot: () => preview,
    publishStatus(update) {
      const next = { ...status, ...update }
      const changed = (Object.keys(update) as Array<keyof RgbTransportState>)
        .some(key => !Object.is(status[key], next[key]))
      if (!changed) return
      status = Object.freeze(next)
      statusListeners.forEach(listener => listener())
    },
    publishPreview(nextPreview) {
      if (Object.is(preview, nextPreview)) return
      preview = nextPreview === null
        ? null
        : Object.freeze({
            ...nextPreview,
            colors: Object.freeze(Array.from(nextPreview.colors, color => Object.freeze({ ...color }))),
          })
      previewListeners.forEach(listener => listener())
    },
    subscribeStatus(listener) {
      statusListeners.add(listener)
      return () => statusListeners.delete(listener)
    },
    subscribePreview(listener) {
      previewListeners.add(listener)
      return () => previewListeners.delete(listener)
    },
    getPreviewSubscriberCount: () => previewListeners.size,
  }
}
