// 任务栏迷你播控窗口 preload：暴露状态订阅、设置读写与操作发送（contextIsolation 下安全桥接）
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('taskbarWidget', {
  onState: (callback) => {
    const listener = (_event, state) => callback(state)
    ipcRenderer.on('taskbar-widget:state', listener)
    return () => ipcRenderer.removeListener('taskbar-widget:state', listener)
  },
  onSettings: (callback) => {
    const listener = (_event, settings) => callback(settings)
    ipcRenderer.on('taskbar-widget:settings', listener)
    return () => ipcRenderer.removeListener('taskbar-widget:settings', listener)
  },
  getSettings: () => ipcRenderer.invoke('taskbar-widget:get-settings'),
  action: (action, payload) => {
    ipcRenderer.send('taskbar-widget:action', action, payload)
  },
  // 悬停进出切换鼠标交互态（默认鼠标穿透，不挡任务栏）
  setInteractive: (interactive) => {
    ipcRenderer.send('taskbar-widget:set-interactive', interactive === true)
  },
  // 展开/收起向上弹出的按钮面板（主进程调整窗口高度）
  setExpanded: (expanded) => {
    ipcRenderer.send('taskbar-widget:set-expanded', expanded === true)
  },
})
