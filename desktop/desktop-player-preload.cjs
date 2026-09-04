const { contextBridge, ipcRenderer } = require('electron')

// 桌面播放器独立小窗口专用 preload：
// 只暴露状态接收、控制指令发送与窗口尺寸联动所需的最小 API。
contextBridge.exposeInMainWorld('desktopPlayer', {
  // 获取当前完整状态快照：{ song, lyric, playing, spectrum, enabled, form }
  getState: () => ipcRenderer.invoke('desktop-player:get-state'),
  // 订阅状态更新
  onState: (callback) => {
    const listener = (_event, state) => callback(state)
    ipcRenderer.on('desktop-player:state', listener)
    return () => ipcRenderer.removeListener('desktop-player:state', listener)
  },
  // 播放控制：'play' | 'pause' | 'toggle' | 'next' | 'prev'
  sendControl: (action, payload) => ipcRenderer.send('desktop-player:control', action, payload),
  startResize: (point) => ipcRenderer.send('desktop-player:resize-start', point),
  resizeTo: (point) => ipcRenderer.send('desktop-player:resize-to', point),
  endResize: () => ipcRenderer.send('desktop-player:resize-end'),
  startDrag: (point) => ipcRenderer.send('desktop-player:drag-start', point),
  dragTo: (point) => ipcRenderer.send('desktop-player:drag-to', point),
  endDrag: () => ipcRenderer.send('desktop-player:drag-end'),
  // 卡片形态内容高度变化时上报，主进程把窗口向下延伸
  reportContentHeight: (height) => ipcRenderer.send('desktop-player:content-height', height),
  setExpanded: (expanded) => ipcRenderer.invoke('desktop-player:set-expanded', expanded),
})
