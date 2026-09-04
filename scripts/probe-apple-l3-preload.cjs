const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('__appleL3Probe', {
  requestLicense: payload => ipcRenderer.invoke('apple-l3-probe-license', payload),
})
