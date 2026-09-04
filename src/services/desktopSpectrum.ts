type ConsumerListener = () => void

let consumerCount = 0
const consumerListeners = new Set<ConsumerListener>()

const notifyConsumerListeners = () => consumerListeners.forEach(listener => listener())

export const registerDesktopSpectrumConsumer = () => {
  consumerCount += 1
  notifyConsumerListeners()
  let active = true
  return () => {
    if (!active) return
    active = false
    consumerCount = Math.max(0, consumerCount - 1)
    notifyConsumerListeners()
  }
}

export const subscribeDesktopSpectrumConsumers = (listener: ConsumerListener) => {
  consumerListeners.add(listener)
  return () => consumerListeners.delete(listener)
}

export const getDesktopSpectrumConsumerCount = () => consumerCount
