'use strict'

function createTaskbarWidgetPolling({ poll, intervalMs = 120, setIntervalFn = setInterval, clearIntervalFn = clearInterval }) {
  let timer = null

  function start() {
    if (timer !== null) return
    timer = setIntervalFn(poll, intervalMs)
  }

  function stop() {
    if (timer === null) return
    clearIntervalFn(timer)
    timer = null
  }

  function bindWindow(window) {
    window.on('show', start)
    window.on('hide', stop)
    window.on('closed', stop)
    if (window.isVisible()) start()
  }

  return { bindWindow, start, stop }
}

module.exports = { createTaskbarWidgetPolling }
