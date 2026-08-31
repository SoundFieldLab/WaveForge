'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createTaskbarWidgetPolling } = require('../desktop/taskbar-widget-polling.cjs')

class FakeWindow extends EventEmitter {
  constructor(visible = false) {
    super()
    this.visible = visible
  }

  isVisible() {
    return this.visible
  }

  show() {
    this.visible = true
    this.emit('show')
  }

  hide() {
    this.visible = false
    this.emit('hide')
  }

  destroy() {
    this.visible = false
    this.emit('closed')
  }
}

function createHarness() {
  const intervals = []
  const cleared = []
  const polling = createTaskbarWidgetPolling({
    poll: () => {},
    setIntervalFn: (callback, delay) => {
      const timer = { callback, delay }
      intervals.push(timer)
      return timer
    },
    clearIntervalFn: timer => cleared.push(timer),
  })
  return { polling, intervals, cleared }
}

test('taskbar polling follows show and hide without duplicate timers', () => {
  const window = new FakeWindow(false)
  const { polling, intervals, cleared } = createHarness()

  polling.bindWindow(window)
  assert.equal(intervals.length, 0)

  window.show()
  assert.equal(intervals.length, 1)
  assert.equal(intervals[0].delay, 120)

  window.show()
  assert.equal(intervals.length, 1)

  window.hide()
  assert.deepEqual(cleared, [intervals[0]])

  window.hide()
  assert.equal(cleared.length, 1)

  window.show()
  assert.equal(intervals.length, 2)

  window.destroy()
  assert.deepEqual(cleared, intervals)
  window.destroy()
  assert.equal(cleared.length, 2)
})

test('taskbar polling starts for a visible window and stops when destroyed', () => {
  const window = new FakeWindow(true)
  const { polling, intervals, cleared } = createHarness()

  polling.bindWindow(window)
  assert.equal(intervals.length, 1)

  window.destroy()
  assert.deepEqual(cleared, [intervals[0]])
})
