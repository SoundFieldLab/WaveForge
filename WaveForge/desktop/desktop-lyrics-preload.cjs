const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktopLyrics', {
  getState: () => ipcRenderer.invoke('desktop-player:get-state'),
  getSettings: () => ipcRenderer.invoke('desktop-lyrics:get-settings'),
  onState: (callback) => {
    const listener = (_event, state) => callback(state)
    ipcRenderer.on('desktop-lyrics:state', listener)
    return () => ipcRenderer.removeListener('desktop-lyrics:state', listener)
  },
  onSettings: (callback) => {
    const listener = (_event, settings) => callback(settings)
    ipcRenderer.on('desktop-lyrics:settings', listener)
    return () => ipcRenderer.removeListener('desktop-lyrics:settings', listener)
  },
  updateSettings: (partial) => ipcRenderer.invoke('desktop-lyrics:update-settings', partial),
  setPanelOpen: (open) => ipcRenderer.invoke('desktop-lyrics:set-panel-open', open),
  setMousePassthrough: (passthrough) => ipcRenderer.invoke('desktop-lyrics:set-mouse-passthrough', passthrough),
  sendControl: (action) => ipcRenderer.send('desktop-lyrics:control', action),
  startResize: (point) => ipcRenderer.send('desktop-lyrics:resize-start', point),
  resizeTo: (point) => ipcRenderer.send('desktop-lyrics:resize-to', point),
  endResize: () => ipcRenderer.send('desktop-lyrics:resize-end'),
  startDrag: (point) => ipcRenderer.send('desktop-lyrics:drag-start', point),
  dragTo: (point) => ipcRenderer.send('desktop-lyrics:drag-to', point),
  endDrag: () => ipcRenderer.send('desktop-lyrics:drag-end'),
})
