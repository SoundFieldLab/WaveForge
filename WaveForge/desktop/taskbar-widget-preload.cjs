// 任务栏 widget 窗口 preload：暴露状态订阅与操作发送（contextIsolation 下安全桥接）
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('taskbarWidget', {
  onState: (callback) => {
    const listener = (_event, state) => callback(state)
    ipcRenderer.on('taskbar-widget:state', listener)
    return () => ipcRenderer.removeListener('taskbar-widget:state', listener)
  },
  action: (action, payload) => {
    ipcRenderer.send('taskbar-widget:action', action, payload)
  },
})
